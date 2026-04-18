"""GPIO relay control — lgpio for Pi 5, mock for Windows development."""

import time
import logging
from typing import Optional

log = logging.getLogger("enclosure.gpio")

# ---------------------------------------------------------------------------
# Try lgpio (Pi 5 native); fall back to mock
# ---------------------------------------------------------------------------
_lgpio = None
_chip_handle = None

try:
    import lgpio as _lgpio_mod
    _lgpio = _lgpio_mod
except ImportError:
    log.info("lgpio not available — using mock GPIO")


class RelayState:
    """Tracks relay state with timing for wear minimization."""

    def __init__(self, name: str, pin: int, invert: bool = True):
        self.name = name
        self.pin = pin
        self.invert = invert
        self.is_on = False
        self.last_change_time: float = 0.0
        self.cycle_count: int = 0

    def seconds_since_change(self) -> float:
        if self.last_change_time == 0:
            return float("inf")
        return time.time() - self.last_change_time

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "pin": self.pin,
            "is_on": self.is_on,
            "seconds_since_change": round(self.seconds_since_change(), 1),
            "cycle_count": self.cycle_count,
        }


class GPIOController:
    """Manages GPIO output pins for relays."""

    def __init__(
        self,
        fan_pin: int = 20,
        heater_pin: int = 21,
        fan_invert: bool = True,
        heater_invert: bool = True,
    ):
        self.fan = RelayState("fan", fan_pin, fan_invert)
        self.heater = RelayState("heater", heater_pin, heater_invert)
        self._hw_available = _lgpio is not None
        self._chip = None
        self._initialized = False

    def init(self) -> None:
        """Initialize GPIO pins as outputs, defaulting to OFF."""
        if self._hw_available:
            try:
                self._chip = _lgpio.gpiochip_open(0)
                for relay in (self.fan, self.heater):
                    # Set initial state to OFF
                    off_level = 1 if relay.invert else 0
                    _lgpio.gpio_claim_output(self._chip, relay.pin, off_level)
                    relay.is_on = False
                    relay.last_change_time = time.time()
                self._initialized = True
                log.info(
                    f"GPIO initialized: fan=pin{self.fan.pin} (invert={self.fan.invert}), "
                    f"heater=pin{self.heater.pin} (invert={self.heater.invert})"
                )
            except Exception as e:
                log.error(f"GPIO init failed: {e}")
                self._hw_available = False
        else:
            # Mock — just track state
            for relay in (self.fan, self.heater):
                relay.is_on = False
                relay.last_change_time = time.time()
            self._initialized = True
            log.info("GPIO mock initialized")

    def _set_pin(self, relay: RelayState, on: bool) -> None:
        """Set a relay pin, respecting invert logic."""
        if on == relay.is_on:
            return  # no change needed

        if self._hw_available and self._chip is not None:
            # Active-LOW (invert=True): on=True -> pin LOW (0), on=False -> pin HIGH (1)
            level = (0 if on else 1) if relay.invert else (1 if on else 0)
            try:
                _lgpio.gpio_write(self._chip, relay.pin, level)
            except Exception as e:
                log.error(f"GPIO write error on pin {relay.pin}: {e}")
                return

        relay.is_on = on
        relay.last_change_time = time.time()
        relay.cycle_count += 1
        log.info(f"Relay {relay.name} -> {'ON' if on else 'OFF'} (pin {relay.pin}, cycle #{relay.cycle_count})")

    def set_fan(self, on: bool) -> None:
        self._set_pin(self.fan, on)

    def set_heater(self, on: bool) -> None:
        self._set_pin(self.heater, on)

    def can_switch(self, relay: RelayState, min_on: float, min_off: float) -> bool:
        """Check if relay has been in current state long enough to switch."""
        elapsed = relay.seconds_since_change()
        if relay.is_on:
            return elapsed >= min_on
        else:
            return elapsed >= min_off

    def cleanup(self) -> None:
        """Release GPIO resources."""
        if self._hw_available and self._chip is not None:
            try:
                # Turn everything off
                for relay in (self.fan, self.heater):
                    off_level = 1 if relay.invert else 0
                    _lgpio.gpio_write(self._chip, relay.pin, off_level)
                _lgpio.gpiochip_close(self._chip)
                log.info("GPIO cleaned up")
            except Exception as e:
                log.error(f"GPIO cleanup error: {e}")

    def status(self) -> dict:
        return {
            "fan": self.fan.to_dict(),
            "heater": self.heater.to_dict(),
            "hw_available": self._hw_available,
        }
