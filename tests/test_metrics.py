"""Prometheus /metrics exposition."""
from sensors import SensorSnapshot, INA260Reading, BME280Reading


def test_metrics_exposes_power_and_relays(client, monkeypatch):
    import app as app_module

    snap = SensorSnapshot(
        timestamp=1700000000.0,
        ina260=INA260Reading(voltage=12.03, current=0.576, power=6.92),
        bme280=BME280Reading(error="boom"),
    )
    monkeypatch.setattr(app_module, "latest_snapshot", snap)

    r = client.get("/metrics")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    body = r.text
    assert "piweathercontrol_ina260_voltage_volts 12.03\n" in body
    assert "piweathercontrol_ina260_current_amps 0.576\n" in body
    assert "piweathercontrol_ina260_power_watts 6.92\n" in body
    # bme280 had no values: no gauge lines, but the error flag is set
    assert "piweathercontrol_bme280_temperature_celsius" not in body
    assert 'piweathercontrol_sensor_error{sensor="bme280"} 1\n' in body
    assert 'piweathercontrol_sensor_error{sensor="ina260"} 0\n' in body
    assert 'piweathercontrol_relay_on{relay="fan"} 0\n' in body
    assert 'piweathercontrol_relay_cycles_total{relay="heater"} 0\n' in body


def test_metrics_before_first_sample(client, monkeypatch):
    import app as app_module

    monkeypatch.setattr(app_module, "latest_snapshot", None)
    r = client.get("/metrics")
    assert r.status_code == 200
    assert "piweathercontrol_ina260" not in r.text
    assert "piweathercontrol_relay_on" in r.text


def test_read_camera_temp(tmp_path):
    import json, os, time
    from sensors import read_camera_temp

    f = tmp_path / "allsky_camera.json"
    f.write_text(json.dumps({"AS_TEMPERATURE_C": {"value": 17.34}}))
    assert read_camera_temp(str(f)) == 17.3

    f.write_text("{ truncated")  # Allsky mid-write
    assert read_camera_temp(str(f)) is None

    f.write_text(json.dumps({"AS_TEMPERATURE_C": {"value": 17.34}}))
    old = time.time() - 3600  # capture stopped
    os.utime(f, (old, old))
    assert read_camera_temp(str(f)) is None
