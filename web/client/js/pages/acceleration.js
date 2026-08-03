/* acceleration.js — DB-driven waveform, no Socket.IO
 * Adds: axis-limit threshold dashed lines (from /api/axis-limits) and
 * red highlighting of points/segments that cross the configured limit,
 * plus scroll/pinch zoom + drag pan + Zoom Reset (chartjs-plugin-zoom +
 * chartjs-plugin-annotation, same libs as sensor-chart-detail.js).
 */

const API          = window.location.origin;
const CHART_POINTS = 120; // seconds visible on chart
const STALE_MS     = 10000; // sensor offline if no data for 10s
let   pollMinutes  = 2;    // window sent to API (matches time range btn)

// ── Clock ──────────────────────────────────────────────────────────────────
function updateTimestamp() {
    const now = new Date();
    document.getElementById('currentTimestamp').textContent =
        now.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        });
}
setInterval(updateTimestamp, 1000);
updateTimestamp();

// ── Channel setup ───────────────────────────────────────────────────────
const channels = [
    { key: 'lv', name: 'AB-L-VERT', color: '#22c55e', legendId: 'legend1', metricId: 'metric1' },
    { key: 'll', name: 'AB-L-LAT',  color: '#eab308', legendId: 'legend2', metricId: 'metric2' },
    { key: 'rv', name: 'AB-R-VERT', color: '#ef4444', legendId: 'legend3', metricId: 'metric3' },
    { key: 'rl', name: 'AB-R-LAT',  color: '#8b5cf6', legendId: 'legend4', metricId: 'metric4' },
    { key: 'pv', name: 'PV-VERT',   color: '#f97316', legendId: 'legend5', metricId: 'metric5' },
    { key: 'pl', name: 'PV-LAT',    color: '#0ea5e9', legendId: 'legend6', metricId: 'metric6' }
];

// ── Axis limits (server-backed) — one g-value per axis per sensor unit ────
// generic = Pivot, a1 = Left, a2 = Right — same shape as /api/axis-limits
let axisLimitsData = {
    generic: { x: null, y: null, z: null },
    a1:      { x: null, y: null, z: null },
    a2:      { x: null, y: null, z: null },
};

// channel key -> { unit, axis, label } — vert = y-axis, lat = x-axis, per sensor
const CHANNEL_LIMIT_MAP = {
    lv: { unit: 'a1',      axis: 'y', label: 'AB-L (VERT)' }, // left vert
    ll: { unit: 'a1',      axis: 'x', label: 'AB-L (LAT)'  }, // left lat
    rv: { unit: 'a2',      axis: 'y', label: 'AB-R (VERT)' }, // right vert
    rl: { unit: 'a2',      axis: 'x', label: 'AB-R (LAT)'  }, // right lat
    pv: { unit: 'generic', axis: 'y', label: 'P (VERT)'    }, // pivot vert
    pl: { unit: 'generic', axis: 'x', label: 'P (LAT)'     }, // pivot lat
};

function getLimitFor(chKey) {
    const map = CHANNEL_LIMIT_MAP[chKey];
    return map ? (axisLimitsData[map.unit]?.[map.axis] ?? null) : null;
}

async function loadAxisLimits() {
    try {
        const res = await fetch(`${API}/api/axis-limits`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data && data.generic && data.a1 && data.a2) axisLimitsData = data;
        rebuildAnnotations();
    } catch (e) {
        console.warn('[acceleration] Could not load axis limits:', e.message);
    }
}

// Builds one dashed reference line per channel that has a configured limit.
// Channels with no limit set are simply left out — no line drawn.
function rebuildAnnotations() {
    const ann = {};
    channels.forEach(ch => {
        const limit = getLimitFor(ch.key);
        const map   = CHANNEL_LIMIT_MAP[ch.key];
        if (limit == null) return;
        ann[`limit_${ch.key}`] = {
            type: 'line',
            yMin: limit,
            yMax: limit,
            borderColor: ch.color,
            borderWidth: 1.5,
            borderDash: [6, 4],
            label: {
                display: true,
                content: `${map.label} ${limit}g`,
                position: 'end',
                font: { size: 10 },
                backgroundColor: ch.color,
                color: '#fff',
                padding: 3
            }
        };
    });
    mainChart.options.plugins.annotation.annotations = ann;
    mainChart.update('none');
}

function resetAccelZoom() { mainChart.resetZoom(); }
window.resetAccelZoom = resetAccelZoom;

// ── Chart setup ───────────────────────────────────────────────────────────
const ctx = document.getElementById('mainChart').getContext('2d');
const mainChart = new Chart(ctx, {
    type: 'line',
    data: {
        labels: Array(CHART_POINTS).fill(''),
        datasets: channels.map(ch => ({
            label: ch.name,
            data: Array(CHART_POINTS).fill(null),
            borderColor: ch.color,
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            tension: 0.3,
            pointRadius: ctx => {
                const limit = getLimitFor(ch.key);
                const v = ctx.parsed?.y;
                return (limit != null && v != null && Math.abs(v) >= limit) ? 4 : 0;
            },
            pointBackgroundColor: ctx => {
                const limit = getLimitFor(ch.key);
                const v = ctx.parsed?.y;
                return (limit != null && v != null && Math.abs(v) >= limit) ? '#dc2626' : ch.color;
            },
            pointBorderColor: '#fff',
            pointBorderWidth: 1,
            segment: {
                borderColor: sctx => {
                    const limit = getLimitFor(ch.key);
                    if (limit == null) return ch.color;
                    const v0 = sctx.p0.parsed.y, v1 = sctx.p1.parsed.y;
                    const v = Math.max(Math.abs(v0 ?? 0), Math.abs(v1 ?? 0));
                    return v >= limit ? '#dc2626' : ch.color;
                },
                borderWidth: sctx => {
                    const limit = getLimitFor(ch.key);
                    if (limit == null) return 1.5;
                    const v0 = sctx.p0.parsed.y, v1 = sctx.p1.parsed.y;
                    const v = Math.max(Math.abs(v0 ?? 0), Math.abs(v1 ?? 0));
                    return v >= limit ? 3 : 1.5;
                }
            },
            spanGaps: true
        }))
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                mode: 'index',
                intersect: false,
                backgroundColor: '#ffffff',
                titleColor: '#1e293b',
                bodyColor: '#334155',
                borderColor: '#e2e8f0',
                borderWidth: 1,
                callbacks: {
                    label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(4) + ' g' : '—'}`
                }
            },
            zoom: {
                pan: { enabled: true, mode: 'x' },
                zoom: {
                    wheel: { enabled: true },
                    pinch: { enabled: true },
                    mode: 'x'
                },
                limits: { x: { minRange: 15 } }
            },
            annotation: { annotations: {} }
        },
        scales: {
            y: {
                beginAtZero: false,
                suggestedMin: -2,
                suggestedMax: 2,
                grid: { color: '#f1f5f9' },
                ticks: {
                    color: '#64748b',
                    font: { size: 11 },
                    callback: v => v.toFixed(1) + ' g'
                }
            },
            x: { display: false }
        },
        interaction: { mode: 'nearest', axis: 'x', intersect: false }
    }
});

// ── Fetch from DB and update chart + metrics ───────────────────────────────
async function fetchChannels() {
    try {
        const data = await fetch(`${API}/api/acceleration/channels?minutes=${pollMinutes}`)
            .then(r => r.json());

        if (!Array.isArray(data) || data.length === 0) {
            // No data — clear chart, show dashes, mark OFFLINE
            channels.forEach((ch, i) => {
                mainChart.data.datasets[i].data = Array(CHART_POINTS).fill(null);
                document.getElementById(ch.legendId).textContent = '— g';
                document.getElementById(ch.metricId).textContent = '—';
            });
            mainChart.data.labels = Array(CHART_POINTS).fill('');
            mainChart.update('none');
            document.getElementById('lastUpdate').textContent = 'No data';
            const liveDot  = document.querySelector('.live-dot');
            const liveText = document.querySelector('.status-text');
            if (liveDot)  liveDot.style.background = '#ef4444';
            if (liveText) liveText.textContent      = 'OFFLINE';
            return;
        }

        // Rolling window: keep last CHART_POINTS seconds
        const slice  = data.slice(-CHART_POINTS);
        const pad    = CHART_POINTS - slice.length;

        // Append 'Z' so JS treats bare ISO strings as UTC (server stores UTC without Z)
        const toUtc = ts => new Date(ts.endsWith('Z') ? ts : ts + 'Z');

        const labels = [...Array(pad).fill(''), ...slice.map(pt =>
            toUtc(pt.ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }))];

        const now      = Date.now();
        const latestTs = toUtc(slice[slice.length - 1].ts).getTime();
        const ageSec   = Math.round((now - latestTs) / 1000);

        channels.forEach((ch, i) => {
            mainChart.data.datasets[i].data = [
                ...Array(pad).fill(null),
                ...slice.map(pt => pt[ch.key])
            ];

            // Always show last known value in legend/metric
            const latest = [...slice].reverse().find(pt => pt[ch.key] != null);
            if (latest) {
                const v = latest[ch.key].toFixed(4);
                document.getElementById(ch.legendId).textContent = v + ' g';
                document.getElementById(ch.metricId).textContent = v;
            } else {
                document.getElementById(ch.legendId).textContent = '— g';
                document.getElementById(ch.metricId).textContent = '—';
            }
        });

        mainChart.data.labels = labels;
        mainChart.update('none');

        // Last seen badge — show actual date+time, colour by online status
        const lastSeenStr = new Date(latestTs).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        });

        // Update LIVE / OFFLINE indicator based on data staleness
        const isLive = ageSec < (STALE_MS / 1000);
        const liveDot  = document.querySelector('.live-dot');
        const liveText = document.querySelector('.status-text');
        if (liveDot)  liveDot.style.background  = isLive ? '#22c55e' : '#ef4444';
        if (liveText) liveText.textContent       = isLive ? 'LIVE' : 'OFFLINE';

        fetch(`${API}/api/management/active-sensors`)
            .then(r => r.json())
            .then(s => {
                const el = document.getElementById('lastUpdate');
                el.textContent = lastSeenStr;
                el.style.color = (s.online && s.online.length > 0) ? '#22c55e' : '#ef4444';
            })
            .catch(() => {
                const el = document.getElementById('lastUpdate');
                el.textContent = lastSeenStr;
                el.style.color = '';
            });

        // Data points count
        const dpEl = document.getElementById('dataPoints');
        if (dpEl) dpEl.textContent = data.length.toLocaleString();

    } catch (e) {
        console.error('fetchChannels error:', e);
    }
}

// ── Time range buttons ─────────────────────────────────────────────────────
function setTimeRange(range, btn) {
    document.querySelectorAll('.graph-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const map = { '2m': 2, '1h': 60, '6h': 360, '24h': 1440 };
    pollMinutes = map[range] || 2;
    fetchChannels();
}
window.setTimeRange = setTimeRange;

// ── Start polling ──────────────────────────────────────────────────────────
loadAxisLimits();
setInterval(loadAxisLimits, 5000); // stay in sync if Configuration page changes limits

fetchChannels();
setInterval(fetchChannels, 3000);