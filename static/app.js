/* Enclosure Controller — Frontend */

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

  if (s.pi_fan) {
    const pf = s.pi_fan;
    $('#pi-fan-rpm').textContent = pf.rpm != null ? pf.rpm : '--';
    $('#pi-fan-pct').textContent = pf.speed_pct != null ? Math.round(pf.speed_pct) : '--';
    drawPiFanCurve(s.pi_fan, s.system?.cpu);
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

  const trackY = pad.top + 30;
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

  // 4. Floating label markers
  function drawMarker(x, label, color, isTop) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, trackY - (isTop ? 20 : -10));
    ctx.lineTo(x, trackY + trackH + (isTop ? -10 : 20));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '600 10px Inter, sans-serif';
    ctx.textAlign = 'center';
    const yPos = isTop ? trackY - 25 : trackY + trackH + 25;

    // Label pill background
    ctx.shadowColor = color;
    ctx.shadowBlur = 5;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    const textWidth = ctx.measureText(label).width;
    ctx.beginPath();
    ctx.roundRect(x - textWidth / 2 - 6, yPos - 10, textWidth + 12, 16, 4);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = color;
    ctx.fillText(label, x, yPos + 2);
  }

  drawMarker(dewX, `Dew ${encDew.toFixed(1)}\u00b0`, '#ef4444', true);
  drawMarker(marginX, 'Margin', '#f59e0b', true);

  if (outdoor.available && outdoor.dew_point != null) {
    drawMarker(tempToXLocal(outdoor.dew_point), `Out Dew ${outdoor.dew_point.toFixed(1)}\u00b0`, '#a855f7', false);
  }
  if (frostThreshold != null) {
    drawMarker(tempToXLocal(frostThreshold), `Frost ${frostThreshold}\u00b0`, '#38bdf8', false);
  }

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

  const hysteresis = parseFloat($('#fan-hysteresis')?.value) || 3;
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

  // 3. Live sensor markers as elegant badges
  function drawSensorBadge(label, temp, color, offsetMultiplier) {
    if (temp == null) return;
    const x = tempToX(temp, w, pad.left);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, h - pad.bottom); ctx.stroke();
    ctx.setLineDash([]);

    const badgeY = pad.top + (20 * offsetMultiplier);
    const text = `${label} ${temp.toFixed(0)}\u00b0`;
    ctx.font = 'bold 10px Inter, sans-serif';
    const textW = ctx.measureText(text).width;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - textW / 2 - 6, badgeY - 12, textW + 12, 18, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, x, badgeY);
  }

  drawSensorBadge('CPU', latestStatus?.sensors?.system?.cpu, '#818cf8', 0);
  drawSensorBadge('SSD', latestStatus?.sensors?.system?.ssd, '#f472b6', 1);
  drawSensorBadge('Enc', latestStatus?.sensors?.bme280?.temperature, '#34d399', 2);
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

  canvas.addEventListener('mouseup', () => { draggingThreshold = false; });
  canvas.addEventListener('mouseleave', () => { draggingThreshold = false; });

  // Save threshold
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
          threshold: fanThreshold,
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
    fanThreshold = cfg.fan.threshold ?? 45;
    $('#fan-hysteresis').value = cfg.fan.hysteresis ?? 3;
    $('#fan-min-on').value = cfg.fan.min_on_seconds ?? 120;
    $('#fan-min-off').value = cfg.fan.min_off_seconds ?? 120;
    if (cfg.fan.sources) {
      $('#src-cpu').checked = cfg.fan.sources.cpu !== false;
      $('#src-ssd').checked = cfg.fan.sources.ssd !== false;
      $('#src-enclosure').checked = cfg.fan.sources.enclosure !== false;
    }
    // Fan curve redrawn by animation loop
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
    // Fan curve redrawn by animation loop
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
