"""Small reference raw TCP relay over an authenticated WebSocket.

The relay is database-agnostic. It forwards bytes between a named, server-side
TCP target and one authenticated WebSocket connection from JustyBase.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, WebSocket
from fastapi.responses import JSONResponse


MAX_CONNECTIONS = int(os.getenv("DATABASE_TUNNEL_MAX_CONNECTIONS", "32"))
TOKEN = os.getenv("DATABASE_TUNNEL_TOKEN", "")


@dataclass(frozen=True)
class Target:
    host: str
    port: int


def load_targets() -> dict[str, Target]:
    raw = os.getenv("DATABASE_TUNNEL_TARGETS_JSON", "{}")
    try:
        parsed: Any = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("DATABASE_TUNNEL_TARGETS_JSON must contain valid JSON") from exc

    if not isinstance(parsed, dict):
        raise RuntimeError("DATABASE_TUNNEL_TARGETS_JSON must be a JSON object")

    targets: dict[str, Target] = {}
    for target_id, value in parsed.items():
        if not isinstance(target_id, str) or not target_id.strip():
            raise RuntimeError("Tunnel target ids must be non-empty strings")
        if not isinstance(value, dict):
            raise RuntimeError(f"Tunnel target '{target_id}' must be an object")
        host = value.get("host")
        port = value.get("port")
        if not isinstance(host, str) or not host.strip():
            raise RuntimeError(f"Tunnel target '{target_id}' must have a host")
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
            raise RuntimeError(f"Tunnel target '{target_id}' has an invalid port")
        targets[target_id] = Target(host=host.strip(), port=port)
    return targets


TARGETS = load_targets()
CONNECTION_LIMIT = asyncio.Semaphore(MAX_CONNECTIONS)
app = FastAPI(title="JustyBase database WSS tunnel")


async def close_socket(websocket: WebSocket, code: int) -> None:
    try:
        await websocket.close(code=code)
    except RuntimeError:
        # The handshake may not have been accepted yet.
        return


@app.get("/healthz")
async def healthz() -> JSONResponse:
    return JSONResponse({"status": "ok"})


@app.websocket("/tunnel/{target_id}")
async def tunnel(websocket: WebSocket, target_id: str) -> None:
    authorization = websocket.headers.get("authorization", "")
    supplied_token = authorization.removeprefix("Bearer ").strip()
    if not TOKEN or not hmac.compare_digest(supplied_token, TOKEN):
        await close_socket(websocket, 1008)
        return

    target = TARGETS.get(target_id)
    if target is None:
        await close_socket(websocket, 1008)
        return

    try:
        await asyncio.wait_for(CONNECTION_LIMIT.acquire(), timeout=0.1)
    except asyncio.TimeoutError:
        await close_socket(websocket, 1013)
        return

    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(target.host, target.port),
            timeout=15,
        )
    except (OSError, asyncio.TimeoutError):
        CONNECTION_LIMIT.release()
        await close_socket(websocket, 1011)
        return

    async def websocket_to_target() -> None:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                return
            data = message.get("bytes")
            if data is None:
                raise RuntimeError("Tunnel accepts binary WebSocket frames only")
            writer.write(data)
            await writer.drain()

    async def target_to_websocket() -> None:
        while True:
            data = await reader.read(64 * 1024)
            if not data:
                return
            await websocket.send_bytes(data)

    tasks: list[asyncio.Task[None]] = []
    try:
        await websocket.accept()
        tasks = [
            asyncio.create_task(websocket_to_target()),
            asyncio.create_task(target_to_websocket()),
        ]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    except Exception:
        # The peer is already being disconnected; do not leak database details.
        return
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            writer.close()
            await writer.wait_closed()
        except OSError:
            pass
        finally:
            CONNECTION_LIMIT.release()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("DATABASE_TUNNEL_BIND_HOST", "127.0.0.1"),
        port=int(os.getenv("DATABASE_TUNNEL_BIND_PORT", "8000")),
    )
