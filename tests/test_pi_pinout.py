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
    # 40-pin Pis expose 28 GPIO pins on the header (including BCM 0/1 reserved for HAT ID EEPROM).
    assert len(gpios) == 28
    bcms = {p["bcm"] for p in gpios}
    # Common user pins must be present.
    for bcm in (4, 17, 18, 20, 21, 22, 23, 24, 25, 27):
        assert bcm in bcms
