"""Tests for gps_reader parsing and satellite dedupe."""
import gps_reader


def _sat(prn, gnssid=0, svid=None, az=100.0, el=45.0, ss=25.0, used=True, sigid=None):
    s = {"PRN": prn, "gnssid": gnssid, "svid": svid or prn, "az": az, "el": el, "ss": ss, "used": used}
    if sigid is not None:
        s["sigid"] = sigid
    return s


def test_dedupe_prefers_used_then_snr():
    # NEO-F10N reports L1 and L5 signals as duplicate PRN entries
    sats = [
        _sat(7, ss=0.0, used=False, sigid=7),   # L5 signal, no lock
        _sat(7, ss=26.0, used=True),            # L1 signal, used in fix
        _sat(14, ss=10.0, used=False, sigid=7),
        _sat(14, ss=19.0, used=False),          # higher SNR wins when neither used
    ]
    out = gps_reader.dedupe_satellites(sats)
    assert len(out) == 2
    by_prn = {s["PRN"]: s for s in out}
    assert by_prn[7]["ss"] == 26.0 and by_prn[7]["used"]
    assert by_prn[14]["ss"] == 19.0


def test_summarize_3d_fix():
    raw = {
        "tpv": {"mode": 3, "time": "2026-08-21T02:41:07.000Z", "lat": 38.7582836,
                "lon": -90.6894746, "altMSL": 158.753, "speed": 0.013,
                "eph": 26.249, "epv": 29.762},
        "sky": {"hdop": 1.12, "vdop": 1.38, "pdop": 1.78, "satellites": [
            _sat(7, gnssid=0, ss=26.0, used=True),
            _sat(307, gnssid=2, svid=7, ss=28.0, used=True),
            _sat(44, gnssid=1, svid=131, ss=0.0, used=False),
        ]},
    }
    out = gps_reader.summarize(raw)
    assert out["fix"] == "3D"
    assert out["lat"] == 38.7582836
    assert out["sats_used"] == 2
    assert out["sats_visible"] == 3
    assert out["hdop"] == 1.12
    gnss = {s["prn"]: s["gnss"] for s in out["satellites"]}
    assert gnss[7] == "GPS" and gnss[307] == "GAL" and gnss[44] == "SBAS"


def test_summarize_no_data():
    out = gps_reader.summarize({"tpv": None, "sky": None})
    assert out["fix"] == "Unknown"
    assert out["lat"] is None
    assert out["sats_visible"] == 0
    assert out["satellites"] == []


def _raw_with_sats(n_used, n_visible):
    sats = [_sat(i + 1, ss=25.0, used=i < n_used) for i in range(n_visible)]
    return {"tpv": {"mode": 3}, "sky": {"satellites": sats}}


def test_record_gps_sample_bins_and_history(client):
    import app as app_module

    app_module.gps_history.clear()
    app_module._gps_sky.clear()
    g = gps_reader.summarize(_raw_with_sats(3, 5))
    app_module._record_gps_sample(g)

    assert len(app_module.gps_history) == 1
    row = app_module.gps_history[0]
    assert row["used"] == 3 and row["vis"] == 5 and row["mode"] == 3
    # lat/lon carried in history so the drift plot survives restarts
    assert "lat" in row and "lon" in row
    # all test sats share az=100 el=45 -> single bin "10,4"
    assert list(app_module._gps_sky.keys()) == ["10,4"]
    seen, used, snr_sum = app_module._gps_sky["10,4"]
    assert (seen, used) == (5, 3)
    assert snr_sum == 5 * 25.0

    resp = client.get("/api/gps/stats").json()
    assert resp["history"][0]["used"] == 3
    assert resp["sky"]["10,4"][0] == 5


def test_parse_ttff(client):
    import app as app_module

    out = "UBX-NAV-STATUS:\n  iTOW 495101000 gpsFix 3 flags 0xdd fixStat 0x0 flags2 0x8\n  ttff 692457, msss 68425473\n"
    parsed = app_module._parse_ttff(out)
    assert parsed == {"ttff_s": 692.457, "uptime_s": 68425.473}
    assert app_module._parse_ttff("no ubx data") is None


def test_gps_peaks_accumulate(client, monkeypatch):
    import app as app_module

    monkeypatch.setitem(app_module._gps_peaks, "sats_used", 0)
    monkeypatch.setitem(app_module._gps_peaks, "sats_visible", 0)

    monkeypatch.setattr(gps_reader, "read_gpsd", lambda: _raw_with_sats(8, 14))
    body = client.get("/api/gps").json()
    assert body["max_sats_used"] == 8
    assert body["max_sats_visible"] == 14

    # Fewer sats now — peaks must hold
    monkeypatch.setattr(gps_reader, "read_gpsd", lambda: _raw_with_sats(3, 5))
    body = client.get("/api/gps").json()
    assert body["sats_used"] == 3
    assert body["max_sats_used"] == 8
    assert body["max_sats_visible"] == 14
    assert body["peaks_since"] > 0
