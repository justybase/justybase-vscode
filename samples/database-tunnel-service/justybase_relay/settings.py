"""Relay targets, resolved on the server only.

The client selects a target by name. It never supplies a host, a port or
database credentials. The JSON configuration names the environment variables
that hold the credentials, so secrets do not sit in the target definition.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Literal, Mapping

TlsMode = Literal["off", "prefer", "require"]

TARGETS_ENV = "JUSTYBASE_RELAY_TARGETS_JSON"


@dataclass(frozen=True)
class NetezzaTarget:
    host: str
    port: int
    user: str
    password: str = field(repr=False)
    # None allows every database the service account can reach.
    allowed_databases: frozenset[str] | None = None
    tls: TlsMode = "prefer"
    ca_file: str | None = None
    # False encrypts without checking who answers. See README: this is unsafe.
    tls_verify: bool = True

    def allows_database(self, database: str) -> bool:
        if self.allowed_databases is None:
            return True
        return database.upper() in self.allowed_databases


def _parse_target(
    target_id: str, value: Any, environ: Mapping[str, str]
) -> NetezzaTarget:
    if not isinstance(value, dict):
        raise RuntimeError(f"Relay target '{target_id}' must be an object")

    host = value.get("host")
    if not isinstance(host, str) or not host.strip():
        raise RuntimeError(f"Relay target '{target_id}' must have a host")

    port = value.get("port", 5480)
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise RuntimeError(f"Relay target '{target_id}' has an invalid port")

    credentials: dict[str, str] = {}
    for key in ("user_env", "password_env"):
        variable = value.get(key)
        if not isinstance(variable, str) or not variable.strip():
            raise RuntimeError(f"Relay target '{target_id}' must set {key}")
        resolved = environ.get(variable)
        if not resolved:
            # The message names the variable and never prints a value.
            raise RuntimeError(
                f"Relay target '{target_id}': environment variable {variable} is not set"
            )
        credentials[key] = resolved

    tls = value.get("tls", "prefer")
    if tls not in ("off", "prefer", "require"):
        raise RuntimeError(f"Relay target '{target_id}' has an invalid tls mode")

    allowed = value.get("allowed_databases")
    if allowed is not None and (
        not isinstance(allowed, list)
        or not allowed
        or not all(isinstance(item, str) and item.strip() for item in allowed)
    ):
        raise RuntimeError(
            f"Relay target '{target_id}': allowed_databases must be a non-empty list"
        )

    ca_file = value.get("ca_file")
    if ca_file is not None and (not isinstance(ca_file, str) or not ca_file.strip()):
        raise RuntimeError(f"Relay target '{target_id}': ca_file must be a path")

    tls_verify = value.get("tls_verify", True)
    if not isinstance(tls_verify, bool):
        raise RuntimeError(f"Relay target '{target_id}': tls_verify must be true or false")
    if not tls_verify and tls == "off":
        raise RuntimeError(
            f"Relay target '{target_id}': tls_verify has no effect when tls is off"
        )
    if not tls_verify and ca_file is not None:
        # The file would look like protection while nothing checks against it.
        raise RuntimeError(
            f"Relay target '{target_id}': ca_file cannot be used when tls_verify is false"
        )

    return NetezzaTarget(
        host=host.strip(),
        port=port,
        user=credentials["user_env"],
        password=credentials["password_env"],
        allowed_databases=(
            None if allowed is None else frozenset(item.upper() for item in allowed)
        ),
        tls=tls,
        ca_file=ca_file,
        tls_verify=tls_verify,
    )


def load_targets(environ: Mapping[str, str] | None = None) -> dict[str, NetezzaTarget]:
    source = os.environ if environ is None else environ
    try:
        parsed: Any = json.loads(source.get(TARGETS_ENV, "{}"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{TARGETS_ENV} must contain valid JSON") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(f"{TARGETS_ENV} must be a JSON object")
    return {
        target_id: _parse_target(target_id, value, source)
        for target_id, value in parsed.items()
    }
