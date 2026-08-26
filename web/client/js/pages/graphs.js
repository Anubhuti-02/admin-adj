/* =============================================================================
   graphs.js — FINAL VERSION (Dynamic 24h tab, offline/online aware)
   - 24h tab: LIVE rolling when hardware online, else yesterday's average line
   - 7d / 30d tabs: always show average line from DB
   - Historical cards (yesterday, 7d, 30d) always populated
============================================================================= */

const SERVER_URL = window.location.origin;

// ── Hardware online detection — PER SENSOR ────────────────────────────────
// Was a single global flag driven only by left/right packets, which meant
// (a) RCI was gated entirely on left's own packet arrival, and (b) losing
// left made the whole chart go dead even while right/pivot kept reporting.
// Each sensor now has its own last-seen time and online flag, so each
// sensor's RCI line lives or dies independently of the others.
const lastSensorDataTime = { left: 0, right: 0, pivot: 0 };
const DATA_TIMEOUT_MS = 10000;   // 10 seconds without data → offline
const sensorOnline = { left: false, right: false, pivot: false };

// Single combined RCI chart: one line, driven only by genuine incoming
// packets (see rciPendingUpdate / the tick below) — this function's only
// job now is to keep sensorOnline[] accurate for whichever sensors are
// still within the timeout window. It no longer resets or re-fetches the
// chart on transitions: when a sensor drops, the chart simply stops
// receiving new points from it and holds whatever was last plotted, and
// when it (or another sensor) comes back, live pushes just resume from
// wherever the buffer left off — no reset, no synthetic gap-fill.
function updateOnlineStatus() {
    const now = Date.now();
    ['left', 'right', 'pivot'].forEach(s => {
        sensorOnline[s] = (now - lastSensorDataTime[s]) < DATA_TIMEOUT_MS;
    });
}

// Check online status every 2 seconds
setInterval(updateOnlineStatus, 2000);

// ── Timestamp ticker ──────────────────────────────────────────────────────
(function tickTimestamp() {
    const el = document.getElementById('currentTimestamp');
    if (el) {
        const n = new Date();
        el.textContent = n.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        });
    }
    setTimeout(tickTimestamp, 1000);
})();

// ── Channel derivation ────────────────────────────────────────────────────
function getVert(x, y, z) { return Math.abs(y); }
function getLat(x, y, z) { return Math.sqrt(x * x + z * z); }

// ── Distance tracking ─────────────────────────────────────────────────────
let distanceM = 0;
const LIVE_DIST_N = 300;   // rolling window in live mode (~5 min at 1 packet/s)
const MAX_DIST_POINTS = 10000;

let distMode = 'live';     // 'live' | 'history'
let distTimestamps = [];   // parallel to distanceChart.data.labels — ISO strings

function formatDistLabel(m) {
    const km = Math.floor(m / 1000);
    const rem = m % 1000;
    return km + '.' + String(rem).padStart(3, '0') + ' km';
}

// ── Rolling buffers (for RCI and raw subplots only) ───────────────────────
const RAW_N = 80;
const RCI_N = 60;

function zeroBuf(n, v = null) { return new Array(n).fill(v); }
function emptyLabels(n) { return new Array(n).fill(''); }

function rollDataset(chart, datasetIndex, value, label) {
    const ds = chart.data.datasets[datasetIndex];
    ds.data.push(value);
    ds.data.shift();
    if (label !== undefined) {
        chart.data.labels.push(label);
        chart.data.labels.shift();
    }
}

// ── Distance Chart ────────────────────────────────────────────────────────
let _distAutoFollow = true;

const distanceChart = new Chart(document.getElementById('distanceChart').getContext('2d'), {
    type: 'line',
    data: {
        labels: [],
        datasets: [
            { label: 'AB-L-VERT', data: [], borderColor: '#22c55e', borderWidth: 2, tension: 0.3, pointRadius: 0, spanGaps: false },
            { label: 'AB-L-LAT',  data: [], borderColor: '#eab308', borderWidth: 2, tension: 0.3, pointRadius: 0, spanGaps: false },
            { label: 'AB-R-VERT', data: [], borderColor: '#ef4444', borderWidth: 2, tension: 0.3, pointRadius: 0, spanGaps: false },
            { label: 'AB-R-LAT',  data: [], borderColor: '#8b5cf6', borderWidth: 2, tension: 0.3, pointRadius: 0, spanGaps: false },
            { label: 'AB-P-VERT', data: [], borderColor: '#f97316', borderWidth: 2, tension: 0.3, pointRadius: 0, spanGaps: false },
            { label: 'AB-P-LAT',  data: [], borderColor: '#0ea5e9', borderWidth: 2, tension: 0.3, pointRadius: 0, spanGaps: false }
        ]
    },
    options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                callbacks: {
                    title(items) {
                        const i = items[0].dataIndex;
                        const dist = items[0].label;
                        const ts = distTimestamps[i];
                        if (!ts) return dist;
                        const d = new Date(ts);
                        const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
                        return `${dist}  ·  ${date} ${time}`;
                    }
                }
            },
            zoom: {
                pan: {
                    enabled: true, mode: 'x',
                    onPanStart: () => { _distAutoFollow = false; }
                },
                zoom: {
                    wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x',
                    onZoomStart: () => { _distAutoFollow = false; }
                }
            }
        },
        scales: {
            y: { suggestedMin: 0, suggestedMax: 2, title: { display: true, text: 'Acceleration (g)' }, grid: { color: '#f1f5f9' }, ticks: { callback: v => v.toFixed(2) + 'g' } },
            x: { title: { display: true, text: 'Distance' }, ticks: { maxRotation: 45, maxTicksLimit: 12 } }
        }
    }
});

function _clearDistChart() {
    distanceChart.data.labels = [];
    distanceChart.data.datasets.forEach(ds => ds.data = []);
    distTimestamps = [];
    distanceChart.resetZoom();
    distanceChart.update('none');
}

function _setDistBadge(mode) {
    const badge = document.getElementById('distModeBadge');
    const btnLive = document.getElementById('btnLiveMode');
    if (badge) {
        badge.textContent = mode === 'live' ? '● LIVE' : '◆ HISTORY';
        badge.style.background = mode === 'live' ? '#22c55e' : '#0891b2';
    }
    if (btnLive) btnLive.style.display = mode === 'history' ? '' : 'none';
}

function _setDistMsg(msg) {
    const el = document.getElementById('distChartMsg');
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
}

function jumpToLatest() {
    _distAutoFollow = true;
    distanceChart.resetZoom();
}

function resetDistZoom() {
    distanceChart.resetZoom();
}

function switchToLiveMode() {
    distMode = 'live';
    distanceM = 0;
    _distAutoFollow = true;
    _clearDistChart();
    _setDistBadge('live');
    _setDistMsg('');
}

async function loadHistoricalRange() {
    const fromEl = document.getElementById('histFrom');
    const toEl   = document.getElementById('histTo');
    if (!fromEl.value || !toEl.value) { _setDistMsg('Please select both a From and To date/time.'); return; }

    const fromISO = new Date(fromEl.value).toISOString();
    const toISO   = new Date(toEl.value).toISOString();
    if (fromISO >= toISO) { _setDistMsg('"From" must be before "To".'); return; }

    _setDistMsg('Loading…');
    try {
        const res  = await fetch(`${SERVER_URL}/api/history/distance-chart?from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}&limit=5000`);
        const data = await res.json();
        const left  = data.left  || [];
        const right = data.right || [];
        const pivot = data.pivot || [];

        if (!left.length && !right.length && !pivot.length) {
            _setDistMsg('No data found for the selected period.');
            return;
        }

        const n = Math.max(left.length, right.length, pivot.length);
        const labels = [], lVert = [], lLat = [], rVert = [], rLat = [], pVert = [], pLat = [];
        distTimestamps = [];
        for (let i = 0; i < n; i++) {
            const distM = i * 10;
            const km = Math.floor(distM / 1000), rem = distM % 1000;
            labels.push(km + '.' + String(rem).padStart(3, '0') + ' km');
            distTimestamps.push((left[i] || right[i] || pivot[i] || {}).timestamp || null);
            if (left[i])  { const {x=0,y=0,z=0} = left[i];  lVert.push(Math.abs(z)); lLat.push(Math.sqrt(x*x+y*y)); }
            else          { lVert.push(null); lLat.push(null); }
            if (right[i]) { const {x=0,y=0,z=0} = right[i]; rVert.push(Math.abs(z)); rLat.push(Math.sqrt(x*x+y*y)); }
            else          { rVert.push(null); rLat.push(null); }
            if (pivot[i]) { const {x=0,y=0,z=0} = pivot[i]; pVert.push(Math.abs(z)); pLat.push(Math.sqrt(x*x+y*y)); }
            else          { pVert.push(null); pLat.push(null); }
        }

        distanceChart.data.labels           = labels;
        distanceChart.data.datasets[0].data = lVert;
        distanceChart.data.datasets[1].data = lLat;
        distanceChart.data.datasets[2].data = rVert;
        distanceChart.data.datasets[3].data = rLat;
        distanceChart.data.datasets[4].data = pVert;
        distanceChart.data.datasets[5].data = pLat;
        distanceChart.resetZoom();
        distanceChart.update('none');

        distMode = 'history';
        _distAutoFollow = false;
        _setDistBadge('history');
        _setDistMsg(`Showing ${n} points · ${fromEl.value.replace('T', ' ')} → ${toEl.value.replace('T', ' ')} · Drag to scroll, scroll wheel to zoom`);
    } catch (e) {
        _setDistMsg('Failed to load history: ' + e.message);
    }
}

// ── Raw subplots ──────────────────────────────────────────────────────────
function makeSubplot(id, color, initVal = 0) {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    const isZ = initVal > 1;   // Z axis initialised at 9.8g, X/Y at 0
    return new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: zeroBuf(RAW_N, ''),
            datasets: [{ data: zeroBuf(RAW_N, initVal), borderColor: color, backgroundColor: color + '18', borderWidth: 1.5, tension: 0.3, pointRadius: 0, fill: true }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
                y: {
                    suggestedMin: isZ ? 0.0 : -2.0,
                    suggestedMax: isZ ? 2.0 :  2.0,
                    grid: { color: '#f1f5f9' },
                    ticks: { maxTicksLimit: 3, font: { size: 9 }, color: '#94a3b8', callback: v => v.toFixed(2) + 'g' }
                },
                x: { display: false }
            }
        }
    });
}

const subplots = {
    s1: { x: makeSubplot('raw1X_chart', '#ef4444', 0), y: makeSubplot('raw1Y_chart', '#22c55e', 0), z: makeSubplot('raw1Z_chart', '#3b82f6', 9.8) },
    s2: { x: makeSubplot('raw2X_chart', '#ef4444', 0), y: makeSubplot('raw2Y_chart', '#22c55e', 0), z: makeSubplot('raw2Z_chart', '#3b82f6', 9.8) },
    s3: { x: makeSubplot('raw3X_chart', '#ef4444', 0), y: makeSubplot('raw3Y_chart', '#22c55e', 0), z: makeSubplot('raw3Z_chart', '#3b82f6', 9.8) }
};

function pushSubplot(chart, value) {
    if (!chart) return;
    chart.data.datasets[0].data.shift();
    chart.data.datasets[0].data.push(value);
    chart.update('none');
}

// ── Sperling Ride Index Wz ────────────────────────────────────────────────
// Input:  rms_g  — RMS acceleration in g-units (as stored in DB / sent by sensor)
// Step 1: Convert g → cm/s²   (1 g = 981 cm/s²)
// Step 2: Apply frequency weighting Bf at 100 Hz.
//         For vertical vibration (ISO 2631 simplified Sperling):
//           Bf ≈ 0.325 at f = 100 Hz  (weighting curve peak ~5–20 Hz, falls off above)
//         This brings typical train values (rms ~0.1–1.3 g) into the 2–5 Wz range.
// Step 3: Wz = 0.896 × (a_rms_cm × Bf)^0.3
//
// Why Bf = 0.325 and NOT 1.0?
//   Bf = 1.0 is only correct when a_rms is already the frequency-weighted RMS (e.g.
//   from a filtered signal).  Our sensor stores the raw RMS at 100 Hz, so we must
//   apply the weighting factor manually.  At 100 Hz vertical: Bf ≈ 0.325.
// ── Dynamic Sperling Bf — tracks configured ODR ───────────────────────────
// Bf (frequency weighting) varies with the ODR set by the user in settings:
//    50 Hz → Bf = 0.48   (closer to 5–20 Hz sensitivity band)
//   100 Hz → Bf = 0.325  (original calibrated value)
//   200 Hz → Bf = 0.18   (far above sensitivity band, attenuated)
let _configuredOdrHz = 100;   // updated from /api/odr-config on load + socket event

function _getSperlingBf() {
    if (_configuredOdrHz >= 150) return 0.18;
    if (_configuredOdrHz >= 75) return 0.325;
    return 0.48;
}

function calculateSperlingWz(rmsG) {
    if (rmsG == null || isNaN(rmsG) || rmsG <= 0) return null;
    const a_rms_cms2 = rmsG * 981;                            // g  → cm/s²
    const a_weighted = a_rms_cms2 * _getSperlingBf();         // apply configured frequency weighting
    const wz = 0.896 * Math.pow(a_weighted, 0.3);             // Sperling formula
    return Math.round(wz * 100) / 100;                        // 2 d.p.
}

function setRCIStatusEl(elId, wz) {
    const el = document.getElementById(elId);
    if (!el || wz == null) return;
    if (wz <= 2.0) { el.textContent = 'Excellent'; el.className = 'rci-status status-excellent'; }
    else if (wz <= 2.75) { el.textContent = 'Good'; el.className = 'rci-status status-good'; }
    else if (wz <= 3.25) { el.textContent = 'Fair'; el.className = 'rci-status status-fair'; }
    else if (wz <= 3.75) { el.textContent = 'Poor'; el.className = 'rci-status status-poor'; }
    else { el.textContent = 'Very Poor'; el.className = 'rci-status status-poor'; }
}

function formatRciLabel(d, period) {
    if (period === '24h') {
        return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
    } else if (period === '7d') {
        return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit' })
            + ' ' + d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit' });
}

// Updates the current/avg/best/worst (+ optional status pill) elements for
// one dataset's worth of Wz values (nulls allowed/ignored).
function updateRciStatEls(values, ids) {
    const valid = values.filter(v => v != null);
    if (!valid.length) {
        [ids.current, ids.avg, ids.best, ids.worst].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = '—';
        });
        return;
    }
    const avg    = valid.reduce((a, b) => a + b, 0) / valid.length;
    const best   = Math.min(...valid);
    const worst  = Math.max(...valid);
    const latest = values[values.length - 1] ?? valid[valid.length - 1];
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v.toFixed(1); };
    set(ids.current, latest);
    set(ids.avg, avg);
    set(ids.best, best);
    set(ids.worst, worst);
    if (ids.status) setRCIStatusEl(ids.status, latest);
}

// ── RCI Chart ─────────────────────────────────────────────────────────────
// Y-axis is NOT hard-capped — it auto-scales to actual Wz values.
// Sperling comfort zones (reference lines drawn via annotation plugin or
// background segment colours via custom plugin below):
//   ≤ 2.0  Excellent  (green)
//   ≤ 2.75 Good       (blue)
//   ≤ 3.25 Fair       (yellow)
//   ≤ 3.75 Poor       (orange)
//   > 3.75 Very Poor  (red)

// Inline background-band plugin — draws horizontal coloured bands behind the line
const rciZoneBandPlugin = {
    id: 'rciZoneBands',
    beforeDraw(chart) {
        const { ctx, chartArea: { left, right, top, bottom }, scales: { y } } = chart;
        if (!y) return;
        const bands = [
            { from: 0, to: 2.0, color: 'rgba(34,197,94,0.08)' },   // Excellent
            { from: 2.0, to: 2.75, color: 'rgba(59,130,246,0.08)' },   // Good
            { from: 2.75, to: 3.25, color: 'rgba(234,179,8,0.10)' },   // Fair
            { from: 3.25, to: 3.75, color: 'rgba(249,115,22,0.12)' },   // Poor
            { from: 3.75, to: 99, color: 'rgba(239,68,68,0.12)' },   // Very Poor
        ];
        ctx.save();
        for (const b of bands) {
            const yTop = Math.max(y.getPixelForValue(b.to), top);
            const yBottom = Math.min(y.getPixelForValue(b.from), bottom);
            if (yTop >= yBottom) continue;
            ctx.fillStyle = b.color;
            ctx.fillRect(left, yTop, right - left, yBottom - yTop);
        }
        ctx.restore();
    }
};

const rciTooltipLabel = ctx => {
    const wz = ctx.parsed.y;
    if (wz == null) return null;
    const grade = wz <= 2.0 ? 'Excellent'
        : wz <= 2.75 ? 'Good'
            : wz <= 3.25 ? 'Fair'
                : wz <= 3.75 ? 'Poor'
                    : 'Very Poor';
    return `${ctx.dataset.label}: Wz ${wz.toFixed(2)} — ${grade}`;
};

// Single combined chart — one line, fed by whichever sensors are online
// (see rciLiveTick()). This replaces the earlier "average only left+right,
// gated on left's packet" bug: now any sensor (left, right, or pivot) keeps
// the line moving, and the value shown is the average across whichever of
// them are currently reporting.
const rciChart = new Chart(document.getElementById('rciChart').getContext('2d'), {
    type: 'line',
    plugins: [rciZoneBandPlugin],
    data: {
        labels: emptyLabels(RCI_N),
        datasets: [
            {
                label: 'Ride Comfort Index',
                data: new Array(RCI_N).fill(null),
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59,130,246,0.06)',
                borderWidth: 2.5, tension: 0.4, fill: false, pointRadius: 0, spanGaps: false
            }
        ]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: rciTooltipLabel } }
        },
        scales: {
            y: {
                suggestedMin: 1.0, suggestedMax: 5.0,
                title: { display: true, text: 'Sperling Ride Index Wz' },
                grid: { color: '#f1f5f9' },
                ticks: { stepSize: 0.25, callback: v => v.toFixed(2) }
            },
            x: { ticks: { maxRotation: 45, maxTicksLimit: 10 }, grid: { display: false } }
        }
    }
});

// ── Tab state ─────────────────────────────────────────────────────────────
let currentPeriod = 1;        // 1=24h, 7=7d, 30=30d

const RCI_IDS = { current: 'rciCurrent', avg: 'rciAvg', best: 'rciBest', worst: 'rciWorst', status: 'rciStatus' };


// ── Fetch average Wz (for historical summary cards) — combined by default ─
// sensor is optional; when omitted the server pools rows across whichever
// sensors reported (left/right/pivot) instead of narrowing to one.
async function fetchAverageWz(days, sensor = null) {
    try {
        const url = `${SERVER_URL}/api/rci/average?days=${days}` + (sensor ? `&sensor=${sensor}` : '');
        const res = await fetch(url);
        const data = await res.json();
        if (data.avgRms != null) return calculateSperlingWz(data.avgRms);
        return null;
    } catch (e) {
        console.error(`[RCI] Failed to fetch ${days}d average:`, e);
        return null;
    }
}

async function fetchRciSeries(period, sensor = null) {
    try {
        const url = `${SERVER_URL}/api/rci/timeseries?period=${period}` + (sensor ? `&sensor=${sensor}` : '');
        const res = await fetch(url);
        const data = await res.json();
        return data.points || [];
    } catch (e) {
        console.error(`[RCI] fetchRciSeries(${period}) failed:`, e);
        return [];
    }
}

// ── Combined timeseries → the single RCI chart/dataset ────────────────────
// API returns raw rms_v_g (g-units), already averaged across whichever
// sensors reported in each time bucket. All Sperling computation happens
// here: rms_v_g → cm/s² → apply Bf → Wz = 0.896 × (rms_g × 981 × Bf)^0.3
async function fetchAndRenderRCICombined(period) {
    const pts = await fetchRciSeries(period);
    if (!pts.length) { console.warn(`[RCI] No timeseries data for ${period}`); return null; }

    const ordered  = [...pts].reverse(); // server returns DESC — chart wants chronological
    const wzValues = ordered.map(p => calculateSperlingWz(p.rms_v_g));
    const validWz  = wzValues.filter(v => v !== null);
    if (!validWz.length) { console.warn(`[RCI] All Wz null for ${period}`); return null; }

    const labels = ordered.map(p => formatRciLabel(new Date(p.timestamp), period));
    rciChart.data.labels = labels;
    rciChart.data.datasets[0].data = wzValues;
    rciChart.options.scales.x.ticks.maxTicksLimit = period === '24h' ? 12 : (period === '7d' ? 14 : 15);
    rciChart.update();

    updateRciStatEls(wzValues, RCI_IDS);
    console.log(`[RCI] combined/${period}: ${validWz.length} pts, latest Wz=${wzValues[wzValues.length - 1]?.toFixed(2)}`);
    return { wzValues };
}

// ── Update historical summary cards (combined across all sensors) ─────────
async function updateHistoricalCards() {
    const [y, w, m] = await Promise.all([fetchAverageWz(1), fetchAverageWz(7), fetchAverageWz(30)]);
    const set = (id, v) => { if (v != null) { const el = document.getElementById(id); if (el) el.textContent = v.toFixed(1); } };
    set('rciYesterday', y);
    set('rciWeekAvg', w);
    set('rciMonthAvg', m);
}

// ── Activate RCI tab (called on tab click or programmatically) ────────────
async function activateRCITab(days) {
    currentPeriod = days;
    document.querySelectorAll('#rciMainTabs .rci-tab').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.days) === days);
    });

    if (days === 1) {
        if (sensorOnline.left || sensorOnline.right || sensorOnline.pivot) {
            // At least one sensor is live — reset to an empty rolling
            // buffer; rciLiveTick() fills it with the average of whichever
            // sensors are actually online, moment to moment.
            console.log('[RCI] 24h tab: at least one sensor online → LIVE rolling');
            rciChart.data.labels = emptyLabels(RCI_N);
            rciChart.data.datasets[0].data = new Array(RCI_N).fill(null);
            rciChart.options.scales.x.ticks.maxTicksLimit = 8;
            rciChart.update();
        } else {
            console.log('[RCI] 24h tab: all sensors offline → showing yesterday timeseries');
            const result = await fetchAndRenderRCICombined('24h');
            if (!result) {
                rciChart.data.labels = emptyLabels(RCI_N);
                rciChart.data.datasets[0].data = new Array(RCI_N).fill(null);
                rciChart.update();
                ['rciAvg', 'rciBest', 'rciWorst'].forEach(id => {
                    const el = document.getElementById(id); if (el) el.textContent = '—';
                });
            }
        }
    } else {
        const periodStr = days === 7 ? '7d' : '30d';
        const result = await fetchAndRenderRCICombined(periodStr);
        if (!result) {
            rciChart.data.labels = emptyLabels(RCI_N);
            rciChart.data.datasets[0].data = new Array(RCI_N).fill(null);
            rciChart.update();
            ['rciAvg', 'rciBest', 'rciWorst'].forEach(id => {
                const el = document.getElementById(id); if (el) el.textContent = '—';
            });
        }
    }
}

// ── Live RCI tick — fires on genuine new packets only ──────────────────────
// Fixed twice now: first it was gated on left's own packet (froze the whole
// chart when left dropped), then it was switched to a blind wall-clock
// setInterval — but that pushed a "new" point every second regardless of
// whether any sensor had actually sent fresh data, which just re-plotted
// the same stale cached RMS on a loop and made the line look like it was
// live-scrolling even with everything disconnected.
//
// Fix: accelerometer-data (any sensor) sets rciPendingUpdate = true. This
// tick still runs every second, but only computes/pushes a point when that
// flag is set, then clears it. No new real data in a given second → no
// push → the line holds exactly where it was (last real value), instead of
// drifting forward on its own.
let rciPendingUpdate = false;
const RCI_TICK_MS = 1000;
setInterval(() => {
    if (currentPeriod !== 1) return;
    if (!rciPendingUpdate) return;   // nothing new since last tick — stay frozen
    rciPendingUpdate = false;

    const onlineRms = ['left', 'right', 'pivot']
        .filter(s => sensorOnline[s])
        .map(s => cache[s].rms)
        .filter(v => v != null && v > 0);

    if (!onlineRms.length) return;   // all offline — freeze, don't push a gap either

    const combinedWz = calculateSperlingWz(onlineRms.reduce((a, b) => a + b, 0) / onlineRms.length);
    const distLabel = formatDistLabel(distanceM);
    rollDataset(rciChart, 0, combinedWz, distLabel);
    rciChart.update();

    updateRciStatEls(rciChart.data.datasets[0].data, RCI_IDS);
}, RCI_TICK_MS);

// ── Sensor cache ──────────────────────────────────────────────────────────
const cache = {
    left: { x: 0, y: 0, z: 0, vert: 0, lat: 0, rms: null },
    right: { x: 0, y: 0, z: 0, vert: 0, lat: 0, rms: null },
    pivot: { x: 0, y: 0, z: 0, vert: 0, lat: 0, rms: null }
};

let rafPending = false;
function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
        distanceChart.update('none');
        rciChart.update('none');
        rafPending = false;
    });
}

// ── Socket.IO ─────────────────────────────────────────────────────────────
const socket = io(SERVER_URL, { transports: ['websocket', 'polling'], reconnectionDelay: 1000 });

socket.on('connect', () => console.log('[graphs] Socket connected ✓'));
socket.on('disconnect', () => console.warn('[graphs] Disconnected'));

// Server-tracked totalDistanceM — replaces the old synthetic +10m-per-accel-
// packet counter, which drifted at whatever rate the accel socket happened
// to emit rather than actual distance traveled. Now sourced from the
// odometer encoder (direct wheel-rotation measurement) rather than GPS
// Haversine-diffing, which was noisy/stuck-at-0 at low speed — but gps-data
// still carries the last-known value too, so either event keeps this in sync.
socket.on('gps-data', data => {
    if (typeof data.totalDistanceM === 'number') distanceM = data.totalDistanceM;
});
socket.on('odometer-data', data => {
    if (typeof data.totalDistanceM === 'number') distanceM = data.totalDistanceM;
});

// ── Sync Sperling Bf when ODR changes from settings page ──────────────────
socket.on('odr-config-changed', (cfg) => {
    const avgOdr = (cfg.accel1 + cfg.accel2) / 2;
    _configuredOdrHz = avgOdr;
    console.log(`[graphs] ODR changed → ${avgOdr}Hz  Bf=${_getSperlingBf()} — refreshing RCI`);

    const periodStr = currentPeriod === 1 ? '24h' : currentPeriod === 7 ? '7d' : '30d';
    const anyOnline = sensorOnline.left || sensorOnline.right || sensorOnline.pivot;
    if (currentPeriod !== 1 || !anyOnline) fetchAndRenderRCICombined(periodStr);
});

// ── Initial load ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    // Default the range pickers: today 00:00 → now
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const localNow  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const localStart = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T00:00`;
    const fromEl = document.getElementById('histFrom');
    const toEl2  = document.getElementById('histTo');
    if (fromEl) fromEl.value = localStart;
    if (toEl2)  toEl2.value  = localNow;

    // Pre-fill raw subplots only (fast — doesn't touch the distance chart)
    if (typeof window.preloadGraphHistory === 'function') {
        await window.preloadGraphHistory(null, subplots);
    }

    // Attach tab listeners
    document.querySelectorAll('#rciMainTabs .rci-tab').forEach(btn => {
        btn.addEventListener('click', () => activateRCITab(parseInt(btn.dataset.days)));
    });

    // Load historical cards
    updateHistoricalCards();
    // Refresh cards every hour
    setInterval(updateHistoricalCards, 60 * 60 * 1000);

    // Activate default tab (24h) – decides live vs historical from combined sensor online status
    activateRCITab(1);

    // Fetch configured ODR so Sperling Bf is correct from the first frame
    fetch(`${SERVER_URL}/api/odr-config`)
        .then(r => r.json())
        .then(cfg => {
            _configuredOdrHz = (cfg.accel1 + cfg.accel2) / 2;
            console.log(`[graphs] ODR loaded → ${_configuredOdrHz}Hz  Bf=${_getSperlingBf()}`);
        })
        .catch(() => { });
});

// ── Live data handler ─────────────────────────────────────────────────────
socket.on('accelerometer-data', data => {
    const side = data.sensor;
    if (side !== 'left' && side !== 'right' && side !== 'pivot') return;

    lastSensorDataTime[side] = Date.now();
    updateOnlineStatus();
    rciPendingUpdate = true;   // real packet arrived — let the next tick push a genuine point

    const x = data.x ?? 0;
    const y = data.y ?? 0;
    const z = data.z ?? 0;
    const rmsV = (data.rmsV != null && data.rmsV > 0) ? data.rmsV : null;

    const vert = getVert(x, y, z);
    const lat = getLat(x, y, z);

    // Update cache with raw values
    cache[side].x = x;
    cache[side].y = y;
    cache[side].z = z;
    cache[side].vert = vert;
    cache[side].lat = lat;
    cache[side].rms = rmsV;   // store RMS (g)

    // Raw subplots
    const sp = side === 'left' ? subplots.s1 : side === 'right' ? subplots.s2 : subplots.s3;
    const pfx = side === 'left' ? 'raw1' : side === 'right' ? 'raw2' : 'raw3';
    pushSubplot(sp.x, x);
    pushSubplot(sp.y, y);
    pushSubplot(sp.z, z);

    document.getElementById(pfx + 'X').textContent = x.toFixed(4) + ' g';
    document.getElementById(pfx + 'Y').textContent = y.toFixed(4) + ' g';
    document.getElementById(pfx + 'Z').textContent = z.toFixed(4) + ' g';

    const now = new Date();
    document.getElementById(pfx + 'RefreshTime').textContent = '🕐 ' + now.toLocaleTimeString('en-IN', { hour12: false }) + ' ' + now.toLocaleDateString('en-IN');

    // ── Distance chart (left sensor drives distance, live mode only) ─────
    // distanceM is updated in real time by the 'gps-data' socket listener
    // above — this just reads whatever the latest real distance is.
    if (side === 'left' && distMode === 'live') {
        const distLabel = formatDistLabel(distanceM);

        distanceChart.data.labels.push(distLabel);
        distTimestamps.push(new Date().toISOString());
        distanceChart.data.datasets[0].data.push(vert);
        distanceChart.data.datasets[1].data.push(lat);
        distanceChart.data.datasets[2].data.push(cache.right.vert);
        distanceChart.data.datasets[3].data.push(cache.right.lat);
        distanceChart.data.datasets[4].data.push(cache.pivot.vert);
        distanceChart.data.datasets[5].data.push(cache.pivot.lat);

        // Roll off oldest once we exceed the live window
        if (distanceChart.data.labels.length > LIVE_DIST_N) {
            distanceChart.data.labels.shift();
            distTimestamps.shift();
            distanceChart.data.datasets.forEach(ds => ds.data.shift());
        }
    }

    // NOTE: RCI (Left/Right/Pivot) is no longer computed here — it used to be
    // gated on side === 'left', which averaged left+right together and froze
    // the whole chart the instant left went offline. It's now driven by the
    // independent rciLiveTick() interval above, which reads each sensor's own
    // cache[...].rms and pushes its own line regardless of what the other
    // sensors are doing.

    // Update legend values (always)
    document.getElementById('distVal1').textContent = cache.left.vert.toFixed(4) + ' g';
    document.getElementById('distVal2').textContent = cache.left.lat.toFixed(4) + ' g';
    document.getElementById('distVal3').textContent = cache.right.vert.toFixed(4) + ' g';
    document.getElementById('distVal4').textContent = cache.right.lat.toFixed(4) + ' g';
    document.getElementById('distVal5').textContent = cache.pivot.vert.toFixed(4) + ' g';
    document.getElementById('distVal6').textContent = cache.pivot.lat.toFixed(4) + ' g';

    scheduleRender();
});


// ── Raw DB polling (fallback) ─────────────────────────────────────────────
// NOTE: pushes vertical → subplot.z and lateral → subplot.x for each sensor,
// mirroring channelPrefixFor()'s l/r/p prefixes from /api/acceleration/channels.
// Pivot (s3) used to be missing here entirely, so its X/Y/Z canvases never
// got backfilled with history — they just sat on their initial buffer values
// (flat line / single block) until enough live socket packets rolled through.
async function fetchRawFromDB() {
    try {
        const data = await fetch(`${SERVER_URL}/api/acceleration/channels?minutes=60`).then(r => r.json());
        if (!data.length) return;
        const slice = data.slice(-60);
        slice.forEach(pt => {
            if (pt.lv != null) pushSubplot(subplots.s1.z, pt.lv);
            if (pt.ll != null) pushSubplot(subplots.s1.x, pt.ll);
            if (pt.rv != null) pushSubplot(subplots.s2.z, pt.rv);
            if (pt.rl != null) pushSubplot(subplots.s2.x, pt.rl);
            if (pt.pv != null) pushSubplot(subplots.s3.z, pt.pv);
            if (pt.pl != null) pushSubplot(subplots.s3.x, pt.pl);
        });
    } catch (e) { console.error('[raw-db]', e); }
}
fetchRawFromDB();
setInterval(fetchRawFromDB, 3000);