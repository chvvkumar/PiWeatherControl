"""Configuration management for enclosure controller."""

import json
import os
import copy
from pathlib import Path

CONFIG_FILE = Path(__file__).parent / "config.json"

DEFAULT_CONFIG = {
    "fan": {
        "mode": "auto",
        "curve": [
            {"temp": 35, "on": True},
            {"temp": 45, "on": True},
        ],
        "hysteresis": 3,
        "sources": {"cpu": True, "ssd": True, "enclosure": True},
        "min_on_seconds": 120,
        "min_off_seconds": 120,
    },
    "heater": {
        "mode": "auto",
        "dew_margin": 5,
        "outside_temp_threshold": 2,
        "hysteresis": 2,
        "min_on_seconds": 120,
        "min_off_seconds": 120,
        "fan_off_when_heating": True,
    },
    "gpio": {
        "fan_pin": 20,
        "heater_pin": 21,
        "invert_relay": True,
    },
    "ha": {
        "url": "",
        "token": "",
        "temp_entity_id": "",
        "humidity_entity_id": "",
    },
    "i2c_bus": 1,
    "poll_interval": 10,
}


def _deep_merge(base: dict, override: dict) -> dict:
    """Merge override into base, preserving keys not in override."""
    result = copy.deepcopy(base)
    for k, v in override.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = copy.deepcopy(v)
    return result


def load_config() -> dict:
    """Load config from file, merging with defaults for any missing keys."""
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r") as f:
                user_config = json.load(f)
            return _deep_merge(DEFAULT_CONFIG, user_config)
        except (json.JSONDecodeError, IOError):
            pass
    return copy.deepcopy(DEFAULT_CONFIG)


def save_config(config: dict) -> None:
    """Persist config to disk."""
    with open(CONFIG_FILE, "w") as f:
        json.dump(config, f, indent=2)


def update_config(updates: dict) -> dict:
    """Merge partial updates into current config and save."""
    current = load_config()
    merged = _deep_merge(current, updates)
    save_config(merged)
    return merged
