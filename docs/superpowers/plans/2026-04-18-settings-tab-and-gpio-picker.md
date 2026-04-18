# Settings Tab and Graphical GPIO Pin Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the PiWeatherControl UI into Dashboard and Settings tabs, consolidate every configurable setting into the Settings tab, and add a graphical Raspberry Pi 40-pin header GPIO picker that renders a layout matched to the runtime-detected Pi model.

**Architecture:** FastAPI backend gets a new `pi_pinout.py` module (model detection plus per-family pin capability tables), a `GET /api/pi-info` endpoint, and pin validation on `POST /api/config`. The vanilla-JS frontend gains a tab bar, a new `static/pinout.js` SVG pin header component, six grouped `<form>` cards inside a Settings panel, and per-section save handlers. GPIO pin changes continue to require a service restart; the UI surfaces a banner instructing the user.

**Tech Stack:** Python 3 (FastAPI + Pydantic + asyncio), pytest + httpx (new), vanilla JavaScript (no build step), SVG, custom CSS.

**Spec reference:** [docs/superpowers/specs/2026-04-18-settings-tab-and-gpio-picker-design.md](../specs/2026-04-18-settings-tab-and-gpio-picker-design.md)

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `pi_pinout.py` | Pi model detection (`detect_model`), per-family pin capability tables (`PIN_CAPABILITIES`), layout builder (`get_layout`) |
| `static/pinout.js` | Render the 40-pin SVG header, manage pin-click assignment popover, export `initPinout` and `getAssignments` |
| `tests/__init__.py` | Empty package marker |
| `tests/conftest.py` | Shared pytest fixtures |
| `tests/test_pi_pinout.py` | Unit tests for `detect_model` and `get_layout` |
| `tests/test_app_config.py` | API tests for `/api/pi-info` and `/api/config` validation |
| `pytest.ini` | Test runner configuration |

### Modified files

| Path | Changes |
|---|---|
| `requirements.txt` | Add `pytest` and `pytest-asyncio` as dev deps |
| `app.py` | New `/api/pi-info` route; pin-validation helper; call validator in `post_config` |
| `static/index.html` | Add tab bar; wrap existing main content in `#dashboard` panel; add `#settings` panel with six grouped cards; move HA details and dew heater settings into Settings panel |
| `static/style.css` | Tab bar, `.tab-panel` visibility, pinout SVG + legend + popover, restart banner styles |
| `static/app.js` | Tab switching, `fetchPiInfo`, per-section save handlers, wire `pinout.js`, restart banner |

---

## Task 0: Establish Test Infrastructure

**Files:**
- Create: `pytest.ini`
- Create: `tests/__init__.py`
- Create: `tests/conftest.py`
- Modify: `requirements.txt`

- [ ] **Step 1: Add pytest to requirements**

Modify `requirements.txt`. Append these lines at the end:

```
# Dev/test-only
pytest>=8.0.0
pytest-asyncio>=0.23.0
```

- [ ] **Step 2: Install dev dependencies**

Run: `pip install pytest pytest-asyncio httpx`
Expected: successful install. `httpx` is already in requirements for HA API calls; pytest and pytest-asyncio install fresh.

- [ ] **Step 3: Create `pytest.ini`**

```ini
[pytest]
testpaths = tests
python_files = test_*.py
asyncio_mode = auto
addopts = -v
```

- [ ] **Step 4: Create `tests/__init__.py`** (empty file)

- [ ] **Step 5: Create `tests/conftest.py`**

```python
"""Shared test fixtures for PiWeatherControl."""
import copy
import json
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
    async def _noop_lifespan(app):
        yield

    app_module.app.router.lifespan_context = _noop_lifespan
    with TestClient(app_module.app) as c:
        yield c
```

- [ ] **Step 6: Verify pytest discovers tests**

Run: `pytest --collect-only`
Expected: exits 0, reports "no tests ran" (directory exists, no test files yet).

- [ ] **Step 7: Commit**

```bash
git add pytest.ini tests/__init__.py tests/conftest.py requirements.txt
git commit -m "Add pytest infrastructure for PiWeatherControl tests"
```

---

## Task 1: Pi Model Detection (`pi_pinout.detect_model`)

**Files:**
- Create: `pi_pinout.py`
- Create: `tests/test_pi_pinout.py`

- [ ] **Step 1: Write failing test for detect_model**

Create `tests/test_pi_pinout.py`:

```python
"""Tests for pi_pinout model detection and layout."""
import pytest

import pi_pinout


def test_detect_model_pi5_from_device_tree(tmp_path, monkeypatch):
    dt = tmp_path / "model"
    dt.write_bytes(b"Raspberry Pi 5 Model B Rev 1.0\x00")
    monkeypatch.setattr(pi_pinout, "_DEVICE_TREE_MODEL", str(dt))
    assert pi_pinout.detect_model() == ("pi5", "Raspberry Pi 5 Model B Rev 1.0")


def test_detect_model_pi4_from_device_tree(tmp_path, monkeypatch):
    dt = tmp_path / "model"
    dt.write_bytes(b"Raspberry Pi 4 Model B Rev 1.4\x00")
    monkeypatch.setattr(pi_pinout, "_DEVICE_TREE_MODEL", str(dt))
    assert pi_pinout.detect_model() == ("pi4", "Raspberry Pi 4 Model B Rev 1.4")


def test_detect_model_pi3_from_device_tree(tmp_path, monkeypatch):
    dt = tmp_path / "model"
    dt.write_bytes(b"Raspberry Pi 3 Model B Plus Rev 1.3\x00")
    monkeypatch.setattr(pi_pinout, "_DEVICE_TREE_MODEL", str(dt))
    assert pi_pinout.detect_model() == ("pi3", "Raspberry Pi 3 Model B Plus Rev 1.3")


def test_detect_model_pi_zero2_from_device_tree(tmp_path, monkeypatch):
    dt = tmp_path / "model"
    dt.write_bytes(b"Raspberry Pi Zero 2 W Rev 1.0\x00")
    monkeypatch.setattr(pi_pinout, "_DEVICE_TREE_MODEL", str(dt))
    assert pi_pinout.detect_model() == ("pi_zero2", "Raspberry Pi Zero 2 W Rev 1.0")


def test_detect_model_missing_device_tree_returns_mock(tmp_path, monkeypatch):
    monkeypatch.setattr(pi_pinout, "_DEVICE_TREE_MODEL", str(tmp_path / "nonexistent"))
    monkeypatch.setattr(pi_pinout, "_CPUINFO", str(tmp_path / "also-nonexistent"))
    family, name = pi_pinout.detect_model()
    assert family == "pi5"
    assert name == "Mock (dev)"


def test_detect_model_falls_back_to_cpuinfo(tmp_path, monkeypatch):
    monkeypatch.setattr(pi_pinout, "_DEVICE_TREE_MODEL", str(tmp_path / "nonexistent"))
    cpuinfo = tmp_path / "cpuinfo"
    cpuinfo.write_text(
        "processor\t: 0\n"
        "Hardware\t: BCM2835\n"
        "Revision\t: c03114\n"  # Pi 4B 4GB rev 1.4
        "Model\t\t: Raspberry Pi 4 Model B Rev 1.4\n"
    )
    monkeypatch.setattr(pi_pinout, "_CPUINFO", str(cpuinfo))
    family, name = pi_pinout.detect_model()
    assert family == "pi4"
    assert "Raspberry Pi 4" in name


def test_detect_model_unknown_string(tmp_path, monkeypatch):
    dt = tmp_path / "model"
    dt.write_bytes(b"Some Other Board\x00")
    monkeypatch.setattr(pi_pinout, "_DEVICE_TREE_MODEL", str(dt))
    family, name = pi_pinout.detect_model()
    assert family == "unknown"
    assert name == "Some Other Board"
```

- [ ] **Step 2: Run failing test**

Run: `pytest tests/test_pi_pinout.py -v`
Expected: `ModuleNotFoundError: No module named 'pi_pinout'` (or import failure).

- [ ] **Step 3: Create `pi_pinout.py` with detection only**

```python
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
```

- [ ] **Step 4: Run tests — expect them to pass**

Run: `pytest tests/test_pi_pinout.py -v`
Expected: all seven tests pass.

- [ ] **Step 5: Commit**

```bash
git add pi_pinout.py tests/test_pi_pinout.py
git commit -m "Add Raspberry Pi model detection for pinout module"
```

---

## Task 2: Pin Capability Tables and `get_layout`

**Files:**
- Modify: `pi_pinout.py`
- Modify: `tests/test_pi_pinout.py`

- [ ] **Step 1: Append failing tests for get_layout**

Append to `tests/test_pi_pinout.py`:

```python
def test_get_layout_pi5_shape(monkeypatch):
    monkeypatch.setattr(pi_pinout, "detect_model", lambda: ("pi5", "Raspberry Pi 5 Model B"))
    layout = pi_pinout.get_layout(i2c_bus=1)
    assert layout["family"] == "pi5"
    assert layout["model"] == "Raspberry Pi 5 Model B"
    assert isinstance(layout["pins"], list)
    assert len(layout["pins"]) == 40
    by_phys = {p["physical_pin"]: p for p in layout["pins"]}
    # Physical 1 is 3V3 on every standard 40-pin Pi.
    assert by_phys[1]["type"] == "3v3"
    # Physical 2 and 4 are 5V.
    assert by_phys[2]["type"] == "5v"
    assert by_phys[4]["type"] == "5v"
    # Physical 6 is GND.
    assert by_phys[6]["type"] == "gnd"
    # Physical 38 is BCM 20 (default fan pin).
    assert by_phys[38]["bcm"] == 20
    assert by_phys[38]["type"] == "gpio"


def test_get_layout_marks_i2c_reserved_when_bus_1(monkeypatch):
    monkeypatch.setattr(pi_pinout, "detect_model", lambda: ("pi5", "Raspberry Pi 5 Model B"))
    layout = pi_pinout.get_layout(i2c_bus=1)
    by_bcm = {p["bcm"]: p for p in layout["pins"] if p["bcm"] is not None}
    assert by_bcm[2]["reserved"] is True
    assert by_bcm[3]["reserved"] is True
    assert "i2c" in by_bcm[2]["reserved_reason"].lower()


def test_get_layout_i2c_not_reserved_when_bus_0(monkeypatch):
    monkeypatch.setattr(pi_pinout, "detect_model", lambda: ("pi5", "Raspberry Pi 5 Model B"))
    layout = pi_pinout.get_layout(i2c_bus=0)
    by_bcm = {p["bcm"]: p for p in layout["pins"] if p["bcm"] is not None}
    assert by_bcm[2]["reserved"] is False
    assert by_bcm[3]["reserved"] is False


def test_get_layout_unknown_family_falls_back_to_pi5(monkeypatch):
    monkeypatch.setattr(pi_pinout, "detect_model", lambda: ("unknown", "Some Other Board"))
    layout = pi_pinout.get_layout(i2c_bus=1)
    assert layout["family"] == "unknown"
    assert layout["model"] == "Some Other Board"
    # Fallback still provides 40 pins (pi5 layout).
    assert len(layout["pins"]) == 40
    assert layout["warning"] is not None


def test_get_layout_has_usable_gpios(monkeypatch):
    monkeypatch.setattr(pi_pinout, "detect_model", lambda: ("pi5", "Raspberry Pi 5 Model B"))
    layout = pi_pinout.get_layout(i2c_bus=1)
    gpios = [p for p in layout["pins"] if p["type"] == "gpio"]
    # 40-pin Pis expose 26 GPIO pins on the header.
    assert len(gpios) == 26
    bcms = {p["bcm"] for p in gpios}
    # Common user pins must be present.
    for bcm in (4, 17, 18, 20, 21, 22, 23, 24, 25, 27):
        assert bcm in bcms
```

- [ ] **Step 2: Run failing tests**

Run: `pytest tests/test_pi_pinout.py -v`
Expected: five new tests fail with `AttributeError: module 'pi_pinout' has no attribute 'get_layout'`.

- [ ] **Step 3: Add pin tables and get_layout to `pi_pinout.py`**

Append to `pi_pinout.py`:

```python
@dataclass
class PinInfo:
    physical_pin: int
    bcm: Optional[int]
    type: str  # "gpio" | "5v" | "3v3" | "gnd"
    alt_functions: list[str]
    reserved: bool = False
    reserved_reason: Optional[str] = None


# Canonical 40-pin header layout shared by Pi 3B/3B+, Pi 4B, Pi 5, Pi Zero 2 W.
# Source: pinout.xyz. Physical pin number -> (bcm or None, type, [alt functions]).
_HEADER_40PIN: list[tuple[int, Optional[int], str, list[str]]] = [
    (1,  None, "3v3", []),
    (2,  None, "5v",  []),
    (3,  2,    "gpio", ["I2C1 SDA"]),
    (4,  None, "5v",  []),
    (5,  3,    "gpio", ["I2C1 SCL"]),
    (6,  None, "gnd", []),
    (7,  4,    "gpio", ["GPCLK0"]),
    (8,  14,   "gpio", ["UART TXD"]),
    (9,  None, "gnd", []),
    (10, 15,   "gpio", ["UART RXD"]),
    (11, 17,   "gpio", []),
    (12, 18,   "gpio", ["PCM CLK", "PWM0"]),
    (13, 27,   "gpio", []),
    (14, None, "gnd", []),
    (15, 22,   "gpio", []),
    (16, 23,   "gpio", []),
    (17, None, "3v3", []),
    (18, 24,   "gpio", []),
    (19, 10,   "gpio", ["SPI0 MOSI"]),
    (20, None, "gnd", []),
    (21, 9,    "gpio", ["SPI0 MISO"]),
    (22, 25,   "gpio", []),
    (23, 11,   "gpio", ["SPI0 SCLK"]),
    (24, 8,    "gpio", ["SPI0 CE0"]),
    (25, None, "gnd", []),
    (26, 7,    "gpio", ["SPI0 CE1"]),
    (27, 0,    "gpio", ["I2C0 SDA (EEPROM)"]),
    (28, 1,    "gpio", ["I2C0 SCL (EEPROM)"]),
    (29, 5,    "gpio", ["GPCLK1"]),
    (30, None, "gnd", []),
    (31, 6,    "gpio", []),
    (32, 12,   "gpio", ["PWM0"]),
    (33, 13,   "gpio", ["PWM1"]),
    (34, None, "gnd", []),
    (35, 19,   "gpio", ["PCM FS", "PWM1"]),
    (36, 16,   "gpio", []),
    (37, 26,   "gpio", []),
    (38, 20,   "gpio", ["PCM DIN"]),
    (39, None, "gnd", []),
    (40, 21,   "gpio", ["PCM DOUT"]),
]


# Families currently share the same 40-pin layout. Left as a dict so future
# families (Pi 5 specific alt functions, CM carriers, etc.) can diverge.
PIN_CAPABILITIES: dict[str, list[tuple[int, Optional[int], str, list[str]]]] = {
    "pi5": _HEADER_40PIN,
    "pi4": _HEADER_40PIN,
    "pi3": _HEADER_40PIN,
    "pi_zero2": _HEADER_40PIN,
}


def _i2c_reserved_bcms(i2c_bus: int) -> set[int]:
    """BCM pins reserved by the configured I2C bus."""
    if i2c_bus == 1:
        return {2, 3}
    if i2c_bus == 0:
        return {0, 1}
    return set()


def get_layout(i2c_bus: int) -> dict:
    """Return {model, family, pins, warning?} for the detected Pi."""
    family, model = detect_model()
    table = PIN_CAPABILITIES.get(family, _HEADER_40PIN)
    reserved_bcms = _i2c_reserved_bcms(i2c_bus)

    pins = []
    for phys, bcm, ptype, alts in table:
        reserved = bcm is not None and bcm in reserved_bcms
        pin = PinInfo(
            physical_pin=phys,
            bcm=bcm,
            type=ptype,
            alt_functions=list(alts),
            reserved=reserved,
            reserved_reason=f"Reserved by I2C bus {i2c_bus}" if reserved else None,
        )
        pins.append(asdict(pin))

    layout: dict = {
        "model": model,
        "family": family,
        "pins": pins,
        "warning": None,
    }
    if family == "unknown":
        layout["warning"] = f"Unrecognised Pi model '{model}', showing generic 40-pin layout"
    return layout
```

- [ ] **Step 4: Run tests — expect them all to pass**

Run: `pytest tests/test_pi_pinout.py -v`
Expected: all twelve tests (seven from Task 1, five new) pass.

- [ ] **Step 5: Commit**

```bash
git add pi_pinout.py tests/test_pi_pinout.py
git commit -m "Add 40-pin header capability table and get_layout builder"
```

---

## Task 3: `GET /api/pi-info` Endpoint

**Files:**
- Modify: `app.py`
- Create: `tests/test_app_config.py`

- [ ] **Step 1: Write failing test for the new endpoint**

Create `tests/test_app_config.py`:

```python
"""API tests for /api/pi-info and /api/config pin validation."""
import json


def test_get_pi_info_returns_layout(client):
    resp = client.get("/api/pi-info")
    assert resp.status_code == 200
    body = resp.json()
    assert "family" in body
    assert "model" in body
    assert "pins" in body
    assert len(body["pins"]) == 40
    # Shape of each pin entry.
    for p in body["pins"]:
        assert set(p.keys()) >= {"physical_pin", "bcm", "type", "alt_functions", "reserved"}


def test_get_pi_info_marks_i2c_reserved_for_default_bus(client):
    resp = client.get("/api/pi-info")
    assert resp.status_code == 200
    by_bcm = {p["bcm"]: p for p in resp.json()["pins"] if p["bcm"] is not None}
    # Default config has i2c_bus = 1, so BCM 2 and 3 must be reserved.
    assert by_bcm[2]["reserved"] is True
    assert by_bcm[3]["reserved"] is True
```

- [ ] **Step 2: Run failing test**

Run: `pytest tests/test_app_config.py -v`
Expected: both tests fail with 404 (endpoint does not exist yet).

- [ ] **Step 3: Add endpoint to `app.py`**

Add this import near the top of `app.py` alongside existing imports (after `from gpio_control import GPIOController`):

```python
import pi_pinout
```

Add this route after the existing `get_config` route (around line 518):

```python
@app.get("/api/pi-info")
async def get_pi_info():
    return pi_pinout.get_layout(config.get("i2c_bus", 1))
```

- [ ] **Step 4: Run tests — expect pass**

Run: `pytest tests/test_app_config.py -v`
Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_app_config.py
git commit -m "Add GET /api/pi-info endpoint for pin layout discovery"
```

---

## Task 4: Pin Validation on `POST /api/config`

**Files:**
- Modify: `app.py`
- Modify: `tests/test_app_config.py`

- [ ] **Step 1: Append failing validation tests**

Append to `tests/test_app_config.py`:

```python
def test_post_config_rejects_i2c_reserved_pin(client):
    # BCM 2 is I2C SDA on the default bus; must be rejected.
    resp = client.post("/api/config", json={"gpio": {"fan_pin": 2, "heater_pin": 21, "invert_relay": True}})
    assert resp.status_code == 400
    assert "i2c" in resp.json()["detail"].lower()


def test_post_config_rejects_pin_collision(client):
    resp = client.post("/api/config", json={"gpio": {"fan_pin": 21, "heater_pin": 21, "invert_relay": True}})
    assert resp.status_code == 400
    detail = resp.json()["detail"].lower()
    assert "same" in detail or "collision" in detail or "conflict" in detail


def test_post_config_rejects_unknown_bcm(client):
    resp = client.post("/api/config", json={"gpio": {"fan_pin": 99, "heater_pin": 21, "invert_relay": True}})
    assert resp.status_code == 400


def test_post_config_accepts_valid_pin_swap(client):
    resp = client.post("/api/config", json={"gpio": {"fan_pin": 16, "heater_pin": 21, "invert_relay": True}})
    assert resp.status_code == 200
    assert resp.json()["gpio"]["fan_pin"] == 16


def test_post_config_accepts_non_gpio_fields(client):
    # A config update that does not touch GPIO should bypass pin validation entirely.
    resp = client.post("/api/config", json={"ha": {"url": "http://example.test:8123"}})
    assert resp.status_code == 200
    assert resp.json()["ha"]["url"] == "http://example.test:8123"


def test_post_config_rejects_power_pin_via_physical_only(client):
    # Physical pin 2 is 5V; its BCM is None. Passing None or a non-integer must be rejected cleanly.
    resp = client.post("/api/config", json={"gpio": {"fan_pin": None, "heater_pin": 21, "invert_relay": True}})
    # Pydantic-level rejection (422) or our own 400 are both acceptable; just make sure it doesn't crash or save.
    assert resp.status_code in (400, 422)
```

- [ ] **Step 2: Run failing tests**

Run: `pytest tests/test_app_config.py -v`
Expected: the six new tests fail (all currently return 200 because no validation exists).

- [ ] **Step 3: Add validation helper and call it from `post_config`**

Add this helper function to `app.py`, just above the `@app.post("/api/config")` route (around line 530):

```python
def _validate_gpio_update(gpio_update: dict, current_gpio: dict, i2c_bus: int) -> Optional[str]:
    """Return an error message if gpio_update is invalid, else None.

    Accepts a partial gpio dict (any of fan_pin, heater_pin, invert_relay). Validates
    BCM numbers against the detected Pi layout and rejects I2C-reserved pins and
    collisions where fan_pin == heater_pin after the update is applied.
    """
    layout = pi_pinout.get_layout(i2c_bus)
    valid_bcms = {p["bcm"]: p for p in layout["pins"] if p["bcm"] is not None and p["type"] == "gpio"}

    merged = {**current_gpio, **gpio_update}
    fan_pin = merged.get("fan_pin")
    heater_pin = merged.get("heater_pin")

    for label, pin in (("fan_pin", fan_pin), ("heater_pin", heater_pin)):
        if pin is None or not isinstance(pin, int):
            return f"{label} must be an integer BCM GPIO number"
        if pin not in valid_bcms:
            return f"{label}={pin} is not a usable BCM GPIO on this Pi"
        info = valid_bcms[pin]
        if info["reserved"]:
            return f"{label}={pin} is reserved: {info['reserved_reason']}"

    if fan_pin == heater_pin:
        return f"fan_pin and heater_pin cannot be the same (both {fan_pin})"

    return None
```

Replace the existing `post_config` route body with:

```python
@app.post("/api/config")
async def post_config(body: ConfigUpdate):
    global config
    updates = {k: v for k, v in body.model_dump().items() if v is not None}

    if "gpio" in updates:
        i2c_bus = updates.get("i2c_bus", config.get("i2c_bus", 1))
        error = _validate_gpio_update(updates["gpio"], config.get("gpio", {}), i2c_bus)
        if error is not None:
            return JSONResponse({"detail": error}, 400)

    config = update_config(updates)
    _log_event(f"Config updated: {list(updates.keys())}")
    if latest_snapshot:
        apply_control(latest_snapshot, config)
    return config
```

- [ ] **Step 4: Run tests — expect pass**

Run: `pytest tests/test_app_config.py -v`
Expected: all eight tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_app_config.py
git commit -m "Validate GPIO pin assignments on /api/config POST"
```

---

## Task 5: SVG Pin Picker Component (`static/pinout.js`)

**Files:**
- Create: `static/pinout.js`

This is a UI module with no unit tests; verification is manual in Task 10. Build it as one focused file exporting an init function and an accessor for the current assignment state.

- [ ] **Step 1: Create `static/pinout.js`**

```javascript
// Renders the 40-pin Raspberry Pi header as an SVG and manages pin assignments
// to named devices (fan, heater). No framework; mounts into a container element.

const PIN_RADIUS = 12;
const PIN_SPACING_X = 48;
const PIN_SPACING_Y = 32;
const PADDING = 28;

const TYPE_CLASS = {
  "3v3": "pin pin-3v3",
  "5v": "pin pin-5v",
  "gnd": "pin pin-gnd",
  "gpio": "pin pin-gpio",
};

const DEVICES = [
  { key: "fan", label: "Fan" },
  { key: "heater", label: "Heater" },
];

let _layout = null;
let _assignments = { fan: null, heater: null };
let _onChange = () => {};
let _rootEl = null;
let _popoverEl = null;

export function initPinout(container, layout, initialAssignments, onChange) {
  _rootEl = container;
  _layout = layout;
  _assignments = { ...initialAssignments };
  _onChange = onChange || (() => {});
  _render();
}

export function getAssignments() {
  return { ..._assignments };
}

export function setAssignments(next) {
  _assignments = { ..._assignments, ...next };
  _render();
}

function _render() {
  if (!_rootEl || !_layout) return;
  _rootEl.innerHTML = "";

  if (_layout.warning) {
    const warn = document.createElement("div");
    warn.className = "pinout-warning";
    warn.textContent = _layout.warning;
    _rootEl.appendChild(warn);
  }

  const headerInfo = document.createElement("div");
  headerInfo.className = "pinout-header-info";
  headerInfo.textContent = `${_layout.model} (${_layout.family})`;
  _rootEl.appendChild(headerInfo);

  const width = PADDING * 2 + PIN_SPACING_X;
  const height = PADDING * 2 + PIN_SPACING_Y * 19;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "pinout-svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", "Raspberry Pi 40-pin header");

  // Header backing rectangle for visual grouping.
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", PADDING - PIN_RADIUS - 4);
  bg.setAttribute("y", PADDING - PIN_RADIUS - 4);
  bg.setAttribute("width", PIN_SPACING_X + (PIN_RADIUS + 4) * 2);
  bg.setAttribute("height", PIN_SPACING_Y * 19 + (PIN_RADIUS + 4) * 2);
  bg.setAttribute("rx", 10);
  bg.setAttribute("class", "pinout-board");
  svg.appendChild(bg);

  // Pin 1 square corner indicator.
  const corner = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  corner.setAttribute("x", PADDING - PIN_RADIUS - 2);
  corner.setAttribute("y", PADDING - PIN_RADIUS - 2);
  corner.setAttribute("width", PIN_RADIUS * 2 + 4);
  corner.setAttribute("height", PIN_RADIUS * 2 + 4);
  corner.setAttribute("class", "pinout-pin1-indicator");
  svg.appendChild(corner);

  for (const pin of _layout.pins) {
    svg.appendChild(_renderPin(pin));
  }
  _rootEl.appendChild(svg);
  _rootEl.appendChild(_renderLegend());
}

function _renderPin(pin) {
  const col = (pin.physical_pin % 2 === 1) ? 0 : 1; // odd -> left
  const row = Math.floor((pin.physical_pin - 1) / 2);
  const cx = PADDING + col * PIN_SPACING_X;
  const cy = PADDING + row * PIN_SPACING_Y;

  const assignedDevice = _deviceAssignedTo(pin.bcm);
  const classes = [TYPE_CLASS[pin.type]];
  if (assignedDevice) classes.push("pin-assigned");
  if (pin.reserved) classes.push("pin-reserved");

  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", "pin-group");
  group.setAttribute("data-physical", String(pin.physical_pin));
  group.setAttribute("data-bcm", pin.bcm == null ? "" : String(pin.bcm));

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", String(cx));
  circle.setAttribute("cy", String(cy));
  circle.setAttribute("r", String(PIN_RADIUS));
  circle.setAttribute("class", classes.join(" "));

  const clickable = pin.type === "gpio" && !pin.reserved;
  circle.setAttribute("tabindex", clickable ? "0" : "-1");
  circle.setAttribute("role", "button");
  const bcmText = pin.bcm == null ? "none" : `BCM ${pin.bcm}`;
  const assignedText = assignedDevice ? `, assigned to ${assignedDevice}` : "";
  const reservedText = pin.reserved ? `, ${pin.reserved_reason}` : "";
  circle.setAttribute(
    "aria-label",
    `Physical pin ${pin.physical_pin}, ${bcmText}, ${pin.type}${assignedText}${reservedText}`
  );

  if (clickable) {
    circle.addEventListener("click", (ev) => _openPopover(ev, pin));
    circle.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        _openPopover(ev, pin);
      }
    });
  }

  // Tooltip via title element.
  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.textContent = _tooltipText(pin, assignedDevice);
  circle.appendChild(title);

  group.appendChild(circle);

  // Pin number label inside the circle.
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", String(cx));
  label.setAttribute("y", String(cy + 4));
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("class", "pin-number");
  label.textContent = String(pin.physical_pin);
  group.appendChild(label);

  // BCM annotation beside GPIO pins.
  if (pin.bcm != null) {
    const bcmLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
    const offsetX = col === 0 ? -PIN_RADIUS - 6 : PIN_RADIUS + 6;
    bcmLabel.setAttribute("x", String(cx + offsetX));
    bcmLabel.setAttribute("y", String(cy + 4));
    bcmLabel.setAttribute("text-anchor", col === 0 ? "end" : "start");
    bcmLabel.setAttribute("class", "pin-bcm-label");
    bcmLabel.textContent = `GPIO ${pin.bcm}`;
    group.appendChild(bcmLabel);
  }

  if (assignedDevice) {
    const badge = document.createElementNS("http://www.w3.org/2000/svg", "text");
    const offsetX = col === 0 ? -PIN_RADIUS - 44 : PIN_RADIUS + 44;
    badge.setAttribute("x", String(cx + offsetX));
    badge.setAttribute("y", String(cy + 4));
    badge.setAttribute("text-anchor", col === 0 ? "end" : "start");
    badge.setAttribute("class", "pin-device-badge");
    badge.textContent = assignedDevice.toUpperCase();
    group.appendChild(badge);
  }

  return group;
}

function _deviceAssignedTo(bcm) {
  if (bcm == null) return null;
  for (const d of DEVICES) {
    if (_assignments[d.key] === bcm) return d.key;
  }
  return null;
}

function _tooltipText(pin, assignedDevice) {
  const parts = [`Physical ${pin.physical_pin}`];
  if (pin.bcm != null) parts.push(`BCM ${pin.bcm}`);
  parts.push(pin.type.toUpperCase());
  if (pin.alt_functions && pin.alt_functions.length) {
    parts.push(pin.alt_functions.join(", "));
  }
  if (pin.reserved) parts.push(pin.reserved_reason || "reserved");
  if (assignedDevice) parts.push(`assigned: ${assignedDevice}`);
  return parts.join(" / ");
}

function _renderLegend() {
  const legend = document.createElement("div");
  legend.className = "pinout-legend";
  const items = [
    { cls: "pin-3v3", text: "3.3V" },
    { cls: "pin-5v", text: "5V" },
    { cls: "pin-gnd", text: "GND" },
    { cls: "pin-gpio", text: "GPIO" },
    { cls: "pin-assigned", text: "Assigned" },
    { cls: "pin-reserved", text: "Reserved (I2C)" },
  ];
  for (const item of items) {
    const row = document.createElement("span");
    row.className = "pinout-legend-item";
    const swatch = document.createElement("span");
    swatch.className = `pinout-legend-swatch ${item.cls}`;
    const label = document.createElement("span");
    label.textContent = item.text;
    row.appendChild(swatch);
    row.appendChild(label);
    legend.appendChild(row);
  }
  return legend;
}

function _closePopover() {
  if (_popoverEl && _popoverEl.parentNode) {
    _popoverEl.parentNode.removeChild(_popoverEl);
  }
  _popoverEl = null;
}

function _openPopover(ev, pin) {
  _closePopover();
  const pop = document.createElement("div");
  pop.className = "pinout-popover";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", `Assign BCM ${pin.bcm}`);

  const title = document.createElement("div");
  title.className = "pinout-popover-title";
  title.textContent = `Pin ${pin.physical_pin} / GPIO ${pin.bcm}`;
  pop.appendChild(title);

  const select = document.createElement("select");
  select.className = "pinout-popover-select";
  const unassigned = document.createElement("option");
  unassigned.value = "__unassigned__";
  unassigned.textContent = "Unassigned";
  select.appendChild(unassigned);
  for (const d of DEVICES) {
    const opt = document.createElement("option");
    opt.value = d.key;
    opt.textContent = d.label;
    if (_assignments[d.key] === pin.bcm) opt.selected = true;
    select.appendChild(opt);
  }

  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "pinout-popover-apply";
  apply.textContent = "Apply";
  apply.addEventListener("click", () => {
    const choice = select.value;
    const next = { ..._assignments };
    // Clear this pin from any device currently using it.
    for (const d of DEVICES) {
      if (next[d.key] === pin.bcm) next[d.key] = null;
    }
    if (choice !== "__unassigned__") {
      next[choice] = pin.bcm;
    }
    _assignments = next;
    _closePopover();
    _render();
    _onChange(getAssignments());
  });

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "pinout-popover-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", _closePopover);

  pop.appendChild(select);
  const actions = document.createElement("div");
  actions.className = "pinout-popover-actions";
  actions.appendChild(cancel);
  actions.appendChild(apply);
  pop.appendChild(actions);

  // Position near the clicked element.
  const rect = ev.currentTarget.getBoundingClientRect();
  const hostRect = _rootEl.getBoundingClientRect();
  pop.style.position = "absolute";
  pop.style.left = `${rect.right - hostRect.left + 8}px`;
  pop.style.top = `${rect.top - hostRect.top - 8}px`;

  _rootEl.appendChild(pop);
  _popoverEl = pop;
  select.focus();
}
```

- [ ] **Step 2: Static syntax check**

Run: `node --check static/pinout.js`
Expected: no output, exit 0. (If `node` is unavailable locally, skip — the manual verification in Task 10 will exercise it.)

- [ ] **Step 3: Commit**

```bash
git add static/pinout.js
git commit -m "Add SVG pin picker component for GPIO assignment"
```

---

## Task 6: Tab Bar and Settings Panel Layout (`index.html`)

**Files:**
- Modify: `static/index.html`

- [ ] **Step 1: Read the current file to confirm line ranges**

Run: `wc -l static/index.html`
Expected: 218 lines (matches current state).

- [ ] **Step 2: Rewrite `static/index.html` with tab structure**

Replace the entire contents of `static/index.html` with:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Enclosure Controller</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
  <header>
    <h1>Enclosure Controller</h1>
    <nav class="tab-bar" role="tablist" aria-label="Primary">
      <button class="tab-btn active" role="tab" aria-selected="true" data-tab="dashboard">Dashboard</button>
      <button class="tab-btn" role="tab" aria-selected="false" data-tab="settings">Settings</button>
    </nav>
    <span id="connection-status" class="status-dot connected" title="Connected"></span>
  </header>

  <main>
    <section id="dashboard" class="tab-panel active" role="tabpanel" aria-labelledby="tab-dashboard">
      <!-- Sensor Cards Row -->
      <section class="card-grid">
        <div class="card" id="card-cpu">
          <div class="card-header">CPU</div>
          <div class="card-value"><span id="cpu-temp">--</span>&deg;C</div>
          <canvas id="spark-cpu" class="sparkline" width="160" height="40"></canvas>
        </div>
        <div class="card" id="card-ssd">
          <div class="card-header">SSD</div>
          <div class="card-value"><span id="ssd-temp">--</span>&deg;C</div>
          <canvas id="spark-ssd" class="sparkline" width="160" height="40"></canvas>
        </div>
        <div class="card" id="card-pi-fan">
          <div class="card-header">Pi Fan</div>
          <div class="card-value"><span id="pi-fan-rpm">--</span> RPM</div>
          <div class="card-sub">
            <span>PWM: <span id="pi-fan-pct">--</span>%</span>
          </div>
          <canvas id="pi-fan-curve" class="sparkline" width="160" height="40"></canvas>
        </div>
        <div class="card" id="card-enclosure">
          <div class="card-header">Enclosure (BME280)</div>
          <div class="card-value"><span id="enc-temp">--</span>&deg;C</div>
          <div class="card-sub">
            <span>Humidity: <span id="enc-humidity">--</span>%</span>
            <span>Dew: <span id="enc-dew">--</span>&deg;C</span>
          </div>
          <div class="card-sub">
            <span>Pressure: <span id="enc-pressure">--</span> hPa</span>
          </div>
          <canvas id="spark-enclosure" class="sparkline" width="160" height="40"></canvas>
        </div>
        <div class="card" id="card-outdoor">
          <div class="card-header">Outside (HA) <span id="ha-status" class="badge">--</span></div>
          <div class="card-value"><span id="out-temp">--</span>&deg;C</div>
          <div class="card-sub card-sub-lg">
            <span>Humidity: <span id="out-humidity">--</span>%</span>
            <span>Dew: <span id="out-dew">--</span>&deg;C</span>
          </div>
        </div>
        <div class="card" id="card-power">
          <div class="card-header">Power (INA260)</div>
          <div class="card-value"><span id="pwr-voltage">--</span> V</div>
          <div class="card-sub card-sub-lg">
            <span><span id="pwr-current">--</span> A</span>
            <span><span id="pwr-power">--</span> W</span>
          </div>
        </div>
      </section>

      <!-- Dew Status + Fan Curve (with relay controls above) -->
      <section class="graph-row">
        <div class="graph-column">
          <div class="card relay-card" id="card-heater">
            <div class="card-header">
              <span>Dew Heater</span>
              <span id="heater-indicator" class="relay-indicator off"></span>
            </div>
            <div class="relay-info">
              <span>GPIO <span id="heater-pin">21</span></span>
              <span>Cycles: <span id="heater-cycles">0</span></span>
            </div>
            <div class="mode-selector">
              <button class="mode-btn" data-device="heater" data-mode="off">Off</button>
              <button class="mode-btn active" data-device="heater" data-mode="auto">Auto</button>
              <button class="mode-btn" data-device="heater" data-mode="on">On</button>
            </div>
          </div>
          <div class="glass-panel" id="card-dew-status">
          <div class="ambient-glow ambient-glow-red"></div>
          <div class="glass-panel-header">
            <div>
              <h2 class="panel-title">
                <svg class="panel-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"></path></svg>
                Dew Point Analysis
              </h2>
              <p class="panel-subtitle">Comparing enclosure temperature against dew thresholds</p>
            </div>
            <div id="heater-badge" class="heater-badge hidden">
              <span class="heater-badge-dot"></span>
              <span class="heater-badge-text">HEATING ACTIVE</span>
            </div>
          </div>
          <div class="dew-gauge-wrap">
            <canvas id="dew-gauge"></canvas>
          </div>
          <div class="dew-indicators">
            <div class="dew-indicator" id="dew-ind-proximity">
              <span class="dew-ind-dot"></span>
              <div class="dew-ind-detail">
                <span class="dew-ind-label">Enclosure</span>
                <span class="dew-ind-value" id="dew-distance-val">--</span>
              </div>
            </div>
            <div class="dew-indicator" id="dew-ind-outside">
              <span class="dew-ind-dot"></span>
              <div class="dew-ind-detail">
                <span class="dew-ind-label">Outdoor</span>
                <span class="dew-ind-value" id="dew-outside-val">--</span>
              </div>
            </div>
            <div class="dew-indicator" id="dew-ind-frost">
              <span class="dew-ind-dot"></span>
              <div class="dew-ind-detail">
                <span class="dew-ind-label">Frost</span>
                <span class="dew-ind-value" id="dew-frost-val">--</span>
              </div>
            </div>
            <div class="dew-indicator" id="dew-ind-fan-suppress">
              <span class="dew-ind-dot"></span>
              <div class="dew-ind-detail">
                <span class="dew-ind-label">Fan Interlock</span>
                <span class="dew-ind-value" id="dew-fan-suppress-val">--</span>
              </div>
            </div>
          </div>
        </div>
        </div>
        <div class="graph-column">
          <div class="card relay-card" id="card-fan">
            <div class="card-header">
              <span>Fan Relay</span>
              <span id="fan-indicator" class="relay-indicator off"></span>
            </div>
            <div class="relay-info">
              <span>GPIO <span id="fan-pin">20</span></span>
              <span>Cycles: <span id="fan-cycles">0</span></span>
            </div>
            <div class="mode-selector">
              <button class="mode-btn" data-device="fan" data-mode="off">Off</button>
              <button class="mode-btn active" data-device="fan" data-mode="auto">Auto</button>
              <button class="mode-btn" data-device="fan" data-mode="on">On</button>
            </div>
          </div>
          <div class="glass-panel" id="card-fan-curve">
          <div class="ambient-glow ambient-glow-blue"></div>
          <div class="glass-panel-header">
            <div>
              <h2 class="panel-title">
                <svg class="panel-icon icon-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5"></path></svg>
                Thermal Fan Curve
              </h2>
              <p class="panel-subtitle">Active cooling temperature threshold</p>
            </div>
            <div class="fan-sources" id="dashboard-fan-sources">
              <label><input type="checkbox" class="src-cpu" checked> CPU</label>
              <label><input type="checkbox" class="src-ssd" checked> SSD</label>
              <label><input type="checkbox" class="src-enclosure" checked> Enclosure</label>
            </div>
          </div>
          <div class="curve-editor-wrap">
            <canvas id="fan-curve-canvas"></canvas>
          </div>
        </div>
        </div>
      </section>

      <!-- Event Log -->
      <section class="card wide-card">
        <div class="card-header">Event Log</div>
        <div id="event-log" class="event-log"></div>
      </section>
    </section>

    <section id="settings" class="tab-panel" role="tabpanel" aria-labelledby="tab-settings">

      <!-- 1. Hardware / GPIO -->
      <section class="card wide-card settings-card">
        <div class="card-header">Hardware / GPIO</div>
        <form id="form-gpio" class="settings-form">
          <div id="pinout-container" class="pinout-container" aria-live="polite"></div>
          <div class="settings-row">
            <label class="checkbox-label"><input type="checkbox" id="gpio-invert-relay"> Invert relay (active-low)</label>
            <button type="submit" class="btn-small btn-primary">Save GPIO</button>
          </div>
          <div id="gpio-restart-banner" class="settings-banner hidden">
            GPIO changes saved. Restart required: <code>sudo systemctl restart piweathercontrol</code>
          </div>
        </form>
      </section>

      <!-- 2. Fan control -->
      <section class="card wide-card settings-card">
        <div class="card-header">Fan Control</div>
        <form id="form-fan" class="settings-form">
          <div class="settings-row">
            <label>Threshold: <input type="number" id="set-fan-threshold" min="20" max="90" step="1">&deg;C</label>
            <label>Hysteresis: <input type="number" id="set-fan-hysteresis" min="0" max="20" step="1">&deg;C</label>
            <label>Min ON: <input type="number" id="set-fan-min-on" min="0" max="600" step="10">s</label>
            <label>Min OFF: <input type="number" id="set-fan-min-off" min="0" max="600" step="10">s</label>
          </div>
          <div class="settings-row fan-sources">
            <label><input type="checkbox" id="set-src-cpu"> CPU source</label>
            <label><input type="checkbox" id="set-src-ssd"> SSD source</label>
            <label><input type="checkbox" id="set-src-enclosure"> Enclosure source</label>
            <button type="submit" class="btn-small btn-primary">Save Fan</button>
          </div>
        </form>
      </section>

      <!-- 3. Dew heater control -->
      <section class="card wide-card settings-card">
        <div class="card-header">Dew Heater Control</div>
        <form id="form-heater" class="settings-form">
          <div class="settings-row">
            <label>Dew Margin: <input type="number" id="set-dew-margin" min="0" max="20" step="0.5">&deg;C</label>
            <label>Frost Threshold: <input type="number" id="set-outside-threshold" min="-20" max="20" step="0.5">&deg;C</label>
            <label>Hysteresis: <input type="number" id="set-heater-hysteresis" min="0" max="10" step="0.5">&deg;C</label>
            <label>Min ON: <input type="number" id="set-heater-min-on" min="0" max="600" step="10">s</label>
            <label>Min OFF: <input type="number" id="set-heater-min-off" min="0" max="600" step="10">s</label>
            <label class="checkbox-label"><input type="checkbox" id="set-fan-off-when-heating"> Fan off when heating</label>
            <button type="submit" class="btn-small btn-primary">Save Heater</button>
          </div>
        </form>
      </section>

      <!-- 4. Home Assistant integration -->
      <section class="card wide-card settings-card">
        <div class="card-header">Home Assistant Integration</div>
        <form id="form-ha" class="settings-form">
          <div class="settings-row">
            <label>URL: <input type="text" id="set-ha-url" placeholder="http://homeassistant.local:8123"></label>
            <label>Token: <input type="password" id="set-ha-token" placeholder="Long-lived access token"></label>
            <label>Temp Entity: <input type="text" id="set-ha-temp-entity" placeholder="sensor.outside_temperature"></label>
            <label>Humidity Entity: <input type="text" id="set-ha-humid-entity" placeholder="sensor.outside_humidity"></label>
            <button type="submit" class="btn-small btn-primary">Save HA</button>
          </div>
        </form>
      </section>

      <!-- 5. AllSky integration -->
      <section class="card wide-card settings-card">
        <div class="card-header">AllSky Integration</div>
        <form id="form-allsky" class="settings-form">
          <div class="settings-row">
            <label class="checkbox-label"><input type="checkbox" id="set-allsky-enabled"> Enable AllSky overlay writer</label>
            <label>Output dir: <input type="text" id="set-allsky-output-dir" placeholder="/home/pi/allsky/config/overlay/extra"></label>
            <button type="submit" class="btn-small btn-primary">Save AllSky</button>
          </div>
        </form>
      </section>

      <!-- 6. System -->
      <section class="card wide-card settings-card">
        <div class="card-header">System</div>
        <form id="form-system" class="settings-form">
          <div class="settings-row">
            <label>I2C bus: <input type="number" id="set-i2c-bus" min="0" max="7" step="1"></label>
            <label>Poll interval: <input type="number" id="set-poll-interval" min="2" max="120" step="1">s</label>
            <button type="submit" class="btn-small btn-primary">Save System</button>
          </div>
          <div class="settings-row settings-readonly">
            <span>BME280 address: <code>0x77</code> (hardcoded in sensors.py)</span>
            <span>INA260 address: <code>0x40</code> (hardcoded in sensors.py)</span>
          </div>
        </form>
      </section>

    </section>
  </main>

  <script type="module" src="/static/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Sanity check**

Run: `wc -l static/index.html`
Expected: ~260 lines (roughly 40 more than before, for the settings panel and tab bar).

- [ ] **Step 4: Commit**

```bash
git add static/index.html
git commit -m "Split UI into Dashboard and Settings tabs, add settings panel markup"
```

---

## Task 7: Tab, Pinout, and Banner CSS (`style.css`)

**Files:**
- Modify: `static/style.css`

- [ ] **Step 1: Read the end of `style.css` so the append lands after existing rules**

Run: `wc -l static/style.css`
Expected: around 600 lines. Remember the number for the edit.

- [ ] **Step 2: Append tab + pinout + settings CSS**

Append to `static/style.css`:

```css
/* ===== Tab bar ===== */
.tab-bar {
  display: flex;
  gap: 4px;
  margin-left: 20px;
  flex: 1;
}

.tab-btn {
  background: transparent;
  color: var(--text-dim, #9ca3af);
  border: 1px solid transparent;
  padding: 6px 16px;
  border-radius: 8px 8px 0 0;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: background 120ms, color 120ms;
}

.tab-btn:hover {
  color: var(--text, #e5e7eb);
  background: rgba(255, 255, 255, 0.04);
}

.tab-btn.active {
  color: var(--text, #e5e7eb);
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.1);
  border-bottom: 1px solid transparent;
}

.tab-panel {
  display: none;
}

.tab-panel.active {
  display: block;
}

/* ===== Settings panel ===== */
.settings-card {
  margin-bottom: 16px;
}

.settings-form .settings-row {
  gap: 16px;
  flex-wrap: wrap;
  align-items: center;
}

.settings-readonly {
  font-size: 0.85em;
  color: var(--text-dim, #9ca3af);
}

.settings-readonly code {
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 6px;
  border-radius: 4px;
}

.settings-banner {
  margin-top: 12px;
  padding: 10px 14px;
  background: rgba(250, 200, 80, 0.12);
  border: 1px solid rgba(250, 200, 80, 0.35);
  color: #f8d57e;
  border-radius: 8px;
  font-size: 0.9em;
}

.settings-banner.hidden {
  display: none;
}

.settings-banner code {
  background: rgba(0, 0, 0, 0.3);
  padding: 1px 6px;
  border-radius: 4px;
}

/* ===== Pinout component ===== */
.pinout-container {
  position: relative;
  padding: 20px 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.pinout-header-info {
  color: var(--text-dim, #9ca3af);
  font-size: 0.9em;
}

.pinout-warning {
  color: #f8d57e;
  background: rgba(250, 200, 80, 0.12);
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 0.85em;
}

.pinout-svg {
  width: 220px;
  max-width: 100%;
  height: auto;
}

.pinout-board {
  fill: rgba(40, 45, 55, 0.6);
  stroke: rgba(255, 255, 255, 0.08);
  stroke-width: 1;
}

.pinout-pin1-indicator {
  fill: none;
  stroke: #f8d57e;
  stroke-width: 1.5;
  stroke-dasharray: 3 2;
}

.pin {
  stroke: rgba(0, 0, 0, 0.4);
  stroke-width: 1;
  cursor: default;
  transition: filter 120ms, stroke 120ms;
}

.pin-3v3 { fill: #f4b35b; }
.pin-5v { fill: #d9534f; }
.pin-gnd { fill: #6b7280; }
.pin-gpio { fill: #4ade80; }

.pin-assigned {
  fill: #f8d57e !important;
  stroke: #f8d57e;
  stroke-width: 2;
}

.pin-reserved {
  fill: #4ade80;
  stroke: #60a5fa;
  stroke-width: 2;
  opacity: 0.85;
}

circle.pin[tabindex="0"] { cursor: pointer; }
circle.pin[tabindex="0"]:hover,
circle.pin[tabindex="0"]:focus {
  filter: brightness(1.2);
  outline: none;
}

.pin-number {
  fill: rgba(0, 0, 0, 0.8);
  font-size: 10px;
  font-weight: 600;
  pointer-events: none;
}

.pin-bcm-label {
  fill: var(--text-dim, #9ca3af);
  font-size: 9px;
  pointer-events: none;
}

.pin-device-badge {
  fill: #f8d57e;
  font-size: 9px;
  font-weight: 700;
  pointer-events: none;
}

.pinout-legend {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  justify-content: center;
  font-size: 0.8em;
  color: var(--text-dim, #9ca3af);
}

.pinout-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.pinout-legend-swatch {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.3);
}

.pinout-popover {
  background: rgba(22, 26, 34, 0.98);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 12px;
  min-width: 180px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  z-index: 50;
}

.pinout-popover-title {
  font-weight: 600;
  margin-bottom: 8px;
}

.pinout-popover-select {
  width: 100%;
  padding: 6px;
  margin-bottom: 10px;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}

.pinout-popover-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.pinout-popover-apply,
.pinout-popover-cancel {
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  cursor: pointer;
}

.pinout-popover-apply {
  background: #3b82f6;
  border-color: #3b82f6;
  color: #fff;
}
```

- [ ] **Step 3: Commit**

```bash
git add static/style.css
git commit -m "Add CSS for tabs, pinout picker, and settings banner"
```

---

## Task 8: Frontend Wiring (`app.js`)

**Files:**
- Modify: `static/app.js`

This task turns the previously single-page app into a tabbed app, wires `pinout.js`, and splits the old global save logic into per-form handlers. Existing sensor polling, canvas rendering, and mode buttons are preserved.

- [ ] **Step 1: Read current app.js to identify the functions to modify**

Run: `wc -l static/app.js`
Expected: around 960 lines.

- [ ] **Step 2: Add tab switching at the top of the init block**

Find the existing `poll` setup near the bottom of `app.js` (grep for `setInterval(poll`). Above that (or alongside existing `DOMContentLoaded` wiring — whichever exists in this codebase), insert the following tab switching code. If no dedicated init function exists, append to the file *outside* any existing listeners:

```javascript
// --- Tab switching -----------------------------------------------------------
function initTabs() {
  const buttons = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      buttons.forEach((b) => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
      });
      panels.forEach((p) => {
        p.classList.toggle("active", p.id === target);
      });
      if (target === "settings") {
        _loadSettingsPanel();
      }
    });
  });
}
```

- [ ] **Step 3: Add pin picker wiring and settings loader**

Append to `static/app.js`:

```javascript
// --- Settings panel ----------------------------------------------------------
import { initPinout, getAssignments, setAssignments } from "/static/pinout.js";

let _settingsLoaded = false;
let _currentConfig = null;

async function _loadSettingsPanel() {
  // Always re-fetch config so values stay fresh when tab is re-opened.
  const cfg = await fetch("/api/config").then((r) => r.json());
  _currentConfig = cfg;
  _populateSettingsForms(cfg);

  if (!_settingsLoaded) {
    const layout = await fetch("/api/pi-info").then((r) => r.json());
    const container = document.getElementById("pinout-container");
    initPinout(
      container,
      layout,
      { fan: cfg.gpio.fan_pin, heater: cfg.gpio.heater_pin },
      () => {} // onChange: user still has to press Save GPIO to persist.
    );
    _wireSettingsForms();
    _settingsLoaded = true;
  } else {
    setAssignments({ fan: cfg.gpio.fan_pin, heater: cfg.gpio.heater_pin });
  }
}

function _populateSettingsForms(cfg) {
  // GPIO invert toggle
  document.getElementById("gpio-invert-relay").checked = !!cfg.gpio.invert_relay;

  // Fan
  document.getElementById("set-fan-threshold").value = cfg.fan.threshold;
  document.getElementById("set-fan-hysteresis").value = cfg.fan.hysteresis;
  document.getElementById("set-fan-min-on").value = cfg.fan.min_on_seconds;
  document.getElementById("set-fan-min-off").value = cfg.fan.min_off_seconds;
  document.getElementById("set-src-cpu").checked = !!cfg.fan.sources.cpu;
  document.getElementById("set-src-ssd").checked = !!cfg.fan.sources.ssd;
  document.getElementById("set-src-enclosure").checked = !!cfg.fan.sources.enclosure;

  // Heater
  document.getElementById("set-dew-margin").value = cfg.heater.dew_margin;
  document.getElementById("set-outside-threshold").value = cfg.heater.outside_temp_threshold;
  document.getElementById("set-heater-hysteresis").value = cfg.heater.hysteresis;
  document.getElementById("set-heater-min-on").value = cfg.heater.min_on_seconds;
  document.getElementById("set-heater-min-off").value = cfg.heater.min_off_seconds;
  document.getElementById("set-fan-off-when-heating").checked = !!cfg.heater.fan_off_when_heating;

  // HA
  document.getElementById("set-ha-url").value = cfg.ha.url || "";
  document.getElementById("set-ha-token").value = cfg.ha.token || "";
  document.getElementById("set-ha-temp-entity").value = cfg.ha.temp_entity_id || "";
  document.getElementById("set-ha-humid-entity").value = cfg.ha.humidity_entity_id || "";

  // AllSky
  document.getElementById("set-allsky-enabled").checked = !!(cfg.allsky && cfg.allsky.enabled);
  document.getElementById("set-allsky-output-dir").value = (cfg.allsky && cfg.allsky.output_dir) || "";

  // System
  document.getElementById("set-i2c-bus").value = cfg.i2c_bus;
  document.getElementById("set-poll-interval").value = cfg.poll_interval;
}

async function _postConfig(partial) {
  const resp = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partial),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ detail: resp.statusText }));
    alert(`Save failed: ${body.detail || resp.statusText}`);
    return null;
  }
  return resp.json();
}

function _wireSettingsForms() {
  document.getElementById("form-gpio").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const { fan, heater } = getAssignments();
    const body = {
      gpio: {
        fan_pin: fan,
        heater_pin: heater,
        invert_relay: document.getElementById("gpio-invert-relay").checked,
      },
    };
    const updated = await _postConfig(body);
    if (updated) {
      _currentConfig = updated;
      document.getElementById("gpio-restart-banner").classList.remove("hidden");
    }
  });

  document.getElementById("form-fan").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = {
      fan: {
        threshold: Number(document.getElementById("set-fan-threshold").value),
        hysteresis: Number(document.getElementById("set-fan-hysteresis").value),
        min_on_seconds: Number(document.getElementById("set-fan-min-on").value),
        min_off_seconds: Number(document.getElementById("set-fan-min-off").value),
        sources: {
          cpu: document.getElementById("set-src-cpu").checked,
          ssd: document.getElementById("set-src-ssd").checked,
          enclosure: document.getElementById("set-src-enclosure").checked,
        },
      },
    };
    const updated = await _postConfig(body);
    if (updated) _currentConfig = updated;
  });

  document.getElementById("form-heater").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = {
      heater: {
        dew_margin: Number(document.getElementById("set-dew-margin").value),
        outside_temp_threshold: Number(document.getElementById("set-outside-threshold").value),
        hysteresis: Number(document.getElementById("set-heater-hysteresis").value),
        min_on_seconds: Number(document.getElementById("set-heater-min-on").value),
        min_off_seconds: Number(document.getElementById("set-heater-min-off").value),
        fan_off_when_heating: document.getElementById("set-fan-off-when-heating").checked,
      },
    };
    const updated = await _postConfig(body);
    if (updated) _currentConfig = updated;
  });

  document.getElementById("form-ha").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = {
      ha: {
        url: document.getElementById("set-ha-url").value,
        token: document.getElementById("set-ha-token").value,
        temp_entity_id: document.getElementById("set-ha-temp-entity").value,
        humidity_entity_id: document.getElementById("set-ha-humid-entity").value,
      },
    };
    const updated = await _postConfig(body);
    if (updated) _currentConfig = updated;
  });

  document.getElementById("form-allsky").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    // allsky is not part of ConfigUpdate model yet; update via raw config.
    const body = {
      // Piggyback on the existing POST contract: send a partial allsky section
      // under a new top-level key. The backend's ConfigUpdate will need an
      // `allsky` optional field (added in Task 9).
      allsky: {
        enabled: document.getElementById("set-allsky-enabled").checked,
        output_dir: document.getElementById("set-allsky-output-dir").value,
      },
    };
    const updated = await _postConfig(body);
    if (updated) _currentConfig = updated;
  });

  document.getElementById("form-system").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = {
      i2c_bus: Number(document.getElementById("set-i2c-bus").value),
      poll_interval: Number(document.getElementById("set-poll-interval").value),
    };
    const updated = await _postConfig(body);
    if (updated) _currentConfig = updated;
  });
}

// Kick off tab wiring as soon as DOM is ready.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initTabs);
} else {
  initTabs();
}
```

- [ ] **Step 4: Remove old settings form handlers**

Search `app.js` for the old handlers that are now superseded by per-section forms:

Run: `grep -n "curve-save-btn\|heater-save-btn\|ha-save-btn\|populateConfigUI" static/app.js`

For each matched block, delete the handler and any DOM references to elements that no longer exist (the old form inputs like `#fan-hysteresis`, `#ha-url`, `#dew-margin`, etc. are now named `set-*` and live in the settings panel). Preserve:
- `fetchConfig` if it is also used by dashboard code for `gpio.fan_pin` or `gpio.heater_pin` display; otherwise delete it.
- Any mode-button handlers (`mode-btn` clicks posting to `/api/fan` and `/api/heater`).
- All canvas/sparkline rendering.
- The polling `setInterval`.

If in doubt, leave a function in place and replace its body with a no-op comment; the next task's integration check catches dead handlers.

- [ ] **Step 5: Verify file still parses**

Run: `node --check static/app.js`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add static/app.js
git commit -m "Wire tab switching, pinout picker, and per-section settings forms"
```

---

## Task 9: Extend Backend `ConfigUpdate` Model for AllSky

**Files:**
- Modify: `app.py`
- Modify: `tests/test_app_config.py`

The old `ConfigUpdate` Pydantic model does not include `allsky`, so the new AllSky settings form cannot round-trip. Extend the model and add a test.

- [ ] **Step 1: Append failing test**

Append to `tests/test_app_config.py`:

```python
def test_post_config_accepts_allsky_update(client):
    resp = client.post("/api/config", json={"allsky": {"enabled": False, "output_dir": "/tmp/allsky"}})
    assert resp.status_code == 200
    body = resp.json()
    assert body["allsky"]["enabled"] is False
    assert body["allsky"]["output_dir"] == "/tmp/allsky"
```

- [ ] **Step 2: Run failing test**

Run: `pytest tests/test_app_config.py::test_post_config_accepts_allsky_update -v`
Expected: fails because Pydantic silently drops the unknown `allsky` key (current config remains unchanged).

- [ ] **Step 3: Add `allsky` to `ConfigUpdate` in `app.py`**

Find the existing `ConfigUpdate` class in `app.py` (around line 521) and replace it with:

```python
class ConfigUpdate(BaseModel):
    fan: Optional[dict] = None
    heater: Optional[dict] = None
    gpio: Optional[dict] = None  # note: GPIO pin changes require restart
    ha: Optional[dict] = None
    allsky: Optional[dict] = None
    i2c_bus: Optional[int] = None
    poll_interval: Optional[int] = None
```

- [ ] **Step 4: Run tests — expect pass**

Run: `pytest tests/test_app_config.py -v`
Expected: all nine tests pass.

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_app_config.py
git commit -m "Accept allsky updates on /api/config"
```

---

## Task 10: Manual Verification on the Pi

**Files:** none. This task runs end-to-end on `allskypi5` to catch integration issues unit tests cannot.

- [ ] **Step 1: Run the full test suite locally**

Run: `pytest -v`
Expected: all tests pass (13 tests: 7 model detection + 5 layout + 8 config API — 8 pinout tests may differ based on exact split; confirm "all pass").

- [ ] **Step 2: Commit any fixup changes (none expected)**

- [ ] **Step 3: Deploy to the Pi**

Memory reference: deploy process is SSH as `pi@allskypi5`, service is `piweathercontrol`, port 8085. Verify the service unit still exists (`systemctl status piweathercontrol`) and that the repo checkout path on the Pi matches what the service runs.

Run (from the user's workstation):

```bash
ssh pi@allskypi5 "cd ~/PiWeatherControl && git pull && sudo systemctl restart piweathercontrol && sudo systemctl status piweathercontrol --no-pager"
```

Expected: service reports `active (running)` and no tracebacks in the last log lines.

- [ ] **Step 4: Verify Dashboard tab**

Open `http://allskypi5:8085/` in a browser. Confirm:
- Tab bar shows `Dashboard` and `Settings`.
- Dashboard is active by default.
- All six sensor cards display values within 10 seconds (CPU, SSD, Pi Fan, Enclosure BME280, Outdoor HA, Power INA260).
- Dew gauge and fan curve canvases animate.
- Event log populates.
- Fan and Heater mode buttons still toggle (check one, observe event log entry).

- [ ] **Step 5: Verify Settings tab**

Click `Settings`. Confirm:
- Six groups render in order: Hardware / GPIO, Fan Control, Dew Heater Control, Home Assistant Integration, AllSky Integration, System.
- Hardware / GPIO shows a 40-pin SVG header, BCM 20 pin yellow (FAN), BCM 21 pin yellow (HEATER), BCM 2 and 3 highlighted blue (I2C reserved).
- Model detection label shows "Raspberry Pi 5 Model B ..." (or similar) with family "pi5".
- Clicking a free green GPIO pin (e.g., BCM 16) opens a popover with `Unassigned / Fan / Heater`.

- [ ] **Step 6: Verify pin reassignment round-trip**

In the picker, assign Fan to BCM 16:
- Click BCM 16, select `Fan`, click `Apply`.
- BCM 20 returns to green, BCM 16 turns yellow with `FAN` badge.
- Click `Save GPIO`.
- Banner appears: "GPIO changes saved. Restart required: ..."

Then on the Pi:

```bash
ssh pi@allskypi5 "cat ~/PiWeatherControl/config.json | python3 -m json.tool | grep -A3 gpio"
```

Expected: `fan_pin: 16` in the file.

Restart service:

```bash
ssh pi@allskypi5 "sudo systemctl restart piweathercontrol"
```

In the browser, toggle Fan to `On`. Confirm that the fan relay wired to BCM 16 energises.

Restore the original assignment (Fan back to BCM 20) before finishing:
- Reassign in picker, Save GPIO, restart service, verify relay on BCM 20 energises.

- [ ] **Step 7: Verify invalid pin rejection**

Attempt via the browser's dev tools console:

```javascript
fetch("/api/config", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({gpio:{fan_pin:2, heater_pin:21, invert_relay:true}})}).then(r => r.json().then(b => console.log(r.status, b)));
```

Expected: status 400 with a detail mentioning I2C.

- [ ] **Step 8: Verify per-section saves are isolated**

Change `HA URL` to a placeholder and click `Save HA`. Refresh the page. Reopen Settings. Confirm only HA URL changed — fan threshold, heater margin, pin assignments, etc. are all unchanged.

- [ ] **Step 9: Record findings**

If any step fails, add a new task at the end of this plan documenting the fix, re-run from Step 1 of that task, and commit. If all steps pass, finish with:

```bash
git log --oneline -n 15
```

Confirm the commit chain: pytest infra, detect_model, pin tables, /api/pi-info, pin validation, pinout.js, index.html tabs, CSS, app.js wiring, ConfigUpdate allsky. No additional commits required unless regressions were found.

- [ ] **Step 10: Final commit (if verification produced any changes)**

```bash
git add -A
git commit -m "Integration fixes from manual Pi verification"
```

---

## Self-Review Notes

- **Spec coverage:** every section of the spec maps to a task (detection → Task 1, layout table → Task 2, `/api/pi-info` → Task 3, pin validation → Task 4, SVG picker → Task 5, tab + settings panel → Task 6, CSS → Task 7, JS wiring + tab switching + per-section saves → Task 8, AllSky in `ConfigUpdate` → Task 9, manual verification → Task 10).
- **Placeholder scan:** no TBDs; every code step shows real code or an explicit grep-and-delete instruction (Task 8 Step 4 — the one "judgment call" step, scoped to dead-handler cleanup that depends on the exact current `app.js` contents).
- **Type consistency:** backend key names align with `config.py` defaults (`fan.threshold`, `heater.dew_margin`, `gpio.fan_pin`, `gpio.heater_pin`, `gpio.invert_relay`, `allsky.enabled`, `allsky.output_dir`, `i2c_bus`, `poll_interval`). Pin picker emits `gpio.fan_pin` / `gpio.heater_pin` in line with backend validation and `gpio_control.py` wiring. `PinInfo` fields match the assertions in Task 2 tests.
