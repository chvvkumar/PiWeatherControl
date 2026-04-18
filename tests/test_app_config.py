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


def test_post_config_accepts_allsky_update(client):
    resp = client.post("/api/config", json={"allsky": {"enabled": False, "output_dir": "/tmp/allsky"}})
    assert resp.status_code == 200
    body = resp.json()
    assert body["allsky"]["enabled"] is False
    assert body["allsky"]["output_dir"] == "/tmp/allsky"
