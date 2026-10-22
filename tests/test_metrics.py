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
