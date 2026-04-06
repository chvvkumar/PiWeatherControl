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
  window.addEventListener('resize', () => { drawFanCurve(); drawSparklines(); });

  // Start polling
  setInterval(poll, POLL_MS);
}

document.addEventListener('DOMContentLoaded', init);
