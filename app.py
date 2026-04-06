"""Enclosure Controller — FastAPI application with background control loop."""

import asyncio
import collections
import logging
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
    invert=config["gpio"]["invert_relay"],
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
    """Evaluate fan curve against smoothed temperatures. Returns desired ON state."""
    fan_cfg = cfg["fan"]
    sources = fan_cfg["sources"]
    curve = sorted(fan_cfg.get("curve", []), key=lambda p: p["temp"])

    if not curve:
        return False

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
    hysteresis = fan_cfg.get("hysteresis", 3)
    current_on = gpio.fan.is_on

    # Find the highest curve breakpoint that the temperature exceeds
    should_on = False
    for point in curve:
        threshold = point["temp"]
        if current_on:
            # Already on — need to drop below threshold - hysteresis to turn off
            if hottest >= (threshold - hysteresis):
                should_on = True
        else:
            # Currently off — need to exceed threshold to turn on
            if hottest >= threshold:
                should_on = True

    return should_on


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
    yield
    # Shutdown
    task.cancel()
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


class ConfigUpdate(BaseModel):
    fan: Optional[dict] = None
    heater: Optional[dict] = None
    gpio: Optional[dict] = None  # note: GPIO pin changes require restart
    ha: Optional[dict] = None
    i2c_bus: Optional[int] = None
    poll_interval: Optional[int] = None


@app.post("/api/config")
async def post_config(body: ConfigUpdate):
    global config
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
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
