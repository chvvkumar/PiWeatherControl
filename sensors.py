"""Sensor reading module — direct I2C, sysfs, and Home Assistant REST API.

On non-Linux platforms (Windows dev), returns mock data.
"""

import glob
import math
import time
import logging
from dataclasses import dataclass, field, asdict
from typing import Optional

import httpx

log = logging.getLogger("enclosure.sensors")

# ---------------------------------------------------------------------------
# Try to import Pi-specific libraries; fall back to mock on Windows
# ---------------------------------------------------------------------------
_HW_AVAILABLE = False
_bme280_sensor = None
_ina260_sensor = None

try:
    import board
    import busio
    from adafruit_bme280 import basic as adafruit_bme280
    from adafruit_ina260 import INA260

    _HW_AVAILABLE = True
except ImportError:
    log.info("Hardware I2C libraries not available — using mock sensors")


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
@dataclass
class BME280Reading:
    temperature: Optional[float] = None   # °C
    humidity: Optional[float] = None      # %RH
    pressure: Optional[float] = None      # hPa
    dew_point: Optional[float] = None     # °C
    error: Optional[str] = None


@dataclass
class INA260Reading:
    voltage: Optional[float] = None       # V
    current: Optional[float] = None       # A
    power: Optional[float] = None         # W
    error: Optional[str] = None


@dataclass
class SystemTemps:
    cpu: Optional[float] = None           # °C
    ssd: Optional[float] = None           # °C


@dataclass
class HAOutdoor:
    temperature: Optional[float] = None   # °C
    humidity: Optional[float] = None      # %RH
    dew_point: Optional[float] = None     # °C
    available: bool = False
    error: Optional[str] = None


@dataclass
class SensorSnapshot:
    timestamp: float = 0.0
    bme280: BME280Reading = field(default_factory=BME280Reading)
    ina260: INA260Reading = field(default_factory=INA260Reading)
    system: SystemTemps = field(default_factory=SystemTemps)
    outdoor: HAOutdoor = field(default_factory=HAOutdoor)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["timestamp"] = self.timestamp
        return d


# ---------------------------------------------------------------------------
# Dew point calculation (Magnus formula)
# ---------------------------------------------------------------------------
_MAGNUS_B = 17.67
_MAGNUS_C = 243.5  # °C


def calc_dew_point(temp_c: float, rh: float) -> float:
    """Calculate dew point from temperature (°C) and relative humidity (%)."""
    if rh <= 0:
        return temp_c - 50  # very dry — return something far below
    gamma = math.log(rh / 100.0) + (_MAGNUS_B * temp_c) / (_MAGNUS_C + temp_c)
    return (_MAGNUS_C * gamma) / (_MAGNUS_B - gamma)


# ---------------------------------------------------------------------------
# Hardware sensor init
# ---------------------------------------------------------------------------
def init_i2c_sensors(i2c_bus: int = 1) -> None:
    """Initialize BME280 and INA260 on the I2C bus."""
    global _bme280_sensor, _ina260_sensor
    if not _HW_AVAILABLE:
        log.info("Skipping I2C init — hardware not available")
        return
    try:
        i2c = board.I2C()
        try:
            _bme280_sensor = adafruit_bme280.Adafruit_BME280_I2C(i2c, address=0x77)
            log.info("BME280 initialized at 0x77")
        except Exception as e:
            log.warning(f"BME280 init failed: {e}")
        try:
            _ina260_sensor = INA260(i2c, address=0x40)
            log.info("INA260 initialized at 0x40")
        except Exception as e:
            log.warning(f"INA260 init failed: {e}")
    except Exception as e:
        log.error(f"I2C bus init failed: {e}")


# ---------------------------------------------------------------------------
# Individual sensor readers
# ---------------------------------------------------------------------------
def read_bme280() -> BME280Reading:
    """Read BME280 temperature, humidity, pressure, and calculated dew point."""
    if not _HW_AVAILABLE or _bme280_sensor is None:
        # Mock data for development
        t = 22.0 + 3.0 * math.sin(time.time() / 60)
        h = 45.0 + 10.0 * math.sin(time.time() / 120)
        return BME280Reading(
            temperature=round(t, 2),
            humidity=round(h, 2),
            pressure=round(1013.25 + math.sin(time.time() / 300), 2),
            dew_point=round(calc_dew_point(t, h), 2),
        )
    try:
        t = _bme280_sensor.temperature
        h = _bme280_sensor.relative_humidity
        p = _bme280_sensor.pressure
        dp = calc_dew_point(t, h) if t is not None and h is not None else None
        return BME280Reading(
            temperature=round(t, 2) if t else None,
            humidity=round(h, 2) if h else None,
            pressure=round(p, 2) if p else None,
            dew_point=round(dp, 2) if dp is not None else None,
        )
    except Exception as e:
        log.warning(f"BME280 read error: {e}")
        return BME280Reading(error=str(e))


def read_ina260() -> INA260Reading:
    """Read INA260 voltage, current, and power."""
    if not _HW_AVAILABLE or _ina260_sensor is None:
        return INA260Reading(
            voltage=round(12.0 + 0.1 * math.sin(time.time() / 30), 3),
            current=round(0.5 + 0.1 * math.sin(time.time() / 45), 3),
            power=round(6.0 + 0.5 * math.sin(time.time() / 45), 2),
        )
    try:
        v = _ina260_sensor.voltage
        c = _ina260_sensor.current / 1000.0  # mA -> A
        p = _ina260_sensor.power / 1000.0    # mW -> W
        return INA260Reading(
            voltage=round(v, 3) if v is not None else None,
            current=round(c, 3) if c is not None else None,
            power=round(p, 2) if p is not None else None,
        )
    except Exception as e:
        log.warning(f"INA260 read error: {e}")
        return INA260Reading(error=str(e))


def read_system_temps() -> SystemTemps:
    """Read CPU and NVMe SSD temperatures from sysfs."""
    cpu = None
    ssd = None

    # CPU temp
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            cpu = round(int(f.read().strip()) / 1000.0, 1)
    except (FileNotFoundError, IOError):
        # Mock on Windows
        cpu = round(38.0 + 5.0 * math.sin(time.time() / 90), 1)

    # NVMe SSD temp
    try:
        paths = glob.glob("/sys/class/nvme/nvme0/hwmon*/temp1_input")
        if paths:
            with open(paths[0]) as f:
                ssd = round(int(f.read().strip()) / 1000.0, 1)
        else:
            raise FileNotFoundError
    except (FileNotFoundError, IOError):
        ssd = round(33.0 + 3.0 * math.sin(time.time() / 120), 1)

    return SystemTemps(cpu=cpu, ssd=ssd)


async def read_ha_outdoor(config: dict) -> HAOutdoor:
    """Fetch outside temp and humidity from Home Assistant REST API."""
    ha = config.get("ha", {})
    url = ha.get("url", "").rstrip("/")
    token = ha.get("token", "")
    temp_eid = ha.get("temp_entity_id", "")
    humid_eid = ha.get("humidity_entity_id", "")

    if not url or not token or not temp_eid:
        return HAOutdoor(error="HA not configured")

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    temp = None
    humidity = None

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # Fetch temperature
            resp = await client.get(f"{url}/api/states/{temp_eid}", headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                state = data.get("state")
                if state not in ("unknown", "unavailable"):
                    temp = round(float(state), 1)

            # Fetch humidity if entity configured
            if humid_eid:
                resp = await client.get(
                    f"{url}/api/states/{humid_eid}", headers=headers
                )
                if resp.status_code == 200:
                    data = resp.json()
                    state = data.get("state")
                    if state not in ("unknown", "unavailable"):
                        humidity = round(float(state), 1)
    except Exception as e:
        log.warning(f"HA fetch error: {e}")
        return HAOutdoor(error=str(e))

    dew_point = None
    if temp is not None and humidity is not None:
        dew_point = round(calc_dew_point(temp, humidity), 1)

    return HAOutdoor(
        temperature=temp,
        humidity=humidity,
        dew_point=dew_point,
        available=temp is not None,
    )


# ---------------------------------------------------------------------------
# Combined snapshot
# ---------------------------------------------------------------------------
async def read_all_sensors(config: dict) -> SensorSnapshot:
    """Read all sensors and return a unified snapshot."""
    bme = read_bme280()
    ina = read_ina260()
    sys_temps = read_system_temps()
    outdoor = await read_ha_outdoor(config)

    return SensorSnapshot(
        timestamp=time.time(),
        bme280=bme,
        ina260=ina,
        system=sys_temps,
        outdoor=outdoor,
    )
