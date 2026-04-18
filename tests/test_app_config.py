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
