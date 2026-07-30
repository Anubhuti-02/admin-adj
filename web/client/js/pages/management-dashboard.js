/* management-dashboard.js — Executive Management Dashboard */

const API = window.location.origin;

// Clock — uses startClock from common.js
startClock('currentTime', 'currentDate', 'long');

// ── Chart config ───────────────────────────────────────────────────────────
const CHART_POINTS = 120; // how many seconds to show

// ── Sensor Performance Chart ───────────────────────────────────────────────
const sensorCtx = document.getElementById('sensorChart').getContext('2d');
const sensorChart = new Chart(sensorCtx, {
    type: 'line',
    data: {
        labels: [],
        datasets: [
            {
                label: 'Left (S1)',
                data: [],
                borderColor: '#0891b2',
                backgroundColor: 'transparent',
                tension: 0.4,
                borderWidth: 2,
                pointRadius: 0,
                spanGaps: true
            },
            {
                label: 'Right (S2)',
                data: [],
                borderColor: '#7c3aed',
                backgroundColor: 'transparent',
                tension: 0.4,
                borderWidth: 2,
                pointRadius: 0,
                spanGaps: true
            },
            {
                label: 'Pivot',
                data: [],
                borderColor: '#f59e0b',
                backgroundColor: 'transparent',
                tension: 0.4,
                borderWidth: 2,
                pointRadius: 0,
                spanGaps: true
            }
        ]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
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
                    label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y != null ? ctx.parsed.y.toFixed(3) + ' g' : 'No data'}`
                }
            }
        },
        scales: {
            y: { suggestedMin: -2, suggestedMax: 2, grid: { color: '#e2e8f0' }, ticks: { color: '#64748b', font: { size: 11 }, callback: v => v.toFixed(1) + 'g' } },
            x: { display: false }
        }
    }
});

// ── System Health Doughnut ─────────────────────────────────────────────────
const healthCtx = document.getElementById('healthChart').getContext('2d');
const healthChart = new Chart(healthCtx, {
    type: 'doughnut',
    data: {
        labels: ['Operational', 'Warning', 'Critical'],
        datasets: [{
            data: [0, 0, 0],
            backgroundColor: ['#22c55e', '#eab308', '#ef4444'],
            borderWidth: 0,
            spacing: 2
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: '#ffffff',
                titleColor: '#0f172a',
                bodyColor: '#0f172a',
                borderColor: '#e2e8f0',
                borderWidth: 1,
                padding: 12
            }
        },
        cutout: '60%'
    }
});

// ── KPI entrance animation ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.kpi-value').forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
        setTimeout(() => {
            el.style.transition = 'all 0.5s ease';
            el.style.opacity = '1';
            el.style.transform = 'translateY(0)';
        }, 100);
    });
});

// ── Helpers ────────────────────────────────────────────────────────────────
function timeAgo(isoStr) {
    const diffMs  = Date.now() - new Date(isoStr).getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1)   return 'just now';
    if (diffMin < 60)  return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24)    return `${diffH}h ago`;
    return `${Math.floor(diffH / 24)}d ago`;
}

// ── REST pollers (KPIs only — chart is now Socket.IO driven) ───────────────

async function fetchUptime() {
    try {
        const data = await fetch(`${API}/api/management/uptime`).then(r => r.json());
        document.getElementById('kpi-uptime').textContent = data.uptime_pct + '%';
        if (data.window_hours === 0) {
            document.getElementById('kpi-uptime-sub').textContent = 'No data yet';
        } else if (data.last_seen) {
            document.getElementById('kpi-uptime-sub').textContent =
                `${data.active_hours}/${data.window_hours} hrs · last seen ${timeAgo(data.last_seen)}`;
        } else {
            document.getElementById('kpi-uptime-sub').textContent =
                `${data.active_hours}/${data.window_hours} hrs active`;
        }
    } catch (e) { console.error('uptime fetch error:', e); }
}

async function fetchActiveSensors() {
    try {
        const data = await fetch(`${API}/api/management/active-sensors`).then(r => r.json());
        document.getElementById('kpi-sensors').textContent = data.count;
        if (data.online.length > 0) {
            const offline = data.last_known.length ? ` · ${data.last_known.join(',')} offline` : '';
            document.getElementById('kpi-sensors-sub').textContent = data.online.join(', ') + ' active' + offline;
        } else if (data.last_known.length > 0) {
            const latestTs = data.last_known.reduce((best, s) =>
                data.last_seen[s] > best ? data.last_seen[s] : best, '');
            document.getElementById('kpi-sensors-sub').textContent =
                `${data.last_known.join(', ')} · last seen ${timeAgo(latestTs)}`;
        } else {
            document.getElementById('kpi-sensors-sub').textContent = 'No sensor data';
        }
    } catch (e) { console.error('active-sensors fetch error:', e); }
}

async function fetchActiveAlerts() {
    try {
        const data = await fetch(`${API}/api/management/active-alerts`).then(r => r.json());
        document.getElementById('kpi-alerts').textContent     = data.total;
        document.getElementById('kpi-alerts-sub').textContent = `${data.require_attention} require attention`;
    } catch (e) { console.error('active-alerts fetch error:', e); }
}

async function fetchSystemHealth() {
    try {
        const data = await fetch(`${API}/api/management/system-health`).then(r => r.json());
        healthChart.data.datasets[0].data = [data.operational, data.warning, data.critical];
        healthChart.update();
        document.getElementById('health-operational').textContent = data.operational;
        document.getElementById('health-warning').textContent     = data.warning;
        document.getElementById('health-critical').textContent    = data.critical;
    } catch (e) { console.error('system-health fetch error:', e); }
}

// ── Live chart via socket — same pattern as operator-dashboard.js's
// pushToChart(): each 'accelerometer-data' event pushes one point into a
// fixed-size rolling buffer and redraws immediately, no polling/DB round
// trip. STALE_CUTOFF_MS still governs when a sensor's line drops to null
// if it stops sending, checked on a slow interval since that's not
// something a live event can tell us on its own.
const STALE_CUTOFF_MS = 15 * 1000; // sensor considered offline after 15s

const chartBuf = {
    labels: Array(CHART_POINTS).fill(''),
    left:   Array(CHART_POINTS).fill(null),
    right:  Array(CHART_POINTS).fill(null),
    pivot:  Array(CHART_POINTS).fill(null),
};
const lastSeenAt = { left: 0, right: 0, pivot: 0 };

function pushChartPoint(sensor, gForce) {
    if (!['left', 'right', 'pivot'].includes(sensor)) return;
    lastSeenAt[sensor] = Date.now();

    chartBuf.labels.shift();
    chartBuf.left.shift();
    chartBuf.right.shift();
    chartBuf.pivot.shift();

    chartBuf.labels.push(new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }));
    chartBuf.left.push(sensor === 'left'  ? gForce : (chartBuf.left[chartBuf.left.length - 1]  ?? null));
    chartBuf.right.push(sensor === 'right' ? gForce : (chartBuf.right[chartBuf.right.length - 1] ?? null));
    chartBuf.pivot.push(sensor === 'pivot' ? gForce : (chartBuf.pivot[chartBuf.pivot.length - 1] ?? null));

    sensorChart.data.labels           = chartBuf.labels;
    sensorChart.data.datasets[0].data = chartBuf.left;
    sensorChart.data.datasets[1].data = chartBuf.right;
    sensorChart.data.datasets[2].data = chartBuf.pivot;
    sensorChart.update('none');
}

// Drop a sensor's line to null once it's gone quiet for STALE_CUTOFF_MS —
// checked periodically since silence can't trigger this on its own.
setInterval(() => {
    const now = Date.now();
    ['left', 'right', 'pivot'].forEach(sensor => {
        if (lastSeenAt[sensor] && now - lastSeenAt[sensor] > STALE_CUTOFF_MS) {
            chartBuf[sensor][chartBuf[sensor].length - 1] = null;
        }
    });
}, 1000);

// ── GPS ────────────────────────────────────────────────────────────────────
async function fetchGPS() {
    try {
        const d = await fetch(`${API}/api/latest/gps`).then(r => r.json());
        if (!d) return;

        const lat = d.lat >= 0 ? `${d.lat.toFixed(6)}° N` : `${Math.abs(d.lat).toFixed(6)}° S`;
        const lng = d.lng >= 0 ? `${d.lng.toFixed(6)}° E` : `${Math.abs(d.lng).toFixed(6)}° W`;
        const ts  = new Date(d.timestamp.endsWith('Z') ? d.timestamp : d.timestamp + 'Z');
        const ageMs = Date.now() - ts.getTime();
        const isLive = ageMs < 10000;

        document.getElementById('gps-lat').textContent      = lat;
        document.getElementById('gps-lng').textContent      = lng;
        document.getElementById('gps-speed').textContent    = `${d.speedKmh} km/h`;
        document.getElementById('gps-distance').textContent = `${(d.totalDistanceM / 1000).toFixed(2)} km`;
        document.getElementById('gps-lastfix').textContent  = ts.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

        const statusEl = document.getElementById('gps-status');
        const statusItem = document.getElementById('gps-status-item');
        statusEl.textContent = isLive ? 'Active' : 'Stale';
        statusEl.style.color = isLive ? '#22c55e' : '#ef4444';
        statusItem.style.borderLeft = `3px solid ${isLive ? '#22c55e' : '#ef4444'}`;
    } catch (e) { console.error('gps fetch error:', e); }
}

// ── Initial load ──────────────────────────────────────────────────────────
fetchUptime();
fetchActiveSensors();
fetchActiveAlerts();
fetchSystemHealth();
fetchGPS();

// The chart itself is fully live/socket-driven (pushChartPoint, wired to
// 'accelerometer-data' below) — these are the other panels, which don't
// need sub-second freshness.
setInterval(() => {
    fetchActiveSensors();
    fetchSystemHealth();
    fetchGPS();
}, 3000);
setInterval(() => {
    fetchUptime();
    fetchActiveAlerts();
}, 15000);

// ── Socket.IO — live chart updates, no polling/DB round trip ──────────────
const socket = io(API);
socket.on('connect', () => console.log('[mgmt] Socket connected ✓'));
socket.on('disconnect', () => console.warn('[mgmt] Disconnected'));
socket.on('accelerometer-data', data => {
    pushChartPoint(data.sensor, data.peak ?? data.gForce ?? 0);
});
