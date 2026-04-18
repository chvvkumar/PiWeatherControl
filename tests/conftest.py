"""Shared test fixtures for PiWeatherControl."""
import copy
import json
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def tmp_config(tmp_path, monkeypatch):
    """Write a fresh default config.json to a temp path and point config.py at it."""
    import config as config_module

    test_config_file = tmp_path / "config.json"
    test_config_file.write_text(json.dumps(copy.deepcopy(config_module.DEFAULT_CONFIG), indent=2))
    monkeypatch.setattr(config_module, "CONFIG_FILE", test_config_file)
    return test_config_file


@pytest.fixture
def client(tmp_config, monkeypatch):
    """FastAPI TestClient with background control loop disabled."""
    # Import app late so monkeypatched CONFIG_FILE is picked up.
    import app as app_module

    # Replace the lifespan so tests do not spin up the asyncio control loop or real GPIO.
    @asynccontextmanager
    async def _noop_lifespan(app):
        yield

    app_module.app.router.lifespan_context = _noop_lifespan
    with TestClient(app_module.app) as c:
        yield c
