/* Enclosure Controller — Frontend */

const POLL_MS = 5000;
let config = {};
let curvePoints = []; // [{temp, on}] sorted by temp
let draggingPoint = null;
let historyData = [];

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
  populateConfigUI(data);
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

  // Draw gauge
  drawDewGauge(encTemp, encDew, outdoor, dewMargin, hysteresis, frostThreshold, heaterOn);

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

function drawDewGauge(encTemp, encDew, outdoor, dewMargin, hysteresis, frostThreshold, heaterOn) {
  const canvas = $('#dew-gauge');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  const pad = { left: 40, right: 20, top: 30, bottom: 24 };

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, w, h);

  if (encTemp == null || encDew == null) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for sensor data...', w / 2, h / 2);
    return;
  }

  // Determine temperature range for the gauge
  const allTemps = [encTemp, encDew, encDew - 5];
  if (outdoor.available && outdoor.dew_point != null) allTemps.push(outdoor.dew_point);
  if (outdoor.available && outdoor.temperature != null) allTemps.push(outdoor.temperature);
  const tMin = Math.floor(Math.min(...allTemps) - 5);
  const tMax = Math.ceil(Math.max(...allTemps) + 5);
  const barY = pad.top;
  const barH = h - pad.top - pad.bottom;

  function tempToX(t) {
    return pad.left + ((t - tMin) / (tMax - tMin)) * (w - pad.left - pad.right);
  }

  // Grid lines and labels
  ctx.strokeStyle = '#21262d';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#8b949e';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  const step = Math.max(1, Math.round((tMax - tMin) / 10));
  for (let t = Math.ceil(tMin / step) * step; t <= tMax; t += step) {
    const x = tempToX(t);
    ctx.beginPath(); ctx.moveTo(x, barY); ctx.lineTo(x, barY + barH); ctx.stroke();
    ctx.fillText(`${t}\u00b0`, x, h - 6);
  }

  // Danger zone: dew point to dew point + margin (condensation risk)
  const dewX = tempToX(encDew);
  const marginX = tempToX(encDew + dewMargin);
  const hystX = tempToX(encDew + dewMargin + hysteresis);

  // Condensation zone (below dew point)
  ctx.fillStyle = 'rgba(248, 81, 73, 0.2)';
  ctx.fillRect(pad.left, barY, dewX - pad.left, barH);

  // Danger zone (dew to dew+margin)
  ctx.fillStyle = 'rgba(248, 81, 73, 0.12)';
  ctx.fillRect(dewX, barY, marginX - dewX, barH);

  // Hysteresis zone (margin to margin+hysteresis)
  ctx.fillStyle = 'rgba(210, 153, 34, 0.10)';
  ctx.fillRect(marginX, barY, hystX - marginX, barH);

  // Safe zone
  ctx.fillStyle = 'rgba(63, 185, 80, 0.06)';
  ctx.fillRect(hystX, barY, w - pad.right - hystX, barH);

  // Dew point line
  ctx.strokeStyle = '#f85149';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(dewX, barY); ctx.lineTo(dewX, barY + barH); ctx.stroke();

  // Margin boundary
  ctx.strokeStyle = '#d29922';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(marginX, barY); ctx.lineTo(marginX, barY + barH); ctx.stroke();
  ctx.setLineDash([]);

  // Outside dew point marker
  if (outdoor.available && outdoor.dew_point != null) {
    const odX = tempToX(outdoor.dew_point);
    ctx.strokeStyle = '#a371f7';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(odX, barY); ctx.lineTo(odX, barY + barH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#a371f7';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Out Dew ${outdoor.dew_point.toFixed(1)}\u00b0`, odX, barY - 4);
  }

  // Frost threshold marker
  if (outdoor.available && outdoor.temperature != null) {
    const ftX = tempToX(frostThreshold);
    ctx.strokeStyle = '#79c0ff';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(ftX, barY); ctx.lineTo(ftX, barY + barH); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Labels at top
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';

  ctx.fillStyle = '#f85149';
  ctx.fillText(`Dew ${encDew.toFixed(1)}\u00b0`, dewX, barY - 4);

  ctx.fillStyle = '#d29922';
  ctx.fillText(`Margin`, marginX, barY - 4);

  // Enclosure temperature marker (large, prominent)
  const encX = tempToX(encTemp);
  const markerY = barY + barH / 2;

  // Determine marker color based on proximity
  const dewDist = encTemp - encDew;
  let markerColor = '#3fb950'; // safe
  if (dewDist < dewMargin) markerColor = '#f85149'; // danger
  else if (dewDist < dewMargin + hysteresis) markerColor = '#d29922'; // warn

  // Marker triangle + line
  ctx.strokeStyle = markerColor;
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(encX, barY); ctx.lineTo(encX, barY + barH); ctx.stroke();

  // Diamond marker
  ctx.fillStyle = markerColor;
  ctx.beginPath();
  ctx.moveTo(encX, markerY - 10);
  ctx.lineTo(encX + 7, markerY);
  ctx.lineTo(encX, markerY + 10);
  ctx.lineTo(encX - 7, markerY);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#e6edf3';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Enclosure temp label
  ctx.fillStyle = '#e6edf3';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`Enc ${encTemp.toFixed(1)}\u00b0`, encX, barY + barH + 14);

  // Heater status badge
  if (heaterOn) {
    ctx.fillStyle = 'rgba(248, 81, 73, 0.9)';
    const bw = 68, bh = 18, bx = w - pad.right - bw - 4, by = barY + 4;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('HEATING', bx + bw / 2, by + 13);
  }
}

// ── Fan Curve Editor ─────────────────────────────────────────────
const CURVE_CANVAS_PAD = 30;
const CURVE_TEMP_MIN = 0;
const CURVE_TEMP_MAX = 80;

function drawFanCurve() {
  const canvas = $('#fan-curve-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  const pad = CURVE_CANVAS_PAD;

  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = '#21262d';
  ctx.lineWidth = 1;
  for (let t = 0; t <= 80; t += 10) {
    const x = tempToX(t, w, pad);
    ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, h - pad); ctx.stroke();
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${t}°`, x, h - 8);
  }

  // ON/OFF zones
  ctx.fillStyle = '#8b949e';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('ON', 4, pad + 14);
  ctx.fillText('OFF', 4, h - pad - 6);

  // Hysteresis zone
  const hysteresis = parseFloat($('#fan-hysteresis')?.value) || 3;

  // Sort points by temp
  const sorted = [...curvePoints].sort((a, b) => a.temp - b.temp);

  // Draw curve line
  if (sorted.length > 0) {
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 2;
    ctx.beginPath();

    // Start from left edge
    const firstY = sorted[0].on ? pad + 20 : h - pad - 20;
    ctx.moveTo(pad, firstY);

    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const x = tempToX(p.temp, w, pad);
      const yOn = pad + 20;
      const yOff = h - pad - 20;

      // Draw step to this point
      if (i === 0) {
        const prevY = !p.on ? yOff : yOn;
        ctx.lineTo(x, prevY);
      }
      ctx.lineTo(x, p.on ? yOn : yOff);

      // Continue to next or edge
      if (i < sorted.length - 1) {
        ctx.lineTo(tempToX(sorted[i + 1].temp, w, pad), p.on ? yOn : yOff);
      } else {
        ctx.lineTo(w - pad, p.on ? yOn : yOff);
      }
    }
    ctx.stroke();

    // Draw hysteresis band
    for (const p of sorted) {
      if (p.on) {
        const x = tempToX(p.temp, w, pad);
        const xH = tempToX(p.temp - hysteresis, w, pad);
        ctx.fillStyle = 'rgba(88, 166, 255, 0.1)';
        ctx.fillRect(xH, pad, x - xH, h - 2 * pad);
        // Hysteresis line
        ctx.strokeStyle = '#58a6ff44';
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(xH, pad); ctx.lineTo(xH, h - pad); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Draw draggable points
    for (const p of sorted) {
      const x = tempToX(p.temp, w, pad);
      const y = p.on ? pad + 20 : h - pad - 20;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = p === draggingPoint ? '#ffffff' : (p.on ? '#3fb950' : '#f85149');
      ctx.fill();
      ctx.strokeStyle = '#e6edf3';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Label
      ctx.fillStyle = '#e6edf3';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${p.temp}°`, x, y - 12);
    }
  }

  // Draw current temps as vertical markers
  drawTempMarker(ctx, 'CPU', latestStatus?.sensors?.system?.cpu, w, h, pad, '#58a6ff');
  drawTempMarker(ctx, 'SSD', latestStatus?.sensors?.system?.ssd, w, h, pad, '#d29922');
  drawTempMarker(ctx, 'Enc', latestStatus?.sensors?.bme280?.temperature, w, h, pad, '#3fb950');
}

function drawTempMarker(ctx, label, temp, w, h, pad, color) {
  if (temp == null) return;
  const x = tempToX(temp, w, pad);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, h - pad); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${label} ${temp.toFixed(0)}°`, x, pad - 4);
}

function tempToX(temp, w, pad) {
  return pad + ((temp - CURVE_TEMP_MIN) / (CURVE_TEMP_MAX - CURVE_TEMP_MIN)) * (w - 2 * pad);
}

function xToTemp(x, w, pad) {
  return CURVE_TEMP_MIN + ((x - pad) / (w - 2 * pad)) * (CURVE_TEMP_MAX - CURVE_TEMP_MIN);
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
    const h = rect.height;
    const pad = CURVE_CANVAS_PAD;

    // Check if clicking near a point
    for (const p of curvePoints) {
      const px = tempToX(p.temp, w, pad);
      const py = p.on ? pad + 20 : h - pad - 20;
      if (Math.hypot(mx - px, my - py) < 12) {
        draggingPoint = p;
        return;
      }
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!draggingPoint) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const pad = CURVE_CANVAS_PAD;

    draggingPoint.temp = Math.round(Math.max(0, Math.min(80, xToTemp(mx, w, pad))));
    draggingPoint.on = my < h / 2;
    drawFanCurve();
  });

  canvas.addEventListener('mouseup', () => { draggingPoint = null; });
  canvas.addEventListener('mouseleave', () => { draggingPoint = null; });

  // Right-click to remove point
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const pad = CURVE_CANVAS_PAD;

    for (let i = 0; i < curvePoints.length; i++) {
      const p = curvePoints[i];
      const px = tempToX(p.temp, w, pad);
      const py = p.on ? pad + 20 : h - pad - 20;
      if (Math.hypot(mx - px, my - py) < 12) {
        curvePoints.splice(i, 1);
        drawFanCurve();
        return;
      }
    }
  });

  // Add point button
  $('#curve-add-btn')?.addEventListener('click', () => {
    // Find a gap in the curve
    const temps = curvePoints.map(p => p.temp).sort((a, b) => a - b);
    let newTemp = 40;
    if (temps.length) {
      newTemp = temps[temps.length - 1] + 5;
      if (newTemp > 75) newTemp = 25;
    }
    curvePoints.push({ temp: newTemp, on: true });
    drawFanCurve();
  });

  // Save curve
  $('#curve-save-btn')?.addEventListener('click', async () => {
    const sources = {
      cpu: $('#src-cpu').checked,
      ssd: $('#src-ssd').checked,
      enclosure: $('#src-enclosure').checked,
    };
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fan: {
          curve: curvePoints,
          hysteresis: parseFloat($('#fan-hysteresis').value) || 3,
          min_on_seconds: parseInt($('#fan-min-on').value) || 120,
          min_off_seconds: parseInt($('#fan-min-off').value) || 120,
          sources,
        }
      }),
    });
    await fetchConfig();
  });
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

// ── Config UI ────────────────────────────────────────────────────
function populateConfigUI(cfg) {
  if (cfg.fan) {
    curvePoints = cfg.fan.curve || [];
    $('#fan-hysteresis').value = cfg.fan.hysteresis ?? 3;
    $('#fan-min-on').value = cfg.fan.min_on_seconds ?? 120;
    $('#fan-min-off').value = cfg.fan.min_off_seconds ?? 120;
    if (cfg.fan.sources) {
      $('#src-cpu').checked = cfg.fan.sources.cpu !== false;
      $('#src-ssd').checked = cfg.fan.sources.ssd !== false;
      $('#src-enclosure').checked = cfg.fan.sources.enclosure !== false;
    }
    drawFanCurve();
  }
  if (cfg.heater) {
    $('#dew-margin').value = cfg.heater.dew_margin ?? 5;
    $('#outside-threshold').value = cfg.heater.outside_temp_threshold ?? 2;
    $('#heater-hysteresis').value = cfg.heater.hysteresis ?? 2;
    $('#heater-min-on').value = cfg.heater.min_on_seconds ?? 120;
    $('#heater-min-off').value = cfg.heater.min_off_seconds ?? 120;
    $('#fan-off-when-heating').checked = cfg.heater.fan_off_when_heating !== false;
  }
  if (cfg.ha) {
    $('#ha-url').value = cfg.ha.url || '';
    $('#ha-token').value = cfg.ha.token || '';
    $('#ha-temp-entity').value = cfg.ha.temp_entity_id || '';
    $('#ha-humid-entity').value = cfg.ha.humidity_entity_id || '';
  }
}

function initSaveButtons() {
  // Heater save
  $('#heater-save-btn')?.addEventListener('click', async () => {
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        heater: {
          dew_margin: parseFloat($('#dew-margin').value) || 5,
          outside_temp_threshold: parseFloat($('#outside-threshold').value) || 2,
          hysteresis: parseFloat($('#heater-hysteresis').value) || 2,
          min_on_seconds: parseInt($('#heater-min-on').value) || 120,
          min_off_seconds: parseInt($('#heater-min-off').value) || 120,
          fan_off_when_heating: $('#fan-off-when-heating').checked,
        }
      }),
    });
    await fetchConfig();
  });

  // HA save
  $('#ha-save-btn')?.addEventListener('click', async () => {
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ha: {
          url: $('#ha-url').value.trim(),
          token: $('#ha-token').value.trim(),
          temp_entity_id: $('#ha-temp-entity').value.trim(),
          humidity_entity_id: $('#ha-humid-entity').value.trim(),
        }
      }),
    });
    await fetchConfig();
  });

  // HA test
  $('#ha-test-btn')?.addEventListener('click', async () => {
    // Save first, then check status
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ha: {
          url: $('#ha-url').value.trim(),
          token: $('#ha-token').value.trim(),
          temp_entity_id: $('#ha-temp-entity').value.trim(),
          humidity_entity_id: $('#ha-humid-entity').value.trim(),
        }
      }),
    });
    // Wait a poll cycle then fetch
    setTimeout(async () => {
      await fetchStatus();
      const badge = $('#ha-status');
      if (badge.textContent === 'OK') {
        alert('Home Assistant connection successful!');
      } else {
        alert('Home Assistant connection failed. Check URL, token, and entity IDs.');
      }
    }, 2000);
  });
}

// ── Polling loop ─────────────────────────────────────────────────
async function poll() {
  const status = await api('/api/status');
  if (status) {
    latestStatus = status;
    updateSensors(status.sensors);
    updateRelays(status.relays, status.modes);
    updateDewStatus(status.sensors, status.relays, status.modes);
    drawFanCurve(); // redraw with current temp markers
  } else {
    $('#connection-status').className = 'status-dot disconnected';
  }

  await fetchEvents();

  // Fetch history less frequently (every 30s)
  if (!poll._histCount) poll._histCount = 0;
  if (poll._histCount++ % 6 === 0) {
    await fetchHistory();
  }
}

// ── Init ─────────────────────────────────────────────────────────
async function init() {
  await fetchConfig();
  await fetchStatus();
  await fetchHistory();
  await fetchEvents();

  initCurveEditor();
  initModeButtons();
  initSaveButtons();

  // Redraw curve on resize
  window.addEventListener('resize', () => {
    drawFanCurve();
    drawSparklines();
    if (latestStatus) updateDewStatus(latestStatus.sensors, latestStatus.relays, latestStatus.modes);
  });

  // Start polling
  setInterval(poll, POLL_MS);
}

document.addEventListener('DOMContentLoaded', init);
