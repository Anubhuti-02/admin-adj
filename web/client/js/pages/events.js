/* events.js — Full version with axis P‑band badges and offline cache */

const API = window.location.origin;

let allEvents      = [];
let filterVal       = 'all';
let sensorFilterVal = 'all';
let lastIsoTime      = '';

const _urlParams = new URLSearchParams(window.location.search);
const HISTORY_FROM = _urlParams.get('from');
const HISTORY_TO   = _urlParams.get('to');
const IS_HISTORY   = !!(HISTORY_FROM && HISTORY_TO);

const VIEW_PARAM = _urlParams.get('view');
let viewModeVal   = (VIEW_PARAM === 'peak' || VIEW_PARAM === 'raw') ? VIEW_PARAM : 'all';

let thresholds = { p1Min: null, p1Max: null, p2Min: null, p2Max: null, p3Min: null };

let axisLimitsData = {
    generic: { x: null, y: null, z: null },
    a1:      { x: null, y: null, z: null },
    a2:      { x: null, y: null, z: null }
};

const DEFAULT_AXIS_LIMIT = 2;
const CACHE_PREFIX = 'eventsCache_';
const LAST_DATE_KEY = 'eventsLastDate';
const FETCH_TIMEOUT = 10000;

// ── Cache helpers ──────────────────────────────────────────────────────────────

function getCacheKey() {
    const dateInput = document.getElementById('filterDate');
    if (dateInput && dateInput.value) {
        return CACHE_PREFIX + dateInput.value;
    }
    return CACHE_PREFIX + 'live';
}

function saveEventsToCache(events) {
    try {
        const key = getCacheKey();
        const cache = {
            timestamp: Date.now(),
            data: events,
            date: document.getElementById('filterDate')?.value || 'live'
        };
        localStorage.setItem(key, JSON.stringify(cache));
    } catch (e) {
        console.warn('[events] Could not cache events:', e);
    }
}

function loadEventsFromCache() {
    try {
        const key = getCacheKey();
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const cache = JSON.parse(raw);
        if (!cache.data || !cache.timestamp) return null;
        return cache;
    } catch (e) {
        console.warn('[events] Could not load cached events:', e);
        return null;
    }
}

function getLastFetchedDate() {
    return localStorage.getItem(LAST_DATE_KEY) || null;
}

function setLastFetchedDate(dateStr) {
    localStorage.setItem(LAST_DATE_KEY, dateStr);
}

function getMostRecentCachedDate() {
    let latest = null;
    let latestTime = 0;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(CACHE_PREFIX)) {
            const datePart = key.substring(CACHE_PREFIX.length);
            if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
                try {
                    const cache = JSON.parse(localStorage.getItem(key));
                    if (cache && cache.timestamp && cache.timestamp > latestTime) {
                        latestTime = cache.timestamp;
                        latest = datePart;
                    }
                } catch (e) { /* ignore */ }
            }
        }
    }
    return latest;
}

// ── Show cached data banner ────────────────────────────────────────────────────

function showCachedBanner(cache) {
    const container = document.querySelector('.container');
    if (!container) return;
    const oldBanner = document.getElementById('offlineBanner');
    if (oldBanner) oldBanner.remove();

    const banner = document.createElement('div');
    banner.id = 'offlineBanner';
    banner.style.cssText = `
        background: #fbbf24;
        color: #1e293b;
        padding: 8px 16px;
        border-radius: 6px;
        margin-bottom: 12px;
        font-size: 14px;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    `;
    const dateStr = cache.date ? new Date(cache.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'unknown';
    const displayDate = cache.date === 'live' ? 'latest' : cache.date;
    banner.innerHTML = `
        <i class="fas fa-database"></i>
        <span>Showing cached data for <strong>${displayDate}</strong> (saved ${dateStr}). 
        New data will appear when connection is restored.</span>
    `;
    container.prepend(banner);
}

// ── Thresholds and axis limits ────────────────────────────────────────────────

async function loadAxisLimits() {
    try {
        const res = await fetch(`${API}/api/axis-limits`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data && data.generic && data.a1 && data.a2) {
            axisLimitsData = data;
            try { localStorage.setItem('axisLimitsData', JSON.stringify(data)); } catch (e) {}
        }
    } catch (e) {
        console.warn('[events] Could not load axis limits:', e.message);
        try {
            const cached = localStorage.getItem('axisLimitsData');
            if (cached) {
                axisLimitsData = JSON.parse(cached);
                console.log('[events] Using cached axis limits');
            }
        } catch (ce) {}
    }
}

function limitForSensor(sensor, axis) {
    const key = sensor === 'left' ? 'a1' : sensor === 'right' ? 'a2' : 'generic';
    const v = axisLimitsData[key] && axisLimitsData[key][axis];
    if (v && typeof v === 'object' && typeof v.p1 === 'number' && !isNaN(v.p1)) {
        return v.p1;
    }
    return (typeof v === 'number' && !isNaN(v)) ? v : null;
}

function matchedLimit(value, limit) {
    if (value == null || isNaN(value) || limit == null) return null;
    return Math.abs(value) >= limit ? limit : null;
}

function numOrNull(x) {
    return (typeof x === 'number' && !isNaN(x)) ? x : null;
}

// Full p1/p2/p3 tier set configured for a given sensor + axis (LAT='x', VERT='y')
function axisTiers(sensor, axis) {
    const key = sensor === 'left' ? 'a1' : sensor === 'right' ? 'a2' : 'generic';
    const v = axisLimitsData[key] && axisLimitsData[key][axis];
    if (v && typeof v === 'object') {
        return { p1: numOrNull(v.p1), p2: numOrNull(v.p2), p3: numOrNull(v.p3) };
    }
    // legacy shape: a single flat number is treated as the p1 limit only
    return { p1: numOrNull(v), p2: null, p3: null };
}

// Which priority tier (P1/P2/P3) this raw axis value crosses, based on that
// axis's own configured limits — independent of the global peak-based thresholds.
function axisBandForValue(sensor, axis, value) {
    if (value == null || isNaN(value)) return null;
    const tiers = axisTiers(sensor, axis);
    const g = Math.abs(value);
    if (tiers.p3 != null && g >= tiers.p3) return 'P3';
    if (tiers.p2 != null && g >= tiers.p2) return 'P2';
    if (tiers.p1 != null && g >= tiers.p1) return 'P1';
    return null;
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

function getBandForValue(value) {
    if (value == null || thresholds.p1Min === null) return null;
    const g = Math.abs(value);
    if (g >= thresholds.p3Min) return 'P3';
    if (g >= thresholds.p2Min) return 'P2';
    if (g >= thresholds.p1Min) return 'P1';
    return null;
}

// ── Normalise raw event ──────────────────────────────────────────────────────

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
        latBand:  axisBandForValue(d.sensor, 'x', xVal),
        vertBand: axisBandForValue(d.sensor, 'y', yVal),
        isNew:    false
    };
}

// ── Connection status ─────────────────────────────────────────────────────────

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
        statusEl.textContent = 'Offline (cached)';
        statusEl.className   = 'conn-status conn-off';
    }
}

// ── Main fetch with timeout ──────────────────────────────────────────────────

function fetchWithTimeout(url, options, timeout = FETCH_TIMEOUT) {
    return Promise.race([
        fetch(url, options),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timed out')), timeout)
        )
    ]);
}

async function fetchEvents() {
    const eventsList = document.getElementById('eventsList');
    try {
        await loadThresholds();
        await loadAxisLimits();
        await updateConnectionStatus();

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
            const end   = new Date();
            const start = new Date(end.getTime() - 30 * 24 * 3600000);
            url.searchParams.set('from', start.toISOString());
            url.searchParams.set('to',   end.toISOString());
        }

        const response = await fetchWithTimeout(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        const normalised = data.map(normalise);
        saveEventsToCache(normalised);

        const fetchedDate = dateInput?.value || new Date().toISOString().slice(0,10);
        setLastFetchedDate(fetchedDate);

        if (!IS_HISTORY && lastIsoTime) {
            normalised.forEach(e => { if (e.isoTime > lastIsoTime) e.isNew = true; });
        }
        if (normalised.length) {
            const latest = normalised.reduce((a, b) => a.isoTime > b.isoTime ? a : b);
            if (latest.isoTime > lastIsoTime) lastIsoTime = latest.isoTime;
        }

        allEvents = normalised;
        renderAll(!IS_HISTORY && normalised.some(e => e.isNew));
        const oldBanner = document.getElementById('offlineBanner');
        if (oldBanner) oldBanner.remove();

    } catch (e) {
        console.error('[events] fetch or processing error:', e.message);
        const cached = loadEventsFromCache();
        if (cached && cached.data && cached.data.length) {
            allEvents = cached.data;
            const latest = allEvents.reduce((a, b) => a.isoTime > b.isoTime ? a : b, { isoTime: '' });
            lastIsoTime = latest.isoTime || '';
            renderAll(false);
            showCachedBanner(cached);
            return;
        }

        const fallbackDate = getMostRecentCachedDate();
        const currentDate = document.getElementById('filterDate')?.value;
        if (fallbackDate && fallbackDate !== currentDate) {
            const dateInput = document.getElementById('filterDate');
            if (dateInput) {
                dateInput.value = fallbackDate;
                if (!window._fallbackTried) {
                    window._fallbackTried = true;
                    await fetchEvents();
                    window._fallbackTried = false;
                    return;
                }
            }
        }

        eventsList.innerHTML = `<p class="empty">No data available. Please check your connection or select a different date.</p>`;
        document.getElementById('totalEvents').textContent = '0';
        document.getElementById('highEvents').textContent = '0';
        document.getElementById('mediumEvents').textContent = '0';
        document.getElementById('lowEvents').textContent = '0';
        const oldBanner = document.getElementById('offlineBanner');
        if (oldBanner) oldBanner.remove();
    }
}

// ── Filter and render ─────────────────────────────────────────────────────────

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

// ── UPDATED axisLimitTag – badge sits next to value ──────────────────────────

function axisLimitTag(label, value, limit, accentColor) {
    const hit = limit != null;
    const absVal = value != null ? Math.abs(value) : null;
    const valStr = absVal != null ? absVal.toFixed(2) + 'g' : '—';
    const thresholdStr = hit ? ` ≥${limit}g` : '';
    const style = hit
        ? `background:${accentColor}22;color:${accentColor};border:1px solid ${accentColor}88;font-weight:800;`
        : `background:#f1f5f9;color:#94a3b8;border:1px solid #e2e8f0;`;
    const text = `${label} ${valStr}${thresholdStr}`;
    const title = hit
        ? `Meets configured ${label} limit of ${limit}g`
        : `No configured ${label} limit reached`;
    return `<span class="axis-limit-tag" style="${style}" title="${title}">${text}</span>`;
}

function bandBadge(band) {
    if (!band) return '';
    const map = { P1: '#22c55e', P2: '#f59e0b', P3: '#ef4444' };
    return `<span class="pclass-badge" style="background:${map[band] || '#94a3b8'};font-size:0.6rem;padding:2px 6px;margin-left:0.3rem;">${band}</span>`;
}

function cardHTML(ev, idx) {
    const newTag = ev.isNew ? '<span class="new-tag">NEW</span>' : '';
    const hasGps = ev.lat != null && ev.lng != null;

    // Peak-only middle row: pClass/threshold info, no raw axis tags.
    const peakRow = `
                <span class="event-meta">Peak <strong>${ev.peak.toFixed(3)} g</strong></span>
                ${ev.appliedThreshold != null
                    ? `<span class="event-meta">Threshold <strong>${ev.appliedThreshold} g</strong></span>`
                    : '<span class="event-meta" style="color:#94a3b8;">Threshold —</span>'}`;

    // Raw-only middle row: LAT/VERT axis tags, no pClass/peak-threshold info.
    const rawRow = `
                ${axisLimitTag('LAT',  ev.xVal, ev.latLimit,  '#ef4444')}${bandBadge(ev.latBand)}
                ${axisLimitTag('VERT', ev.yVal, ev.vertLimit, '#22c55e')}${bandBadge(ev.vertBand)}`;

    const bottomRow = viewModeVal === 'peak' ? peakRow
        : viewModeVal === 'raw' ? rawRow
        : peakRow + rawRow; // 'all' view keeps combined display

    const topRowExtra = viewModeVal === 'raw' ? '' : pClassBadge(ev.pClass);

    const band      = highestBand(ev);
    const bandColor = band ? (BAND_COLORS[band] || '#94a3b8') : '#94a3b8';

    return `
    <div class="event-card${ev.isNew ? ' event-flash' : ''}${hasGps ? ' event-clickable' : ''}"
        style="border-left:4px solid ${bandColor};"
        ${hasGps ? `onclick="goToMapEvent(${idx})" title="View on map"` : ''}>
        <div class="event-left">
            <div class="event-top-row">
                ${newTag}
                <span class="event-time">${ev.time}</span>
                <span class="event-sensor">${ev.sensor}</span>
                ${topRowExtra}
                ${hasGps ? '<i class="fas fa-map-marked-alt event-map-hint" title="View on map"></i>' : ''}
            </div>
            <div class="event-bottom-row">
                <span class="event-location"><i class="fas fa-map-marker-alt"></i> ${ev.location}</span>
                ${bottomRow}
            </div>
        </div>
        <div class="event-right">
            <span class="event-peak" style="color:${bandColor};">${crossedValueHTML(ev)}</span>
        </div>
    </div>`;
}

// Highest-priority P-band (P3 > P2 > P1) actually crossed by this event —
// checks the raw LAT/VERT axis bands first, falling back to the peak-based
// pClass so peak-only rows still get a band to colour by.
const BAND_PRIORITY = { P1: 1, P2: 2, P3: 3 };
const BAND_COLORS   = { P1: '#22c55e', P2: '#f59e0b', P3: '#ef4444' };

function highestBand(ev) {
    const candidates = [ev.latBand, ev.vertBand, ev.pClass].filter(Boolean);
    if (!candidates.length) return null;
    return candidates.reduce((a, b) => (BAND_PRIORITY[b] > BAND_PRIORITY[a] ? b : a));
}

// Exact axis value(s) that actually crossed a configured limit (raw threshold
// crossing), shown as plain numbers — no LAT/VERT label. If only LAT crossed,
// show LAT's value; if only VERT crossed, show VERT's value; if both crossed,
// show both side by side. Falls back to the peak g value if neither axis
// registered a crossing (e.g. legacy/peak-only events).
function crossedValueHTML(ev) {
    const latHit  = ev.latLimit  != null && ev.xVal != null;
    const vertHit = ev.vertLimit != null && ev.yVal != null;

    if (latHit && vertHit) {
        return `<span class="crossed-vals">${Math.abs(ev.xVal).toFixed(2)} g&nbsp;&nbsp;${Math.abs(ev.yVal).toFixed(2)} g</span>`;
    }
    if (latHit)  return `${Math.abs(ev.xVal).toFixed(2)} g`;
    if (vertHit) return `${Math.abs(ev.yVal).toFixed(2)} g`;

    return `${ev.peak.toFixed(1)} g`;
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
    const list = filtered();
    const statsBase = (viewModeVal === 'peak' || viewModeVal === 'raw') ? list : allEvents;

    document.getElementById('totalEvents').textContent  = statsBase.length;
    document.getElementById('highEvents').textContent   = statsBase.filter(e => e.severity === 'high').length;
    document.getElementById('mediumEvents').textContent = statsBase.filter(e => e.severity === 'medium').length;
    document.getElementById('lowEvents').textContent    = statsBase.filter(e => e.severity === 'low').length;
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

// ── Event listeners ───────────────────────────────────────────────────────────

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
    window._fallbackTried = false;
    fetchEvents();
});

async function exportEvents() {
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

    // Peak and raw exports are kept fully separate — different backend
    // filter (?type=) and different downloaded filename, never a shared file.
    let filename;
    if (viewModeVal === 'peak') {
        url.searchParams.set('type', 'peak');
        filename = 'IMPACT_REPORTS_PEAK_EVENTS.csv';
    } else if (viewModeVal === 'raw') {
        url.searchParams.set('type', 'raw');
        filename = 'IMPACT_REPORTS_RAW_EVENTS.csv';
    } else {
        filename = 'IMPACT_REPORTS_ALL_EVENTS.csv';
    }

    try {
        const res = await fetch(url.toString());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(blobUrl);
    } catch (e) {
        console.error('[events] export failed:', e.message);
        alert('Export failed: ' + e.message);
    }
}
window.exportEvents = exportEvents;

// ── Socket events ─────────────────────────────────────────────────────────────

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
            latBand:   axisBandForValue(ev.sensor, 'x', ev.xVal),
            vertBand:  axisBandForValue(ev.sensor, 'y', ev.yVal),
        }));
        renderAll();
    });
}

// ── Init ───────────────────────────────────────────────────────────────────────

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
        let defaultDate = getLastFetchedDate();
        if (defaultDate) {
            const dateInput = document.getElementById('filterDate');
            if (dateInput) dateInput.value = defaultDate;
        }
        if (statusEl) { statusEl.textContent = 'Offline'; statusEl.className = 'conn-status conn-off'; }
        fetchEvents();
        setInterval(fetchEvents, 2000);
    }
})();