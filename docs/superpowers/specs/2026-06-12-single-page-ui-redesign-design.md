# Single-Page UI Redesign

Date: 2026-06-12
Status: Approved design, pending implementation plan

## Goal

Replace the two-tab (Dashboard / Settings) interface with a single scrolling page.
Each configuration group lives next to the panel it controls. Rarely-touched
hardware and integration settings collapse into an accordion at the bottom.
Refine the top sensor row. Keep the existing dew point bar gauge and the glass
visual theme unchanged.

## Scope

In scope:
- Remove the tab bar and the separate Settings panel.
- Restyle the six top sensor cards (Variant 2).
- Merge the standalone relay control cards into their respective panel headers.
- Embed Fan and Heater settings as collapsible rows inside their panels.
- Collect Hardware/GPIO, Home Assistant, AllSky, and System into one accordion card.
- Persist accordion open/closed state in localStorage.

Out of scope:
- No backend or API changes. Every Save posts the same partial config payloads
  to `/api/config` that the current forms post today.
- No change to the dew point bar gauge rendering (`drawDewGauge`), the fan curve
  editor (`drawFanCurve`), the Pi fan mini curve, or the sparkline logic.
- No change to `app.py`, `config.py`, `sensors.py`, `gpio_control.py`, or `pinout.js`.

## Layout

Single `<main>` column, top to bottom:

1. Header: title plus connection status dot. No tab bar.
2. Sensor strip: six cards in a `repeat(6, minmax(0, 1fr))` grid.
3. Two-panel row: Dew Point Analysis (left) and Thermal Fan Curve (right).
4. Accordion card: Hardware/GPIO, Home Assistant, AllSky, System.
5. Event log, full width.

### Sensor cards (Variant 2)

Each card keeps its existing data bindings (same element IDs) and gains:
- An outlined category icon chip in the top-right corner (Tabler-style glyph or
  inline SVG): CPU, drive, fan, box, cloud, bolt.
- A larger value with the unit as a separate muted span. The main value is
  tinted with the card's accent color for the temperature/outside cards.
- A trend delta pill on the CPU and SSD cards (rising in red, falling in green).
- The Pi fan card shows a PWM duty progress bar instead of a sparkline.
- Enclosure, Outside, and Power keep their inline meta stats with brightened
  numbers and dimmed labels.

Trend delta source: computed in `updateSensors` from `historyData`. The delta is
current value minus the value from approximately five minutes earlier in the
history buffer (smoothed, not since-last-poll). Hidden until enough history
exists. No new API calls; reuses the existing `/api/history` fetch.

### Relay controls merged into panels

The two `relay-card` blocks (`#card-heater`, `#card-fan`) are removed. Their
off/auto/on mode selector and state indicator dot move into the headers of
`#card-dew-status` and `#card-fan-curve` respectively. GPIO pin and cycle count
become a single small line beneath each panel header.

`updateRelays` is updated to target the relocated elements. The `data-device` /
`data-mode` attributes on the mode buttons are preserved, so `initModeButtons`
keeps working unchanged.

### Embedded panel settings

Each panel gains a collapsible settings row at its bottom:
- Dew panel: "Heater settings" holds dew margin, frost threshold, hysteresis,
  min on, min off, and fan-off-when-heating. Posts the same `{ heater: {...} }`
  payload as `form-heater` today.
- Fan panel: "Fan settings" holds threshold, hysteresis, min on, min off, and
  the CPU/SSD/Enclosure source checkboxes. Posts the same `{ fan: {...} }`
  payload as `form-fan` today.

When collapsed, the row shows a one-line summary of current values (for example
"margin 3 deg, hyst 1 deg"). Each section keeps its own Save button and an
"Unsaved changes" hint that appears when an input changes before saving.

### Accordion card

One card holds four collapsible sections, each a single summary row when closed:
- Hardware / GPIO: the pinout picker, fan/heater invert checkboxes, Save GPIO,
  and the existing restart-required banner.
- Home Assistant: URL, token, temp entity, humidity entity, Save.
- AllSky: enabled checkbox, output dir, Save.
- System: I2C bus, poll interval, Save, plus the read-only address notes.

The GPIO pinout still initializes via `initPinout` from `pinout.js`. Because the
settings now render on initial page load rather than on tab switch, pinout init
moves from `_loadSettingsPanel` into the main `init` sequence (or runs lazily the
first time the Hardware section expands).

## State and behavior changes in app.js

- Remove `initTabs` and the `_loadSettingsPanel` tab-switch trigger. Settings
  forms populate on initial load via `fetchConfig` plus `_populateSettingsForms`.
- `_wireSettingsForms` runs once during `init`.
- Add accordion toggle handlers; persist each section's open state in
  localStorage under a namespaced key, restore on load.
- Add per-field "dirty" tracking to show the "Unsaved changes" hint; clear it on
  successful save.
- Keep the `requestAnimationFrame` animation loop and the 5s poll loop unchanged.

## Files touched

- `static/index.html`: restructure markup, remove tabs and relay cards, add
  panel-embedded settings and the accordion.
- `static/style.css`: Variant 2 card styles, accordion styles, segmented control
  in panel headers, embedded settings form layout. Glass tokens unchanged.
- `static/app.js`: relocate relay/settings wiring, add trend delta, accordion
  persistence, and dirty-state hints. No API contract changes.

## Testing

- Existing Python tests are unaffected (no backend change); run them to confirm.
- Manual verification on the Pi (pi@allskypi5, service piweathercontrol, port
  8085): confirm all six cards populate, mode buttons switch relays, each Save
  posts and persists, the GPIO restart banner shows, accordion state survives a
  reload, and the dew gauge plus fan curve still render and remain interactive.

## Open questions

None blocking. Trend delta window defaults to ~5 minutes; adjust during
implementation if it reads too jumpy or too sluggish.
