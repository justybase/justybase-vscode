"""Stand-in for your existing FastAPI service.

Everything above the "JustyBase" marker imitates what the service already has:
a login screen, a login endpoint, JWTs and a protected REST API. Only the block
below the marker is new. Do not use this file's user store in production.

This module must not use `from __future__ import annotations`: FastAPI could not
then resolve `Depends(current_user)`, which is defined inside create_app.
"""

import hashlib
import hmac
import logging
import os
import secrets
import time
from dataclasses import dataclass
from typing import Annotated

import jwt
from fastapi import Depends, FastAPI, Form, HTTPException, status
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from justybase_relay import create_justybase_router

JWT_ALGORITHM = "HS256"
JWT_AUDIENCE = "demo-service"

LOGIN_PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Demo service</title></head>
<body>
  <h1>Demo service login</h1>
  <form id="login">
    <label>Login <input name="username" autocomplete="username"></label>
    <label>Password <input name="password" type="password"
      autocomplete="current-password"></label>
    <button>Log in</button>
  </form>
  <pre id="result"></pre>
  <script>
    document.getElementById('login').addEventListener('submit', async event => {
      event.preventDefault();
      const response = await fetch('/auth/login', {
        method: 'POST',
        body: new URLSearchParams(new FormData(event.target)),
      });
      document.getElementById('result').textContent =
        response.ok ? 'Logged in.' : 'Login failed.';
    });
  </script>
</body></html>
"""


@dataclass(frozen=True)
class User:
    username: str


def _hash_password(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Environment variable {name} is required")
    return value


def create_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO)

    jwt_secret = _required_env("DEMO_JWT_SECRET")
    if len(jwt_secret) < 32:
        raise RuntimeError("DEMO_JWT_SECRET must have at least 32 characters")
    jwt_ttl_seconds = int(os.environ.get("DEMO_JWT_TTL_SECONDS", "900"))
    demo_username = _required_env("DEMO_USERNAME")
    salt = secrets.token_bytes(16)
    password_hash = _hash_password(_required_env("DEMO_PASSWORD"), salt)

    app = FastAPI(title="Demo service with a JustyBase relay")
    bearer = HTTPBearer()

    def authenticate_user(username: str, password: str) -> User | None:
        candidate = _hash_password(password, salt)
        password_matches = hmac.compare_digest(candidate, password_hash)
        username_matches = hmac.compare_digest(
            username.encode("utf-8"), demo_username.encode("utf-8")
        )
        return User(username) if username_matches and password_matches else None

    def create_access_token(user: User) -> tuple[str, int]:
        now = int(time.time())
        token = jwt.encode(
            {
                "sub": user.username,
                "aud": JWT_AUDIENCE,
                "iat": now,
                "exp": now + jwt_ttl_seconds,
            },
            jwt_secret,
            algorithm=JWT_ALGORITHM,
        )
        return token, jwt_ttl_seconds

    def decode_access_token(token: str) -> User | None:
        claims = jwt.decode(
            token,
            jwt_secret,
            algorithms=[JWT_ALGORITHM],
            audience=JWT_AUDIENCE,
            options={"require": ["exp", "sub"]},
        )
        return User(claims["sub"])

    def current_user(
        credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
    ) -> User:
        try:
            user = decode_access_token(credentials.credentials)
        except jwt.PyJWTError as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED) from exc
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED)
        return user

    @app.get("/healthz")
    def healthz() -> JSONResponse:
        return JSONResponse({"status": "ok"})

    @app.get("/", response_class=HTMLResponse)
    def login_screen() -> str:
        return LOGIN_PAGE

    @app.post("/auth/login")
    def login(
        username: Annotated[str, Form()], password: Annotated[str, Form()]
    ) -> JSONResponse:
        user = authenticate_user(username, password)
        if user is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED)
        token, expires_in = create_access_token(user)
        return JSONResponse({"access_token": token, "expires_in": expires_in})

    @app.get("/api/me")
    def me(user: Annotated[User, Depends(current_user)]) -> JSONResponse:
        return JSONResponse({"username": user.username})

    # ---------------------------- JustyBase ----------------------------
    # This is the only addition. The login screen and endpoints above are
    # not changed. Replace `authorize` with your service's own permission check.
    app.include_router(
        create_justybase_router(
            authenticate=authenticate_user,
            issue_token=create_access_token,
            verify_token=decode_access_token,
            authorize=lambda user, target_id: True,
        ),
        prefix="/api/justybase",
    )
    return app
