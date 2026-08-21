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
