/* Enclosure Controller — Frontend */

import { initPinout, getAssignments, setAssignments } from "/static/pinout.js";

const POLL_MS = 5000;
let config = {};
let fanThreshold = 45; // single ON threshold temperature
let draggingThreshold = false;
let historyData = [];
let _dewGaugeParams = null; // set by updateDewStatus, read by animation loop

// ── Helpers ──────────────────────────────────────────────────────
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function tempClass(v) {
  if (v == null) return '';
  if (v >= 55) return 'temp-hot';
  if (v >= 40) return 'temp-warm';
  return 'temp-cool';
}

// ── API calls ────────────────────────────────────────────────────
async function api(path, opts = {}) {
  try {
    const resp = await fetch(path, opts);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (e) {
    console.error(`API ${path}:`, e);
    return null;
  }
}

async function fetchStatus() {
  const data = await api('/api/status');
  if (!data) {
    $('#connection-status').className = 'status-dot disconnected';
    return;
  }
  $('#connection-status').className = 'status-dot connected';
  updateSensors(data.sensors);
  updateRelays(data.relays, data.modes);
  updateDewStatus(data.sensors, data.relays, data.modes);
}

async function fetchConfig() {
  const data = await api('/api/config');
  if (!data) return;
  config = data;
  if (data.fan?.threshold != null) fanThreshold = data.fan.threshold;
}

async function fetchHistory() {
  const data = await api('/api/history');
  if (data) {
    historyData = data;
    drawSparklines();
  }
}

async function fetchEvents() {
  const data = await api('/api/events');
  if (!data) return;
  const log = $('#event-log');
  log.innerHTML = '';
  // Show newest first
  for (let i = data.length - 1; i >= 0; i--) {
    const e = data[i];
    const div = document.createElement('div');
    div.className = 'entry';
    const msg = e.message || '';
    if (msg.includes('Fan ON')) div.className += ' fan-on';
    else if (msg.includes('Fan OFF')) div.className += ' fan-off';
    else if (msg.includes('Heater ON')) div.className += ' heater-on';
    else if (msg.includes('Heater OFF')) div.className += ' heater-off';
    if (msg.includes('WATCHDOG')) div.className += ' warning';
    div.innerHTML = `<span class="time">${fmtTime(e.time)}</span>${msg}`;
    log.appendChild(div);
  }
}

// ── Sensor display ───────────────────────────────────────────────
function updateSensors(s) {
  if (!s || !s.system) return;

  const cpu = s.system.cpu;
  const ssd = s.system.ssd;
  $('#cpu-temp').textContent = cpu != null ? cpu.toFixed(1) : '--';
  $('#cpu-temp').className = tempClass(cpu);
  $('#ssd-temp').textContent = ssd != null ? ssd.toFixed(1) : '--';
  $('#ssd-temp').className = tempClass(ssd);

  // ── Trend delta pills (CPU and SSD) ──────────────────────────
  _updateTrendDelta('#cpu-delta', historyData, d => d.system?.cpu, cpu);
  _updateTrendDelta('#ssd-delta', historyData, d => d.system?.ssd, ssd);

  if (s.bme280) {
    const b = s.bme280;
    $('#enc-temp').textContent = b.temperature != null ? b.temperature.toFixed(1) : '--';
    $('#enc-temp').className = tempClass(b.temperature);
    $('#enc-humidity').textContent = b.humidity != null ? b.humidity.toFixed(1) : '--';
    $('#enc-dew').textContent = b.dew_point != null ? b.dew_point.toFixed(1) : '--';
    $('#enc-pressure').textContent = b.pressure != null ? b.pressure.toFixed(0) : '--';
  }

  if (s.outdoor) {
    const o = s.outdoor;
    const badge = $('#ha-status');
    if (o.available) {
      badge.textContent = 'OK';
      badge.className = 'badge ok';
    } else {
      badge.textContent = o.error ? 'ERR' : 'N/A';
      badge.className = 'badge err';
    }
    $('#out-temp').textContent = o.temperature != null ? o.temperature.toFixed(1) : '--';
    $('#out-humidity').textContent = o.humidity != null ? o.humidity.toFixed(1) : '--';
    $('#out-dew').textContent = o.dew_point != null ? o.dew_point.toFixed(1) : '--';
  }

  if (s.ina260) {
    const p = s.ina260;
    $('#pwr-voltage').textContent = p.voltage != null ? p.voltage.toFixed(2) : '--';
    $('#pwr-current').textContent = p.current != null ? p.current.toFixed(3) : '--';
    $('#pwr-power').textContent = p.power != null ? p.power.toFixed(1) : '--';
  }

  if (s.pi_fan) {
    const pf = s.pi_fan;
    $('#pi-fan-rpm').textContent = pf.rpm != null ? pf.rpm : '--';
    $('#pi-fan-pct').textContent = pf.speed_pct != null ? Math.round(pf.speed_pct) : '--';

    // ── Pi fan PWM bar ────────────────────────────────────────
    const bar = $('#pi-fan-bar');
    if (bar && pf.speed_pct != null) {
      bar.style.width = `${Math.round(Math.min(100, Math.max(0, pf.speed_pct)))}%`;
    }

    drawPiFanCurve(s.pi_fan, s.system?.cpu);
  }
}

// ── Trend delta helper ────────────────────────────────────────────
// history is sampled every 30 s; 5 min back = ~10 entries
const TREND_WINDOW_ENTRIES = 10;

function _updateTrendDelta(pillId, history, accessor, currentVal) {
  const pill = $(pillId);
  if (!pill) return;

  // Need at least 2 entries and a valid current value
  if (history.length < 2 || currentVal == null) {
    pill.textContent = '';
    pill.className = 'delta flat';
    return;
  }

  // Pick the entry closest to 5 min back (index from end = TREND_WINDOW_ENTRIES)
  const targetIdx = Math.max(0, history.length - 1 - TREND_WINDOW_ENTRIES);
  const oldEntry = history[targetIdx];
  const oldVal = oldEntry ? accessor(oldEntry) : null;

  if (oldVal == null) {
    pill.textContent = '';
    pill.className = 'delta flat';
    return;
  }

  const delta = currentVal - oldVal;
  const absDelta = Math.abs(delta);

  // Treat changes smaller than 0.05 as flat
  if (absDelta < 0.05) {
    pill.textContent = '';
    pill.className = 'delta flat';
    return;
  }

  const sign = delta > 0 ? '+' : '-';
  pill.textContent = `${sign}${absDelta.toFixed(1)}°`;
  pill.className = delta > 0 ? 'delta up' : 'delta dn';
}

// ── Relay display ────────────────────────────────────────────────
function updateRelays(relays, modes) {
  if (!relays) return;

  for (const name of ['fan', 'heater']) {
    const r = relays[name];
    if (!r) continue;
    const ind = $(`#${name}-indicator`);
    ind.className = `relay-indicator ${r.is_on ? 'on' : 'off'}`;
    $(`#${name}-pin`).textContent = r.pin;
    $(`#${name}-cycles`).textContent = r.cycle_count;

    // Update mode buttons
    const mode = modes[name] || 'auto';
    $$(`[data-device="${name}"]`).forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
  }
}

// ── Sparklines ───────────────────────────────────────────────────
function drawSparkline(canvasId, values, color = '#58a6ff') {
  const canvas = $(canvasId);
  if (!canvas || values.length < 2) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.offsetWidth * (window.devicePixelRatio || 1);
  const h = canvas.height = 40 * (window.devicePixelRatio || 1);
  ctx.clearRect(0, 0, w, h);

  const valid = values.filter(v => v != null);
  if (valid.length < 2) return;
  const min = Math.min(...valid) - 1;
  const max = Math.max(...valid) + 1;
  const range = max - min || 1;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * (window.devicePixelRatio || 1);
  ctx.beginPath();

  const step = w / (values.length - 1);
  let first = true;
  values.forEach((v, i) => {
    if (v == null) return;
    const x = i * step;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    if (first) { ctx.moveTo(x, y); first = false; }
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawSparklines() {
  if (!historyData.length) return;
  // Use last 60 entries (~10 min at 10s interval)
  const slice = historyData.slice(-60);
  drawSparkline('#spark-cpu', slice.map(d => d.system?.cpu), '#58a6ff');
  drawSparkline('#spark-ssd', slice.map(d => d.system?.ssd), '#d29922');
  drawSparkline('#spark-enclosure', slice.map(d => d.bme280?.temperature), '#3fb950');
}

// ── Dew Status Gauge ─────────────────────────────────────────────
function updateDewStatus(sensors, relays, modes) {
  if (!sensors) return;
  const bme = sensors.bme280 || {};
  const outdoor = sensors.outdoor || {};
  const heaterCfg = config.heater || {};
  const dewMargin = heaterCfg.dew_margin ?? 5;
  const hysteresis = heaterCfg.hysteresis ?? 2;
  const frostThreshold = heaterCfg.outside_temp_threshold ?? 2;
  const heaterOn = relays?.heater?.is_on ?? false;
  const fanOn = relays?.fan?.is_on ?? false;
  const fanOffWhenHeating = heaterCfg.fan_off_when_heating !== false;

  const encTemp = bme.temperature;
  const encDew = bme.dew_point;

  // Store latest params for animation loop
  _dewGaugeParams = { encTemp, encDew, outdoor, dewMargin, hysteresis, frostThreshold, heaterOn };

  // Update indicators
  // 1. Enclosure dew gap
  const proxInd = $('#dew-ind-proximity');
  const proxVal = $('#dew-distance-val');
  if (encTemp != null && encDew != null) {
    const dist = encTemp - encDew;
    if (dist < dewMargin) {
      proxInd.className = 'dew-indicator danger';
      proxVal.textContent = `${dist.toFixed(1)}\u00b0C above dew \u2014 risk`;
    } else if (dist < dewMargin + hysteresis) {
      proxInd.className = 'dew-indicator warn';
      proxVal.textContent = `${dist.toFixed(1)}\u00b0C above dew`;
    } else {
      proxInd.className = 'dew-indicator safe';
      proxVal.textContent = `${dist.toFixed(1)}\u00b0C above dew`;
    }
  } else {
    proxVal.textContent = '--';
    proxInd.className = 'dew-indicator';
  }

  // 2. Outdoor dew gap
  const outInd = $('#dew-ind-outside');
  const outVal = $('#dew-outside-val');
  if (outdoor.available && outdoor.dew_point != null && encTemp != null) {
    const dist = encTemp - outdoor.dew_point;
    if (dist < dewMargin) {
      outInd.className = 'dew-indicator danger';
      outVal.textContent = `${dist.toFixed(1)}\u00b0C above outdoor dew \u2014 risk`;
    } else if (dist < dewMargin + hysteresis) {
      outInd.className = 'dew-indicator warn';
      outVal.textContent = `${dist.toFixed(1)}\u00b0C above outdoor dew`;
    } else {
      outInd.className = 'dew-indicator safe';
      outVal.textContent = `${dist.toFixed(1)}\u00b0C above outdoor dew`;
    }
  } else {
    outVal.textContent = outdoor.available ? '--' : 'No HA data';
    outInd.className = 'dew-indicator inactive';
  }

  // 3. Frost
  const frostInd = $('#dew-ind-frost');
  const frostVal = $('#dew-frost-val');
  if (outdoor.available && outdoor.temperature != null) {
    const aboveThresh = outdoor.temperature - frostThreshold;
    if (outdoor.temperature < frostThreshold) {
      frostInd.className = 'dew-indicator danger';
      frostVal.textContent = `${outdoor.temperature.toFixed(1)}\u00b0C \u2014 below ${frostThreshold}\u00b0C threshold`;
    } else if (outdoor.temperature < frostThreshold + hysteresis) {
      frostInd.className = 'dew-indicator warn';
      frostVal.textContent = `${outdoor.temperature.toFixed(1)}\u00b0C \u2014 near ${frostThreshold}\u00b0C threshold`;
    } else {
      frostInd.className = 'dew-indicator safe';
      frostVal.textContent = `${outdoor.temperature.toFixed(1)}\u00b0C \u2014 ${aboveThresh.toFixed(0)}\u00b0C above threshold`;
    }
  } else {
    frostVal.textContent = outdoor.available ? '--' : 'No HA data';
    frostInd.className = 'dew-indicator inactive';
  }

  // 4. Fan interlock
  const fanInd = $('#dew-ind-fan-suppress');
  const fanVal = $('#dew-fan-suppress-val');
  if (fanOffWhenHeating && heaterOn) {
    fanInd.className = 'dew-indicator active';
    fanVal.textContent = fanOn ? 'Waiting to cut fan' : 'Fan held off';
  } else if (fanOffWhenHeating) {
    fanInd.className = 'dew-indicator safe';
    fanVal.textContent = 'Armed';
  } else {
    fanInd.className = 'dew-indicator inactive';
    fanVal.textContent = 'Disabled';
  }
}

function drawDewGauge(encTemp, encDew, outdoor, dewMargin, hysteresis, frostThreshold, heaterOn, time) {
  const canvas = $('#dew-gauge');
  if (!canvas) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  const pad = { left: 50, right: 50, top: 20, bottom: 40 };

  ctx.clearRect(0, 0, w, h);

  // Show/hide heater badge
  const badge = $('#heater-badge');
  if (badge) badge.classList.toggle('hidden', !heaterOn);

  if (encTemp == null || encDew == null) {
    ctx.fillStyle = '#64748b';
    ctx.font = '13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for sensor data\u2026', w / 2, h / 2);
    return;
  }

  const allTemps = [encTemp, encDew, encDew - 5];
  if (outdoor.available && outdoor.dew_point != null) allTemps.push(outdoor.dew_point);
  if (outdoor.available && outdoor.temperature != null) allTemps.push(outdoor.temperature);
  if (frostThreshold != null) allTemps.push(frostThreshold);
  const tMin = Math.floor(Math.min(...allTemps) - 5);
  const tMax = Math.ceil(Math.max(...allTemps) + 5);

  const trackY = Math.round(h * 0.45);
  const trackH = 12;

  function tempToXLocal(t) {
    return pad.left + ((t - tMin) / (tMax - tMin)) * (w - pad.left - pad.right);
  }

  // 1. Background ticks
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '11px Inter, sans-serif';
  ctx.textAlign = 'center';
  const step = Math.max(1, Math.round((tMax - tMin) / 8));
  for (let t = Math.ceil(tMin / step) * step; t <= tMax; t += step) {
    const x = tempToXLocal(t);
    ctx.beginPath();
    ctx.moveTo(x, trackY - 15);
    ctx.lineTo(x, trackY + trackH + 15);
    ctx.stroke();
    ctx.fillText(`${t}\u00b0`, x, trackY + trackH + 30);
  }

  // 2. Main track background (pill)
  ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
  ctx.beginPath();
  ctx.roundRect(pad.left, trackY, w - pad.left - pad.right, trackH, trackH / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.stroke();

  const dewX = tempToXLocal(encDew);
  const marginX = tempToXLocal(encDew + dewMargin);

  // 3. Colored zones clipped inside the pill track
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(pad.left, trackY, w - pad.left - pad.right, trackH, trackH / 2);
  ctx.clip();

  // Danger zone (red)
  ctx.fillStyle = 'rgba(239, 68, 68, 0.8)';
  ctx.shadowColor = 'rgba(239, 68, 68, 0.8)';
  ctx.shadowBlur = 10;
  ctx.fillRect(pad.left, trackY, dewX - pad.left, trackH);

  // Warning zone (amber)
  ctx.fillStyle = 'rgba(245, 158, 11, 0.8)';
  ctx.shadowColor = 'rgba(245, 158, 11, 0.8)';
  ctx.shadowBlur = 10;
  ctx.fillRect(dewX, trackY, marginX - dewX, trackH);

  // Safe zone (green, subtle)
  ctx.fillStyle = 'rgba(34, 197, 94, 0.3)';
  ctx.shadowBlur = 0;
  ctx.fillRect(marginX, trackY, w - marginX, trackH);

  ctx.restore();

  // 4. Floating label markers — staggered to avoid overlap
  const topMarkers = [
    { x: dewX, label: `Dew ${encDew.toFixed(1)}\u00b0`, color: '#ef4444' },
    { x: marginX, label: 'Margin', color: '#f59e0b' },
  ];
  const botMarkers = [];
  if (outdoor.available && outdoor.dew_point != null) {
    botMarkers.push({ x: tempToXLocal(outdoor.dew_point), label: `Out Dew ${outdoor.dew_point.toFixed(1)}\u00b0`, color: '#a855f7' });
  }
  if (frostThreshold != null) {
    botMarkers.push({ x: tempToXLocal(frostThreshold), label: `Frost ${frostThreshold}\u00b0`, color: '#38bdf8' });
  }

  ctx.font = '600 10px Inter, sans-serif';

  // Assign each marker its own row, sorted by x position
  function assignRows(markers) {
    const sorted = [...markers].sort((a, b) => a.x - b.x);
    sorted.forEach((m, i) => { m.row = i; });
  }

  assignRows(topMarkers);
  assignRows(botMarkers);

  function drawMarker(m, isTop) {
    const rowOffset = (m.row || 0) * 28;
    const yPos = isTop ? trackY - 25 - rowOffset : trackY + trackH + 25 + rowOffset;

    ctx.strokeStyle = m.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(m.x, trackY - (isTop ? 20 + rowOffset : -10));
    ctx.lineTo(m.x, trackY + trackH + (isTop ? -10 : 20 + rowOffset));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '600 10px Inter, sans-serif';
    ctx.textAlign = 'center';

    ctx.shadowColor = m.color;
    ctx.shadowBlur = 5;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    const textWidth = ctx.measureText(m.label).width;
    ctx.beginPath();
    ctx.roundRect(m.x - textWidth / 2 - 6, yPos - 10, textWidth + 12, 16, 4);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = m.color;
    ctx.fillText(m.label, m.x, yPos + 2);
  }

  for (const m of topMarkers) drawMarker(m, true);
  for (const m of botMarkers) drawMarker(m, false);

  // 5. Current enclosure temp — animated glowing dot
  const encX = tempToXLocal(encTemp);
  const dewDist = encTemp - encDew;
  let markerColor = '#22c55e';
  if (dewDist < dewMargin) markerColor = '#ef4444';
  else if (dewDist < dewMargin + hysteresis) markerColor = '#f59e0b';

  const animTime = time || performance.now();
  const pulseSize = Math.sin(animTime * 0.005) * 2;

  ctx.beginPath();
  ctx.moveTo(encX, trackY - 5);
  ctx.lineTo(encX, trackY + trackH + 5);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.shadowColor = markerColor;
  ctx.shadowBlur = 15;
  ctx.fillStyle = markerColor;
  ctx.beginPath();
  ctx.arc(encX, trackY + trackH / 2, 6 + pulseSize, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(encX, trackY + trackH / 2, 2.5, 0, Math.PI * 2);
  ctx.fill();

  // Main temp label
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 13px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`Enc ${encTemp.toFixed(1)}\u00b0`, encX, trackY - 10);
}

// ── Pi Fan Curve (mini card graph) ──────────────────────────────
function drawPiFanCurve(fan, cpuTemp) {
  const canvas = $('#pi-fan-curve');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth || canvas.parentElement.clientWidth;
  const ch = 40;
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cw, ch);

  const trips = fan.trip_points;
  if (!trips || !trips.length) return;

  // Derive range from trip points: 0 → last trip + margin
  const lastTrip = trips[trips.length - 1].temp;
  const tempMax = lastTrip + 15;
  const pad = { left: 18, right: 8, top: 4, bot: 12 };
  const plotW = cw - pad.left - pad.right;
  const plotH = ch - pad.top - pad.bot;
  const tToX = t => pad.left + (t / tempMax) * plotW;
  const sToY = s => pad.top + plotH - (s / 255) * plotH;

  // Axis labels at key trip temps
  ctx.fillStyle = '#64748b';
  ctx.font = '9px Inter, sans-serif';
  ctx.textAlign = 'center';
  for (const tp of trips) {
    if (tp.temp > 0) {
      ctx.fillText(`${tp.temp}°`, tToX(tp.temp), ch - 1);
    }
  }

  // Step curve path
  ctx.beginPath();
  let prevSpeed = 0;
  ctx.moveTo(pad.left, sToY(prevSpeed));
  for (const tp of trips) {
    const x = tToX(tp.temp);
    ctx.lineTo(x, sToY(prevSpeed));
    ctx.lineTo(x, sToY(tp.speed));
    prevSpeed = tp.speed;
  }
  ctx.lineTo(cw - pad.right, sToY(prevSpeed));

  ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Fill under curve
  ctx.lineTo(cw - pad.right, sToY(0));
  ctx.lineTo(pad.left, sToY(0));
  ctx.closePath();
  ctx.fillStyle = 'rgba(56, 189, 248, 0.08)';
  ctx.fill();

  // CPU temp marker dot on the curve
  if (cpuTemp != null) {
    const mx = tToX(cpuTemp);
    let curSpeed = 0;
    for (const tp of trips) {
      if (cpuTemp >= tp.temp) curSpeed = tp.speed;
    }
    const my = sToY(curSpeed);

    // Glowing dot
    ctx.beginPath();
    ctx.arc(mx, my, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#38bdf8';
    ctx.shadowColor = '#38bdf8';
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;

    // White center
    ctx.beginPath();
    ctx.arc(mx, my, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }
}

// ── Fan Curve Editor ─────────────────────────────────────────────
const CURVE_TEMP_MIN = 0;
const CURVE_TEMP_MAX = 80;

function drawFanCurve(time) {
  const canvas = $('#fan-curve-canvas');
  if (!canvas) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  const pad = { left: 40, right: 30, top: 20, bottom: 30 };

  ctx.clearRect(0, 0, w, h);

  // 1. Sleek grid
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
  ctx.lineWidth = 1;

  for (let t = 0; t <= 80; t += 10) {
    const x = tempToX(t, w, pad.left);
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, h - pad.bottom); ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${t}\u00b0`, x, h - pad.bottom + 16);
  }

  // ON/OFF horizontal lines and labels
  const yOn = pad.top + 30;
  const yOff = h - pad.bottom - 30;

  ctx.beginPath(); ctx.moveTo(pad.left, yOn); ctx.lineTo(w - pad.right, yOn); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pad.left, yOff); ctx.lineTo(w - pad.right, yOff); ctx.stroke();

  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'right';
  ctx.font = '600 11px Inter, sans-serif';
  ctx.fillText('ON', pad.left - 10, yOn + 4);
  ctx.fillText('OFF', pad.left - 10, yOff + 4);

  const hysteresis = config.fan?.hysteresis ?? 3;
  const animTime = time || performance.now();
  const threshX = tempToX(fanThreshold, w, pad.left);
  const hystX = tempToX(fanThreshold - hysteresis, w, pad.left);

  // Hysteresis shaded area
  const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
  grad.addColorStop(0, 'rgba(56, 189, 248, 0.15)');
  grad.addColorStop(1, 'rgba(56, 189, 248, 0.02)');
  ctx.fillStyle = grad;
  ctx.fillRect(hystX, pad.top, threshX - hystX, h - pad.top - pad.bottom);
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(hystX, pad.top); ctx.lineTo(hystX, h - pad.bottom); ctx.stroke();
  ctx.setLineDash([]);

  // Draw step curve path: OFF until threshold, then ON
  ctx.beginPath();
  ctx.moveTo(pad.left, yOff);
  ctx.lineTo(threshX, yOff);
  ctx.lineTo(threshX, yOn);
  ctx.lineTo(w - pad.right, yOn);

  // Neon glow stroke
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#38bdf8';
  ctx.shadowBlur = 12;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Gradient fill under curve
  ctx.lineTo(w - pad.right, h - pad.bottom);
  ctx.lineTo(pad.left, h - pad.bottom);
  ctx.closePath();
  const fillGrad = ctx.createLinearGradient(0, yOn, 0, h - pad.bottom);
  fillGrad.addColorStop(0, 'rgba(56, 189, 248, 0.2)');
  fillGrad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');
  ctx.fillStyle = fillGrad;
  ctx.fill();

  // Glowing orb at threshold point
  const pulse = Math.sin(animTime * 0.006 + fanThreshold) * 3;
  if (draggingThreshold) {
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.arc(threshX, yOn, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.shadowBlur = 0;
  } else {
    ctx.shadowColor = '#38bdf8';
    ctx.shadowBlur = 15;
    ctx.beginPath();
    ctx.arc(threshX, yOn, 6 + Math.max(0, pulse), 0, Math.PI * 2);
    ctx.fillStyle = '#38bdf8';
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // White center dot
  ctx.beginPath();
  ctx.arc(threshX, yOn, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // Value label
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '600 10px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${fanThreshold}\u00b0`, threshX, yOn - 16);

  // 3. Live sensor markers as staggered badges
  const badges = [
    { label: 'CPU', temp: latestStatus?.sensors?.system?.cpu, color: '#818cf8' },
    { label: 'SSD', temp: latestStatus?.sensors?.system?.ssd, color: '#f472b6' },
    { label: 'Enc', temp: latestStatus?.sensors?.bme280?.temperature, color: '#34d399' },
  ].filter(b => b.temp != null);

  // Sort by x-position, assign each its own row
  ctx.font = 'bold 10px Inter, sans-serif';
  badges.sort((a, b) => a.temp - b.temp);
  badges.forEach((b, i) => { b.row = i; });

  for (const b of badges) {
    const x = tempToX(b.temp, w, pad.left);
    const badgeY = pad.top + 10 + (b.row * 24);
    const lineTop = badgeY + 8;
    const lineBot = b.temp >= fanThreshold ? yOn : yOff;

    ctx.strokeStyle = b.color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x, lineTop); ctx.lineTo(x, lineBot); ctx.stroke();
    ctx.setLineDash([]);
    const text = `${b.label} ${b.temp.toFixed(0)}\u00b0`;
    ctx.font = 'bold 10px Inter, sans-serif';
    const textW = ctx.measureText(text).width;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - textW / 2 - 6, badgeY - 12, textW + 12, 18, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = b.color;
    ctx.textAlign = 'center';
    ctx.fillText(text, x, badgeY);
  }
}

function tempToX(temp, w, padLeft) {
  const padRight = 30;
  return padLeft + ((temp - CURVE_TEMP_MIN) / (CURVE_TEMP_MAX - CURVE_TEMP_MIN)) * (w - padLeft - padRight);
}

function xToTemp(x, w, padLeft) {
  const padRight = 30;
  return CURVE_TEMP_MIN + ((x - padLeft) / (w - padLeft - padRight)) * (CURVE_TEMP_MAX - CURVE_TEMP_MIN);
}

// ── Curve interaction ────────────────────────────────────────────
let latestStatus = null;

function initCurveEditor() {
  const canvas = $('#fan-curve-canvas');
  if (!canvas) return;

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const w = rect.width;
    const padLeft = 40;
    const padTop = 20;
    const yOn = padTop + 30;

    const px = tempToX(fanThreshold, w, padLeft);
    if (Math.hypot(mx - px, my - yOn) < 16) {
      draggingThreshold = true;
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!draggingThreshold) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const w = rect.width;
    const padLeft = 40;

    fanThreshold = Math.round(Math.max(0, Math.min(80, xToTemp(mx, w, padLeft))));
  });

  canvas.addEventListener('mouseup', async () => {
    if (!draggingThreshold) return;
    draggingThreshold = false;
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fan: { threshold: fanThreshold } }),
    });
    await fetchConfig();
  });
  canvas.addEventListener('mouseleave', () => { draggingThreshold = false; });
}

// ── Mode buttons ─────────────────────────────────────────────────
function initModeButtons() {
  $$('.mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const device = btn.dataset.device;
      const mode = btn.dataset.mode;
      await api(`/api/${device}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      // Update button state immediately
      $$(`[data-device="${device}"]`).forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
      });
      // Re-fetch status so relay indicators and dew gauge update instantly
      await fetchStatus();
      await fetchEvents();
    });
  });
}

// ── GPS ──────────────────────────────────────────────────────────
const GNSS_COLORS = { GPS: '#58a6ff', GAL: '#3fb950', BDS: '#f85149', GLO: '#d29922', SBAS: '#8b949e', QZSS: '#bc8cff', IRN: '#f778ba', '?': '#8b949e' };

async function fetchGps() {
  const det = $('details[data-acc="gps"]');
  if (!det) return;
  const badge = $('#gps-fix-badge');
  if (!det.open) return; // skip polling while collapsed
  const data = await api('/api/gps');
  if (!data || data.error) {
    badge.textContent = 'OFFLINE';
    badge.className = 'badge err';
    return;
  }
  renderGps(data);
}

function renderGps(g) {
  const badge = $('#gps-fix-badge');
  badge.textContent = g.fix;
  badge.className = 'badge ' + (g.mode === 3 ? 'ok' : g.mode === 2 ? 'warn' : 'err');

  const fmt = (v, dp, unit = '') => v != null ? v.toFixed(dp) + unit : '--';
  // only write when changed — a rewrite of identical text still destroys the user's text selection
  const setTxt = (sel, text) => { const el = $(sel); if (el.textContent !== text) el.textContent = text; };
  setTxt('#gps-lat', g.lat != null ? g.lat.toFixed(6) + '°' : '--');
  setTxt('#gps-lon', g.lon != null ? g.lon.toFixed(6) + '°' : '--');
  setTxt('#gps-alt', fmt(g.alt_msl, 1, ' m'));
  setTxt('#gps-sats', `${g.sats_used} / ${g.sats_visible}`);
  setTxt('#gps-sats-max', g.max_sats_used != null ? `${g.max_sats_used} / ${g.max_sats_visible}` : '--');
  if (g.peaks_since) {
    $('#gps-sats-max-label').title = `Peak used / visible since ${new Date(g.peaks_since * 1000).toLocaleString()}`;
  }
  setTxt('#gps-dop', g.hdop != null ? `${g.hdop.toFixed(2)} / ${g.vdop?.toFixed(2) ?? '--'}` : '--');
  setTxt('#gps-err', g.eph != null ? `±${g.eph.toFixed(1)} / ±${g.epv?.toFixed(1) ?? '--'} m` : '--');
  setTxt('#gps-speed', fmt(g.speed, 2, ' m/s'));
  setTxt('#gps-time', g.time ? g.time.slice(11, 19) : '--');
  if (g.ttff && g.ttff.ttff_s != null) {
    const t = g.ttff.ttff_s;
    setTxt('#gps-ttff', t < 90 ? `${t.toFixed(0)} s` : `${(t / 60).toFixed(1)} min`);
    $('#gps-ttff-label').title = `Receiver-reported time from power-up to first fix (UBX-NAV-STATUS). Static until the receiver resets. Receiver up ${(g.ttff.uptime_s / 3600).toFixed(1)} h.`;
  } else {
    setTxt('#gps-ttff', '--');
  }

  drawSkyplot(g.satellites);
  drawSnrBars(g.satellites);
  fetchGpsStats();
}

// ── Long-term GPS stats: sky coverage + 24h trends ───────────────
let _gpsStatsLast = 0;

async function fetchGpsStats() {
  const now = Date.now();
  if (now - _gpsStatsLast < 60000) return; // server samples every 30s; no point polling faster
  const s = await api('/api/gps/stats');
  if (!s || s.error) return;
  _gpsStatsLast = now;
  const since = m => s.resets?.[m] ?? 0;
  drawSkyCoverage(s.sky, s.history.filter(r => r.t >= since('sky')));
  drawGpsTrends(s.history, since);
  drawDrift(s.history.filter(r => r.t >= since('drift') && r.mode >= 2 && r.lat != null && r.lon != null));
}

function initGpsResetButtons() {
  document.querySelectorAll('.gps-reset').forEach(btn => btn.addEventListener('click', async (e) => {
    e.preventDefault();
    const m = btn.dataset.reset;
    if (!confirm(`Reset "${btn.title.replace(/^Reset /, '')}"? This cannot be undone.`)) return;
    const r = await api(`/api/gps/reset/${m}`, { method: 'POST' });
    if (!r || r.error) return;
    _gpsStatsLast = 0;
    fetchGpsStats();
    if (m === 'peaks') fetchGps();
  }));
}

function drawSkyCoverage(sky, hist) {
  const svg = $('#gps-skycov');
  const C = 120, R = 105;
  const pt = (r, az) => { const a = az * Math.PI / 180; return [C + r * Math.sin(a), C - r * Math.cos(a)]; };
  let maxSeen = 0;
  for (const c of Object.values(sky)) maxSeen = Math.max(maxSeen, c[0]);
  let out = '';
  for (const [key, [seen, used, snrSum]] of Object.entries(sky)) {
    const [ab, eb] = key.split(',').map(Number);
    if (eb < 0 || eb > 8) continue; // below-horizon bins from older data
    const r2 = R * (90 - eb * 10) / 90, r1 = R * (90 - (eb + 1) * 10) / 90;
    const a0 = ab * 10, a1 = a0 + 10;
    const [x0, y0] = pt(r2, a0), [x1, y1] = pt(r2, a1), [x2, y2] = pt(r1, a1), [x3, y3] = pt(r1, a0);
    const inner = r1 < 0.5
      ? `L${C},${C}`
      : `L${x2.toFixed(1)},${y2.toFixed(1)} A${r1.toFixed(1)},${r1.toFixed(1)} 0 0 0 ${x3.toFixed(1)},${y3.toFixed(1)}`;
    const ratio = used / seen;
    const alpha = 0.15 + 0.85 * Math.min(1, seen / (maxSeen * 0.5 || 1));
    const hue = 30 + 90 * ratio; // orange (rarely used) -> green (used)
    out += `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${r2.toFixed(1)},${r2.toFixed(1)} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)} ${inner} Z" fill="hsl(${hue.toFixed(0)},60%,42%)" fill-opacity="${alpha.toFixed(2)}"><title>az ${a0}–${a1}° el ${eb * 10}–${eb * 10 + 10}°: seen ${seen}×, used ${(ratio * 100).toFixed(0)}%, avg SNR ${(snrSum / seen).toFixed(0)}</title></path>`;
  }
  for (const el of [0, 30, 60]) out += `<circle cx="${C}" cy="${C}" r="${R * (90 - el) / 90}" fill="none" stroke="rgba(255,255,255,0.15)"/>`;
  for (const [az, name] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
    const [xa, ya] = pt(R, az), [xb, yb] = pt(R, az + 180), [xl, yl] = pt(R + 9, az);
    if (az < 180) out += `<line x1="${xa.toFixed(1)}" y1="${ya.toFixed(1)}" x2="${xb.toFixed(1)}" y2="${yb.toFixed(1)}" stroke="rgba(255,255,255,0.10)"/>`;
    out += `<text x="${xl.toFixed(1)}" y="${(yl + 3.5).toFixed(1)}" class="gps-sky-label" text-anchor="middle">${name}</text>`;
  }
  svg.innerHTML = out;
  if (hist.length > 1) {
    const hrs = (hist[hist.length - 1].t - hist[0].t) / 3600;
    $('#gps-skycov-info').textContent = `· ${hrs < 1 ? (hrs * 60).toFixed(0) + ' min' : hrs.toFixed(1) + ' h'} of data`;
  }
}

function drawGpsTrends(all, since = () => 0) {
  if (all.length < 2) return;
  const W = 600;
  const t0 = all[0].t, span = Math.max(1, all[all.length - 1].t - t0);
  const X = t => (t - t0) / span * W;
  const empty = (id, info) => { $(id).innerHTML = ''; if (info) $(info).textContent = '· reset, collecting…'; };

  // satellites: used area + visible line
  const H1 = 100;
  let hist = all.filter(h => h.t >= since('sats'));
  if (hist.length < 2) { empty('#gps-sats-chart', '#gps-trend-sats-info'); hist = []; }
  const maxSats = Math.max(4, ...hist.map(h => h.vis));
  const y1 = v => H1 - v / maxSats * (H1 - 8);
  const ptsUsed = hist.map(h => `${X(h.t).toFixed(1)},${y1(h.used).toFixed(1)}`).join(' ');
  const ptsVis = hist.map(h => `${X(h.t).toFixed(1)},${y1(h.vis).toFixed(1)}`).join(' ');
  if (hist.length) {
    const x0 = X(hist[0].t).toFixed(1);
    $('#gps-sats-chart').innerHTML =
      `<polygon points="${x0},${H1} ${ptsUsed} ${W},${H1}" fill="rgba(88,166,255,0.18)"/>` +
      `<polyline points="${ptsVis}" fill="none" stroke="rgba(139,148,158,0.8)" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
      `<polyline points="${ptsUsed}" fill="none" stroke="#58a6ff" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
    const last = hist[hist.length - 1];
    $('#gps-trend-sats-info').textContent = `· blue used (${last.used}), grey visible (${last.vis}), peak ${maxSats}`;
  }

  // hdop line
  const H2 = 60, hd = all.filter(h => h.t >= since('hdop') && h.hdop != null);
  if (hd.length < 2) empty('#gps-hdop-chart', '#gps-trend-hdop-info');
  if (hd.length > 1) {
    const maxH = Math.max(2, ...hd.map(h => Math.min(h.hdop, 10)));
    const y2 = v => H2 - Math.min(v, maxH) / maxH * (H2 - 6);
    $('#gps-hdop-chart').innerHTML =
      `<polyline points="${hd.map(h => `${X(h.t).toFixed(1)},${y2(h.hdop).toFixed(1)}`).join(' ')}" fill="none" stroke="#d29922" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
    $('#gps-trend-hdop-info').textContent = `· now ${hd[hd.length - 1].hdop.toFixed(2)}, range ${Math.min(...hd.map(h => h.hdop)).toFixed(2)}–${Math.max(...hd.map(h => h.hdop)).toFixed(2)}`;
  }

  // fix quality strip: merged same-mode runs
  hist = all.filter(h => h.t >= since('fix'));
  $('#gps-trend-start').textContent = new Date(t0 * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (hist.length < 2) { empty('#gps-fix-strip', '#gps-trend-fix-info'); return; }
  const colorFor = m => m === 3 ? '#3fb950' : m === 2 ? '#d29922' : '#f85149';
  let runs = '', runStart = 0;
  for (let i = 1; i <= hist.length; i++) {
    if (i === hist.length || hist[i].mode !== hist[runStart].mode) {
      const xa = X(hist[runStart].t), xb = i === hist.length ? W : X(hist[i].t);
      runs += `<rect x="${xa.toFixed(1)}" y="0" width="${Math.max(0.5, xb - xa).toFixed(1)}" height="12" fill="${colorFor(hist[runStart].mode)}"/>`;
      runStart = i;
    }
  }
  $('#gps-fix-strip').innerHTML = runs;

  // fix uptime, losses, time-to-fix (duration of no-fix runs that ended in a fix)
  let losses = 0, fixSamples = 0, outStart = null;
  const reacq = [];
  hist.forEach((h, i) => {
    const fixed = h.mode >= 2;
    if (fixed) fixSamples++;
    if (!fixed && outStart === null) { outStart = h.t; if (i > 0) losses++; }
    if (fixed && outStart !== null) { reacq.push(Math.max(h.t - outStart, 30)); outStart = null; }
  });
  const fmtDur = s => s < 90 ? `${s.toFixed(0)} s` : `${(s / 60).toFixed(1)} min`;
  let fixInfo = `· ${(fixSamples / hist.length * 100).toFixed(1)}% fix, ${losses} ${losses === 1 ? 'loss' : 'losses'}`;
  if (reacq.length) {
    const avg = reacq.reduce((a, b) => a + b, 0) / reacq.length;
    fixInfo += `, time to fix last ${fmtDur(reacq[reacq.length - 1])} / avg ${fmtDur(avg)}`;
  }
  $('#gps-trend-fix-info').textContent = fixInfo;
}

// ── Position drift plot ──────────────────────────────────────────
// Fed from the server's persisted 24h sample history (survives service
// restarts and page reloads), not a page-local buffer.
function drawDrift(fixes) {
  const svg = $('#gps-drift');
  if (!svg) return;
  const C = 120, R = 105;

  // mean position -> offsets in meters (equirectangular; fine for meter-scale wander)
  const n = fixes.length;
  let pts = [], dists = [], maxD = 0;
  if (n >= 2) {
    const mlat = fixes.reduce((a, f) => a + f.lat, 0) / n;
    const mlon = fixes.reduce((a, f) => a + f.lon, 0) / n;
    const mLat = 111320, mLon = 111320 * Math.cos(mlat * Math.PI / 180);
    pts = fixes.map(f => [(f.lon - mlon) * mLon, (f.lat - mlat) * mLat]); // [E, N]
    dists = pts.map(([x, y]) => Math.hypot(x, y)).sort((a, b) => a - b);
    maxD = dists[dists.length - 1];
  }

  // rings: 3 at a step that covers the worst point, min 1 m
  const step = Math.max(1, Math.ceil(maxD / 3));
  const edge = 3 * step, S = R / edge;

  let out = '';
  for (let m = step; m <= edge; m += step) {
    out += `<circle cx="${C}" cy="${C}" r="${m * S}" fill="none" stroke="rgba(255,255,255,0.10)"/>`;
    out += `<text x="${C + 3}" y="${C - m * S + 11}" class="gps-sky-label">${m}m</text>`;
  }
  out += `<line x1="${C}" y1="${C - R}" x2="${C}" y2="${C + R}" stroke="rgba(255,255,255,0.07)"/>`;
  out += `<line x1="${C - R}" y1="${C}" x2="${C + R}" y2="${C}" stroke="rgba(255,255,255,0.07)"/>`;
  out += `<text x="${C}" y="${C - R - 4}" class="gps-sky-label" text-anchor="middle">N</text>`;
  out += `<text x="${C + R + 8}" y="${C + 4}" class="gps-sky-label" text-anchor="middle">E</text>`;

  const setStat = (id, v) => { $(id).textContent = v; };
  if (n < 2) {
    out += `<text x="${C}" y="${C - 10}" class="gps-sky-label" text-anchor="middle">collecting fixes…</text>`;
    svg.innerHTML = out;
    ['#gps-drift-now', '#gps-drift-rms', '#gps-drift-max', '#gps-drift-cep'].forEach(id => setStat(id, '--'));
    setStat('#gps-drift-n', String(n));
    return;
  }

  const cep = dists[Math.floor(dists.length / 2)];
  const rms = Math.sqrt(pts.reduce((a, [x, y]) => a + x * x + y * y, 0) / n);

  out += `<circle cx="${C}" cy="${C}" r="${cep * S}" fill="none" stroke="#d29922" stroke-dasharray="4 3" opacity="0.8"/>`;
  out += `<polyline points="${pts.map(([x, y]) => `${(C + x * S).toFixed(1)},${(C - y * S).toFixed(1)}`).join(' ')}" fill="none" stroke="rgba(88,166,255,0.18)" stroke-width="1"/>`;
  pts.forEach(([x, y], i) => {
    const age = i / (n - 1); // 1 = newest
    out += `<circle cx="${(C + x * S).toFixed(1)}" cy="${(C - y * S).toFixed(1)}" r="${(1.5 + age * 1.2).toFixed(1)}" fill="rgba(88,166,255,${(0.08 + age * 0.55).toFixed(2)})"/>`;
  });
  const [cx, cy] = pts[n - 1];
  const X = C + cx * S, Y = C - cy * S;
  out += `<line x1="${(X - 8).toFixed(1)}" y1="${Y.toFixed(1)}" x2="${(X + 8).toFixed(1)}" y2="${Y.toFixed(1)}" stroke="#58a6ff" stroke-width="1.5"/>`;
  out += `<line x1="${X.toFixed(1)}" y1="${(Y - 8).toFixed(1)}" x2="${X.toFixed(1)}" y2="${(Y + 8).toFixed(1)}" stroke="#58a6ff" stroke-width="1.5"/>`;
  out += `<circle cx="${X.toFixed(1)}" cy="${Y.toFixed(1)}" r="3.5" fill="#58a6ff"/>`;
  svg.innerHTML = out;

  const fm = v => v.toFixed(2) + ' m';
  setStat('#gps-drift-now', fm(Math.hypot(cx, cy)));
  setStat('#gps-drift-rms', fm(rms));
  setStat('#gps-drift-max', fm(maxD));
  setStat('#gps-drift-cep', fm(cep));
  const hrs = (fixes[n - 1].t - fixes[0].t) / 3600;
  setStat('#gps-drift-n', `${n} (${hrs < 1 ? (hrs * 60).toFixed(0) + ' min' : hrs.toFixed(1) + ' h'})`);
}

function initGpsCopyButtons() {
  document.querySelectorAll('.gps-copy').forEach(btn => btn.addEventListener('click', () => {
    // copy the bare number — strip the ° / m unit
    const val = $('#' + btn.dataset.copy).textContent.replace(/[°]|\s*m$/g, '').trim();
    if (val === '--') return;
    const done = () => { btn.classList.add('copied'); setTimeout(() => btn.classList.remove('copied'), 1000); };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(val).then(done);
    } else {
      // http on LAN: no clipboard API outside secure context
      const ta = document.createElement('textarea');
      ta.value = val;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    }
  }));
}

function drawSkyplot(sats) {
  const svg = $('#gps-skyplot');
  const C = 120, R = 105;
  let out = '';
  // Elevation rings at 0/30/60 deg + crosshairs
  for (const el of [0, 30, 60]) {
    out += `<circle cx="${C}" cy="${C}" r="${R * (90 - el) / 90}" fill="none" stroke="rgba(255,255,255,0.12)"/>`;
  }
  out += `<line x1="${C}" y1="${C - R}" x2="${C}" y2="${C + R}" stroke="rgba(255,255,255,0.08)"/>`;
  out += `<line x1="${C - R}" y1="${C}" x2="${C + R}" y2="${C}" stroke="rgba(255,255,255,0.08)"/>`;
  out += `<text x="${C}" y="${C - R - 4}" class="gps-sky-label" text-anchor="middle">N</text>`;
  out += `<text x="${C + R + 8}" y="${C + 4}" class="gps-sky-label" text-anchor="middle">E</text>`;
  out += `<text x="${C}" y="${C + R + 12}" class="gps-sky-label" text-anchor="middle">S</text>`;
  out += `<text x="${C - R - 8}" y="${C + 4}" class="gps-sky-label" text-anchor="middle">W</text>`;

  for (const s of sats) {
    if (s.az == null || s.el == null) continue;
    const rr = R * (90 - s.el) / 90;
    const a = s.az * Math.PI / 180;
    const x = C + rr * Math.sin(a);
    const y = C - rr * Math.cos(a);
    const color = GNSS_COLORS[s.gnss] || GNSS_COLORS['?'];
    const fill = s.used ? color : 'none';
    const op = s.snr ? Math.min(1, 0.35 + s.snr / 40) : 0.35;
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${fill}" stroke="${color}" stroke-width="1.5" opacity="${op.toFixed(2)}"><title>${s.gnss} ${s.prn} el ${s.el} az ${s.az} snr ${s.snr ?? 0}</title></circle>`;
    if (s.used) {
      out += `<text x="${x.toFixed(1)}" y="${(y - 7).toFixed(1)}" class="gps-sky-prn" text-anchor="middle">${s.prn}</text>`;
    }
  }
  svg.innerHTML = out;
}

function drawSnrBars(sats) {
  const wrap = $('#gps-snr-bars');
  wrap.innerHTML = '';
  for (const s of sats) {
    const bar = document.createElement('div');
    bar.className = 'gps-snr-bar' + (s.used ? ' used' : '');
    const h = Math.max(2, Math.min(100, (s.snr || 0) / 45 * 100));
    bar.innerHTML =
      `<span class="gps-snr-val">${s.snr ? s.snr.toFixed(0) : ''}</span>` +
      `<span class="gps-snr-fill" style="height:${h}%;background:${GNSS_COLORS[s.gnss] || '#8b949e'}"></span>` +
      `<span class="gps-snr-prn" style="color:${GNSS_COLORS[s.gnss] || '#8b949e'}">${s.prn}</span>`;
    bar.title = `${s.gnss} ${s.prn}: ${s.snr ?? 0} dB-Hz${s.used ? ' (used)' : ''}`;
    wrap.appendChild(bar);
  }
}

// ── Polling loop ─────────────────────────────────────────────────
async function poll() {
  const status = await api('/api/status');
  if (status) {
    latestStatus = status;
    updateSensors(status.sensors);
    updateRelays(status.relays, status.modes);
    updateDewStatus(status.sensors, status.relays, status.modes);
    // Fan curve redrawn by animation loop
  } else {
    $('#connection-status').className = 'status-dot disconnected';
  }

  await fetchEvents();
  await fetchGps();

  // Fetch history less frequently (every 30s)
  if (!poll._histCount) poll._histCount = 0;
  if (poll._histCount++ % 6 === 0) {
    await fetchHistory();
  }
}

// ── Init ─────────────────────────────────────────────────────────
async function init() {
  await fetchConfig();

  // Settings are on the page at load time — populate and wire immediately
  await _initSettingsOnLoad();

  await fetchStatus();
  await fetchHistory();
  await fetchEvents();

  initCurveEditor();
  initModeButtons();
  initAccordionPersistence();
  // Fetch GPS immediately when its section is expanded
  $('details[data-acc="gps"]')?.addEventListener('toggle', e => { if (e.target.open) fetchGps(); });
  fetchGps();
  initGpsCopyButtons();
  initGpsResetButtons();
  initDirtyHints();

  // Redraw sparklines on resize (gauges handled by animation loop)
  window.addEventListener('resize', () => {
    drawSparklines();
  });

  // Animation loop for smooth pulsing effects on gauges
  function animate(time) {
    if (_dewGaugeParams) {
      const p = _dewGaugeParams;
      drawDewGauge(p.encTemp, p.encDew, p.outdoor, p.dewMargin, p.hysteresis, p.frostThreshold, p.heaterOn, time);
    }
    drawFanCurve(time);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  // Start polling
  setInterval(poll, POLL_MS);
}

document.addEventListener('DOMContentLoaded', init);

// ── Settings init (single-page: runs once at startup) ────────────
let _currentConfig = null;

async function _initSettingsOnLoad() {
  _populateSettingsForms(config);
  _currentConfig = config;

  const layout = await api('/api/pi-info');
  if (layout) {
    const container = document.getElementById('pinout-container');
    if (container) {
      initPinout(
        container,
        layout,
        { fan: config.gpio?.fan_pin, heater: config.gpio?.heater_pin },
        () => {}
      );
    }
  }
  _wireSettingsForms();
}

// ── Accordion persistence ─────────────────────────────────────────
function initAccordionPersistence() {
  $$('details[data-acc]').forEach(details => {
    const key = `pwc.acc.${details.dataset.acc}`;
    // Restore saved state
    const saved = localStorage.getItem(key);
    if (saved === 'true') details.open = true;
    else if (saved === 'false') details.open = false;

    // Persist on toggle
    details.addEventListener('toggle', () => {
      localStorage.setItem(key, details.open ? 'true' : 'false');
    });
  });
}

// ── Dirty hints ───────────────────────────────────────────────────
function initDirtyHints() {
  ['form-fan', 'form-heater', 'form-gpio', 'form-ha', 'form-allsky', 'form-system'].forEach(formId => {
    const form = document.getElementById(formId);
    if (!form) return;
    const hint = form.querySelector('.dirty-hint');
    if (!hint) return;

    form.addEventListener('input', () => hint.classList.remove('hidden'));
    form.addEventListener('change', () => hint.classList.remove('hidden'));
  });
}

function _populateSettingsForms(cfg) {
  const fanInvert = cfg.gpio.fan_invert ?? cfg.gpio.invert_relay ?? true;
  const heaterInvert = cfg.gpio.heater_invert ?? cfg.gpio.invert_relay ?? true;
  document.getElementById('gpio-fan-invert').checked = !!fanInvert;
  document.getElementById('gpio-heater-invert').checked = !!heaterInvert;

  document.getElementById('set-fan-threshold').value = cfg.fan.threshold;
  document.getElementById('set-fan-hysteresis').value = cfg.fan.hysteresis;
  document.getElementById('set-fan-min-on').value = cfg.fan.min_on_seconds;
  document.getElementById('set-fan-min-off').value = cfg.fan.min_off_seconds;
  document.getElementById('set-src-cpu').checked = !!cfg.fan.sources.cpu;
  document.getElementById('set-src-ssd').checked = !!cfg.fan.sources.ssd;
  document.getElementById('set-src-enclosure').checked = !!cfg.fan.sources.enclosure;

  document.getElementById('set-dew-margin').value = cfg.heater.dew_margin;
  document.getElementById('set-outside-threshold').value = cfg.heater.outside_temp_threshold;
  document.getElementById('set-heater-hysteresis').value = cfg.heater.hysteresis;
  document.getElementById('set-heater-min-on').value = cfg.heater.min_on_seconds;
  document.getElementById('set-heater-min-off').value = cfg.heater.min_off_seconds;
  document.getElementById('set-fan-off-when-heating').checked = !!cfg.heater.fan_off_when_heating;

  document.getElementById('set-ha-url').value = cfg.ha.url || '';
  document.getElementById('set-ha-token').value = cfg.ha.token || '';
  document.getElementById('set-ha-temp-entity').value = cfg.ha.temp_entity_id || '';
  document.getElementById('set-ha-humid-entity').value = cfg.ha.humidity_entity_id || '';

  document.getElementById('set-allsky-enabled').checked = !!(cfg.allsky && cfg.allsky.enabled);
  document.getElementById('set-allsky-output-dir').value = (cfg.allsky && cfg.allsky.output_dir) || '';

  document.getElementById('set-i2c-bus').value = cfg.i2c_bus;
  document.getElementById('set-poll-interval').value = cfg.poll_interval;
}

async function _postConfig(partial) {
  const resp = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ detail: resp.statusText }));
    alert(`Save failed: ${body.detail || resp.statusText}`);
    return null;
  }
  return resp.json();
}

function _clearDirtyHint(formId) {
  const form = document.getElementById(formId);
  if (!form) return;
  const hint = form.querySelector('.dirty-hint');
  if (hint) hint.classList.add('hidden');
}

function _wireSettingsForms() {
  document.getElementById('form-gpio').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const { fan, heater } = getAssignments();
    const body = {
      gpio: {
        fan_pin: fan,
        heater_pin: heater,
        fan_invert: document.getElementById('gpio-fan-invert').checked,
        heater_invert: document.getElementById('gpio-heater-invert').checked,
      },
    };
    const updated = await _postConfig(body);
    if (updated) {
      _currentConfig = updated;
      document.getElementById('gpio-restart-banner').classList.remove('hidden');
      _clearDirtyHint('form-gpio');
    }
  });

  document.getElementById('form-fan').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = {
      fan: {
        threshold: Number(document.getElementById('set-fan-threshold').value),
        hysteresis: Number(document.getElementById('set-fan-hysteresis').value),
        min_on_seconds: Number(document.getElementById('set-fan-min-on').value),
        min_off_seconds: Number(document.getElementById('set-fan-min-off').value),
        sources: {
          cpu: document.getElementById('set-src-cpu').checked,
          ssd: document.getElementById('set-src-ssd').checked,
          enclosure: document.getElementById('set-src-enclosure').checked,
        },
      },
    };
    const updated = await _postConfig(body);
    if (updated) {
      _currentConfig = updated;
      config = updated;
      if (updated.fan?.threshold != null) fanThreshold = updated.fan.threshold;
      _clearDirtyHint('form-fan');
    }
  });

  document.getElementById('form-heater').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = {
      heater: {
        dew_margin: Number(document.getElementById('set-dew-margin').value),
        outside_temp_threshold: Number(document.getElementById('set-outside-threshold').value),
        hysteresis: Number(document.getElementById('set-heater-hysteresis').value),
        min_on_seconds: Number(document.getElementById('set-heater-min-on').value),
        min_off_seconds: Number(document.getElementById('set-heater-min-off').value),
        fan_off_when_heating: document.getElementById('set-fan-off-when-heating').checked,
      },
    };
    const updated = await _postConfig(body);
    if (updated) {
      _currentConfig = updated;
      config = updated;
      _clearDirtyHint('form-heater');
    }
  });

  document.getElementById('form-ha').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = {
      ha: {
        url: document.getElementById('set-ha-url').value,
        token: document.getElementById('set-ha-token').value,
        temp_entity_id: document.getElementById('set-ha-temp-entity').value,
        humidity_entity_id: document.getElementById('set-ha-humid-entity').value,
      },
    };
    const updated = await _postConfig(body);
    if (updated) {
      _currentConfig = updated;
      config = updated;
      _clearDirtyHint('form-ha');
    }
  });

  document.getElementById('form-allsky').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = {
      allsky: {
        enabled: document.getElementById('set-allsky-enabled').checked,
        output_dir: document.getElementById('set-allsky-output-dir').value,
      },
    };
    const updated = await _postConfig(body);
    if (updated) {
      _currentConfig = updated;
      config = updated;
      _clearDirtyHint('form-allsky');
    }
  });

  document.getElementById('form-system').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = {
      i2c_bus: Number(document.getElementById('set-i2c-bus').value),
      poll_interval: Number(document.getElementById('set-poll-interval').value),
    };
    const updated = await _postConfig(body);
    if (updated) {
      _currentConfig = updated;
      config = updated;
      _clearDirtyHint('form-system');
    }
  });
}
