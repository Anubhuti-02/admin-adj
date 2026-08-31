/* =============================================================================
   preload.js — Fetches last known state from CouchDB on page load
   Include this in every page AFTER common.js and BEFORE the page-specific JS
   Populates all UI elements with historical data so the page is never blank
============================================================================= */

const PRELOAD_SERVER = window.location.origin;

// ── Safe DOM setter ───────────────────────────────────────────────────────
function _set(id, val) {
    const el = document.getElementById(id);
    if (el && val != null) el.textContent = val;
}

function _fmt4(v) { return v != null ? (+v).toFixed(4) + ' g' : '—'; }
function _fmt2(v) { return v != null ? (+v).toFixed(2) + 'g'  : '—'; }
function _fmtInt(v) { return v != null ? String(v) : '—'; }

// ── 1. Pre-populate sensor readings (Northern Central + operator raw values)
async function preloadSensorReadings() {
    try {
        const res  = await fetch(`${PRELOAD_SERVER}/api/latest/sensor`);
        const data = await res.json(); // { left: {...}, right: {...} }

        const sides = { left: data.left, right: data.right, pivot: data.pivot };

        for (const [side, d] of Object.entries(sides)) {
            if (!d) continue;

            // Northern Central panel (index.html) — VERT = Y axis, LAT = X
            // axis. Z is intentionally never used here.
            if (side === 'left') {
                const vert = Math.abs(d.y ?? 0);
                const lat  = Math.abs(d.x ?? 0);
                _set('ablVert', vert.toFixed(4) + ' g');
                _set('ablLat',  lat.toFixed(4)  + ' g');
            }
            if (side === 'right') {
                const vert = Math.abs(d.y ?? 0);
                const lat  = Math.abs(d.x ?? 0);
                _set('abrVert', vert.toFixed(4) + ' g');
                _set('abrLat',  lat.toFixed(4)  + ' g');
            }
            if (side === 'pivot') {
                const vert = Math.abs(d.y ?? 0);
                const lat  = Math.abs(d.x ?? 0);
                // Pivot's DOM ids in index.html are pivotY (P-VERT) and
                // pivotX (P-LAT) — matches the live socket path in index.js's
                // updateNorthernPanel(), unlike left/right which use
                // ablVert/ablLat/abrVert/abrLat.
                _set('pivotY', vert.toFixed(4) + ' g');
                _set('pivotX', lat.toFixed(4)  + ' g');
            }

            // Operator dashboard raw values
            const pfx = side === 'left' ? 'accel1' : side === 'right' ? 'accel2' : 'accel3';
            _set(pfx + 'X',      _fmt4(d.x));
            _set(pfx + 'Y',      _fmt4(d.y));
            _set(pfx + 'Z',      _fmt4(d.z));
            _set(pfx + 'Peak',   _fmt4(d.peak ?? d.gForce));
            _set(pfx + 'RmsV',   _fmt4(d.rmsV));
            _set(pfx + 'RmsL',   _fmt4(d.rmsL));
            _set(pfx + 'SdV',    _fmt4(d.sdV));
            _set(pfx + 'SdL',    _fmt4(d.sdL));
            _set(pfx + 'P2pV',   _fmt4(d.p2pV));
            _set(pfx + 'P2pL',   _fmt4(d.p2pL));
            _set(pfx + 'Fs',     _fmtInt(d.fs));
            _set(pfx + 'Window', _fmtInt(d.window));

            // Graphs page legend values
            const gpfx = side === 'left' ? 'raw1' : side === 'right' ? 'raw2' : 'raw3';
            _set(gpfx + 'X', _fmt4(d.x));
            _set(gpfx + 'Y', _fmt4(d.y));
            _set(gpfx + 'Z', _fmt4(d.z));
        }

        console.log('[preload] Sensor readings populated from DB');
    } catch (e) {
        console.warn('[preload] Sensor readings fetch failed:', e.message);
    }
}

// ── 2. Pre-populate impact stats (operator dashboard metric cards) ─────────
async function preloadStats() {
    try {
        const res   = await fetch(`${PRELOAD_SERVER}/api/impacts/stats`);
        const stats = await res.json();

        _set('impactsToday', stats.total        ?? 0);
        _set('highSeverity', stats.highSeverity ?? 0);
        _set('maxPeak',      stats.maxPeak != null ? (+stats.maxPeak).toFixed(2) + 'g' : '—');

        // Last peak + p-class badge
        if (stats.lastPeak > 0) {
            _set('lastPeak', (+stats.lastPeak).toFixed(2) + 'g');
            const badge = document.getElementById('lastPeakClass');
            if (badge) {
                badge.textContent = stats.lastPeakClass || '—';
                const STYLE = {
                    'P1': { bg: '#fef3c7', color: '#92400e' },
                    'P2': { bg: '#fee2e2', color: '#b91c1c' },
                    'P3': { bg: '#4c0519', color: '#fecdd3' },
                    '—':  { bg: '#f1f5f9', color: '#64748b' }
                };
                const s = STYLE[stats.lastPeakClass] || STYLE['—'];
                badge.style.background = s.bg;
                badge.style.color      = s.color;
            }
        }

        // Distance
        const distM = stats.totalDistanceM ?? 0;
        _set('totalDistance', distM + ' m');
        _set('distanceKm',    (distM / 1000).toFixed(3) + ' km');

        console.log('[preload] Stats populated from DB:', stats);
    } catch (e) {
        console.warn('[preload] Stats fetch failed:', e.message);
    }
}

// ── 3. Pre-populate recent alerts ─────────────────────────────────────────
async function preloadAlerts() {
    try {
        const res     = await fetch(`${PRELOAD_SERVER}/api/impacts`);
        const impacts = await res.json();
        if (!impacts.length) return;

        const container = document.querySelector('.alerts-mini-list');
        if (!container) return;

        container.innerHTML = impacts.slice(0, 5).map(impact => {
            const cls  = (impact.severity || 'low').toLowerCase();
            const g    = impact.peak_g != null ? (+impact.peak_g).toFixed(1) + 'g' : '?g';
            const dist = impact.distance_m != null ? ` at ${impact.distance_m}m` : '';
            const side = impact.sensor ? ` (${impact.sensor})` : '';
            return `<div class="alert-mini-item ${cls}">
                        <span class="alert-dot"></span>
                        <span class="alert-text">${g}${dist}${side}</span>
                    </div>`;
        }).join('');

        console.log('[preload] Alerts populated from DB');
    } catch (e) {
        console.warn('[preload] Alerts fetch failed:', e.message);
    }
}

// ── 4. Pre-populate graphs (distance chart + raw subplots) ─────────────────
// This function is called by graphs.js after charts are initialized
// Exposed as window.preloadGraphHistory so graphs.js can call it.
// Returns the number of left-sensor points loaded so graphs.js can offset distanceM.
// When distChart is null, only pre-fills raw subplots (fast path used on page load).
window.preloadGraphHistory = async function(distChart, subplotsObj) {
    try {
        // Only fetch the last 80 points for raw subplots — small, fast query
        const res  = await fetch(`${PRELOAD_SERVER}/api/history/sensor?limit=240`);
        const data = await res.json();
        if (!data.length) return 0;

        const left  = data.filter(d => d.sensor === 'left');
        const right = data.filter(d => d.sensor === 'right');
        const pivot = data.filter(d => d.sensor === 'pivot');

        const fillSubplot = (chart, arr, extractFn) => {
            if (!chart) return;
            const pts = arr.slice(-80);
            chart.data.datasets[0].data = Array(80 - pts.length).fill(
                extractFn(pts[0] || {})
            ).concat(pts.map(extractFn));
            chart.update('none');
        };

        if (subplotsObj) {
            fillSubplot(subplotsObj.s1.x, left,  d => d.x ?? 0);
            fillSubplot(subplotsObj.s1.y, left,  d => d.y ?? 0);
            fillSubplot(subplotsObj.s1.z, left,  d => d.z ?? 9.8);
            fillSubplot(subplotsObj.s2.x, right, d => d.x ?? 0);
            fillSubplot(subplotsObj.s2.y, right, d => d.y ?? 0);
            fillSubplot(subplotsObj.s2.z, right, d => d.z ?? 9.8);
            fillSubplot(subplotsObj.s3.x, pivot, d => d.x ?? 0);
            fillSubplot(subplotsObj.s3.y, pivot, d => d.y ?? 0);
            fillSubplot(subplotsObj.s3.z, pivot, d => d.z ?? 9.8);
        }

        console.log('[preload] Raw subplots pre-filled');
        return left.length;
    } catch (e) {
        console.warn('[preload] Subplot preload failed:', e.message);
        return 0;
    }
};

// ── 5. Pre-populate last-saved GPS position (left panel) ───────────────────
async function preloadGPS() {
    try {
        const res = await fetch(`${PRELOAD_SERVER}/api/latest/gps`);
        const gps = await res.json();
        if (!gps) return;

        _set('gpsLat', gps.lat != null ? (+gps.lat).toFixed(6) + '°' : null);
        _set('gpsLon', gps.lng != null ? (+gps.lng).toFixed(6) + '°' : null);

        console.log('[preload] Last saved GPS position populated from DB');
    } catch (e) {
        console.warn('[preload] GPS fetch failed:', e.message);
    }
}

// ── 5b. Pre-populate last-saved odometer distance (left panel) ─────────────
// Uses the odometer's own km/meter/mm fields (odometer_data table) directly,
// not monitoring_data's derived distance_m — same source the live
// 'odometer-data' socket handler in index.js uses, so the on-load value and
// the first live update never disagree.
async function preloadOdometerDistance() {
    try {
        const res = await fetch(`${PRELOAD_SERVER}/api/latest/odometer`);
        const odo = await res.json();
        if (!odo || odo.km == null) return;

        _set('leftDistance', `${odo.km} km ${odo.meter} m ${odo.mm} mm`);

        console.log('[preload] Last saved odometer distance populated from DB');
    } catch (e) {
        console.warn('[preload] Odometer distance fetch failed:', e.message);
    }
}

// ── 6. Pre-populate health grid ───────────────────────────────────────────
window.preloadHealth = async function() {
    try {
        const res    = await fetch(`${PRELOAD_SERVER}/api/latest/health`);
        const health = await res.json();
        if (!health) return;

        // Trigger the same applyHealthUpdate function used by socket events
        if (typeof applyHealthUpdate === 'function') {
            applyHealthUpdate(health);
            console.log('[preload] Health grid populated from DB');
        }
    } catch (e) {
        console.warn('[preload] Health fetch failed:', e.message);
    }
};

// ── Run all preloads on DOM ready ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    preloadSensorReadings();
    preloadStats();
    preloadAlerts();
    preloadGPS();
    preloadOdometerDistance();
    // preloadHealth and preloadGraphHistory are called by their respective
    // page JS files after charts/health grid are initialized
});