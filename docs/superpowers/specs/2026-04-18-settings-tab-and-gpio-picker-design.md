# Settings Tab and Graphical GPIO Pin Picker

**Date:** 2026-04-18
**Status:** Approved design, ready for planning

## Summary

Add a two-tab layout (Dashboard, Settings) to the PiWeatherControl web UI. Move every configurable setting currently scattered across collapsible `<details>` sections and modal forms into the Settings tab, grouped by concern. Introduce a graphical Raspberry Pi 40-pin header component that lets the user assign GPIO pins to Fan and Heater devices visually, with runtime detection of the Pi model to drive pin capability rendering.

## Goals

- Consolidate all user-configurable settings into a single Settings tab, leaving the Dashboard as a pure readouts-plus-controls view.
- Replace hardcoded GPIO pin entry with a visual 40-pin header picker.
- Detect the running Pi model at request time and render the matching pin capability table.
- Preserve existing behavior for sensor polling, graphs, relay control, and event logging.

## Non-goals

- Hot-reloading GPIO pins. Changes require `systemctl restart piweathercontrol`, matching the current code comment.
- Adding user-defined GPIO devices beyond Fan and Heater. The device list stays fixed.
- Introducing a frontend framework, build step, or charting library. The UI remains vanilla JS with canvas and SVG.
- Tab-based routing, URL fragments, or deep links to Settings.

## Architecture

### Frontend

A tab bar at the top of `index.html` toggles visibility between two `<section class="tab-panel">` elements: `#dashboard` and `#settings`. Tab switching is handled by a small JS listener that flips the `active` class on tab buttons and panels. No routing library. The Dashboard panel contains the existing sensor cards, relay control cards, graphs, and event log, moved verbatim. The Settings panel is newly constructed and contains six grouped cards (see Settings Groups).

### Backend

- New endpoint `GET /api/pi-info` returning `{ model, family, pins: [...] }`. Model detection reads `/proc/device-tree/model`, falls back to `/proc/cpuinfo` `Revision:`, defaults to `pi5` with `model: "Mock (dev)"` on non-Linux.
- New module `pi_pinout.py` owns pin capability tables per Pi family (`pi3`, `pi4`, `pi5`, `pi_zero2`), detection logic, and reserved-pin marking based on the configured I2C bus.
- `POST /api/config` gains validation: reject assignments to power, ground, reserved-by-I2C pins, and collisions where `gpio.fan_pin == gpio.heater_pin`, returning HTTP 400 with a descriptive error.
- `gpio_control.py` is unchanged. Pins are read from config at process startup as today.

## Settings Groups

Settings panel layout, top to bottom:

1. **Hardware / GPIO.** The graphical pin picker. Shows current Fan and Heater pin assignments, plus a single `gpio.invert_relay` toggle (matches existing schema). Save here posts only GPIO-related fields, then displays an inline banner: "GPIO changes require a service restart. Run `sudo systemctl restart piweathercontrol`."
2. **Fan control.** All keys under `fan`: `threshold`, `hysteresis`, `sources` (CPU / SSD / enclosure checkboxes), `min_on_seconds`, `min_off_seconds`. The thermal curve canvas visualization stays on the Dashboard next to the relay control; only configuration inputs live here.
3. **Dew heater control.** All keys under `heater`: `dew_margin`, `outside_temp_threshold`, `hysteresis`, `min_on_seconds`, `min_off_seconds`, `fan_off_when_heating`.
4. **Home Assistant integration.** `ha.url`, `ha.token`, `ha.temp_entity_id`, `ha.humidity_entity_id`. Moved from the existing collapsible `<details>` block.
5. **AllSky integration.** `allsky.enabled`, `allsky.output_dir`. Currently in config but not exposed in the UI; surfacing matches the "move all settings" requirement.
6. **System.** `i2c_bus`, `poll_interval`. BME280 (`0x77`) and INA260 (`0x40`) addresses are shown read-only for reference since they are hardcoded in `sensors.py`; making them configurable is out of scope.

Each group is a `<form>` with its own Save button. Forms post a partial config diff containing only their own fields to `/api/config`. There is no global Save.

## GPIO Picker Component

### Visual

SVG rendering of the 40-pin header as two columns of 20 pins, matching pinout.xyz conventions. Pin 1 is marked with a square corner indicator. Each pin is a focusable `<button>` inside the SVG with an `aria-label` describing pin number, BCM number, and current assignment.

Color coding:

- Red: 5V power pins (physical 2, 4)
- Orange: 3.3V power pins (physical 1, 17)
- Gray: GND pins (physical 6, 9, 14, 20, 25, 30, 34, 39)
- Green: free GPIO
- Yellow: GPIO currently assigned to a device; label shows device name
- Blue outline: I2C pins (BCM 2, 3 when `i2c_bus == 1`) with "reserved for sensors" tooltip
- Dimmed: GPIO not present on the detected Pi family

Hover or focus shows a tooltip with: BCM number, physical pin number, default function (for example "GPIO 18 / PCM_CLK / PWM0"), current assignment.

### Interaction

1. Picker renders from `/api/pi-info` on tab load.
2. Current assignments from `/api/config` paint Fan and Heater pins yellow.
3. Clicking a green pin opens a popover with a dropdown: `Assign to: [Fan | Heater | Unassigned]`.
4. Selecting a device moves the assignment in local state; the previously assigned pin returns to green.
5. Power, ground, dimmed, and reserved pins are not clickable.
6. Save button in the Hardware / GPIO section posts `{ gpio: { fan_pin, heater_pin, invert_relay } }` to `/api/config`, then shows the restart banner.

## Config Schema

No changes to the existing `config.json` shape. The full schema is already defined in `config.py:10-45`:

```json
{
  "fan":    { "mode": "auto", "threshold": 45, "hysteresis": 3, "sources": {...}, "min_on_seconds": 120, "min_off_seconds": 120 },
  "heater": { "mode": "auto", "dew_margin": 5, "outside_temp_threshold": 2, "hysteresis": 2, "min_on_seconds": 120, "min_off_seconds": 120, "fan_off_when_heating": true },
  "gpio":   { "fan_pin": 20, "heater_pin": 21, "invert_relay": true },
  "ha":     { "url": "", "token": "", "temp_entity_id": "", "humidity_entity_id": "" },
  "allsky": { "enabled": true, "output_dir": "/home/pi/allsky/config/overlay/extra" },
  "i2c_bus": 1,
  "poll_interval": 10
}
```

The GPIO picker reads and writes `gpio.fan_pin`, `gpio.heater_pin`, and `gpio.invert_relay` directly. No schema migration needed. Existing `config.py` deep-merge already handles any additive keys we introduce later without breaking older `config.json` files.

## Pi Detection

New module `pi_pinout.py`:

- `detect_model() -> str`. Reads `/proc/device-tree/model`, strips nulls, returns a family key: `pi3`, `pi4`, `pi5`, `pi_zero2`. Falls back to `/proc/cpuinfo` `Revision:` lookup. Returns `pi5` on non-Linux with model string `"Mock (dev)"`.
- `PIN_CAPABILITIES: dict[str, list[PinInfo]]`. Each `PinInfo` carries physical pin number, BCM number, type (`gpio | 5v | 3v3 | gnd`), list of alternate functions, and a `reserved` flag.
- `get_layout(i2c_bus: int) -> dict`. Returns `{ model, family, pins: [...] }`. Marks BCM 2 and 3 as reserved when `i2c_bus == 1`; marks other I2C buses if later configured. Returned shape is what `/api/pi-info` serves directly.

## Restart Flow

After a successful `POST /api/config` that modified any GPIO-affecting field (`gpio.fan_pin`, `gpio.heater_pin`, `gpio.invert_relay`), the frontend shows a persistent banner in the Hardware / GPIO card: "GPIO changes saved. Restart required: `sudo systemctl restart piweathercontrol`." The banner stays until page reload; cross-checking against live pin state is out of scope.

## File Changes

### New

- `pi_pinout.py`: model detection, pin capability tables, `get_layout()`.
- `static/pinout.js`: SVG pin header renderer, click and keyboard interaction, assignment state.
- `tests/test_pi_pinout.py`: unit tests for detection and layout.
- `tests/test_app_config.py`: validation tests for `/api/config` pin rules.
- `docs/superpowers/specs/2026-04-18-settings-tab-and-gpio-picker-design.md`: this document.

### Modified

- `app.py`: add `GET /api/pi-info`; add pin validation in `POST /api/config`.
- `static/index.html`: wrap existing dashboard content in `<section id="dashboard" class="tab-panel active">`; add `<section id="settings" class="tab-panel">` with six grouped cards; add tab bar.
- `static/style.css`: tab bar and `.tab-panel` visibility; pinout SVG styles; pin color classes; legend; tooltip and popover styles.
- `static/app.js`: tab switching, `fetchPiInfo()`, wire `pinout.js` into settings panel, split existing settings populate and save logic into per-section forms.

## Test Plan

### Backend unit tests (`tests/test_pi_pinout.py`)

- `detect_model()` returns `pi5` for `"Raspberry Pi 5 Model B"`, `pi4` for `"Raspberry Pi 4 Model B"`, `pi3` for `"Raspberry Pi 3 Model B Plus"`, `pi_zero2` for `"Raspberry Pi Zero 2 W"`.
- `detect_model()` falls back to `/proc/cpuinfo` parsing when `/proc/device-tree/model` is absent.
- `get_layout(i2c_bus=1)` returns BCM 2 and 3 with `reserved: true`.
- `get_layout(i2c_bus=0)` returns BCM 2 and 3 with `reserved: false`.
- Non-Linux environment: `get_layout()` returns pi5 layout with `model: "Mock (dev)"`.

### Backend API tests (`tests/test_app_config.py`)

Pin validation operates on BCM numbers. Power and ground physical pins have no BCM number, so the picker cannot emit them; validation focuses on I2C-reserved pins, pin collisions, and pins outside the detected model's GPIO range.

- `POST /api/config` with `gpio.fan_pin = 2` (I2C SDA when `i2c_bus == 1`) returns HTTP 400 with message mentioning I2C.
- `POST /api/config` with `gpio.fan_pin = gpio.heater_pin = 21` returns HTTP 400 with a collision message.
- `POST /api/config` with `gpio.fan_pin = 99` (not a valid BCM GPIO on any supported model) returns HTTP 400.
- `POST /api/config` with `gpio.fan_pin = 16` (free GPIO on Pi 5) returns HTTP 200 and persists the change.
- `POST /api/config` unchanged from the GPIO picker's perspective continues to accept fan/heater/ha/allsky/i2c_bus/poll_interval edits.

### Manual verification on the Pi

Deploy to `pi@allskypi5`, restart service, load in browser.

1. Tab bar shows Dashboard and Settings; switching toggles panels without page reload.
2. Dashboard retains every sensor card, relay control, graph, and event log from before.
3. Settings tab shows all six groups in order: Hardware / GPIO, Fan control, Dew heater control, Home Assistant, AllSky, System.
4. Pin picker renders the Pi 5 layout, Fan pin 20 and Heater pin 21 are yellow, I2C pins blue.
5. Reassigning Fan from pin 20 to pin 16 and saving returns success and shows the restart banner.
6. `sudo systemctl restart piweathercontrol` applies the change; relay on pin 16 toggles with the Fan mode buttons.
7. Each Settings group's Save button persists only its own fields; editing HA credentials does not re-send fan or heater values.

### Regression

- Dashboard polling remains on 5-second interval.
- Dew gauge and fan curve canvas animations run unchanged.
- Event log populates from `/api/events`.
- Mode buttons (off/auto/on) for fan and heater continue to post to `/api/fan` and `/api/heater`.

## Implementation Team Plan

Four agents working in parallel once the plan is approved, integrated in a main-session pass:

- **Agent A (backend):** `pi_pinout.py`, `/api/pi-info` endpoint, `/api/config` pin validation, both test files.
- **Agent B (pin picker):** `static/pinout.js` SVG component, click and keyboard interaction, exported render API.
- **Agent C (layout):** `static/index.html` tab structure and Settings panel markup, `static/style.css` tab and pinout styles.
- **Agent D (wiring):** `static/app.js` tab switching, `fetchPiInfo()`, per-section form handlers, restart banner logic.

Integration pass verifies tab switching works end-to-end, picker renders with live config, and Settings forms round-trip to `/api/config`.

## Risks

- Pi model detection returning an unexpected string for some variant board, falling through to `unknown` and breaking the picker. Mitigation: default to `pi5` layout with a visible "unknown model, showing Pi 5 layout" warning in the UI.
- Users saving an invalid pin via a stale UI after backend validation rules change. Mitigation: backend validation is the source of truth; UI disables invalid pins, backend rejects with 400 regardless.
- Users on Pi models with non-standard pin capabilities (e.g., Compute Module carriers) seeing the wrong layout. Mitigation: the `unknown` family falls back to the Pi 5 layout with a visible warning; user can still save pin assignments but the I2C-reserved marking may be inaccurate.
