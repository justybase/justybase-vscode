"""Add a JustyBase Netezza relay to an existing FastAPI service.

The router reuses the service's own login and JWT functions, so the existing
login screen and endpoints stay as they are. It adds two routes:

    POST /auth/token            login + password -> JWT
    WS   /tunnel/{target_id}    Bearer JWT + client proof -> database session
"""

from __future__ import annotations

import inspect
import logging
from typing import Any, Awaitable, Callable, Mapping, TypeVar

from fastapi import APIRouter, HTTPException, WebSocket, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from .relay import ConnectionLimiter, run_relay
from .settings import NetezzaTarget, load_targets

__all__ = ["NetezzaTarget", "create_justybase_router", "load_targets"]

T = TypeVar("T")

logger = logging.getLogger("justybase.relay")

CLIENT_PROOF_HEADER = "x-justybase-client-proof"
MIN_CLIENT_PROOF_LENGTH = 32
MAX_CLIENT_PROOF_LENGTH = 512
BEARER_PREFIX = "bearer "


class TokenRequest(BaseModel):
    username: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=1, max_length=1024)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


async def _call(function: Callable[..., T | Awaitable[T]], *args: Any) -> T:
    """Call a sync or async service function without blocking the event loop."""
    if inspect.iscoroutinefunction(function):
        return await function(*args)
    result = await run_in_threadpool(function, *args)
    if inspect.isawaitable(result):
        return await result
    return result


def _default_user_id(user: Any) -> str:
    # Never str(user): a user object may print its password hash into the log.
    if isinstance(user, str):
        return user
    return str(getattr(user, "username", "unknown"))


def _bearer_token(websocket: WebSocket) -> str | None:
    header = websocket.headers.get("authorization", "")
    if not header.lower().startswith(BEARER_PREFIX):
        return None
    return header[len(BEARER_PREFIX) :].strip() or None


def create_justybase_router(
    *,
    authenticate: Callable[[str, str], Any],
    issue_token: Callable[[Any], tuple[str, int] | Awaitable[tuple[str, int]]],
    verify_token: Callable[[str], Any],
    authorize: Callable[[Any, str], bool | Awaitable[bool]],
    targets: Mapping[str, NetezzaTarget] | None = None,
    user_id: Callable[[Any], str] = _default_user_id,
    max_connections: int = 64,
    max_connections_per_user: int = 16,
) -> APIRouter:
    """Build the relay router from functions the service already has.

    authenticate(username, password) returns a user, or None for a bad login.
    issue_token(user) returns (jwt, seconds until it expires).
    verify_token(token) returns a user, or None. It may raise on a bad token.
    authorize(user, target_id) decides who may use which target. It has no
    default, because a session has the full rights of the service account.
    """
    resolved_targets = load_targets() if targets is None else dict(targets)
    for target_id, target in resolved_targets.items():
        if target.tls == "off":
            logger.warning(
                "relay target %s has tls=off: traffic to the database is not encrypted",
                target_id,
            )
        elif not target.tls_verify:
            logger.warning(
                "relay target %s has tls_verify=false: the database certificate is "
                "not checked, so a network attacker could pose as the database",
                target_id,
            )
    limiter = ConnectionLimiter(max_connections, max_connections_per_user)
    router = APIRouter()

    @router.post("/auth/token", response_model=TokenResponse)
    async def create_token(request: TokenRequest) -> TokenResponse:
        user = await _call(authenticate, request.username, request.password)
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid login or password.",
                headers={"WWW-Authenticate": "Bearer"},
            )
        token, expires_in = await _call(issue_token, user)
        return TokenResponse(access_token=token, expires_in=expires_in)

    @router.websocket("/tunnel/{target_id}")
    async def tunnel(websocket: WebSocket, target_id: str) -> None:
        # Closing before accept makes the server answer the upgrade with an
        # HTTP error, so no database connection exists for a refused client.
        token = _bearer_token(websocket)
        client_proof = websocket.headers.get(CLIENT_PROOF_HEADER, "")
        if (
            token is None
            or not MIN_CLIENT_PROOF_LENGTH
            <= len(client_proof)
            <= MAX_CLIENT_PROOF_LENGTH
        ):
            await websocket.close(code=1008)
            return

        try:
            user = await _call(verify_token, token)
        except Exception:
            # Every JWT library has its own exceptions. All of them mean "refuse".
            user = None
        if user is None:
            await websocket.close(code=1008)
            return

        target = resolved_targets.get(target_id)
        if target is None or not await _call(authorize, user, target_id):
            await websocket.close(code=1008)
            return

        identity = user_id(user)
        if not limiter.try_acquire(identity):
            await websocket.close(code=1013)
            return
        try:
            await run_relay(websocket, target_id, target, identity, client_proof)
        finally:
            limiter.release(identity)

    return router
