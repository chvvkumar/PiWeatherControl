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
