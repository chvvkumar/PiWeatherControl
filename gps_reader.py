"""Minimal gpsd client: read latest TPV/SKY reports over TCP and summarize.

Talks to gpsd's JSON protocol on localhost:2947 with a short-lived socket.
No dependency on the gpsd Python bindings.
"""
import json
import socket
import time

GNSS_NAMES = {0: "GPS", 1: "SBAS", 2: "GAL", 3: "BDS", 4: "IMES", 5: "QZSS", 6: "GLO", 7: "IRN"}
FIX_MODES = {0: "Unknown", 1: "No Fix", 2: "2D", 3: "3D"}


def read_gpsd(host: str = "127.0.0.1", port: int = 2947, timeout: float = 3.0) -> dict:
    """Return {"tpv": ..., "sky": ...} with the latest reports, or raise OSError.

    Opens a socket, enables WATCH, and reads until it has seen both a TPV and a
    SKY-with-satellites report or the timeout expires. gpsd emits both about
    once per second, so this normally returns in ~1s.
    """
    tpv = sky = None
    deadline = time.monotonic() + timeout
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.sendall(b'?WATCH={"enable":true,"json":true}\n')
        sock.settimeout(1.0)
        buf = b""
        while time.monotonic() < deadline and not (tpv and sky):
            try:
                chunk = sock.recv(65536)
            except socket.timeout:
                continue
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                try:
                    report = json.loads(line)
                except ValueError:
                    continue
                cls = report.get("class")
                if cls == "TPV":
                    tpv = report
                elif cls == "SKY" and report.get("satellites"):
                    sky = report
    return {"tpv": tpv, "sky": sky}


def dedupe_satellites(sats: list) -> list:
    """One entry per satellite; multi-band receivers (e.g. NEO-F10N L1+L5)
    report duplicate PRN entries per signal. Prefer the used entry, then max SNR."""
    best = {}
    for s in sats:
        key = (s.get("gnssid"), s.get("svid"), s.get("PRN"))
        prev = best.get(key)
        rank = (bool(s.get("used")), s.get("ss") or 0.0)
        if prev is None or rank > (bool(prev.get("used")), prev.get("ss") or 0.0):
            best[key] = s
    return sorted(best.values(), key=lambda s: -(s.get("ss") or 0.0))


def summarize(raw: dict) -> dict:
    """Flatten raw TPV/SKY reports into the /api/gps response shape."""
    tpv = raw.get("tpv") or {}
    sky = raw.get("sky") or {}
    sats = dedupe_satellites(sky.get("satellites") or [])
    mode = tpv.get("mode", 0)
    return {
        "fix": FIX_MODES.get(mode, "Unknown"),
        "mode": mode,
        "time": tpv.get("time"),
        "lat": tpv.get("lat"),
        "lon": tpv.get("lon"),
        "alt_msl": tpv.get("altMSL"),
        "speed": tpv.get("speed"),
        "eph": tpv.get("eph"),
        "epv": tpv.get("epv"),
        "hdop": sky.get("hdop"),
        "vdop": sky.get("vdop"),
        "pdop": sky.get("pdop"),
        "sats_visible": len(sats),
        "sats_used": sum(1 for s in sats if s.get("used")),
        "satellites": [
            {
                "prn": s.get("PRN"),
                "gnss": GNSS_NAMES.get(s.get("gnssid"), "?"),
                "az": s.get("az"),
                "el": s.get("el"),
                "snr": s.get("ss"),
                "used": bool(s.get("used")),
            }
            for s in sats
        ],
    }
