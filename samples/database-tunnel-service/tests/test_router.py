"""Router tests: login, tunnel authorization and target configuration."""

from __future__ import annotations

import json
import logging
import ssl

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from justybase_relay import NetezzaTarget, create_justybase_router, load_targets
from justybase_relay.netezza_auth import build_database_tls_context
from justybase_relay.settings import TARGETS_ENV

PROOF = "p" * 32
TARGET = NetezzaTarget(host="127.0.0.1", port=1, user="svc", password="secret")


def build_client(authorize=lambda user, target_id: True, **options) -> TestClient:
    def authenticate(username: str, password: str):
        return username if (username, password) == ("analyst", "good") else None

    def issue_token(user: str) -> tuple[str, int]:
        return f"token-{user}", 900

    def verify_token(token: str):
        if token == "raises":
            raise ValueError("bad signature")
        return token.removeprefix("token-") if token.startswith("token-") else None

    app = FastAPI()
    app.include_router(
        create_justybase_router(
            authenticate=authenticate,
            issue_token=issue_token,
            verify_token=verify_token,
            authorize=authorize,
            targets={"netezza": TARGET},
            **options,
        ),
        prefix="/api/justybase",
    )
    return TestClient(app)


def assert_refused(client: TestClient, path: str, headers: dict[str, str]) -> None:
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(path, headers=headers):
            pytest.fail("the connection should have been refused")


def test_login_returns_a_token():
    response = build_client().post(
        "/api/justybase/auth/token", json={"username": "analyst", "password": "good"}
    )

    assert response.status_code == 200
    assert response.json() == {
        "access_token": "token-analyst",
        "token_type": "bearer",
        "expires_in": 900,
    }


def test_bad_login_gets_401_without_saying_which_part_was_wrong():
    response = build_client().post(
        "/api/justybase/auth/token", json={"username": "analyst", "password": "bad"}
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid login or password."}


@pytest.mark.parametrize(
    "headers",
    [
        {"x-justybase-client-proof": PROOF},
        {"authorization": "Bearer token-analyst"},
        {"authorization": "Bearer token-analyst", "x-justybase-client-proof": "short"},
        {"authorization": "Bearer wrong", "x-justybase-client-proof": PROOF},
        {"authorization": "Bearer raises", "x-justybase-client-proof": PROOF},
        {"authorization": "Basic token-analyst", "x-justybase-client-proof": PROOF},
    ],
)
def test_tunnel_refuses_missing_or_bad_credentials(headers: dict[str, str]):
    assert_refused(build_client(), "/api/justybase/tunnel/netezza", headers)


def test_tunnel_ignores_a_token_in_the_query_string():
    assert_refused(
        build_client(),
        "/api/justybase/tunnel/netezza?access_token=token-analyst",
        {"x-justybase-client-proof": PROOF},
    )


def test_tunnel_refuses_an_unknown_target():
    assert_refused(
        build_client(),
        "/api/justybase/tunnel/other",
        {"authorization": "Bearer token-analyst", "x-justybase-client-proof": PROOF},
    )


def test_tunnel_refuses_when_authorize_says_no():
    assert_refused(
        build_client(authorize=lambda user, target_id: False),
        "/api/justybase/tunnel/netezza",
        {"authorization": "Bearer token-analyst", "x-justybase-client-proof": PROOF},
    )


def test_tunnel_refuses_above_the_connection_limit():
    assert_refused(
        build_client(max_connections_per_user=0),
        "/api/justybase/tunnel/netezza",
        {"authorization": "Bearer token-analyst", "x-justybase-client-proof": PROOF},
    )


def test_authorized_client_with_unreachable_target_gets_a_closed_socket():
    client = build_client()
    with client.websocket_connect(
        "/api/justybase/tunnel/netezza",
        headers={
            "authorization": "Bearer token-analyst",
            "x-justybase-client-proof": PROOF,
        },
    ) as websocket:
        with pytest.raises(WebSocketDisconnect) as closed:
            websocket.receive_bytes()
    assert closed.value.code == 1011


def test_target_password_is_not_in_its_repr():
    assert "secret" not in repr(TARGET)


def target_env(target: dict) -> dict[str, str]:
    return {
        TARGETS_ENV: json.dumps({"netezza": target}),
        "SVC_USER": "svc",
        "SVC_PASSWORD": "secret",
    }


def test_targets_read_credentials_from_named_variables():
    targets = load_targets(
        target_env(
            {
                "host": "db.internal",
                "user_env": "SVC_USER",
                "password_env": "SVC_PASSWORD",
                "allowed_databases": ["dev"],
                "tls": "require",
            }
        )
    )

    target = targets["netezza"]
    assert (target.user, target.password) == ("svc", "secret")
    assert target.port == 5480
    assert target.allows_database("DEV")
    assert not target.allows_database("PROD")


def test_certificate_check_is_on_unless_explicitly_disabled():
    env = target_env(
        {"host": "db", "user_env": "SVC_USER", "password_env": "SVC_PASSWORD"}
    )

    target = load_targets(env)["netezza"]

    assert target.tls_verify is True
    context = build_database_tls_context(target)
    assert context.verify_mode is ssl.CERT_REQUIRED
    assert context.check_hostname is True


def test_tls_verify_false_skips_only_the_certificate_check():
    env = target_env(
        {
            "host": "db",
            "user_env": "SVC_USER",
            "password_env": "SVC_PASSWORD",
            "tls": "require",
            "tls_verify": False,
        }
    )

    context = build_database_tls_context(load_targets(env)["netezza"])

    assert context.verify_mode is ssl.CERT_NONE
    assert context.check_hostname is False


def test_service_warns_about_a_target_without_a_certificate_check(
    caplog: pytest.LogCaptureFixture,
):
    unsafe = NetezzaTarget(
        host="db", port=1, user="svc", password="secret", tls_verify=False
    )

    with caplog.at_level(logging.WARNING, logger="justybase.relay"):
        create_justybase_router(
            authenticate=lambda username, password: None,
            issue_token=lambda user: ("token", 900),
            verify_token=lambda token: None,
            authorize=lambda user, target_id: False,
            targets={"unsafe": unsafe, "safe": TARGET},
        )

    warnings = [record.getMessage() for record in caplog.records]
    assert len(warnings) == 1
    assert "unsafe" in warnings[0] and "tls_verify=false" in warnings[0]
    assert "secret" not in warnings[0]


def test_service_warns_about_a_target_without_tls(caplog: pytest.LogCaptureFixture):
    plain = NetezzaTarget(host="db", port=1, user="svc", password="secret", tls="off")

    with caplog.at_level(logging.WARNING, logger="justybase.relay"):
        create_justybase_router(
            authenticate=lambda username, password: None,
            issue_token=lambda user: ("token", 900),
            verify_token=lambda token: None,
            authorize=lambda user, target_id: False,
            targets={"plain": plain},
        )

    assert ["plain" in record.getMessage() for record in caplog.records] == [True]


def test_tls_off_needs_no_certificate_settings():
    env = target_env(
        {
            "host": "db",
            "user_env": "SVC_USER",
            "password_env": "SVC_PASSWORD",
            "tls": "off",
        }
    )

    target = load_targets(env)["netezza"]

    assert target.tls == "off"
    assert target.ca_file is None


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"tls_verify": "false"}, "must be true or false"),
        ({"tls": "off", "tls_verify": False}, "no effect when tls is off"),
        ({"tls_verify": False, "ca_file": "/ca.pem"}, "ca_file cannot be used"),
        ({"host": ""}, "must have a host"),
        ({"port": 0}, "invalid port"),
        ({"tls": "maybe"}, "invalid tls"),
        ({"allowed_databases": []}, "allowed_databases"),
        ({"password_env": "MISSING_VARIABLE"}, "MISSING_VARIABLE is not set"),
    ],
)
def test_invalid_targets_stop_the_service(override: dict, message: str):
    target = {
        "host": "db.internal",
        "user_env": "SVC_USER",
        "password_env": "SVC_PASSWORD",
        **override,
    }

    with pytest.raises(RuntimeError, match=message):
        load_targets(target_env(target))
