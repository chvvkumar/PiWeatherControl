// Renders the 40-pin Raspberry Pi header as an SVG and manages pin assignments
// to named devices (fan, heater). No framework; mounts into a container element.

const PIN_RADIUS = 9;
// Horizontal layout: PIN_SPACING_X separates the 20 columns (left to right),
// PIN_SPACING_Y separates the 2 rows (top = odd pins, bottom = even pins).
const PIN_SPACING_X = 36;
const PIN_SPACING_Y = 36;
const PADDING = 18;
// Vertical room above the top row and below the bottom row for BCM labels and
// device badges. Badge is staggered further out than the BCM text so they do
// not overlap each other or the pin-number inside the circle.
const LABEL_HEIGHT = 34;

const TYPE_CLASS = {
  "3v3": "pin pin-3v3",
  "5v": "pin pin-5v",
  "gnd": "pin pin-gnd",
  "gpio": "pin pin-gpio",
};

const DEVICES = [
  { key: "fan", label: "Fan" },
  { key: "heater", label: "Heater" },
];

let _layout = null;
let _assignments = { fan: null, heater: null };
let _onChange = () => {};
let _rootEl = null;
let _popoverEl = null;

export function initPinout(container, layout, initialAssignments, onChange) {
  _rootEl = container;
  _layout = layout;
  _assignments = { ...initialAssignments };
  _onChange = onChange || (() => {});
  _render();
}

export function getAssignments() {
  return { ..._assignments };
}

export function setAssignments(next) {
  _assignments = { ..._assignments, ...next };
  _render();
}

function _render() {
  if (!_rootEl || !_layout) return;
  _rootEl.innerHTML = "";

  if (_layout.warning) {
    const warn = document.createElement("div");
    warn.className = "pinout-warning";
    warn.textContent = _layout.warning;
    _rootEl.appendChild(warn);
  }

  const headerInfo = document.createElement("div");
  headerInfo.className = "pinout-header-info";
  headerInfo.textContent = `${_layout.model} (${_layout.family})`;
  _rootEl.appendChild(headerInfo);

  // Horizontal layout: 20 columns x 2 rows.
  // leftEdge: cx of pin in column 0 (physical pins 1 and 2).
  // topEdge:  cy of the top row (odd pins: 1, 3, 5, ..., 39).
  // Bottom row cy = topEdge + PIN_SPACING_Y (even pins: 2, 4, 6, ..., 40).
  const leftEdge = PADDING;
  const topEdge = PADDING + LABEL_HEIGHT;

  // SVG viewBox spans 20 columns plus horizontal padding, and 2 rows plus
  // vertical padding and label room above/below.
  const width = PADDING * 2 + PIN_SPACING_X * 19 + PIN_RADIUS * 2;
  const height = PADDING * 2 + LABEL_HEIGHT * 2 + PIN_SPACING_Y + PIN_RADIUS * 2;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "pinout-svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", "Raspberry Pi 40-pin header");

  // Header backing rectangle for visual grouping.
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", String(leftEdge - PIN_RADIUS - 4));
  bg.setAttribute("y", String(topEdge - PIN_RADIUS - 4));
  bg.setAttribute("width", String(PIN_SPACING_X * 19 + (PIN_RADIUS + 4) * 2));
  bg.setAttribute("height", String(PIN_SPACING_Y + (PIN_RADIUS + 4) * 2));
  bg.setAttribute("rx", 10);
  bg.setAttribute("class", "pinout-board");
  svg.appendChild(bg);

  // Pin 1 square corner indicator (top-left corner of the board rect).
  const corner = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  corner.setAttribute("x", String(leftEdge - PIN_RADIUS - 2));
  corner.setAttribute("y", String(topEdge - PIN_RADIUS - 2));
  corner.setAttribute("width", String(PIN_RADIUS * 2 + 4));
  corner.setAttribute("height", String(PIN_RADIUS * 2 + 4));
  corner.setAttribute("class", "pinout-pin1-indicator");
  svg.appendChild(corner);

  for (const pin of _layout.pins) {
    svg.appendChild(_renderPin(pin, leftEdge, topEdge));
  }
  _rootEl.appendChild(svg);
  _rootEl.appendChild(_renderLegend());
}

function _renderPin(pin, leftEdge, topEdge) {
  // Horizontal layout: colIndex drives x (0..19), rowIndex drives y (0=top, 1=bottom).
  // Odd physical pins (1, 3, 5, ...) occupy the top row; even pins the bottom row.
  const colIndex = Math.floor((pin.physical_pin - 1) / 2); // 0..19
  const rowIndex = (pin.physical_pin % 2 === 1) ? 0 : 1;   // 0=top, 1=bottom
  const cx = leftEdge + colIndex * PIN_SPACING_X;
  const cy = topEdge + rowIndex * PIN_SPACING_Y;

  const assignedDevice = _deviceAssignedTo(pin.bcm);
  const classes = [TYPE_CLASS[pin.type]];
  if (assignedDevice) classes.push("pin-assigned");
  if (pin.reserved) classes.push("pin-reserved");

  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", "pin-group");
  group.setAttribute("data-physical", String(pin.physical_pin));
  group.setAttribute("data-bcm", pin.bcm == null ? "" : String(pin.bcm));

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", String(cx));
  circle.setAttribute("cy", String(cy));
  circle.setAttribute("r", String(PIN_RADIUS));
  circle.setAttribute("class", classes.join(" "));

  const clickable = pin.type === "gpio" && !pin.reserved;
  circle.setAttribute("tabindex", clickable ? "0" : "-1");
  circle.setAttribute("role", "button");
  const bcmText = pin.bcm == null ? "none" : `BCM ${pin.bcm}`;
  const assignedText = assignedDevice ? `, assigned to ${assignedDevice}` : "";
  const reservedText = pin.reserved ? `, ${pin.reserved_reason}` : "";
  circle.setAttribute(
    "aria-label",
    `Physical pin ${pin.physical_pin}, ${bcmText}, ${pin.type}${assignedText}${reservedText}`
  );

  if (clickable) {
    circle.addEventListener("click", (ev) => _openPopover(ev, pin));
    circle.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        _openPopover(ev, pin);
      }
    });
  }

  // Tooltip via title element.
  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.textContent = _tooltipText(pin, assignedDevice);
  circle.appendChild(title);

  group.appendChild(circle);

  // Pin number label inside the circle.
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", String(cx));
  label.setAttribute("y", String(cy + 4));
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("class", "pin-number");
  label.textContent = String(pin.physical_pin);
  group.appendChild(label);

  // BCM annotation: above the circle for top-row pins, below for bottom-row pins.
  // Device badge is staggered further out so it does not overlap the BCM text.
  if (pin.bcm != null) {
    const bcmLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
    // top row (rowIndex=0): label above; bottom row (rowIndex=1): label below.
    const bcmOffsetY = rowIndex === 0
      ? -(PIN_RADIUS + 8)   // above the circle
      : PIN_RADIUS + 16;    // below the circle (16 accounts for text baseline)
    bcmLabel.setAttribute("x", String(cx));
    bcmLabel.setAttribute("y", String(cy + bcmOffsetY));
    bcmLabel.setAttribute("text-anchor", "middle");
    bcmLabel.setAttribute("class", "pin-bcm-label");
    bcmLabel.textContent = `GPIO ${pin.bcm}`;
    group.appendChild(bcmLabel);
  }

  if (assignedDevice) {
    const badge = document.createElementNS("http://www.w3.org/2000/svg", "text");
    // Stagger further out beyond the BCM label (additional 14 px).
    const badgeOffsetY = rowIndex === 0
      ? -(PIN_RADIUS + 22)  // further above the BCM label
      : PIN_RADIUS + 30;    // further below the BCM label
    badge.setAttribute("x", String(cx));
    badge.setAttribute("y", String(cy + badgeOffsetY));
    badge.setAttribute("text-anchor", "middle");
    badge.setAttribute("class", "pin-device-badge");
    badge.textContent = assignedDevice.toUpperCase();
    group.appendChild(badge);
  }

  return group;
}

function _deviceAssignedTo(bcm) {
  if (bcm == null) return null;
  for (const d of DEVICES) {
    if (_assignments[d.key] === bcm) return d.key;
  }
  return null;
}

function _tooltipText(pin, assignedDevice) {
  const parts = [`Physical ${pin.physical_pin}`];
  if (pin.bcm != null) parts.push(`BCM ${pin.bcm}`);
  parts.push(pin.type.toUpperCase());
  if (pin.alt_functions && pin.alt_functions.length) {
    parts.push(pin.alt_functions.join(", "));
  }
  if (pin.reserved) parts.push(pin.reserved_reason || "reserved");
  if (assignedDevice) parts.push(`assigned: ${assignedDevice}`);
  return parts.join(" / ");
}

function _renderLegend() {
  const legend = document.createElement("div");
  legend.className = "pinout-legend";
  const items = [
    { cls: "pin-3v3", text: "3.3V" },
    { cls: "pin-5v", text: "5V" },
    { cls: "pin-gnd", text: "GND" },
    { cls: "pin-gpio", text: "GPIO" },
    { cls: "pin-assigned", text: "Assigned" },
    { cls: "pin-reserved", text: "Reserved (I2C)" },
  ];
  for (const item of items) {
    const row = document.createElement("span");
    row.className = "pinout-legend-item";
    const swatch = document.createElement("span");
    swatch.className = `pinout-legend-swatch ${item.cls}`;
    const label = document.createElement("span");
    label.textContent = item.text;
    row.appendChild(swatch);
    row.appendChild(label);
    legend.appendChild(row);
  }
  return legend;
}

function _closePopover() {
  if (_popoverEl && _popoverEl.parentNode) {
    _popoverEl.parentNode.removeChild(_popoverEl);
  }
  _popoverEl = null;
}

function _openPopover(ev, pin) {
  _closePopover();
  const pop = document.createElement("div");
  pop.className = "pinout-popover";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", `Assign BCM ${pin.bcm}`);

  const title = document.createElement("div");
  title.className = "pinout-popover-title";
  title.textContent = `Pin ${pin.physical_pin} / GPIO ${pin.bcm}`;
  pop.appendChild(title);

  const select = document.createElement("select");
  select.className = "pinout-popover-select";
  const unassigned = document.createElement("option");
  unassigned.value = "__unassigned__";
  unassigned.textContent = "Unassigned";
  select.appendChild(unassigned);
  for (const d of DEVICES) {
    const opt = document.createElement("option");
    opt.value = d.key;
    opt.textContent = d.label;
    if (_assignments[d.key] === pin.bcm) opt.selected = true;
    select.appendChild(opt);
  }

  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "pinout-popover-apply";
  apply.textContent = "Apply";
  apply.addEventListener("click", () => {
    const choice = select.value;
    const next = { ..._assignments };
    // Clear this pin from any device currently using it.
    for (const d of DEVICES) {
      if (next[d.key] === pin.bcm) next[d.key] = null;
    }
    if (choice !== "__unassigned__") {
      next[choice] = pin.bcm;
    }
    _assignments = next;
    _closePopover();
    _render();
    _onChange(getAssignments());
  });

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "pinout-popover-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", _closePopover);

  pop.appendChild(select);
  const actions = document.createElement("div");
  actions.className = "pinout-popover-actions";
  actions.appendChild(cancel);
  actions.appendChild(apply);
  pop.appendChild(actions);

  // Position near the clicked element.
  const rect = ev.currentTarget.getBoundingClientRect();
  const hostRect = _rootEl.getBoundingClientRect();
  pop.style.position = "absolute";
  pop.style.left = `${rect.right - hostRect.left + 8}px`;
  pop.style.top = `${rect.top - hostRect.top - 8}px`;

  _rootEl.appendChild(pop);
  _popoverEl = pop;
  select.focus();
}
