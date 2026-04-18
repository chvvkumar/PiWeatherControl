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
