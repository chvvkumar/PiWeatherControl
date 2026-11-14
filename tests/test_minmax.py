"""Persistent min/max store and its API."""
import minmax
from minmax import MinMaxStore

T0 = 1_700_000_000  # arbitrary fixed clock


def test_ranges_and_persistence(tmp_path):
    db = tmp_path / "mm.db"
    s = MinMaxStore(db)
    s.record({"cpu": 50.0, "ssd": None}, now=T0 - 3 * 86400)  # 3 days ago
    s.record({"cpu": 30.0}, now=T0 - 2 * 3600)                # 2 hours ago
    s.record({"cpu": 40.0}, now=T0 - 60)                      # just now
    s.record({"cpu": 42.0}, now=T0)

    assert s.query("1h", now=T0) == {"cpu": [40.0, 42.0]}
    assert s.query("6h", now=T0) == {"cpu": [30.0, 42.0]}
    assert s.query("7d", now=T0) == {"cpu": [30.0, 50.0]}
    assert s.query("all", now=T0) == {"cpu": [30.0, 50.0]}

    # Survives a restart once flushed, and later samples widen the same bucket.
    s.flush()
    s2 = MinMaxStore(db)
    assert s2.query("all", now=T0) == {"cpu": [30.0, 50.0]}
    s2.record({"cpu": 45.0}, now=T0 + 1)
    s2.flush()
    assert MinMaxStore(db).query("1h", now=T0 + 1) == {"cpu": [40.0, 45.0]}


def test_api(client, monkeypatch, tmp_path):
    import app as app_module

    store = MinMaxStore(tmp_path / "mm.db")
    store.record({"cpu_temperature_celsius": 33.0})
    monkeypatch.setattr(app_module, "minmax_store", store)

    for key in minmax.RANGES:
        r = client.get(f"/api/minmax?range={key}")
        assert r.status_code == 200
        assert r.json()["values"] == {"cpu_temperature_celsius": [33.0, 33.0]}
    assert client.get("/api/minmax?range=bogus").status_code == 400
