"""Netezza handshake with credentials injected by the relay.

The JustyBase driver runs its normal Netezza handshake against this code. The
relay forwards that handshake with three changes:

* the user frame is replaced with the service account,
* TLS towards the database is negotiated here, because WSS protects the client,
* authentication is split in two. The client proves only that it owns this
  tunnel, and the relay answers the database password challenge itself.

After that the connection is a raw byte stream, so the driver's streaming,
notices, cancellation and external tables are not parsed or changed.

Framing, as implemented by @justybase/netezza-driver and IBM nzpy: a client
frame is an int32 length that includes itself, an int16 opcode and a payload.
The database answers most handshake frames with a single byte.
"""

from __future__ import annotations

import asyncio
import base64
import enum
import hashlib
import hmac
import logging
import ssl
import struct
from typing import Protocol

from .settings import NetezzaTarget

logger = logging.getLogger("justybase.relay")

HSV2_CLIENT_BEGIN = 1
HSV2_DB = 2
HSV2_USER = 3
HSV2_OPTIONS = 4
HSV2_REMOTE_PID = 6
HSV2_CLIENT_TYPE = 8
HSV2_PROTOCOL = 9
HSV2_SSL_NEGOTIATE = 11
HSV2_SSL_CONNECT = 12
HSV2_APPNAME = 13
HSV2_CLIENT_OS = 14
HSV2_CLIENT_HOST_NAME = 15
HSV2_CLIENT_OS_USER = 16
HSV2_64BIT_VARLENA_ENABLED = 17
HSV2_CLIENT_DONE = 1000

CANCEL_REQUEST_CODE = 80877102

FORWARDED_OPCODES = frozenset(
    {
        HSV2_CLIENT_BEGIN,
        HSV2_DB,
        HSV2_USER,
        HSV2_OPTIONS,
        HSV2_REMOTE_PID,
        HSV2_CLIENT_TYPE,
        HSV2_PROTOCOL,
        HSV2_APPNAME,
        HSV2_CLIENT_OS,
        HSV2_CLIENT_HOST_NAME,
        HSV2_CLIENT_OS_USER,
        HSV2_64BIT_VARLENA_ENABLED,
        HSV2_CLIENT_DONE,
    }
)

SECURITY_LEVELS = {"off": 1, "prefer": 2, "require": 3}

AUTH_OK = 0
AUTH_PLAIN = 3
AUTH_MD5 = 5
AUTH_SHA256 = 6

MAX_HANDSHAKE_FRAME_BYTES = 64 * 1024
MAX_LOGGED_ERROR_BYTES = 2048
ERROR_DRAIN_TIMEOUT_SECONDS = 5

GENERIC_LOGIN_FAILURE = (
    "The relay could not log in to the database. "
    "Ask the service administrator to check the relay logs."
)


class HandshakeRejected(Exception):
    """The relay refused the client. The message is safe to show to the client."""


class ClientStream(Protocol):
    async def read_exactly(self, count: int) -> bytes: ...

    async def write(self, data: bytes) -> None: ...


class Outcome(enum.Enum):
    # The handshake succeeded. The caller relays raw bytes in both directions.
    SESSION = "session"
    # A cancel request was delivered. Nothing else is relayed.
    CANCEL = "cancel"
    # The database refused before the login, and its error went to the client.
    DATABASE_ERROR = "database_error"


def error_frame(message: str) -> bytes:
    """Build the NUL-terminated text error the driver accepts during a handshake."""
    return b"E" + message.encode("utf-8") + b"\0"


def build_user_frame(user: str) -> bytes:
    payload = struct.pack(">h", HSV2_USER) + user.encode("utf-8") + b"\0"
    return struct.pack(">i", len(payload) + 4) + payload


def build_password_frame(secret: bytes) -> bytes:
    return struct.pack(">i", len(secret) + 5) + secret + b"\0"


def hash_password(algorithm: str, salt: bytes, password: bytes) -> bytes:
    digest = hashlib.new(algorithm, salt + password).digest()
    return base64.b64encode(digest).rstrip(b"=")


async def _read_frame(client: ClientStream) -> tuple[bytes, bytes]:
    """Return one client frame as (length prefix, body)."""
    prefix = await client.read_exactly(4)
    length = struct.unpack(">i", prefix)[0]
    if length < 6 or length > MAX_HANDSHAKE_FRAME_BYTES:
        raise HandshakeRejected("Invalid handshake frame.")
    return prefix, await client.read_exactly(length - 4)


def _decode_name(payload: bytes) -> str:
    return payload.rstrip(b"\0").decode("utf-8", errors="replace")


async def _reply_with_database_error(
    client: ClientStream, reader: asyncio.StreamReader, first_byte: bytes
) -> None:
    """Forward a pre-login database error, one way only.

    Client input is ignored from here on. The client has not proved anything
    yet, so it must not be able to keep talking to the database.
    """
    await client.write(first_byte)
    try:
        async with asyncio.timeout(ERROR_DRAIN_TIMEOUT_SECONDS):
            while chunk := await reader.read(4096):
                await client.write(chunk)
    except TimeoutError:
        return


async def _log_login_failure(reader: asyncio.StreamReader, stage: str) -> None:
    """Keep a database login error in the relay log, not on the client."""
    try:
        async with asyncio.timeout(ERROR_DRAIN_TIMEOUT_SECONDS):
            detail = await reader.read(MAX_LOGGED_ERROR_BYTES)
    except TimeoutError:
        detail = b""
    logger.warning(
        "database login failed at %s: %s",
        stage,
        detail.decode("utf-8", errors="replace"),
    )


def build_database_tls_context(target: NetezzaTarget) -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=target.ca_file)
    if not target.tls_verify:
        # Encrypts against passive listening only. Anyone able to intercept the
        # relay's traffic can pose as the database and receive the login exchange.
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return context


async def _secure_database_session(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    target: NetezzaTarget,
) -> None:
    payload = struct.pack(">hi", HSV2_SSL_NEGOTIATE, SECURITY_LEVELS[target.tls])
    writer.write(struct.pack(">i", len(payload) + 4) + payload)
    await writer.drain()

    response = await reader.readexactly(1)
    if response == b"N":
        if target.tls == "require":
            raise HandshakeRejected(GENERIC_LOGIN_FAILURE)
        return
    if response != b"S":
        await _log_login_failure(reader, "TLS negotiation")
        raise HandshakeRejected(GENERIC_LOGIN_FAILURE)

    connect = struct.pack(">h", HSV2_SSL_CONNECT)
    writer.write(struct.pack(">i", len(connect) + 4) + connect)
    await writer.drain()

    # A certificate failure must end the login. There is no retry without TLS,
    # because that would expose the database login to the network.
    try:
        context = build_database_tls_context(target)
        await writer.start_tls(context, server_hostname=target.host)
    except OSError as exc:
        # ssl.SSLError is an OSError, and so is an unreadable ca_file.
        hint = (
            " If the database has no usable certificate, set the target's "
            '"tls" to "off", or "tls_verify" to false.'
            if isinstance(exc, ssl.SSLCertVerificationError)
            else ""
        )
        logger.warning("TLS to the database failed: %s.%s", exc, hint)
        raise HandshakeRejected(GENERIC_LOGIN_FAILURE) from exc

    confirmation = await reader.readexactly(1)
    if confirmation != b"N":
        await _log_login_failure(reader, "TLS confirmation")
        raise HandshakeRejected(GENERIC_LOGIN_FAILURE)


async def _verify_client_proof(client: ClientStream, client_proof: str) -> None:
    """Make the driver show the per-tunnel nonce it got from the extension.

    Without this check any local process could reach the loopback listener and
    receive a logged-in session on the service account.
    """
    await client.write(b"R" + struct.pack(">i", AUTH_PLAIN))
    prefix = await client.read_exactly(4)
    length = struct.unpack(">i", prefix)[0]
    if length < 5 or length > MAX_HANDSHAKE_FRAME_BYTES:
        raise HandshakeRejected("Invalid client proof.")
    supplied = (await client.read_exactly(length - 4)).rstrip(b"\0")
    if not hmac.compare_digest(supplied, client_proof.encode("utf-8")):
        raise HandshakeRejected("Invalid client proof.")


async def _answer_database_login(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    target: NetezzaTarget,
) -> None:
    response = await reader.readexactly(1)
    if response != b"R":
        await _log_login_failure(reader, "authentication request")
        raise HandshakeRejected(GENERIC_LOGIN_FAILURE)

    request = struct.unpack(">i", await reader.readexactly(4))[0]
    if request == AUTH_OK:
        return

    password = target.password.encode("utf-8")
    if request == AUTH_PLAIN:
        secret = password
    elif request == AUTH_MD5:
        secret = hash_password("md5", await reader.readexactly(2), password)
    elif request == AUTH_SHA256:
        secret = hash_password("sha256", await reader.readexactly(2), password)
    else:
        logger.warning("unsupported database authentication request: %s", request)
        raise HandshakeRejected(GENERIC_LOGIN_FAILURE)

    writer.write(build_password_frame(secret))
    await writer.drain()

    response = await reader.readexactly(1)
    if response != b"R":
        await _log_login_failure(reader, "password check")
        raise HandshakeRejected(GENERIC_LOGIN_FAILURE)
    request = struct.unpack(">i", await reader.readexactly(4))[0]
    if request != AUTH_OK:
        logger.warning("unexpected database authentication result: %s", request)
        raise HandshakeRejected(GENERIC_LOGIN_FAILURE)


async def _deliver_cancel(
    prefix: bytes,
    body: bytes,
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    writer.write(prefix + body)
    await writer.drain()
    try:
        async with asyncio.timeout(ERROR_DRAIN_TIMEOUT_SECONDS):
            await reader.read(1)
    except TimeoutError:
        return


async def negotiate(
    client: ClientStream,
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    target: NetezzaTarget,
    client_proof: str,
) -> Outcome:
    """Run the handshake. `reader`/`writer` are an open database connection.

    Raises HandshakeRejected, whose message may be sent to the client.
    """
    prefix, body = await _read_frame(client)
    if (
        len(body) == 12
        and struct.unpack(">i", body[:4])[0] == CANCEL_REQUEST_CODE
    ):
        # The backend PID and secret key inside are validated by the database.
        await _deliver_cancel(prefix, body, reader, writer)
        return Outcome.CANCEL

    secured = False
    user_sent = False
    database_sent = False

    while True:
        opcode = struct.unpack(">h", body[:2])[0]
        payload = body[2:]

        if opcode == HSV2_SSL_NEGOTIATE:
            if secured:
                raise HandshakeRejected("Unexpected handshake frame.")
            await _secure_database_session(reader, writer, target)
            secured = True
            await client.write(b"N")
            prefix, body = await _read_frame(client)
            continue

        if opcode not in FORWARDED_OPCODES:
            raise HandshakeRejected("Unexpected handshake frame.")

        outgoing = prefix + body
        if opcode == HSV2_DB:
            database = _decode_name(payload)
            if database_sent or not target.allows_database(database):
                raise HandshakeRejected(
                    f"Database '{database}' is not available through this relay target."
                )
            database_sent = True
        elif opcode == HSV2_USER:
            # TLS comes first, so the service identity is never sent in the
            # clear when the target requires a secure session.
            if user_sent or not secured:
                raise HandshakeRejected("Unexpected handshake frame.")
            outgoing = build_user_frame(target.user)
            user_sent = True

        writer.write(outgoing)
        await writer.drain()

        if opcode == HSV2_CLIENT_DONE:
            if not user_sent or not database_sent:
                raise HandshakeRejected("Incomplete handshake.")
            break

        response = await reader.readexactly(1)
        if response == b"N":
            await client.write(b"N")
        elif response == b"M" and opcode == HSV2_CLIENT_BEGIN:
            # The server asks for an older handshake version. The client retries.
            await client.write(response + await reader.readexactly(1))
        elif user_sent:
            # Errors after the rewrite could name the service account.
            await _log_login_failure(reader, "handshake")
            raise HandshakeRejected(GENERIC_LOGIN_FAILURE)
        else:
            await _reply_with_database_error(client, reader, response)
            return Outcome.DATABASE_ERROR

        prefix, body = await _read_frame(client)

    await _verify_client_proof(client, client_proof)
    await _answer_database_login(reader, writer, target)
    await client.write(b"R" + struct.pack(">i", AUTH_OK))
    return Outcome.SESSION
