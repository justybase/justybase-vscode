import importlib.util
import json
import sys
from pathlib import Path

import pytest


MODULE_PATH = Path(__file__).parents[1] / "server" / "main.py"


def load_module(monkeypatch: pytest.MonkeyPatch, targets: object):
    monkeypatch.setenv("DATABASE_TUNNEL_TARGETS_JSON", json.dumps(targets))
    spec = importlib.util.spec_from_file_location("database_tunnel_main_test", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_target_configuration_rejects_invalid_port(monkeypatch: pytest.MonkeyPatch):
    with pytest.raises(RuntimeError, match="invalid port"):
        load_module(monkeypatch, {"reports": {"host": "db", "port": 0}})


def test_target_configuration_accepts_postgres_and_netezza(monkeypatch: pytest.MonkeyPatch):
    module = load_module(
        monkeypatch,
        {
            "reports": {"host": "postgres.internal", "port": 5432},
            "warehouse": {"host": "netezza.internal", "port": 5480},
        },
    )

    assert module.TARGETS["reports"].port == 5432
    assert module.TARGETS["warehouse"].port == 5480
