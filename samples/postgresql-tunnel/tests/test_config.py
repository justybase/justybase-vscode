import json

import pytest


def test_target_configuration_rejects_invalid_port(monkeypatch):
    monkeypatch.setenv("POSTGRES_TUNNEL_TARGETS_JSON", json.dumps({"reports": {"host": "db", "port": 0}}))
    import importlib.util
    import sys
    from pathlib import Path

    module_path = Path(__file__).parents[1] / "server" / "main.py"
    spec = importlib.util.spec_from_file_location("tunnel_main_invalid", module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    with pytest.raises(RuntimeError, match="invalid port"):
        assert spec.loader is not None
        spec.loader.exec_module(module)
