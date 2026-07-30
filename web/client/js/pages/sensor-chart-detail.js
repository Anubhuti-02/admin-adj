/* sensor-chart-detail.js — standalone full-screen sensor chart page
 * Live mode: same 'accelerometer-data' socket feed as management-dashboard.js
 * History mode: /api/acceleration/channels?from=&to= (lg/rg/pg = g-force per sensor)
 */

const API = window.location.origin;

// ── Chart config ─────────────────────────────────────────────────────────
const DETAIL_CHART_POINTS = 300; // ~5 min of context at 1 pt/sec

let liveMode = true;
let isPaused = false; // true once the user pans/zooms in live mode — data keeps arriving in the background, chart just stops redrawing until "Back to Live"
let detailTimestamps = [];

const detailCtx = document.getElementById('detailChart').getContext('2d');
const detailChart = new Chart(detailCtx, {
    type: 'line',
    data: {
        labels: [],
        datasets: [
            { label: 'Left (S1)',  data: [], borderColor: '#0891b2', backgroundColor: 'transparent', tension: 0.4, borderWidth: 2, pointRadius: 0, spanGaps: true },
            { label: 'Right (S2)', data: [], borderColor: '#7c3aed', backgroundColor: 'transparent', tension: 0.4, borderWidth: 2, pointRadius: 0, spanGaps: true },
            { label: 'Pivot',      data: [], borderColor: '#f59e0b', backgroundColor: 'transparent', tension: 0.4, borderWidth: 2, pointRadius: 0, spanGaps: true }
        ]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { display: true, position: 'top', labels: { color: '#0f172a', font: { size: 11 } } },
            tooltip: {
                backgroundColor: '#ffffff',
                titleColor: '#0f172a',
                bodyColor: '#0f172a',
                borderColor: '#e2e8f0',
                borderWidth: 1,
                padding: 12,
                callbacks: {
                    title(items) {
                        const i = items[0].dataIndex;
                        const ts = detailTimestamps[i];
                        if (!ts) return items[0].label;
                        const d = new Date(ts);
                        return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    },
                    label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(3) + ' g' : 'No data'}`
                }
            },
            zoom: {
                pan: {
                    enabled: true, mode: 'x',
                    onPanStart: () => { if (liveMode) pauseLive(); }
                },
                zoom: {
                    wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x',
                    onZoomStart: () => { if (liveMode) pauseLive(); }
                },
                limits: {
                    // Don't allow zooming in past ~15 points wide — any tighter and
                    // individual peaks become indistinguishable from each other.
                    x: { minRange: 15 }
                }
            },
            annotation: { annotations: {} }
        },
        scales: {
            y: { suggestedMin: -2, suggestedMax: 2, grid: { color: '#e2e8f0' }, ticks: { color: '#64748b', font: { size: 11 }, callback: v => v.toFixed(1) + 'g' } },
            x: { display: false }
        }
    }
});

function resetDetailZoom() { detailChart.resetZoom(); }
window.resetDetailZoom = resetDetailZoom;

function setModeBadge(mode) {
    const badge = document.getElementById('modeBadge');
    if (!badge) return;
    if (mode === 'live')   { badge.textContent = '● LIVE';    badge.style.background = '#22c55e'; }
    else if (mode === 'paused') { badge.textContent = '⏸ PAUSED (still recording)'; badge.style.background = '#f59e0b'; }
    else                   { badge.textContent = '◆ HISTORY'; badge.style.background = '#0891b2'; }
}

// Called the moment the user pans/zooms while in live mode. Data keeps
// flowing into chartBuf in the background (pushChartPoint still runs),
// it just stops calling detailChart.update() so the view doesn't jump
// out from under the user. "Back to Live" resumes redrawing at the
// current (fully caught-up) buffer.
function pauseLive() {
    if (isPaused) return;
    isPaused = true;
    setModeBadge('paused');
    setChartMsg('Paused — still recording in the background. Click "Back to Live" to resume and jump to the latest data.');
}

function setChartMsg(msg) {
    const el = document.getElementById('chartMsg');
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
}

// ── Live mode — rolling buffer, same pattern as management-dashboard.js ────
// Starts EMPTY (not pre-filled with nulls) so the chart shows real data
// building up from the first point on load/server-start, instead of a
// mostly-blank 300-point window with just a sliver of real data at the
// end. Grows up to DETAIL_CHART_POINTS, then rolls (shift+push) once full.
const STALE_CUTOFF_MS = 15 * 1000;
const chartBuf = {
    labels: [],
    left:   [],
    right:  [],
    pivot:  [],
    ts:     [],
};
const lastSeenAt = { left: 0, right: 0, pivot: 0 };

function pushChartPoint(sensor, gForce) {
    if (!['left', 'right', 'pivot'].includes(sensor)) return;
    lastSeenAt[sensor] = Date.now();

    if (chartBuf.labels.length >= DETAIL_CHART_POINTS) {
        chartBuf.labels.shift();
        chartBuf.left.shift();
        chartBuf.right.shift();
        chartBuf.pivot.shift();
        chartBuf.ts.shift();
    }

    const now = new Date();
    chartBuf.labels.push(now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }));
    chartBuf.left.push(sensor === 'left'  ? gForce : (chartBuf.left[chartBuf.left.length - 1]  ?? null));
    chartBuf.right.push(sensor === 'right' ? gForce : (chartBuf.right[chartBuf.right.length - 1] ?? null));
    chartBuf.pivot.push(sensor === 'pivot' ? gForce : (chartBuf.pivot[chartBuf.pivot.length - 1] ?? null));
    chartBuf.ts.push(now.toISOString());

    detailTimestamps = chartBuf.ts;
    detailChart.data.labels           = chartBuf.labels;
    detailChart.data.datasets[0].data = chartBuf.left;
    detailChart.data.datasets[1].data = chartBuf.right;
    detailChart.data.datasets[2].data = chartBuf.pivot;

    // Keep recording into chartBuf even while paused — just don't redraw,
    // so the user's pan/zoom position isn't disturbed until they resume.
    if (!isPaused) detailChart.update('none');
}

setInterval(() => {
    const now = Date.now();
    ['left', 'right', 'pivot'].forEach(sensor => {
        if (lastSeenAt[sensor] && chartBuf[sensor].length && now - lastSeenAt[sensor] > STALE_CUTOFF_MS) {
            chartBuf[sensor][chartBuf[sensor].length - 1] = null;
        }
    });
}, 1000);

function backToLive() {
    const wasHistory = !liveMode;
    liveMode = true;
    isPaused = false;

    // Coming from History mode: chartBuf was never touched while we were
    // away, so it's stale — clear it so live mode restarts fresh from
    // empty (grows back up from the first new point, same as page load).
    // Coming from a paused live pan/zoom: chartBuf has been recording in
    // the background the whole time, so just redraw what's already there.
    if (wasHistory) {
        chartBuf.labels.length = 0;
        chartBuf.left.length   = 0;
        chartBuf.right.length  = 0;
        chartBuf.pivot.length  = 0;
        chartBuf.ts.length     = 0;
    }

    detailTimestamps = chartBuf.ts;
    detailChart.data.labels           = chartBuf.labels;
    detailChart.data.datasets[0].data = chartBuf.left;
    detailChart.data.datasets[1].data = chartBuf.right;
    detailChart.data.datasets[2].data = chartBuf.pivot;
    detailChart.resetZoom();
    detailChart.update('none');
    setModeBadge('live');
    setChartMsg('');
}
window.backToLive = backToLive;

// ── History mode ────────────────────────────────────────────────────────
async function loadHistoricalRange() {
    const fromEl = document.getElementById('histFrom');
    const toEl   = document.getElementById('histTo');
    if (!fromEl.value || !toEl.value) { setChartMsg('Please select both a From and To date/time.'); return; }

    const fromISO = new Date(fromEl.value).toISOString();
    const toISO   = new Date(toEl.value).toISOString();
    if (fromISO >= toISO) { setChartMsg('"From" must be before "To".'); return; }

    setChartMsg('Loading…');
    try {
        const res  = await fetch(`${API}/api/acceleration/channels?from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}`);
        const data = await res.json();

        if (!data.length) { setChartMsg('No data found for the selected period.'); return; }

        const labels = [], left = [], right = [], pivot = [], ts = [];
        data.forEach(pt => {
            labels.push(new Date(pt.ts).toLocaleTimeString('en-IN', { hour12: false }));
            ts.push(pt.ts);
            left.push(pt.lg ?? null);
            right.push(pt.rg ?? null);
            pivot.push(pt.pg ?? null);
        });

        detailTimestamps = ts;
        detailChart.data.labels           = labels;
        detailChart.data.datasets[0].data = left;
        detailChart.data.datasets[1].data = right;
        detailChart.data.datasets[2].data = pivot;
        detailChart.resetZoom();
        detailChart.update('none');

        liveMode = false;
        isPaused = false;
        setModeBadge('history');
        setChartMsg(`Showing ${data.length} points · ${fromEl.value.replace('T', ' ')} → ${toEl.value.replace('T', ' ')} · Drag to scroll, scroll wheel to zoom`);
    } catch (e) {
        setChartMsg('Failed to load history: ' + e.message);
    }
}
window.loadHistoricalRange = loadHistoricalRange;

// ── PNG export ────────────────────────────────────────────────────────────
function exportChartPNG() {
    const link = document.createElement('a');
    link.download = `sensor-chart-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    link.href = detailChart.toBase64Image('image/png', 1);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}
window.exportChartPNG = exportChartPNG;

// ── Threshold reference lines ───────────────────────────────────────────
function buildThresholdAnnotations(axle, pivot) {
    const ann = {};
    if (axle) {
        ann.axleP1 = { type: 'line', yMin: axle.p1Min, yMax: axle.p1Min, borderColor: '#94a3b8', borderWidth: 1, borderDash: [6, 4], label: { display: true, content: 'Axle P1', position: 'start', font: { size: 10 } } };
        ann.axleP2 = { type: 'line', yMin: axle.p2Min, yMax: axle.p2Min, borderColor: '#94a3b8', borderWidth: 1, borderDash: [6, 4], label: { display: true, content: 'Axle P2', position: 'start', font: { size: 10 } } };
        ann.axleP3 = { type: 'line', yMin: axle.p3Min, yMax: axle.p3Min, borderColor: '#94a3b8', borderWidth: 1, borderDash: [6, 4], label: { display: true, content: 'Axle P3', position: 'start', font: { size: 10 } } };
    }
    if (pivot) {
        ann.pivotP1 = { type: 'line', yMin: pivot.p1Min, yMax: pivot.p1Min, borderColor: '#f59e0b', borderWidth: 1, borderDash: [2, 3], label: { display: true, content: 'Pivot P1', position: 'end', font: { size: 10 } } };
        ann.pivotP2 = { type: 'line', yMin: pivot.p2Min, yMax: pivot.p2Min, borderColor: '#f59e0b', borderWidth: 1, borderDash: [2, 3], label: { display: true, content: 'Pivot P2', position: 'end', font: { size: 10 } } };
        ann.pivotP3 = { type: 'line', yMin: pivot.p3Min, yMax: pivot.p3Min, borderColor: '#f59e0b', borderWidth: 1, borderDash: [2, 3], label: { display: true, content: 'Pivot P3', position: 'end', font: { size: 10 } } };
    }
    return ann;
}

let _axleThresholds = null, _pivotThresholds = null;

async function loadThresholds() {
    try {
        const [axle, pivot] = await Promise.all([
            fetch(`${API}/api/thresholds`).then(r => r.json()),
            fetch(`${API}/api/thresholds/pivot`).then(r => r.json())
        ]);
        _axleThresholds = axle;
        _pivotThresholds = pivot;
        detailChart.options.plugins.annotation.annotations = buildThresholdAnnotations(axle, pivot);
        detailChart.update('none');
    } catch (e) { console.warn('[sensor-detail] threshold load failed:', e.message); }
}
loadThresholds();

// ── Socket.IO ─────────────────────────────────────────────────────────────
const socket = io(API);
socket.on('connect', () => console.log('[sensor-detail] Socket connected ✓'));
socket.on('disconnect', () => console.warn('[sensor-detail] Disconnected'));
socket.on('accelerometer-data', data => {
    if (liveMode) pushChartPoint(data.sensor, data.peak ?? data.gForce ?? 0);
});
socket.on('thresholds-updated', axle => {
    _axleThresholds = axle;
    detailChart.options.plugins.annotation.annotations = buildThresholdAnnotations(_axleThresholds, _pivotThresholds);
    detailChart.update('none');
});
socket.on('pivot-thresholds-updated', pivot => {
    _pivotThresholds = pivot;
    detailChart.options.plugins.annotation.annotations = buildThresholdAnnotations(_axleThresholds, _pivotThresholds);
    detailChart.update('none');
});
