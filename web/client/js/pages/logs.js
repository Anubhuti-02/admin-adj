/* logs.js — Live Logs page
 * Odometer readings arrive over the 'odometer-data' socket event (server.js's
 * ODOMETER-TCP handler); /api/logs/odometer backfills recent history on load.
 * Built as a scrolling console, same idea as tcp_binary_server1.py's stdout,
 * with room to add more sensor panels the same way later. */

const API = window.location.origin;
const MAX_LINES = 500; // trim the DOM list so a long session doesn't grow forever

let odoCount = 0;
let paused   = false;

function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString('en-IN', { hour12: false }) + '.' + String(new Date(ts).getMilliseconds()).padStart(3, '0'); }
    catch (e) { return ts; }
}

function renderOdoLine(data) {
    const el = document.createElement('div');
    if (!data.ok) {
        el.className = 'log-line log-bad';
        el.textContent = `[${fmtTime(data.timestamp)}] *** UNPARSEABLE *** ${data.raw || ''}`;
        return el;
    }
    el.className = 'log-line';
    el.innerHTML =
        `<span class="log-ts">[${fmtTime(data.timestamp)}]</span>` +
        `Count:${data.count} ` +
        `<span class="log-dist">Dist:${data.km}KM ${data.meter}M ${data.mm}MM</span> ` +
        `<span class="log-speed">Speed:${data.speedMs.toFixed(3)}m/s ${data.speedKmh.toFixed(2)}km/h</span>`;
    return el;
}

function appendOdoLine(data) {
    const console_ = document.getElementById('odoConsole');
    if (!console_) return;

    const empty = console_.querySelector('.log-empty');
    if (empty) empty.remove();

    const wasAtBottom = console_.scrollHeight - console_.scrollTop - console_.clientHeight < 30;
    console_.appendChild(renderOdoLine(data));
    while (console_.children.length > MAX_LINES) console_.removeChild(console_.firstChild);
    if (wasAtBottom) console_.scrollTop = console_.scrollHeight;

    odoCount++;
    const countEl = document.getElementById('odoCount');
    if (countEl) countEl.textContent = `${odoCount} readings`;
}

function pulseLiveDot() {
    const dot = document.getElementById('liveDot');
    if (!dot) return;
    dot.classList.remove('pulse');
    void dot.offsetWidth; // restart animation
    dot.classList.add('pulse');
}

async function updateConnectionStatus() {
    const statusEl = document.getElementById('connStatus');
    if (!statusEl) return;
    try {
        const res    = await fetch(`${API}/api/realtime/status`);
        const status = await res.json();
        const live = status.connected;
        statusEl.textContent = live ? 'Live' : 'Offline';
        statusEl.className   = `conn-status ${live ? 'conn-on' : 'conn-off'}`;
    } catch (e) {
        statusEl.textContent = 'Offline (cached)';
        statusEl.className   = 'conn-status conn-off';
    }
}

async function loadOdometerHistory() {
    const console_ = document.getElementById('odoConsole');
    try {
        const res = await fetch(`${API}/api/logs/odometer?limit=200`);
        const rows = await res.json();
        if (!Array.isArray(rows) || !rows.length) {
            if (console_) console_.innerHTML = '<div class="log-line log-empty">No odometer readings yet — waiting for live data…</div>';
            return;
        }
        rows.forEach(appendOdoLine);
    } catch (e) {
        console.warn('[logs] Could not load odometer history:', e.message);
        if (console_) console_.innerHTML = '<div class="log-line log-empty">Could not load history — is the server running?</div>';
    }
}

// ── Pause / Clear controls ───────────────────────────────────────────────
document.getElementById('pauseBtn')?.addEventListener('click', () => {
    paused = !paused;
    const btn = document.getElementById('pauseBtn');
    btn.classList.toggle('active', paused);
    btn.innerHTML = paused
        ? '<i class="fas fa-play"></i> Resume'
        : '<i class="fas fa-pause"></i> Pause';
});

document.getElementById('clearBtn')?.addEventListener('click', () => {
    const console_ = document.getElementById('odoConsole');
    if (console_) console_.innerHTML = '<div class="log-line log-empty">Cleared — waiting for new data…</div>';
    odoCount = 0;
    const countEl = document.getElementById('odoCount');
    if (countEl) countEl.textContent = '0 readings';
});

// ── Live socket feed ──────────────────────────────────────────────────────
if (typeof io !== 'undefined') {
    const _logsSocket = io(API);
    _logsSocket.on('odometer-data', (data) => {
        if (paused) return;
        appendOdoLine(data);
        pulseLiveDot();
    });
    _logsSocket.on('connect',    updateConnectionStatus);
    _logsSocket.on('disconnect', updateConnectionStatus);
}

// ── Init ──────────────────────────────────────────────────────────────────
updateConnectionStatus();
loadOdometerHistory();
setInterval(updateConnectionStatus, 10000);
