/* configuration.js
 * Axle thresholds   → /api/thresholds        (unchanged shape, other pages still work)
 * Pivot thresholds  → /api/thresholds/pivot  (pivot classified separately)
 * Axis limits (X/Y/Z) — one g-value per axis per unit (generic/a1/a2), server-
 * backed via /api/axis-limits. Same semantics as the threshold endpoints:
 * a reading whose |value| >= the configured number crosses the limit.
 * Saving one unit's X/Y/Z sends 3 POSTs (one per axis); Reset deletes every
 * saved value and the server falls back to its 0.5g default.
 */

const AXES = ['x', 'y', 'z'];
const AXIS_UNIT_PREFIX = { generic: 'Gen', a1: 'A1', a2: 'A2' };

// axisLimitsData mirrors the server shape exactly: { generic:{x,y,z}, a1:{x,y,z}, a2:{x,y,z} }
// — each leaf is a single number (or null if somehow unset).
let axisLimitsData = {
    generic: { x: null, y: null, z: null },
    a1:      { x: null, y: null, z: null },
    a2:      { x: null, y: null, z: null }
};

async function fetchAxisLimits() {
    try {
        const res = await fetch('/api/axis-limits');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data && data.generic && data.a1 && data.a2) axisLimitsData = data;
        console.log('[config] Axis limits loaded from server:', axisLimitsData);
    } catch (e) {
        console.warn('[config] Could not load axis limits:', e.message);
        showError('Could not load axis limits from server. Is the server running?');
    }
}

// ── Boot: fetch axle + pivot thresholds and axis limits from server ───────
async function loadConfig() {
    let axle  = { p1Min: null, p1Max: null, p2Min: null, p2Max: null, p3Min: null };
    let pivot = { p1Min: null, p1Max: null, p2Min: null, p2Max: null, p3Min: null };

    try {
        const res = await fetch('/api/thresholds');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        axle = await res.json();
        console.log('[config] Axle loaded from server:', axle);
    } catch (e) {
        console.warn('[config] Could not reach /api/thresholds:', e.message);
        showError('Could not load axle thresholds from server. Is the server running?');
    }

    try {
        const res = await fetch('/api/thresholds/pivot');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        pivot = await res.json();
        console.log('[config] Pivot loaded from server:', pivot);
    } catch (e) {
        console.warn('[config] Could not reach /api/thresholds/pivot:', e.message);
    }

    setInputs('', axle);
    setInputs('pv-', pivot);

    await fetchAxisLimits();

    updateUI(axle, pivot);
}

function setInputs(prefix, t) {
    const el = id => document.getElementById(prefix + id);
    if (el('p1Min')) el('p1Min').value = t.p1Min ?? '';
    if (el('p1Max')) el('p1Max').value = t.p1Max ?? '';
    if (el('p2Min')) el('p2Min').value = t.p2Min ?? '';
    if (el('p2Max')) el('p2Max').value = t.p2Max ?? '';
    if (el('p3Min')) el('p3Min').value = t.p3Min ?? '';
}

// ── UI helpers ────────────────────────────────────────────────────────────
function updateUI(axle, pivot) {
    if (!axle)  axle  = readInputs('');
    if (!pivot) pivot = readInputs('pv-');
    updateRanges('', axle);
    updateRanges('pv-', pivot);

    Object.keys(AXIS_UNIT_PREFIX).forEach(unit => displayAxisLimitUnit(unit));

    displayCurrentConfig(axle,  'configBadges');
    displayCurrentConfig(pivot, 'pivotConfigBadges');
}

function readInputs(prefix) {
    return {
        p1Min: parseFloat(document.getElementById(prefix + 'p1Min').value) || null,
        p1Max: parseFloat(document.getElementById(prefix + 'p1Max').value) || null,
        p2Min: parseFloat(document.getElementById(prefix + 'p2Min').value) || null,
        p2Max: parseFloat(document.getElementById(prefix + 'p2Max').value) || null,
        p3Min: parseFloat(document.getElementById(prefix + 'p3Min').value) || null,
    };
}

function fmt(min, max) {
    if (min === null && max === null) return '—';
    if (max === null) return `${min}g +`;
    return `${min}g – ${max}g`;
}

function updateRanges(prefix, t) {
    if (!t) t = readInputs(prefix);
    const r1 = document.getElementById(prefix + 'p1Range');
    const r2 = document.getElementById(prefix + 'p2Range');
    const r3 = document.getElementById(prefix + 'p3Range');
    if (r1) r1.textContent = fmt(t.p1Min, t.p1Max);
    if (r2) r2.textContent = fmt(t.p2Min, t.p2Max);
    if (r3) r3.textContent = t.p3Min !== null ? `${t.p3Min}g +` : '—';
}

function displayCurrentConfig(t, badgesElId) {
    const badges = document.getElementById(badgesElId);
    if (!badges) return;
    if (!t) t = readInputs(badgesElId === 'pivotConfigBadges' ? 'pv-' : '');
    const configured = t.p1Min !== null;
    badges.innerHTML = configured ? `
        <div class="config-badge-item">P1: ${fmt(t.p1Min, t.p1Max)}</div>
        <div class="config-badge-item">P2: ${fmt(t.p2Min, t.p2Max)}</div>
        <div class="config-badge-item">P3: &gt; ${t.p3Min}g</div>
    ` : `<div class="config-badge-item" style="color:#94a3b8;">No thresholds configured yet — enter values and save.</div>`;
}

// ── Single-value Axis Limits — one number per axis per unit ────────────────
// Populates the X/Y/Z inputs + "Current: —" labels for one unit from
// axisLimitsData (called on load and whenever the server pushes an update).
function displayAxisLimitUnit(unit) {
    const prefix = AXIS_UNIT_PREFIX[unit];
    AXES.forEach(axis => {
        const input   = document.getElementById(`axisLimit${prefix}${axis.toUpperCase()}`);
        const current = document.getElementById(`axisLimit${prefix}${axis.toUpperCase()}Current`);
        const v = axisLimitsData[unit] && axisLimitsData[unit][axis];
        if (input && document.activeElement !== input) input.value = v ?? '';
        if (current) {
            if (v != null) { current.textContent = `Current: ${v}g`; current.classList.add('set'); }
            else            { current.textContent = 'Current: —';     current.classList.remove('set'); }
        }
    });
}

// Reads the three X/Y/Z inputs for one unit and POSTs each axis that has a
// valid positive value. Mirrors /api/thresholds's "one object per Save
// click" pattern rather than the old per-keystroke Add/Remove.
async function saveAxisLimit(unit) {
    const prefix = AXIS_UNIT_PREFIX[unit];
    const values = {};
    for (const axis of AXES) {
        const input = document.getElementById(`axisLimit${prefix}${axis.toUpperCase()}`);
        const raw   = input ? input.value.trim() : '';
        if (raw === '') continue; // leave that axis's saved value untouched
        const v = parseFloat(raw);
        if (isNaN(v) || v <= 0) { showError(`Enter a valid positive ${axis.toUpperCase()}-axis limit`); return; }
        values[axis] = v;
    }
    if (!Object.keys(values).length) { showError('Enter at least one axis value to save'); return; }

    try {
        for (const [axis, value] of Object.entries(values)) {
            const res  = await fetch('/api/axis-limits', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ unit, axis, value })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            axisLimitsData = data.axisLimits;
        }
        displayAxisLimitUnit(unit);
        hideError();
        const msg = document.getElementById('successMessage');
        if (msg) { msg.style.display = 'flex'; setTimeout(() => msg.style.display = 'none', 4000); }
    } catch (e) {
        showError(`Could not save axis limits: ${e.message}`);
    }
}

// ── Input live preview ────────────────────────────────────────────────────
['p1Min','p1Max','p2Min','p2Max','p3Min'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => updateRanges(''));
});
['pv-p1Min','pv-p1Max','pv-p2Min','pv-p2Max','pv-p3Min'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => updateRanges('pv-'));
});

// ── Validation ────────────────────────────────────────────────────────────
function validateThresholds(prefix, label) {
    const t = readInputs(prefix);
    if (Object.values(t).some(v => v === null || isNaN(v)))
        { showError(`All ${label} threshold values are required`); return null; }
    if (t.p1Min >= t.p1Max)  { showError(`${label}: P1 min must be less than P1 max`); return null; }
    if (t.p2Min >= t.p2Max)  { showError(`${label}: P2 min must be less than P2 max`); return null; }
    if (t.p2Min <= t.p1Min)  { showError(`${label}: P2 min must be greater than P1 min`); return null; }
    if (t.p3Min <= t.p2Min)  { showError(`${label}: P3 min must be greater than P2 min`); return null; }
    return t;
}

// ── Save — thresholds (P1/P2/P3) only. Axis limits save independently via
// their own "Save … Limits" button next to each unit's inputs. ────────────
async function saveAllConfig() {
    const axle  = validateThresholds('', 'Axle');
    if (!axle) return;
    const pivot = validateThresholds('pv-', 'Pivot');
    if (!pivot) return;

    try {
        const res  = await fetch('/api/thresholds', {
            method:  'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(axle)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        const pvRes  = await fetch('/api/thresholds/pivot', {
            method:  'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pivot)
        });
        const pvData = await pvRes.json();
        if (!pvRes.ok) throw new Error(pvData.error || `HTTP ${pvRes.status}`);

        console.log('[config] Saved axle:', data.thresholds, 'pivot:', pvData.thresholds);
        updateUI(data.thresholds, pvData.thresholds);
    } catch (e) {
        showError(`Save failed: ${e.message}`);
        return;
    }

    hideError();
    const msg = document.getElementById('successMessage');
    if (msg) { msg.style.display = 'flex'; setTimeout(() => msg.style.display = 'none', 4000); }
}

// ── Clear — resets thresholds AND deletes every saved axis-limit value,
// falling the latter back to the server's 0.5g default. ────────────────────
async function resetToDefault() {
    try {
        const res = await fetch('/api/thresholds', { method: 'DELETE' });
        console.log('[reset] axle status:', res.status, res.headers.get('content-type'));
        if (!res.ok) {
            const text = await res.text();
            console.error('[reset] axle response body:', text.slice(0, 300));
            throw new Error(`HTTP ${res.status} on /api/thresholds`);
        }
        const data = await res.json();

        const pvRes = await fetch('/api/thresholds/pivot', { method: 'DELETE' });
        console.log('[reset] pivot status:', pvRes.status, pvRes.headers.get('content-type'));
        if (!pvRes.ok) {
            const text = await pvRes.text();
            console.error('[reset] pivot response body:', text.slice(0, 300));
            throw new Error(`HTTP ${pvRes.status} on /api/thresholds/pivot`);
        }
        const pvData = await pvRes.json();

        ['p1Min','p1Max','p2Min','p2Max','p3Min'].forEach(id => { document.getElementById(id).value = ''; });
        setInputs('pv-', pvData.thresholds);

        // Deletes every user-saved axis limit — server resets each axis to 0.5g
        const axRes = await fetch('/api/axis-limits', { method: 'DELETE' });
        if (!axRes.ok) throw new Error(`HTTP ${axRes.status} on /api/axis-limits`);
        const axData = await axRes.json();
        axisLimitsData = axData.axisLimits;

        updateUI(data.thresholds, pvData.thresholds);
        hideError();
    } catch (e) {
        console.error('[reset] failed:', e);
        showError(`Clear failed: ${e.message}`);
    }
}

// ── Error/success display ─────────────────────────────────────────────────
function showError(msg) {
    const el = document.getElementById('validationError');
    if (!el) return;
    el.querySelector('span').textContent = msg;
    el.style.display = 'block';
}
function hideError() {
    const el = document.getElementById('validationError');
    if (el) el.style.display = 'none';
}

// ── Live sync with other tabs/pages editing Configuration concurrently —
// server broadcasts on every Save/Reset ────────────────────────────────────
if (typeof io !== 'undefined') {
    const _cfgSocket = io(window.location.origin);
    _cfgSocket.on('axis-limits-updated', (data) => {
        axisLimitsData = data;
        Object.keys(AXIS_UNIT_PREFIX).forEach(unit => displayAxisLimitUnit(unit));
    });
}

// ── Expose to HTML onclick handlers ──────────────────────────────────────
window.saveAxisLimit  = saveAxisLimit;
window.saveAllConfig  = saveAllConfig;
window.resetToDefault = resetToDefault;

// ── Start ─────────────────────────────────────────────────────────────────
loadConfig();