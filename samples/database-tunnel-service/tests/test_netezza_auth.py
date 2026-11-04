"""Handshake tests against a scripted Netezza server on a real TCP socket."""

from __future__ import annotations

import asyncio
import struct
from collections import deque
from dataclasses import dataclass, field

import pytest

from justybase_relay.netezza_auth import (
    AUTH_MD5,
    AUTH_OK,
    AUTH_PLAIN,
    AUTH_SHA256,
    CANCEL_REQUEST_CODE,
    GENERIC_LOGIN_FAILURE,
    HSV2_CLIENT_BEGIN,
    HSV2_CLIENT_DONE,
    HSV2_CLIENT_TYPE,
    HSV2_DB,
    HSV2_SSL_CONNECT,
    HSV2_SSL_NEGOTIATE,
    HSV2_USER,
    HandshakeRejected,
    Outcome,
    build_password_frame,
    hash_password,
    negotiate,
)
from justybase_relay.settings import NetezzaTarget

PROOF = "p" * 32
SALT = b"\x01\x02"
PASSWORD = "service-password"


def frame(opcode: int, payload: bytes = b"") -> bytes:
    body = struct.pack(">h", opcode) + payload
    return struct.pack(">i", len(body) + 4) + body


def text(value: str) -> bytes:
    return value.encode("utf-8") + b"\0"


def cstring_frame(opcode: int, value: str) -> bytes:
    return frame(opcode, text(value))


def driver_frames(
    user: str = "service-login",
    database: str = "DEV",
    proof: str = PROOF,
) -> list[bytes]:
    """The frames the JustyBase driver sends, in order."""
    return [
        frame(HSV2_CLIENT_BEGIN, struct.pack(">h", 6)),
        cstring_frame(HSV2_DB, database),
        frame(HSV2_SSL_NEGOTIATE, struct.pack(">i", 0)),
        cstring_frame(HSV2_USER, user),
        frame(HSV2_CLIENT_TYPE, struct.pack(">h", 11)),
        frame(HSV2_CLIENT_DONE),
        build_password_frame(proof.encode("utf-8")),
    ]


class MemoryClient:
    def __init__(self, data: bytes) -> None:
        self._data = bytearray(data)
        self.written = bytearray()

    async def read_exactly(self, count: int) -> bytes:
        if len(self._data) < count:
            raise ConnectionError("client disconnected")
        chunk = bytes(self._data[:count])
        del self._data[:count]
        return chunk

    async def write(self, data: bytes) -> None:
        self.written.extend(data)


@dataclass
class FakeNetezza:
    """Answers the handshake and records what the relay sent to the database."""

    auth_request: int = AUTH_MD5
    ssl_response: bytes = b"N"
    responses: deque[bytes] = field(default_factory=deque)
    password_response: bytes = b"R" + struct.pack(">i", AUTH_OK)
    frames: list[tuple[int, bytes]] = field(default_factory=list)
    password_frame: bytes | None = None
    raw_cancel: bytes | None = None
    security_level: int | None = None

    async def handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            await self._serve(reader, writer)
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()

    async def _serve(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        while True:
            length = struct.unpack(">i", await reader.readexactly(4))[0]
            body = await reader.readexactly(length - 4)
            if length == 16 and struct.unpack(">i", body[:4])[0] == CANCEL_REQUEST_CODE:
                self.raw_cancel = body
                return

            opcode = struct.unpack(">h", body[:2])[0]
            self.frames.append((opcode, body[2:]))

            if opcode == HSV2_SSL_NEGOTIATE:
                self.security_level = struct.unpack(">i", body[2:6])[0]
                writer.write(self.ssl_response)
            elif opcode == HSV2_CLIENT_DONE:
                await self._authenticate(reader, writer)
                return
            elif self.responses:
                writer.write(self.responses.popleft())
            else:
                writer.write(b"N")
            await writer.drain()

    async def _authenticate(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        writer.write(b"R" + struct.pack(">i", self.auth_request))
        if self.auth_request in (AUTH_MD5, AUTH_SHA256):
            writer.write(SALT)
        await writer.drain()
        if self.auth_request != AUTH_OK:
            prefix = await reader.readexactly(4)
            length = struct.unpack(">i", prefix)[0]
            self.password_frame = prefix + await reader.readexactly(length - 4)
            writer.write(self.password_response)
            await writer.drain()

    def frame_payload(self, opcode: int) -> bytes:
        return next(payload for code, payload in self.frames if code == opcode)


def make_target(**overrides: object) -> NetezzaTarget:
    values: dict[str, object] = {
        "host": "127.0.0.1",
        "port": 5480,
        "user": "NZ_SERVICE",
        "password": PASSWORD,
        "tls": "prefer",
    }
    values.update(overrides)
    return NetezzaTarget(**values)  # type: ignore[arg-type]


async def run_negotiate(
    database: FakeNetezza, client: MemoryClient, target: NetezzaTarget
) -> Outcome:
    server = await asyncio.start_server(database.handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    try:
        return await negotiate(client, reader, writer, target, PROOF)
    finally:
        writer.close()
        server.close()
        await asyncio.sleep(0)


def negotiate_sync(
    database: FakeNetezza, client_data: bytes, target: NetezzaTarget | None = None
) -> tuple[Outcome, MemoryClient]:
    client = MemoryClient(client_data)
    outcome = asyncio.run(run_negotiate(database, client, target or make_target()))
    return outcome, client


@pytest.mark.parametrize(
    ("auth_request", "expected_secret"),
    [
        (AUTH_PLAIN, PASSWORD.encode("utf-8")),
        (AUTH_MD5, hash_password("md5", SALT, PASSWORD.encode("utf-8"))),
        (AUTH_SHA256, hash_password("sha256", SALT, PASSWORD.encode("utf-8"))),
    ],
)
def test_relay_answers_the_database_login_itself(
    auth_request: int, expected_secret: bytes
):
    database = FakeNetezza(auth_request=auth_request)

    outcome, client = negotiate_sync(database, b"".join(driver_frames()))

    assert outcome is Outcome.SESSION
    assert database.password_frame == build_password_frame(expected_secret)
    # N for BEGIN, DB, SSL, USER, CLIENT_TYPE. Then the proof request and login OK.
    assert bytes(client.written) == (
        b"NNNNN"
        + b"R"
        + struct.pack(">i", AUTH_PLAIN)
        + b"R"
        + struct.pack(">i", AUTH_OK)
    )


def test_hash_matches_the_driver_algorithm():
    # Expected values come from Node crypto, using the driver's formula:
    # base64(hash(salt + password)) without padding.
    assert hash_password("md5", b"ab", b"secret") == b"C+kIloI2OxLkmu+7k1ZFDQ"
    assert (
        hash_password("sha256", b"ab", b"secret")
        == b"Xi9QkSaVzTdXwPSd7THFFWj3kMBOyCreGN+ZmkBGS/M"
    )


def test_user_frame_is_replaced_and_client_login_never_reaches_the_database():
    database = FakeNetezza()

    negotiate_sync(database, b"".join(driver_frames(user="service-login")))

    assert database.frame_payload(HSV2_USER) == text("NZ_SERVICE")
    assert all(b"service-login" not in payload for _, payload in database.frames)


def test_client_frames_are_forwarded_unchanged():
    database = FakeNetezza()

    negotiate_sync(database, b"".join(driver_frames()))

    assert database.frame_payload(HSV2_DB) == text("DEV")
    assert database.frame_payload(HSV2_CLIENT_TYPE) == struct.pack(">h", 11)


@pytest.mark.parametrize(
    ("mode", "level"), [("off", 1), ("prefer", 2), ("require", 3)]
)
def test_security_level_comes_from_the_target_not_the_client(mode: str, level: int):
    database = FakeNetezza(ssl_response=b"N")
    data = b"".join(driver_frames())

    if mode == "require":
        with pytest.raises(HandshakeRejected):
            negotiate_sync(database, data, make_target(tls=mode))
    else:
        negotiate_sync(database, data, make_target(tls=mode))

    assert database.security_level == level


def test_required_tls_refused_by_the_server_stops_before_the_user_is_sent():
    database = FakeNetezza(ssl_response=b"N")

    with pytest.raises(HandshakeRejected):
        negotiate_sync(
            database, b"".join(driver_frames()), make_target(tls="require")
        )

    assert all(code != HSV2_USER for code, _ in database.frames)


def test_tls_failure_gives_a_clear_refusal_and_sends_no_user():
    # The server offers TLS and then speaks something else, as a TLS failure would.
    database = FakeNetezza(
        ssl_response=b"S",
        responses=deque([b"N", b"N", b"this is not a TLS record at all......"]),
    )

    with pytest.raises(HandshakeRejected) as rejection:
        negotiate_sync(database, b"".join(driver_frames()))

    assert str(rejection.value) == GENERIC_LOGIN_FAILURE
    assert all(code != HSV2_USER for code, _ in database.frames)


def test_unreadable_ca_file_gives_a_clear_refusal():
    database = FakeNetezza(
        ssl_response=b"S",
        responses=deque([b"N", b"N", b"N"]),
    )

    with pytest.raises(HandshakeRejected) as rejection:
        negotiate_sync(
            database,
            b"".join(driver_frames()),
            make_target(ca_file="/no/such/ca-file.pem"),
        )

    assert str(rejection.value) == GENERIC_LOGIN_FAILURE


def test_no_tls_mode_never_starts_tls():
    database = FakeNetezza(ssl_response=b"N")

    outcome, _ = negotiate_sync(
        database, b"".join(driver_frames()), make_target(tls="off")
    )

    assert outcome is Outcome.SESSION
    assert all(code != HSV2_SSL_CONNECT for code, _ in database.frames)


def test_version_downgrade_is_forwarded_to_the_client():
    database = FakeNetezza(responses=deque([b"M4"]))
    frames = driver_frames()
    data = frames[0] + frame(HSV2_CLIENT_BEGIN, struct.pack(">h", 4)) + b"".join(frames[1:])

    outcome, client = negotiate_sync(database, data)

    assert outcome is Outcome.SESSION
    assert bytes(client.written).startswith(b"M4N")


def test_wrong_client_proof_is_refused_before_the_database_password_is_sent():
    database = FakeNetezza()

    with pytest.raises(HandshakeRejected, match="client proof"):
        negotiate_sync(database, b"".join(driver_frames(proof="x" * 32)))

    assert database.password_frame is None


def test_database_outside_the_allowlist_is_refused():
    database = FakeNetezza()
    target = make_target(allowed_databases=frozenset({"DEV"}))

    with pytest.raises(HandshakeRejected, match="not available"):
        negotiate_sync(database, b"".join(driver_frames(database="PROD")), target)

    assert all(code != HSV2_DB for code, _ in database.frames)


def test_database_allowlist_ignores_case():
    database = FakeNetezza()
    target = make_target(allowed_databases=frozenset({"DEV"}))

    outcome, _ = negotiate_sync(
        database, b"".join(driver_frames(database="dev")), target
    )

    assert outcome is Outcome.SESSION


def test_cancel_request_is_forwarded_raw():
    database = FakeNetezza()
    body = struct.pack(">iii", CANCEL_REQUEST_CODE, 1234, 5678)

    outcome, client = negotiate_sync(database, struct.pack(">i", 16) + body)

    assert outcome is Outcome.CANCEL
    assert database.raw_cancel == body
    assert bytes(client.written) == b""


def test_error_before_the_login_is_forwarded_and_ends_the_conversation():
    message = b"E" + text("database does not exist")
    database = FakeNetezza(responses=deque([b"N", message]))
    # Frames after the error must be ignored, even though they were sent.
    data = b"".join(driver_frames())

    outcome, client = negotiate_sync(database, data)

    assert outcome is Outcome.DATABASE_ERROR
    assert bytes(client.written).endswith(message)
    assert all(code != HSV2_USER for code, _ in database.frames)


def test_failed_database_login_hides_the_error_from_the_client():
    database = FakeNetezza(
        auth_request=AUTH_MD5,
        password_response=b"E" + text("Password authentication failed for NZ_SERVICE"),
    )

    with pytest.raises(HandshakeRejected) as rejection:
        negotiate_sync(database, b"".join(driver_frames()))

    assert str(rejection.value) == GENERIC_LOGIN_FAILURE
    assert "NZ_SERVICE" not in str(rejection.value)


@pytest.mark.parametrize("opcode", [HSV2_SSL_CONNECT, 99])
def test_unknown_frames_are_refused(opcode: int):
    with pytest.raises(HandshakeRejected, match="Unexpected"):
        negotiate_sync(FakeNetezza(), frame(opcode))


def test_user_frame_without_tls_negotiation_is_refused():
    frames = driver_frames()
    data = frames[0] + frames[1] + frames[3]

    with pytest.raises(HandshakeRejected, match="Unexpected"):
        negotiate_sync(FakeNetezza(), data)


def test_done_without_user_is_refused():
    frames = driver_frames()
    data = frames[0] + frames[1] + frames[2] + frames[5]

    with pytest.raises(HandshakeRejected, match="Incomplete"):
        negotiate_sync(FakeNetezza(), data)


def test_oversized_frame_is_refused():
    with pytest.raises(HandshakeRejected, match="Invalid"):
        negotiate_sync(FakeNetezza(), struct.pack(">i", 10_000_000))
