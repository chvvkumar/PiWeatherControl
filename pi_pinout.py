"""Raspberry Pi model detection and 40-pin header capability tables.

Model detection reads /proc/device-tree/model first and falls back to
/proc/cpuinfo Model line. On non-Linux hosts (dev machines) defaults
to the Pi 5 layout so the UI can still render.

Pin capability tables follow the 40-pin header convention used by
pinout.xyz: physical pin numbers 1..40, two columns (odd=left, even=right).
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Optional

_DEVICE_TREE_MODEL = "/proc/device-tree/model"
_CPUINFO = "/proc/cpuinfo"


def _read_model_string() -> Optional[str]:
    """Return the raw model string from device-tree or /proc/cpuinfo, or None."""
    try:
        with open(_DEVICE_TREE_MODEL, "rb") as f:
            raw = f.read()
        # device-tree strings are NUL-terminated.
        return raw.rstrip(b"\x00").decode("utf-8", errors="replace").strip()
    except OSError:
        pass
    try:
        with open(_CPUINFO, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if line.startswith("Model"):
                    _, _, value = line.partition(":")
                    return value.strip()
    except OSError:
        pass
    return None


def _family_from_name(name: str) -> str:
    """Classify a raw model string into a family key."""
    lowered = name.lower()
    if "zero 2" in lowered:
        return "pi_zero2"
    if "pi 5" in lowered or "raspberry pi 5" in lowered:
        return "pi5"
    if "pi 4" in lowered or "raspberry pi 4" in lowered:
        return "pi4"
    if "pi 3" in lowered or "raspberry pi 3" in lowered:
        return "pi3"
    return "unknown"


def detect_model() -> tuple[str, str]:
    """Return (family_key, human_name). Defaults to pi5 / 'Mock (dev)' off-Pi."""
    name = _read_model_string()
    if name is None:
        return "pi5", "Mock (dev)"
    return _family_from_name(name), name
