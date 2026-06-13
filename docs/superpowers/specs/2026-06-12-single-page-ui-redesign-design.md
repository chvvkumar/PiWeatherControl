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
- Render the GPIO pinout horizontally (2 rows by 20 columns) instead of the
  current vertical 2-by-20 column orientation.

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

## GPIO pinout: horizontal orientation

Currently `pinout.js` lays the 40-pin header as 2 columns by 20 rows (odd pins
in the left column, even in the right). Rotate to 2 rows by 20 columns: odd pins
(1, 3, 5, ...) on the top row, even pins (2, 4, 6, ...) on the bottom row, both
increasing left to right. Pin 1 indicator stays at the top-left.

In `_renderPin`:
- `colIndex = Math.floor((pin.physical_pin - 1) / 2)` drives the x position
  (0..19); `rowIndex = (pin.physical_pin % 2 === 1) ? 0 : 1` drives y (top/bottom).
- `cx = leftEdge + colIndex * PIN_SPACING_X`, `cy = topEdge + rowIndex * PIN_SPACING_Y`.
- BCM labels and device badges move to a vertical offset: above the top row
  (`text-anchor: middle`, y above the circle) and below the bottom row, instead
  of the current left/right horizontal offset. Stagger so labels do not overlap
  the pin numbers.
- Swap the SVG `width`/`height` and the backing board rect accordingly: width
  spans 20 columns, height spans 2 rows plus label room.

In `style.css`, `.pinout-svg` becomes full-width (remove the fixed 220px and the
`.settings-left .pinout-svg` override, which disappears with the two-column
settings layout). The pinout sits in the expanded Hardware accordion section.

## Element and class contract (shared interface for all files)

The redesign preserves every existing element id so `app.js` data bindings keep
working; elements are relocated, not renamed. Files must agree on the following.

Preserved ids (relocated, not renamed): `#connection-status`, `#cpu-temp`,
`#ssd-temp`, `#enc-temp`, `#enc-humidity`, `#enc-dew`, `#enc-pressure`,
`#ha-status`, `#out-temp`, `#out-humidity`, `#out-dew`, `#pwr-voltage`,
`#pwr-current`, `#pwr-power`, `#pi-fan-rpm`, `#pi-fan-pct`, the sparkline canvases
`#spark-cpu`/`#spark-ssd`/`#spark-enclosure`/`#pi-fan-curve`, `#dew-gauge`,
`#fan-curve-canvas`, all `#dew-ind-*` and `#dew-*-val`, `#heater-indicator`,
`#fan-indicator`, `#heater-pin`, `#fan-pin`, `#heater-cycles`, `#fan-cycles`,
`#event-log`, `#pinout-container`, the dashboard fan-source checkboxes, and every
`#set-*`, `#gpio-*`, and `form-*` id used by `_populateSettingsForms` and
`_wireSettingsForms`.

Preserved attributes: relay mode buttons keep `class="mode-btn"` with
`data-device` (`fan`/`heater`) and `data-mode` (`off`/`auto`/`on`); the active
button keeps the `active` class. Relay indicators keep `class="relay-indicator"`
plus `on`/`off`. This keeps `initModeButtons` and `updateRelays` unchanged.

New ids and classes (added by this redesign):
- Sensor cards: container `.sensor-strip`; each card `.sensor-card`; icon chip
  `.sensor-ico`; value `.sensor-val`; unit `.sensor-unit`; meta row `.sensor-meta`.
- Trend pills: `<span id="cpu-delta" class="delta"></span>` and
  `<span id="ssd-delta" class="delta"></span>`. `app.js` sets `textContent` and
  toggles `delta up` / `delta dn` / `delta flat`.
- Pi fan PWM bar: `<div class="pwm-bar"><span id="pi-fan-bar"></span></div>`.
  `app.js` sets `#pi-fan-bar` width to `speed_pct%`.
- Collapsible sections use native `<details>`/`<summary>`. Panel settings:
  `<details class="panel-settings" data-acc="fan-settings">` and
  `data-acc="heater-settings"`. Bottom accordion: `<details class="acc-section"
  data-acc="...">` with keys `hardware`, `ha`, `allsky`, `system`, each summary
  `class="acc-summary"`. `app.js` persists each `data-acc` element's `open`
  property to localStorage and restores on load.
- Dirty hint: each settings `<form>` contains
  `<span class="dirty-hint hidden">Unsaved changes</span>`. `app.js` removes
  `hidden` on `input`/`change` within the form and re-adds it after a successful
  save.
- Segmented relay controls in panel headers reuse the existing
  `.mode-selector` / `.mode-btn` classes; no new control class.

## Files touched

- `static/index.html`: restructure markup, remove tabs and relay cards, add
  panel-embedded settings and the accordion.
- `static/style.css`: Variant 2 card styles, accordion styles, segmented control
  in panel headers, embedded settings form layout. Glass tokens unchanged.
- `static/app.js`: relocate relay/settings wiring, add trend delta, accordion
  persistence, and dirty-state hints. No API contract changes.
- `static/pinout.js`: horizontal pin geometry and label repositioning.

## Testing

- Existing Python tests are unaffected (no backend change); run them to confirm.
- Manual verification on the Pi (pi@allskypi5, service piweathercontrol, port
  8085): confirm all six cards populate, mode buttons switch relays, each Save
  posts and persists, the GPIO restart banner shows, accordion state survives a
  reload, and the dew gauge plus fan curve still render and remain interactive.

## Open questions

None blocking. Trend delta window defaults to ~5 minutes; adjust during
implementation if it reads too jumpy or too sluggish.
