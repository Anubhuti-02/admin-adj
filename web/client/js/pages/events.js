/* events.js — Realtime Impact Events */

const API = window.location.origin;

let allEvents      = [];
let filterVal       = 'all';
let sensorFilterVal = 'all';
let lastIsoTime      = '';

const _urlParams = new URLSearchParams(window.location.search);
const HISTORY_FROM = _urlParams.get('from');
const HISTORY_TO   = _urlParams.get('to');
const IS_HISTORY   = !!(HISTORY_FROM && HISTORY_TO);

// 'all' | 'peak' (crossed a P1/P2/P3 priority threshold) | 'raw' (crossed a raw X/Y axis limit)
// Set via ?view=peak / ?view=raw when this page is opened from the Peak Events /
// Raw Events menu entries; falls back to 'all' for the plain Events link.
const VIEW_PARAM = _urlParams.get('view');
let viewModeVal   = (VIEW_PARAM === 'peak' || VIEW_PARAM === 'raw') ? VIEW_PARAM : 'all';

let thresholds = { p1Min: null, p1Max: null, p2Min: null, p2Max: null, p3Min: null };

// ── Axis limits (server-backed via /api/axis-limits) — single g-value per axis,
// same "meets or exceeds" semantics as p1Min/p2Min/p3Min thresholds. ──────────
let axisLimitsData = {
    generic: { x: null, y: null, z: null },
    a1:      { x: null, y: null, z: null },
    a2:      { x: null, y: null, z: null }
};

async function loadAxisLimits() {
    try {
        const res = await fetch(`${API}/api/axis-limits`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data && data.generic && data.a1 && data.a2) {
            axisLimitsData = data;
        } else {
            console.warn('[events] axis-limits payload missing expected shape:', data);
        }
    } catch (e) {
        console.warn('[events] Could not load axis limits:', e.message);
    }
}

function limitForSensor(sensor, axis) {
    const key = sensor === 'left' ? 'a1' : sensor === 'right' ? 'a2' : 'generic';
    const v = axisLimitsData[key] && axisLimitsData[key][axis];
    return (typeof v === 'number' && !isNaN(v)) ? v : null;
}

// Returns the configured limit if |value| crosses it, else null — no more
// "pick the highest matched tag from a list", just a direct >= comparison
// against the single configured value for that axis.
function matchedLimit(value, limit) {
    if (value == null || isNaN(value) || limit == null) return null;
    return Math.abs(value) >= limit ? limit : null;
}

async function loadThresholds() {
    try {
        const res = await fetch(`${API}/api/thresholds`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        thresholds = await res.json();
    } catch (e) {
        console.warn('[events] Could not load thresholds:', e.message);
    }
}

function getPClass(peakG) {
    if (peakG == null || thresholds.p1Min === null) return null;
    const g = +peakG;
    if (g >= thresholds.p3Min) return 'P3';
    if (g >= thresholds.p2Min) return 'P2';
    if (g >= thresholds.p1Min) return 'P1';
    return null;
}

function normalise(d) {
    const sev = (d.severity || '').toLowerCase();

    const xVal = typeof d.x === 'number' ? d.x : (d.x != null ? parseFloat(d.x) : null);
    const yVal = typeof d.y === 'number' ? d.y : (d.y != null ? parseFloat(d.y) : null);

    const latLimit  = matchedLimit(xVal, limitForSensor(d.sensor, 'x'));
    const vertLimit = matchedLimit(yVal, limitForSensor(d.sensor, 'y'));

    return {
        id: d.id ?? null,
        time: d.timestamp ? new Date(d.timestamp).toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        }) : '—',
        isoTime:  d.timestamp || '',
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
        pClass:     getPClass(d.peak_g),
        appliedThreshold: (() => {
            if (thresholds.p1Min === null) return null;
            const g = +(d.peak_g || 0);
            if (g >= thresholds.p3Min) return thresholds.p3Min;
            if (g >= thresholds.p2Min) return thresholds.p2Min;
            if (g >= thresholds.p1Min) return thresholds.p1Min;
            return null;
        })(),
        xVal, yVal,
        latLimit,
        vertLimit,
        isNew:    false
    };
}

async function updateConnectionStatus() {
    const statusEl = document.getElementById('connStatus');
    if (!statusEl) return;
    try {
        const res    = await fetch(`${API}/api/realtime/status`);
        const status = await res.json();
        const live = status.connected && status.receiving_data;
        statusEl.textContent  = live ? 'Live' : 'Offline';
        statusEl.className    = `conn-status ${live ? 'conn-on' : 'conn-off'}`;
    } catch (e) {
        statusEl.textContent = 'Offline';
        statusEl.className   = 'conn-status conn-off';
    }
}

async function fetchEvents() {
    await loadThresholds();
    await loadAxisLimits();
    await updateConnectionStatus();

    try {
        const url = new URL(`${API}/api/impacts`);
        if (HISTORY_FROM) url.searchParams.set('from', HISTORY_FROM);
        if (HISTORY_TO)   url.searchParams.set('to',   HISTORY_TO);

        const dateInput = document.getElementById('filterDate');
        if (dateInput && dateInput.value) {
            const [y, m, d] = dateInput.value.split('-').map(Number);
            const start = new Date(y, m - 1, d); start.setHours(0, 0, 0, 0);
            const end   = new Date(y, m - 1, d); end.setHours(23, 59, 59, 999);
            url.searchParams.set('from', start.toISOString());
            url.searchParams.set('to',   end.toISOString());
        }
        else if (!HISTORY_FROM && (viewModeVal === 'peak' || viewModeVal === 'raw')) {
            // Peak/Raw views need to search FAR beyond the noisy "last 2000
            // rows" window, since low-magnitude readings can flood that
            // window and bury the real classified events further back.
            // Pull the last 30 days by default when no explicit date is set.
            const end   = new Date();
            const start = new Date(end.getTime() - 30 * 24 * 3600000);
            url.searchParams.set('from', start.toISOString());
            url.searchParams.set('to',   end.toISOString());
        }

        const data = await fetch(url).then(r => r.json());
        console.log('[events] raw /api/impacts sample record:', data[0]);
        const normalised = data.map(normalise);
        console.log('[events] first normalised event xVal/yVal/latLimit/vertLimit:',
            normalised[0] && {
                sensor: normalised[0].sensor, xVal: normalised[0].xVal, yVal: normalised[0].yVal,
                latLimit: normalised[0].latLimit, vertLimit: normalised[0].vertLimit
            });

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

function filtered() {
    let list = filterVal === 'all' ? allEvents : allEvents.filter(e => e.severity === filterVal);
    if (sensorFilterVal !== 'all') list = list.filter(e => e.sensor === sensorFilterVal);
    if (viewModeVal === 'peak') list = list.filter(e => !!e.pClass);
    if (viewModeVal === 'raw')  list = list.filter(e => e.latLimit != null || e.vertLimit != null);
    return list;
}

function pClassBadge(p) {
    if (!p) return '';
    const map = { P1: '#22c55e', P2: '#f59e0b', P3: '#ef4444' };
    return `<span class="pclass-badge" style="background:${map[p] || '#94a3b8'}">${p}</span>`;
}

function axisLimitTag(label, value, limit, accentColor) {
    const hit = limit != null;
    const valStr = value != null ? Math.abs(value).toFixed(2) + 'g' : '—';
    const style = hit
        ? `background:${accentColor}22;color:${accentColor};border:1px solid ${accentColor}88;font-weight:800;`
        : `background:#f1f5f9;color:#94a3b8;border:1px solid #e2e8f0;`;
    const text = hit ? `${label} ${valStr} ≥${limit}g` : `${label} ${valStr}`;
    const title = hit
        ? `Meets configured ${label} limit of ${limit}g`
        : `No configured ${label} limit reached`;
    return `<span class="axis-limit-tag" style="${style}" title="${title}">${text}</span>`;
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
                ${axisLimitTag('LAT',  ev.xVal, ev.latLimit,  '#ef4444')}
                ${axisLimitTag('VERT', ev.yVal, ev.vertLimit, '#22c55e')}
            </div>
        </div>
        <div class="event-right">
            <span class="event-peak peak-${ev.severity}">${ev.peak.toFixed(1)} g</span>
            <span class="sev-label sev-${ev.severity}">${ev.severity.toUpperCase()}</span>
        </div>
    </div>`;
}

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
    document.getElementById('totalEvents').textContent  = allEvents.length;
    document.getElementById('highEvents').textContent   = allEvents.filter(e => e.severity === 'high').length;
    document.getElementById('mediumEvents').textContent = allEvents.filter(e => e.severity === 'medium').length;
    document.getElementById('lowEvents').textContent    = allEvents.filter(e => e.severity === 'low').length;

    const list = filtered();
    const emptyMsg = viewModeVal === 'peak'
        ? 'No events have crossed a Priority (P1/P2/P3) peak threshold. Check Configuration → Priority Thresholds.'
        : viewModeVal === 'raw'
            ? 'No events have crossed a configured raw Axis Limit. Check Configuration → Axis Limit Values.'
            : 'No events found.';
    document.getElementById('eventsList').innerHTML =
        list.length ? list.map((ev, i) => cardHTML(ev, i)).join('') : `<p class="empty">${emptyMsg}</p>`;

    if (flashDot) {
        const dot = document.getElementById('liveDot');
        if (dot) { dot.classList.add('pulse'); setTimeout(() => dot.classList.remove('pulse'), 800); }
    }
}

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

function exportEvents() {
    const dateInput = document.getElementById('filterDate');
    const url = new URL(`${API}/api/impacts/export/csv`);

    if (dateInput && dateInput.value) {
        const [y, m, d] = dateInput.value.split('-').map(Number);
        const start = new Date(y, m - 1, d); start.setHours(0, 0, 0, 0);
        const end   = new Date(y, m - 1, d); end.setHours(23, 59, 59, 999);
        url.searchParams.set('from', start.toISOString());
        url.searchParams.set('to',   end.toISOString());
    } else if (HISTORY_FROM && HISTORY_TO) {
        url.searchParams.set('from', HISTORY_FROM);
        url.searchParams.set('to',   HISTORY_TO);
    }

    window.open(url.toString(), '_blank');
}
window.exportEvents = exportEvents;

if (!IS_HISTORY && typeof io !== 'undefined') {
    const _evSocket = io(API);
    _evSocket.on('display-reset', () => {
        allEvents  = [];
        lastIsoTime = '';
        renderAll();
    });
    _evSocket.on('axis-limits-updated', (data) => {
        console.log('[events] axis-limits-updated via socket:', data);
        axisLimitsData = data;
        allEvents = allEvents.map(ev => ({
            ...ev,
            latLimit:  matchedLimit(ev.xVal, limitForSensor(ev.sensor, 'x')),
            vertLimit: matchedLimit(ev.yVal, limitForSensor(ev.sensor, 'y')),
        }));
        renderAll();
    });
}

(function initViewHeading() {
    const h1 = document.querySelector('.header-left h1');
    if (h1) {
        if (viewModeVal === 'peak') h1.textContent = 'Peak Events';
        else if (viewModeVal === 'raw') h1.textContent = 'Raw Events';
    }
})();

(function init() {
    const statusEl = document.getElementById('connStatus');
    if (IS_HISTORY) {
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