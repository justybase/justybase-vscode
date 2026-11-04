"""The integration keeps the login screen and adds only the relay routes."""

from __future__ import annotations

import time

import jwt
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from demo_service.app import JWT_ALGORITHM, JWT_AUDIENCE, create_app
from justybase_relay.settings import TARGETS_ENV

SECRET = "s" * 32
PROOF = "p" * 32


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("DEMO_JWT_SECRET", SECRET)
    monkeypatch.setenv("DEMO_USERNAME", "analyst")
    monkeypatch.setenv("DEMO_PASSWORD", "good")
    monkeypatch.setenv(TARGETS_ENV, "{}")
    return TestClient(create_app())


def login(client: TestClient) -> str:
    response = client.post(
        "/api/justybase/auth/token", json={"username": "analyst", "password": "good"}
    )
    assert response.status_code == 200
    return response.json()["access_token"]


def test_existing_login_screen_and_endpoint_still_work(client: TestClient):
    assert "Demo service login" in client.get("/").text

    response = client.post(
        "/auth/login", data={"username": "analyst", "password": "good"}
    )

    assert response.status_code == 200
    me = client.get(
        "/api/me",
        headers={"authorization": f"Bearer {response.json()['access_token']}"},
    )
    assert me.json() == {"username": "analyst"}


def test_relay_token_is_a_normal_service_token(client: TestClient):
    me = client.get("/api/me", headers={"authorization": f"Bearer {login(client)}"})

    assert me.status_code == 200


def test_wrong_password_is_refused_by_the_relay_login(client: TestClient):
    response = client.post(
        "/api/justybase/auth/token", json={"username": "analyst", "password": "bad"}
    )

    assert response.status_code == 401


def test_expired_jwt_cannot_open_a_tunnel(client: TestClient):
    now = int(time.time())
    expired = jwt.encode(
        {"sub": "analyst", "aud": JWT_AUDIENCE, "iat": now - 120, "exp": now - 60},
        SECRET,
        algorithm=JWT_ALGORITHM,
    )

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            "/api/justybase/tunnel/netezza",
            headers={
                "authorization": f"Bearer {expired}",
                "x-justybase-client-proof": PROOF,
            },
        ):
            pytest.fail("the connection should have been refused")
