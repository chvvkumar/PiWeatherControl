"""Enclosure Controller — FastAPI application with background control loop."""

import asyncio
import collections
import json
import logging
import math
import re
import shutil
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional

from config import load_config, update_config, save_config
from sensors import read_all_sensors, init_i2c_sensors, SensorSnapshot
from gpio_control import GPIOController
import gps_reader
import pi_pinout

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
log = logging.getLogger("enclosure")

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
config = load_config()
gpio = GPIOController(
    fan_pin=config["gpio"]["fan_pin"],
    heater_pin=config["gpio"]["heater_pin"],
    fan_invert=config["gpio"].get("fan_invert", config["gpio"].get("invert_relay", True)),
    heater_invert=config["gpio"].get("heater_invert", config["gpio"].get("invert_relay", True)),
)

# Ring buffer for history: ~2 hours at 10s intervals
history: collections.deque = collections.deque(maxlen=720)

# Event log: last 100 control decisions
event_log: collections.deque = collections.deque(maxlen=100)

# Latest snapshot for API
latest_snapshot: Optional[SensorSnapshot] = None

# Smoothing buffer for debounce (last 3 readings)
_smooth_buffer: list[SensorSnapshot] = []
_SMOOTH_SIZE = 3

# Watchdog: track last successful sensor read
_last_good_read: float = time.time()
_WATCHDOG_TIMEOUT = 300  # 5 minutes


# ---------------------------------------------------------------------------
# Control logic
# ---------------------------------------------------------------------------
def _log_event(msg: str) -> None:
    entry = {"time": time.time(), "message": msg}
    event_log.append(entry)
    log.info(f"EVENT: {msg}")


def _smoothed_temps(buffer: list[SensorSnapshot]) -> dict:
    """Average temperatures from recent readings to debounce transient spikes."""
    if not buffer:
        return {"cpu": None, "ssd": None, "enclosure": None}

    def avg(vals):
        valid = [v for v in vals if v is not None]
        return round(sum(valid) / len(valid), 1) if valid else None

    return {
        "cpu": avg([s.system.cpu for s in buffer]),
        "ssd": avg([s.system.ssd for s in buffer]),
        "enclosure": avg([s.bme280.temperature for s in buffer]),
    }


def evaluate_fan(smoothed: dict, cfg: dict) -> bool:
    """Evaluate fan against a single temperature threshold. Returns desired ON state."""
    fan_cfg = cfg["fan"]
    sources = fan_cfg["sources"]
    threshold = fan_cfg.get("threshold", 45)
    hysteresis = fan_cfg.get("hysteresis", 3)

    # Get the hottest enabled source
    temps = []
    if sources.get("cpu") and smoothed["cpu"] is not None:
        temps.append(smoothed["cpu"])
    if sources.get("ssd") and smoothed["ssd"] is not None:
        temps.append(smoothed["ssd"])
    if sources.get("enclosure") and smoothed["enclosure"] is not None:
        temps.append(smoothed["enclosure"])

    if not temps:
        return False

    hottest = max(temps)

    if gpio.fan.is_on:
        return hottest >= (threshold - hysteresis)
    else:
        return hottest >= threshold


def evaluate_heater(snapshot: SensorSnapshot, cfg: dict) -> bool:
    """Evaluate dew heater logic. Returns desired ON state."""
    heater_cfg = cfg["heater"]
    hysteresis = heater_cfg.get("hysteresis", 2)
    dew_margin = heater_cfg.get("dew_margin", 5)
    outside_threshold = heater_cfg.get("outside_temp_threshold", 2)
    current_on = gpio.heater.is_on

    bme = snapshot.bme280
    outdoor = snapshot.outdoor

    enclosure_temp = bme.temperature
    enclosure_dew = bme.dew_point

    # Condition 1: Enclosure temp approaching enclosure dew point
    dew_trigger = False
    if enclosure_temp is not None and enclosure_dew is not None:
        dew_distance = enclosure_temp - enclosure_dew
        if current_on:
            dew_trigger = dew_distance < (dew_margin + hysteresis)
        else:
            dew_trigger = dew_distance < dew_margin

    # Condition 2: Enclosure temp approaching HA outdoor dew point
    outside_dew_trigger = False
    if enclosure_temp is not None and outdoor.available and outdoor.dew_point is not None:
        outside_dew_distance = enclosure_temp - outdoor.dew_point
        if current_on:
            outside_dew_trigger = outside_dew_distance < (dew_margin + hysteresis)
        else:
            outside_dew_trigger = outside_dew_distance < dew_margin

    # Condition 3: Frost protection — outside temp below threshold
    frost_trigger = False
    if outdoor.available and outdoor.temperature is not None:
        if current_on:
            frost_trigger = outdoor.temperature < (outside_threshold + hysteresis)
        else:
            frost_trigger = outdoor.temperature < outside_threshold

    return dew_trigger or outside_dew_trigger or frost_trigger


def apply_control(snapshot: SensorSnapshot, cfg: dict) -> None:
    """Run control logic and actuate relays with wear protection."""
    global _last_good_read

    # Check sensor health for watchdog
    if snapshot.bme280.error is None and snapshot.system.cpu is not None:
        _last_good_read = time.time()

    watchdog_tripped = (time.time() - _last_good_read) > _WATCHDOG_TIMEOUT

    # --- Heater control (evaluated first — may suppress fan) ---
    heater_mode = cfg["heater"]["mode"]
    heater_manual = heater_mode in ("on", "off")
    if heater_mode == "on":
        desired_heater = True
        heater_reason = "manual ON"
    elif heater_mode == "off":
        desired_heater = False
        heater_reason = "manual OFF"
    elif watchdog_tripped:
        desired_heater = False
        heater_reason = "WATCHDOG: sensors stale >5min, forcing heater OFF for safety"
    else:
        desired_heater = evaluate_heater(snapshot, cfg)
        dew_dist = None
        if snapshot.bme280.temperature and snapshot.bme280.dew_point:
            dew_dist = round(snapshot.bme280.temperature - snapshot.bme280.dew_point, 1)
        heater_reason = f"auto (dew_distance={dew_dist}, outdoor={snapshot.outdoor.temperature})"

    if desired_heater != gpio.heater.is_on:
        min_on = cfg["heater"].get("min_on_seconds", 120)
        min_off = cfg["heater"].get("min_off_seconds", 120)
        # Manual overrides bypass wear protection
        if heater_manual or gpio.can_switch(gpio.heater, min_on, min_off):
            gpio.set_heater(desired_heater)
            _log_event(f"Heater {'ON' if desired_heater else 'OFF'}: {heater_reason}")

    # --- Fan control ---
    fan_mode = cfg["fan"]["mode"]
    fan_manual = fan_mode in ("on", "off")
    if fan_mode == "on":
        desired_fan = True
        reason = "manual ON"
    elif fan_mode == "off":
        desired_fan = False
        reason = "manual OFF"
    elif watchdog_tripped:
        desired_fan = True
        reason = "WATCHDOG: sensors stale >5min, forcing fan ON for safety"
    else:
        smoothed = _smoothed_temps(_smooth_buffer)
        desired_fan = evaluate_fan(smoothed, cfg)
        reason = f"auto (hottest: CPU={smoothed['cpu']}, SSD={smoothed['ssd']}, Enc={smoothed['enclosure']})"

    # Suppress fan when heater is active to avoid blowing cold air over heated surfaces
    heater_active = desired_heater or gpio.heater.is_on
    if heater_active and cfg["heater"].get("fan_off_when_heating", True):
        if desired_fan and not fan_manual:
            desired_fan = False
            reason = "suppressed: heater active (fan_off_when_heating)"

    if desired_fan != gpio.fan.is_on:
        min_on = cfg["fan"].get("min_on_seconds", 120)
        min_off = cfg["fan"].get("min_off_seconds", 120)
        # Manual overrides bypass wear protection
        if fan_manual or gpio.can_switch(gpio.fan, min_on, min_off):
            gpio.set_fan(desired_fan)
            _log_event(f"Fan {'ON' if desired_fan else 'OFF'}: {reason}")


# ---------------------------------------------------------------------------
# Pi system status helpers
# ---------------------------------------------------------------------------
def _vcgencmd(cmd: str) -> str:
    """Run a vcgencmd command and return its stdout, or empty string on failure."""
    try:
        result = subprocess.run(
            ["vcgencmd", cmd] if " " not in cmd else ["vcgencmd"] + cmd.split(),
            capture_output=True, text=True, timeout=5,
        )
        return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return ""


def _parse_vcgencmd_value(raw: str) -> str:
    """Extract the value after '=' from vcgencmd output like 'temp=34.5'C'."""
    if "=" in raw:
        return raw.split("=", 1)[1]
    return raw


def _collect_pi_status(snapshot: SensorSnapshot) -> dict:
    """Gather disk, CPU temp, throttle, clock, and voltage data for pistatus.json."""
    # --- Disk usage ---
    try:
        usage = shutil.disk_usage("/")
        total = f"{usage.total / (1024 ** 3):.2f}G"
        used = f"{usage.used / (1024 ** 3):.2f}G"
        free = f"{usage.free / (1024 ** 3):.2f}G"
    except Exception:
        total = used = free = "N/A"

    # --- CPU temp ---
    cpu_temp = str(snapshot.system.cpu) if snapshot.system.cpu is not None else "0"

    # --- Throttle status ---
    throttled_raw = _vcgencmd("get_throttled")
    throttled_hex = _parse_vcgencmd_value(throttled_raw) if throttled_raw else "0x0"
    try:
        throttle_bits = int(throttled_hex, 16)
    except ValueError:
        throttle_bits = 0

    # --- Clock speeds (GHz) ---
    clock_names = ["arm", "core", "isp", "v3d", "uart", "pwm", "emmc", "pixel", "vec", "hdmi", "dpi"]
    clocks = {}
    for name in clock_names:
        raw = _vcgencmd(f"measure_clock {name}")
        val = _parse_vcgencmd_value(raw)
        try:
            # vcgencmd returns frequency in Hz, convert to GHz
            hz = int(val.rstrip("'\""))
            clocks[name] = hz / 1_000_000_000.0
        except (ValueError, AttributeError):
            clocks[name] = 0.0

    # --- Voltages ---
    voltage_names = ["core", "sdram_c", "sdram_i", "sdram_p"]
    voltages = {}
    for name in voltage_names:
        raw = _vcgencmd(f"measure_volts {name}")
        val = _parse_vcgencmd_value(raw)
        try:
            voltages[name] = float(val.rstrip("V'\""))
        except (ValueError, AttributeError):
            voltages[name] = 0.0

    return {
        "AS_DISKSIZE": total,
        "AS_DISKUSAGE": used,
        "AS_DISKFREE": free,
        "AS_CPUTEMP": cpu_temp,
        "AS_THROTTLEDBINARY": throttled_hex,
        "AS_TSTAT0": str(bool(throttle_bits & (1 << 0))),
        "AS_TSTAT1": str(bool(throttle_bits & (1 << 1))),
        "AS_TSTAT2": str(bool(throttle_bits & (1 << 2))),
        "AS_TSTAT3": str(bool(throttle_bits & (1 << 3))),
        "AS_TSTAT16": str(bool(throttle_bits & (1 << 16))),
        "AS_TSTAT17": str(bool(throttle_bits & (1 << 17))),
        "AS_TSTAT18": str(bool(throttle_bits & (1 << 18))),
        "AS_TSTAT19": str(bool(throttle_bits & (1 << 19))),
        "AS_TSTATSUMARYTEXT": _throttle_summary(throttle_bits),
        "AS_CLOCKARM": str(clocks["arm"]),
        "AS_CLOCKCORE": str(clocks["core"]),
        "AS_CLOCKISP": str(clocks["isp"]),
        "AS_CLOCKV3D": str(clocks["v3d"]),
        "AS_CLOCKUART": str(clocks["uart"]),
        "AS_CLOCKPWM": str(clocks["pwm"]),
        "AS_CLOCKEMMC": str(clocks["emmc"]),
        "AS_CLOCKPIXEL": str(clocks["pixel"]),
        "AS_CLOCKVEC": str(clocks["vec"]),
        "AS_CLOCKHDMI": str(clocks["hdmi"]),
        "AS_CLOCKDPI": str(clocks["dpi"]),
        "AS_VOLTAGECORE": str(voltages["core"]),
        "AS_VOLTAGESDRAM_C": str(voltages["sdram_c"]),
        "AS_VOLTAGESDRAM_I": str(voltages["sdram_i"]),
        "AS_VOLTAGESDRAM_P": str(voltages["sdram_p"]),
    }


def _throttle_summary(bits: int) -> str:
    """Build a human-readable summary of throttle flags, empty if none set."""
    flags = []
    if bits & (1 << 0):
        flags.append("Under-voltage detected")
    if bits & (1 << 1):
        flags.append("Arm frequency capped")
    if bits & (1 << 2):
        flags.append("Currently throttled")
    if bits & (1 << 3):
        flags.append("Soft temperature limit active")
    if bits & (1 << 16):
        flags.append("Under-voltage has occurred")
    if bits & (1 << 17):
        flags.append("Arm frequency capping has occurred")
    if bits & (1 << 18):
        flags.append("Throttling has occurred")
    if bits & (1 << 19):
        flags.append("Soft temperature limit has occurred")
    return ", ".join(flags)


# ---------------------------------------------------------------------------
# Allsky overlay JSON writer
# ---------------------------------------------------------------------------
def _atomic_write_json(path: Path, data: dict) -> None:
    """Write JSON to ``path`` atomically.

    Allsky's overlay loader and ``allsky_publishdata`` poll these files on
    every capture cycle. A plain ``Path.write_text`` truncates the file
    before writing, which leaves a brief window where readers see a
    zero-byte file and raise ``json.JSONDecodeError`` ("is invalid -
    IGNORING"). Writing to a sibling ``*.tmp`` and renaming via
    ``Path.replace`` is atomic on POSIX, so readers always see either the
    previous full file or the new one.
    """
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=4) + "\n")
    tmp.replace(path)


def write_allsky_files(snapshot: SensorSnapshot, cfg: dict) -> None:
    """Write allskydew.json and allskyfans.json for the Allsky overlay system."""
    allsky_cfg = cfg.get("allsky", {})
    if not allsky_cfg.get("enabled", False):
        return

    output_dir = Path(allsky_cfg.get("output_dir", "/home/pi/allsky/config/overlay/extra"))
    if not output_dir.exists():
        log.warning(f"Allsky output dir does not exist: {output_dir}")
        return

    bme = snapshot.bme280
    fan_cfg = cfg["fan"]

    # --- allskydew.json ---
    pressure = bme.pressure if bme.pressure is not None else 0
    humidity = bme.humidity if bme.humidity is not None else 0
    altitude = 44330.0 * (1.0 - (pressure / 1013.25) ** (1.0 / 5.255)) if pressure > 0 else 0

    dew_data = {
        "AS_DEWCONTROLSENSOR": "BME280-I2C",
        "AS_DEWCONTROLAMBIENT": str(bme.temperature) if bme.temperature is not None else "0",
        "AS_DEWCONTROLDEW": str(bme.dew_point) if bme.dew_point is not None else "0",
        "AS_DEWCONTROLHUMIDITY": str(bme.humidity) if bme.humidity is not None else "0",
        "AS_DEWCONTROLHEATER": "On" if gpio.heater.is_on else "Off",
        "AS_DEWCONTROLPRESSURE": pressure,
        "AS_DEWCONTROLRELHUMIDITY": humidity,
        "AS_DEWCONTROLALTITUDE": altitude,
    }

    # --- allskyfans.json ---
    fan_threshold = fan_cfg.get("threshold", 45)

    fan_data = {
        "OTH_FANS": "On" if gpio.fan.is_on else "Off",
        "OTH_FANT": fan_threshold,
        "OTH_USE_PWM": "No",
        "OTH_PWM_ENABLED": "No",
        "OTH_PWM_DUTY_CYCLE": 0,
        "OTH_TEMPERATURE": bme.temperature if bme.temperature is not None else 0,
    }

    # --- allskytemp.json ---
    temp_data = {
        "AS_GPIOSTATE1": "N/A",
        "AS_TEMPSENSOR1": "BME280-I2C",
        "AS_TEMPSENSORNAME1": "BME280_Box_",
        "AS_TEMPAMBIENT1": str(bme.temperature) if bme.temperature is not None else "0",
        "AS_TEMPDEW1": str(bme.dew_point) if bme.dew_point is not None else "0",
        "AS_TEMPHUMIDITY1": str(bme.humidity) if bme.humidity is not None else "0",
        "AS_TEMPPRESSURE1": pressure,
        "AS_TEMPRELHUMIDITY1": humidity,
        "AS_TEMPALTITUDE1": altitude,
    }

    # --- pistatus.json ---
    pi_data = _collect_pi_status(snapshot)

    try:
        _atomic_write_json(output_dir / "allskytemp.json", temp_data)
    except Exception as e:
        log.warning(f"Failed to write allskytemp.json: {e}")

    try:
        _atomic_write_json(output_dir / "pistatus.json", pi_data)
    except Exception as e:
        log.warning(f"Failed to write pistatus.json: {e}")

    try:
        _atomic_write_json(output_dir / "allskydew.json", dew_data)
    except Exception as e:
        log.warning(f"Failed to write allskydew.json: {e}")

    try:
        _atomic_write_json(output_dir / "allskyfans.json", fan_data)
    except Exception as e:
        log.warning(f"Failed to write allskyfans.json: {e}")


# ---------------------------------------------------------------------------
# Background loop
# ---------------------------------------------------------------------------
async def control_loop() -> None:
    """Main sensor read + control loop, runs forever."""
    global latest_snapshot, config
    log.info("Control loop started")

    while True:
        try:
            config = load_config()
            snapshot = await read_all_sensors(config)
            latest_snapshot = snapshot

            # Update smoothing buffer
            _smooth_buffer.append(snapshot)
            if len(_smooth_buffer) > _SMOOTH_SIZE:
                _smooth_buffer.pop(0)

            # Store history
            history.append(snapshot.to_dict())

            # Run control
            apply_control(snapshot, config)

            # Write allsky overlay files
            write_allsky_files(snapshot, config)

        except Exception as e:
            log.error(f"Control loop error: {e}", exc_info=True)

        await asyncio.sleep(config.get("poll_interval", 10))


# ---------------------------------------------------------------------------
# FastAPI lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    init_i2c_sensors(config.get("i2c_bus", 1))
    gpio.init()
    _log_event("Enclosure controller started")
    task = asyncio.create_task(control_loop())
    gps_task = asyncio.create_task(gps_sample_loop())
    yield
    # Shutdown
    task.cancel()
    gps_task.cancel()
    _save_gps_stats()
    gpio.cleanup()
    _log_event("Enclosure controller stopped")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="Enclosure Controller", lifespan=lifespan)

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# --- Routes ---


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/status")
async def get_status():
    snap = latest_snapshot.to_dict() if latest_snapshot else {}
    return {
        "sensors": snap,
        "relays": gpio.status(),
        "modes": {
            "fan": config["fan"]["mode"],
            "heater": config["heater"]["mode"],
        },
    }


@app.get("/api/config")
async def get_config():
    return config


@app.get("/api/pi-info")
async def get_pi_info():
    return pi_pinout.get_layout(config.get("i2c_bus", 1))


class ConfigUpdate(BaseModel):
    fan: Optional[dict] = None
    heater: Optional[dict] = None
    gpio: Optional[dict] = None  # note: GPIO pin changes require restart
    ha: Optional[dict] = None
    allsky: Optional[dict] = None
    i2c_bus: Optional[int] = None
    poll_interval: Optional[int] = None


def _validate_gpio_update(gpio_update: dict, current_gpio: dict, i2c_bus: int) -> Optional[str]:
    """Return an error message if gpio_update is invalid, else None.

    Accepts a partial gpio dict (any of fan_pin, heater_pin, invert_relay). Validates
    BCM numbers against the detected Pi layout and rejects I2C-reserved pins and
    collisions where fan_pin == heater_pin after the update is applied.
    """
    layout = pi_pinout.get_layout(i2c_bus)
    valid_bcms = {p["bcm"]: p for p in layout["pins"] if p["bcm"] is not None and p["type"] == "gpio"}

    merged = {**current_gpio, **gpio_update}
    fan_pin = merged.get("fan_pin")
    heater_pin = merged.get("heater_pin")

    for label, pin in (("fan_pin", fan_pin), ("heater_pin", heater_pin)):
        if pin is None or not isinstance(pin, int):
            return f"{label} must be an integer BCM GPIO number"
        if pin not in valid_bcms:
            return f"{label}={pin} is not a usable BCM GPIO on this Pi"
        info = valid_bcms[pin]
        if info["reserved"]:
            return f"{label}={pin} is reserved: {info['reserved_reason']}"

    if fan_pin == heater_pin:
        return f"fan_pin and heater_pin cannot be the same (both {fan_pin})"

    return None


@app.post("/api/config")
async def post_config(body: ConfigUpdate):
    global config
    updates = {k: v for k, v in body.model_dump().items() if v is not None}

    if "gpio" in updates:
        i2c_bus = updates.get("i2c_bus", config.get("i2c_bus", 1))
        error = _validate_gpio_update(updates["gpio"], config.get("gpio", {}), i2c_bus)
        if error is not None:
            return JSONResponse({"detail": error}, 400)

    config = update_config(updates)
    _log_event(f"Config updated: {list(updates.keys())}")
    if latest_snapshot:
        apply_control(latest_snapshot, config)
    return config


class ModeUpdate(BaseModel):
    mode: str  # "auto", "on", "off"


@app.post("/api/fan")
async def set_fan_mode(body: ModeUpdate):
    global config
    if body.mode not in ("auto", "on", "off"):
        return JSONResponse({"error": "mode must be auto, on, or off"}, 400)
    config["fan"]["mode"] = body.mode
    save_config(config)
    _log_event(f"Fan mode set to {body.mode}")
    if latest_snapshot:
        apply_control(latest_snapshot, config)
    return {"fan_mode": body.mode}


@app.post("/api/heater")
async def set_heater_mode(body: ModeUpdate):
    global config
    if body.mode not in ("auto", "on", "off"):
        return JSONResponse({"error": "mode must be auto, on, or off"}, 400)
    config["heater"]["mode"] = body.mode
    save_config(config)
    _log_event(f"Heater mode set to {body.mode}")
    if latest_snapshot:
        apply_control(latest_snapshot, config)
    return {"heater_mode": body.mode}


_gps_peaks = {"sats_used": 0, "sats_visible": 0, "since": time.time()}

# Long-term GPS stats: sampled by a background task so they accumulate
# 24/7, independent of whether the web panel is open.
GPS_SAMPLE_S = 30
gps_history: collections.deque = collections.deque(maxlen=2880)  # 24 h at 30 s
_gps_sky: dict = {}  # "azbin,elbin" (10 deg cells) -> [seen, used, snr_sum]
_gps_resets: dict = {}  # metric -> unix time of last manual reset (history-derived metrics ignore older rows)
GPS_RESETTABLE = {"peaks", "drift", "sky", "sats", "hdop", "fix"}
_GPS_STATS_FILE = Path(__file__).parent / "gps_stats.json"


def _load_gps_stats() -> None:
    try:
        d = json.loads(_GPS_STATS_FILE.read_text())
        _gps_sky.update(d.get("sky", {}))
        gps_history.extend(d.get("history", []))
        _gps_peaks.update(d.get("peaks", {}))
        _gps_resets.update(d.get("resets", {}))
    except (OSError, ValueError):
        pass


def _save_gps_stats() -> None:
    try:
        _atomic_write_json(_GPS_STATS_FILE, {
            "sky": _gps_sky, "history": list(gps_history), "peaks": _gps_peaks,
            "resets": _gps_resets,
        })
    except OSError as e:
        log.warning(f"Failed to persist GPS stats: {e}")


def _record_gps_sample(g: dict) -> None:
    _gps_peaks["sats_used"] = max(_gps_peaks["sats_used"], g["sats_used"])
    _gps_peaks["sats_visible"] = max(_gps_peaks["sats_visible"], g["sats_visible"])
    gps_history.append({
        "t": round(time.time()), "mode": g["mode"],
        "used": g["sats_used"], "vis": g["sats_visible"], "hdop": g["hdop"],
        "lat": round(g["lat"], 7) if g["lat"] is not None else None,
        "lon": round(g["lon"], 7) if g["lon"] is not None else None,
    })
    for s in g["satellites"]:
        # SBAS birds are geostationary: same cell every sample, never used in
        # the fix, so they would swamp the coverage map with a fake dead spot.
        if s["az"] is None or s["el"] is None or s["el"] < 0 or s["gnss"] == "SBAS":
            continue  # below-horizon entries would land in a negative elevation bin
        key = f"{int(s['az'] // 10) % 36},{min(8, int(s['el'] // 10))}"
        c = _gps_sky.setdefault(key, [0, 0, 0.0])
        c[0] += 1
        c[1] += 1 if s["used"] else 0
        c[2] += s["snr"] or 0.0


_gps_ttff: dict | None = None


def _parse_ttff(out: str) -> dict | None:
    """Extract ttff/msss (ms) from ubxtool UBX-NAV-STATUS output."""
    m = re.search(r"ttff (\d+), msss (\d+)", out)
    if m:
        return {"ttff_s": int(m.group(1)) / 1000, "uptime_s": int(m.group(2)) / 1000}
    return None


def _read_receiver_ttff() -> dict | None:
    """Receiver-reported time to first fix. Static until the receiver resets."""
    try:
        out = subprocess.run(
            ["ubxtool", "-w", "3", "-p", "NAV-STATUS"],
            capture_output=True, text=True, timeout=15,
        ).stdout
        return _parse_ttff(out)
    except (OSError, subprocess.TimeoutExpired):
        return None


async def gps_sample_loop() -> None:
    global _gps_ttff
    _load_gps_stats()
    n = 0
    while True:
        try:
            raw = await asyncio.to_thread(gps_reader.read_gpsd)
            _record_gps_sample(gps_reader.summarize(raw))
        except OSError:
            gps_history.append({"t": round(time.time()), "mode": 0, "used": 0, "vis": 0, "hdop": None})
        except Exception as e:
            log.warning(f"GPS sample loop error: {e}")
        if n % 120 == 0:  # at start, then hourly — it only changes on receiver reset
            _gps_ttff = await asyncio.to_thread(_read_receiver_ttff) or _gps_ttff
        n += 1
        if n % 20 == 0:  # persist every 10 min
            _save_gps_stats()
        await asyncio.sleep(GPS_SAMPLE_S)


@app.get("/api/gps")
async def get_gps():
    try:
        raw = await asyncio.to_thread(gps_reader.read_gpsd)
    except OSError as e:
        return JSONResponse({"error": f"gpsd unavailable: {e}"}, 503)
    data = gps_reader.summarize(raw)
    _gps_peaks["sats_used"] = max(_gps_peaks["sats_used"], data["sats_used"])
    _gps_peaks["sats_visible"] = max(_gps_peaks["sats_visible"], data["sats_visible"])
    data["max_sats_used"] = _gps_peaks["sats_used"]
    data["max_sats_visible"] = _gps_peaks["sats_visible"]
    data["peaks_since"] = _gps_peaks["since"]
    data["ttff"] = _gps_ttff
    return data


@app.get("/api/gps/stats")
async def get_gps_stats():
    """24 h satellite/DOP history and sky-coverage bins from the sampler."""
    return {"history": list(gps_history), "sky": _gps_sky, "sample_s": GPS_SAMPLE_S, "resets": _gps_resets}


@app.post("/api/gps/reset/{metric}")
async def reset_gps_metric(metric: str):
    if metric not in GPS_RESETTABLE:
        return JSONResponse({"error": f"unknown metric; one of {sorted(GPS_RESETTABLE)}"}, 400)
    now = time.time()
    if metric == "peaks":
        _gps_peaks.update({"sats_used": 0, "sats_visible": 0, "since": now})
    elif metric == "sky":
        _gps_sky.clear()
    _gps_resets[metric] = now
    _save_gps_stats()
    _log_event(f"GPS metric reset: {metric}")
    return {"reset": metric, "at": now}


@app.get("/api/history")
async def get_history():
    return list(history)


@app.get("/api/events")
async def get_events():
    return list(event_log)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8085)
