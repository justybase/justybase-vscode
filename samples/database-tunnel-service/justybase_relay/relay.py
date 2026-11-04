"""WebSocket <-> TCP relay for one authenticated JustyBase connection."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter

from fastapi import WebSocket

from .netezza_auth import (
    GENERIC_LOGIN_FAILURE,
    HandshakeRejected,
    Outcome,
    error_frame,
    negotiate,
)
from .settings import NetezzaTarget

logger = logging.getLogger("justybase.relay")

CONNECT_TIMEOUT_SECONDS = 15
HANDSHAKE_TIMEOUT_SECONDS = 30
READ_CHUNK_BYTES = 64 * 1024


class ConnectionLimiter:
    """Limits per process. With several workers the limits apply to each worker."""

    def __init__(self, max_total: int, max_per_user: int) -> None:
        self._max_total = max_total
        self._max_per_user = max_per_user
        self._total = 0
        self._per_user: Counter[str] = Counter()

    def try_acquire(self, user: str) -> bool:
        if self._total >= self._max_total or self._per_user[user] >= self._max_per_user:
            return False
        self._total += 1
        self._per_user[user] += 1
        return True

    def release(self, user: str) -> None:
        self._total -= 1
        self._per_user[user] -= 1
        if self._per_user[user] <= 0:
            del self._per_user[user]


class WebSocketClientStream:
    """Exact-length reads over WebSocket messages, which split bytes arbitrarily."""

    def __init__(self, websocket: WebSocket) -> None:
        self._websocket = websocket
        self._buffer = bytearray()

    async def _receive(self) -> bytes:
        message = await self._websocket.receive()
        if message.get("type") == "websocket.disconnect":
            raise ConnectionError("client disconnected")
        data = message.get("bytes")
        if data is None:
            raise HandshakeRejected("The tunnel accepts binary WebSocket frames only.")
        return data

    async def read_exactly(self, count: int) -> bytes:
        while len(self._buffer) < count:
            self._buffer.extend(await self._receive())
        data = bytes(self._buffer[:count])
        del self._buffer[:count]
        return data

    async def write(self, data: bytes) -> None:
        await self._websocket.send_bytes(data)

    def take_buffered(self) -> bytes:
        data = bytes(self._buffer)
        self._buffer.clear()
        return data

    async def receive_chunk(self) -> bytes | None:
        try:
            return await self._receive()
        except ConnectionError:
            return None


async def _relay_bytes(
    client: WebSocketClientStream,
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> tuple[int, int]:
    sent = 0
    received = 0

    buffered = client.take_buffered()
    if buffered:
        writer.write(buffered)
        await writer.drain()
        sent += len(buffered)

    async def client_to_database() -> None:
        nonlocal sent
        while (chunk := await client.receive_chunk()) is not None:
            writer.write(chunk)
            await writer.drain()
            sent += len(chunk)

    async def database_to_client() -> None:
        nonlocal received
        while chunk := await reader.read(READ_CHUNK_BYTES):
            await client.write(chunk)
            received += len(chunk)

    tasks = [
        asyncio.create_task(client_to_database()),
        asyncio.create_task(database_to_client()),
    ]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    return sent, received


async def run_relay(
    websocket: WebSocket,
    target_id: str,
    target: NetezzaTarget,
    user_id: str,
    client_proof: str,
) -> None:
    """Serve one accepted-to-be connection. Authorization has already passed."""
    started = time.monotonic()
    outcome = "failed"
    sent = 0
    received = 0
    writer: asyncio.StreamWriter | None = None

    await websocket.accept()
    client = WebSocketClientStream(websocket)
    try:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(target.host, target.port),
                timeout=CONNECT_TIMEOUT_SECONDS,
            )
        except (OSError, TimeoutError):
            logger.warning("relay target %s is unreachable", target_id)
            await websocket.close(code=1011)
            return

        try:
            result = await asyncio.wait_for(
                negotiate(client, reader, writer, target, client_proof),
                timeout=HANDSHAKE_TIMEOUT_SECONDS,
            )
        except HandshakeRejected as rejection:
            outcome = "rejected"
            logger.info("handshake rejected for %s on %s: %s", user_id, target_id, rejection)
            await client.write(error_frame(str(rejection)))
            await websocket.close(code=1008)
            return
        except (TimeoutError, asyncio.IncompleteReadError) as failure:
            # Say something, or the driver reports only a closed socket.
            outcome = "handshake_failed"
            logger.warning(
                "handshake failed for %s on %s: %s",
                user_id,
                target_id,
                type(failure).__name__,
            )
            await client.write(error_frame(GENERIC_LOGIN_FAILURE))
            await websocket.close(code=1011)
            return

        outcome = result.value
        if result is Outcome.SESSION:
            sent, received = await _relay_bytes(client, reader, writer)
        await websocket.close(code=1000)
    except (ConnectionError, RuntimeError, OSError):
        # The peer is already gone. Details stay out of client-visible errors.
        pass
    finally:
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass
        # Audit record. It holds no SQL and no credentials.
        logger.info(
            "relay closed user=%s target=%s outcome=%s seconds=%.1f sent=%d received=%d",
            user_id,
            target_id,
            outcome,
            time.monotonic() - started,
            sent,
            received,
        )
