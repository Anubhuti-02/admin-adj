/* events.js — Realtime Impact Events
 *
 * Threshold classification:
 *   - Fetched fresh from /api/thresholds every poll cycle
 *   - d.p_class from DB is IGNORED — re-classified at render time against
 *     live thresholds so config changes reflect immediately
 *   - Gap-absorbing logic: g >= p3Min → P3, g >= p2Min → P2, g >= p1Min → P1
 *
 * Live/Offline indicator:
 *   - Checks /api/realtime/status on every cycle
 *   - "Live" (green) only when MQTT is connected AND data received < 10s ago
 *   - "Offline" (red) when hardware disconnected or no recent data
 */

const API = window.location.origin;

let allEvents  = [];
let filterVal  = 'all';
let sensorFilterVal = 'all';
let lastIsoTime = '';

// Read history range from URL params (set by parent index.js)
const _urlParams = new URLSearchParams(window.location.search);
const HISTORY_FROM = _urlParams.get('from');
const HISTORY_TO   = _urlParams.get('to');
const IS_HISTORY   = !!(HISTORY_FROM && HISTORY_TO);

// Null until fetched — no hardcoded defaults
let thresholds = { p1Min: null, p1Max: null, p2Min: null, p2Max: null, p3Min: null };

// ── Fetch live thresholds ─────────────────────────────────────────────────
async function loadThresholds() {
    try {
        const res = await fetch(`${API}/api/thresholds`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        thresholds = await res.json();
    } catch (e) {
        console.warn('[events] Could not load thresholds:', e.message);
    }
}

// ── Gap-absorbing P-class from live thresholds ────────────────────────────
// Never reads d.p_class — always re-classifies from raw peak_g value.
function getPClass(peakG) {
    if (peakG == null || thresholds.p1Min === null) return null;
    const g = +peakG;
    if (g >= thresholds.p3Min) return 'P3';
    if (g >= thresholds.p2Min) return 'P2';
    if (g >= thresholds.p1Min) return 'P1';
    return null;
}

// ── Normalise DB record ───────────────────────────────────────────────────
function normalise(d) {
    const sev = (d.severity || '').toLowerCase();
    return {
        id: d.id ?? null,
        time: d.timestamp ? new Date(d.timestamp).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        }) : '—',
        isoTime:  d.timestamp || '',
        // IST calendar date (YYYY-MM-DD) — used to preselect the map's date picker
        dateIST: d.timestamp
            ? new Date(d.timestamp).toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' })
            : '',
        lat: (typeof d.lat === 'number' && d.lat !== 0) ? d.lat : null,
        lng: (typeof d.lng === 'number' && d.lng !== 0) ? d.lng : null,
        location: d.distance_m > 0
            ? `KM ${Math.floor(d.distance_m / 1000)}+${String(d.distance_m % 1000).padStart(3,'0')}`
            : 'Stationary',
        peak:     +(d.peak_g || d.gForce || 0).toFixed(2),
        sensor:   d.sensor || '—',
        severity: sev,
        pClass:     getPClass(d.peak_g),   // live classification, not d.p_class
        // Applied threshold: the min of whichever band the peak falls into
        appliedThreshold: (() => {
            if (thresholds.p1Min === null) return null;
            const g = +(d.peak_g || 0);
            if (g >= thresholds.p3Min) return thresholds.p3Min;
            if (g >= thresholds.p2Min) return thresholds.p2Min;
            if (g >= thresholds.p1Min) return thresholds.p1Min;
            return null;
        })(),
        isNew:    false
    };
}

// ── Device connection status ──────────────────────────────────────────────
async function updateConnectionStatus() {
    const statusEl = document.getElementById('connStatus');
    if (!statusEl) return;
    try {
        const res    = await fetch(`${API}/api/realtime/status`);
        const status = await res.json();
        // "Live" only when MQTT connected AND hardware sent data in last 10s
        const live = status.connected && status.receiving_data;
        statusEl.textContent  = live ? 'Live' : 'Offline';
        statusEl.className    = `conn-status ${live ? 'conn-on' : 'conn-off'}`;
    } catch (e) {
        // Server itself unreachable
        statusEl.textContent = 'Offline';
        statusEl.className   = 'conn-status conn-off';
    }
}

// ── Fetch and render events ───────────────────────────────────────────────
async function fetchEvents() {
    // Always refresh thresholds first so classification uses latest config
    await loadThresholds();

    // Connection status is independent of data fetch — check separately
    await updateConnectionStatus();

    try {
        const url = new URL(`${API}/api/impacts`);
        if (HISTORY_FROM) url.searchParams.set('from', HISTORY_FROM);
        if (HISTORY_TO)   url.searchParams.set('to',   HISTORY_TO);

        // Date filter from the inline picker overrides history params
        const dateInput = document.getElementById('filterDate');
        if (dateInput && dateInput.value) {
            const d = new Date(dateInput.value);
            const start = new Date(d); start.setHours(0, 0, 0, 0);
            const end   = new Date(d); end.setHours(23, 59, 59, 999);
            url.searchParams.set('from', start.toISOString());
            url.searchParams.set('to',   end.toISOString());
        }

        const data       = await fetch(url).then(r => r.json());
        const normalised = data.map(normalise);

        // In history mode don't track "new" arrivals — all data is historical
        if (!IS_HISTORY && lastIsoTime) {
            normalised.forEach(e => { if (e.isoTime > lastIsoTime) e.isNew = true; });
        }
        if (normalised.length) {
            const latest = normalised.reduce((a, b) => a.isoTime > b.isoTime ? a : b);
            if (latest.isoTime > lastIsoTime) lastIsoTime = latest.isoTime;
        }

        allEvents = normalised;
        renderAll(!IS_HISTORY && normalised.some(e => e.isNew));
    } catch (e) {
        console.error('[events] fetch impacts:', e);
    }
}

// ── Render ────────────────────────────────────────────────────────────────
function filtered() {
    let list = filterVal === 'all' ? allEvents : allEvents.filter(e => e.severity === filterVal);
    if (sensorFilterVal !== 'all') list = list.filter(e => e.sensor === sensorFilterVal);
    return list;
}

function pClassBadge(p) {
    if (!p) return '';
    const map = { P1: '#22c55e', P2: '#f59e0b', P3: '#ef4444' };
    return `<span class="pclass-badge" style="background:${map[p] || '#94a3b8'}">${p}</span>`;
}

function cardHTML(ev, idx) {
    const newTag = ev.isNew ? '<span class="new-tag">NEW</span>' : '';
    const hasGps = ev.lat != null && ev.lng != null;
    return `
    <div class="event-card event-${ev.severity}${ev.isNew ? ' event-flash' : ''}${hasGps ? ' event-clickable' : ''}"
        ${hasGps ? `onclick="goToMapEvent(${idx})" title="View on map"` : ''}>
        <div class="event-left">
            <div class="event-top-row">
                ${newTag}
                <span class="event-time">${ev.time}</span>
                <span class="event-sensor">${ev.sensor}</span>
                ${pClassBadge(ev.pClass)}
                ${hasGps ? '<i class="fas fa-map-marked-alt event-map-hint" title="View on map"></i>' : ''}
            </div>
            <div class="event-bottom-row">
                <span class="event-location"><i class="fas fa-map-marker-alt"></i> ${ev.location}</span>
                <span class="event-meta">Peak <strong>${ev.peak.toFixed(3)} g</strong></span>
                ${ev.appliedThreshold != null
                    ? `<span class="event-meta">Threshold <strong>${ev.appliedThreshold} g</strong></span>`
                    : '<span class="event-meta" style="color:#94a3b8;">Threshold —</span>'}
            </div>
        </div>
        <div class="event-right">
            <span class="event-peak peak-${ev.severity}">${ev.peak.toFixed(1)} g</span>
            <span class="sev-label sev-${ev.severity}">${ev.severity.toUpperCase()}</span>
        </div>
    </div>`;
}

// ── Jump to peak on the map page ──────────────────────────────────────────
function goToMapEvent(idx) {
    const ev = filtered()[idx];
    if (!ev || ev.lat == null || ev.lng == null) return;

    const params = new URLSearchParams();
    if (ev.id != null) params.set('eventId', ev.id);
    params.set('lat', ev.lat);
    params.set('lng', ev.lng);
    if (ev.dateIST) params.set('date', ev.dateIST);

    const target = `pages/map-content.html?${params.toString()}`;
    if (window.parent && window.parent.loadPage) {
        window.parent.loadPage(target);
    } else {
        window.location.href = target.replace('pages/', '');
    }
}
window.goToMapEvent = goToMapEvent;

function renderAll(flashDot = false) {
    const list = filtered();
    document.getElementById('totalEvents').textContent  = list.length;
    document.getElementById('highEvents').textContent   = list.filter(e => e.severity === 'high').length;
    document.getElementById('mediumEvents').textContent = list.filter(e => e.severity === 'medium').length;
    document.getElementById('lowEvents').textContent    = list.filter(e => e.severity === 'low').length;
    document.getElementById('eventsList').innerHTML =
        list.length ? list.map((ev, i) => cardHTML(ev, i)).join('') : '<p class="empty">No events found.</p>';

    if (flashDot) {
        const dot = document.getElementById('liveDot');
        if (dot) { dot.classList.add('pulse'); setTimeout(() => dot.classList.remove('pulse'), 800); }
    }
}

// ── Filter ────────────────────────────────────────────────────────────────
document.getElementById('severityFilter').addEventListener('change', e => {
    filterVal = e.target.value;
    renderAll();
});

document.getElementById('sensorFilter')?.addEventListener('change', e => {
    sensorFilterVal = e.target.value;
    renderAll();
});

document.getElementById('filterDate')?.addEventListener('change', () => {
    allEvents  = [];
    lastIsoTime = '';
    fetchEvents();
});

// ── Export ────────────────────────────────────────────────────────────────
function exportEvents() {
    const dateInput = document.getElementById('filterDate');
    const url = new URL(`${API}/api/impacts/export/csv`);

    if (dateInput && dateInput.value) {
        const d     = new Date(dateInput.value);
        const start = new Date(d); start.setHours(0, 0, 0, 0);
        const end   = new Date(d); end.setHours(23, 59, 59, 999);
        url.searchParams.set('from', start.toISOString());
        url.searchParams.set('to',   end.toISOString());
    } else if (HISTORY_FROM && HISTORY_TO) {
        url.searchParams.set('from', HISTORY_FROM);
        url.searchParams.set('to',   HISTORY_TO);
    }

    window.open(url.toString(), '_blank');
}
window.exportEvents = exportEvents;

// ── Socket — listen for display-reset from server ────────────────────────
if (!IS_HISTORY && typeof io !== 'undefined') {
    const _evSocket = io(API);
    _evSocket.on('display-reset', () => {
        allEvents  = [];
        lastIsoTime = '';
        renderAll();
    });
}

// ── Boot — show Offline immediately, then start polling ───────────────────
(function init() {
    const statusEl = document.getElementById('connStatus');
    if (IS_HISTORY) {
        // History mode — show banner, fetch once, no polling
        if (statusEl) { statusEl.textContent = 'History'; statusEl.className = 'conn-status'; statusEl.style.background = '#7c3aed'; statusEl.style.color = '#fff'; }
        const header = document.querySelector('.page-header, .header');
        if (header) {
            const banner = document.createElement('div');
            banner.style.cssText = 'background:#7c3aed;color:#fff;padding:6px 16px;font-size:13px;border-radius:6px;margin-bottom:8px;';
            banner.textContent = `Showing history: ${new Date(HISTORY_FROM).toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})} → ${new Date(HISTORY_TO).toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`;
            header.prepend(banner);
        }
        fetchEvents();
    } else {
        if (statusEl) { statusEl.textContent = 'Offline'; statusEl.className = 'conn-status conn-off'; }
        fetchEvents();
        setInterval(fetchEvents, 2000);
    }
})();