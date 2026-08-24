/* configuration.js
 * Axle thresholds   → /api/thresholds        (unchanged shape, other pages still work)
 * Pivot thresholds  → /api/thresholds/pivot  (pivot classified separately)
 * Axis limits (X/Y/Z) — P1/P2/P3 g-band values per axis per unit (generic/a1/a2),
 * server-backed via /api/axis-limits. Same semantics as the threshold endpoints:
 * a reading whose |value| >= the configured band value crosses that band.
 * Saving one unit's X/Y/Z sends one POST per axis/band combo that has a value
 * entered; Reset deletes every saved value and the server falls back to its
 * 2g default for every band.
 */

const AXES = ['x', 'y', 'z'];
const BANDS = ['p1', 'p2', 'p3'];
const AXIS_UNIT_PREFIX = { generic: 'Gen', a1: 'A1', a2: 'A2' };

// axisLimitsData mirrors the server shape exactly:
// { generic:{x:{p1,p2,p3}, y:{...}, z:{...}}, a1:{...}, a2:{...} }
// — each band leaf is a single number (or null if somehow unset).
function emptyBand() { return { p1: null, p2: null, p3: null }; }
let axisLimitsData = {
    generic: { x: emptyBand(), y: emptyBand(), z: emptyBand() },
    a1:      { x: emptyBand(), y: emptyBand(), z: emptyBand() },
    a2:      { x: emptyBand(), y: emptyBand(), z: emptyBand() }
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

// ── Axis Limits — P1/P2/P3 g-bands per axis per unit ────────────────────────
// Populates the X/Y/Z P1/P2/P3 inputs + "Current" labels for one unit from
// axisLimitsData (called on load and whenever the server pushes an update).
function displayAxisLimitUnit(unit) {
    const prefix = AXIS_UNIT_PREFIX[unit];
    AXES.forEach(axis => {
        const axisData = (axisLimitsData[unit] && axisLimitsData[unit][axis]) || {};
        BANDS.forEach(band => {
            const input = document.getElementById(`axisLimit${prefix}${axis.toUpperCase()}${band.toUpperCase()}`);
            const v = axisData[band];
            if (input && document.activeElement !== input) input.value = v ?? '';
        });
        const current = document.getElementById(`axisLimit${prefix}${axis.toUpperCase()}Current`);
        if (current) {
            const parts = BANDS.filter(b => axisData[b] != null).map(b => `${b.toUpperCase()}:${axisData[b]}g`);
            if (parts.length) { current.textContent = `Current: ${parts.join(' · ')}`; current.classList.add('set'); }
            else               { current.textContent = 'Current: —'; current.classList.remove('set'); }
        }
    });
}

// Reads the P1/P2/P3 inputs for all three axes of one unit and POSTs each
// axis/band combo that has a valid positive value entered. Mirrors
// /api/thresholds's "one object per Save click" pattern rather than the old
// per-keystroke Add/Remove. Bands left blank simply keep their previously
// saved value — save is never blocked by missing/null fields, only by an
// explicitly-entered invalid one (e.g. negative or non-numeric).
async function saveAxisLimit(unit) {
    const prefix = AXIS_UNIT_PREFIX[unit];
    const updates = []; // { axis, band, value }

    for (const axis of AXES) {
        for (const band of BANDS) {
            const input = document.getElementById(`axisLimit${prefix}${axis.toUpperCase()}${band.toUpperCase()}`);
            const raw   = input ? input.value.trim() : '';
            if (raw === '') continue; // leave that band's saved value untouched — not an error
            const v = parseFloat(raw);
            if (isNaN(v) || v <= 0) { showError(`Enter a valid positive ${axis.toUpperCase()}-axis ${band.toUpperCase()} value`); return; }
            updates.push({ axis, band, value: v });
        }
    }

    // Nothing entered this click — not an error, just nothing to do.
    if (!updates.length) { hideError(); return; }

    try {
        for (const { axis, band, value } of updates) {
            const res  = await fetch('/api/axis-limits', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ unit, axis, band, value })
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
// their own "Save … Limits" button next to each unit's inputs. Called by
// the page's combined saveAllConfig() below, alongside sampling/bandpass. ─
async function saveThresholdConfig() {
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
// falling the latter back to the server's 2g default for every band. ──────
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

        // Deletes every user-saved axis limit — server resets each band to 2g
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

// ── Sampling & Bandpass Configuration (merged in from the old standalone
// Sampling Frequency page) — Sample Distance, per-sensor bandpass filter
// low/high Hz, and ODR (sampling frequency) for Left (accel1) and Pivot
// (accel3). Right (accel2) only has a bandpass filter in this layout —
// its ODR is still set server-side via /api/odr-config's accel2 key, just
// not exposed as a control here since nothing in the source screenshot
// showed one for the middle sensor. ─────────────────────────────────────
const SAMPLING_RATES_HZ = [50, 100, 200];

function populateSamplingSelect(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = SAMPLING_RATES_HZ.map(hz => `<option value="${hz}">${hz}</option>`).join('');
}

async function loadSamplingBandpassConfig() {
    populateSamplingSelect(document.getElementById('a1-sf'));
    populateSamplingSelect(document.getElementById('a3-sf'));

    try {
        const res = await fetch('/api/odr-config');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const odr = await res.json();
        if (odr.accel1 && document.getElementById('a1-sf')) document.getElementById('a1-sf').value = odr.accel1;
        if (odr.accel3 && document.getElementById('a3-sf')) document.getElementById('a3-sf').value = odr.accel3;
    } catch (e) {
        console.warn('[config] Could not load ODR config:', e.message);
    }

    try {
        const res = await fetch('/api/limits-config');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const cfg = await res.json();

        if (cfg.sampleDistanceMm != null) {
            const el = document.getElementById('sampleDistance');
            if (el) el.value = cfg.sampleDistanceMm;
        }

        const bp = cfg.bandpass;
        if (bp) {
            const setBp = (prefix, key) => {
                const lowEl  = document.getElementById(`${prefix}-low`);
                const highEl = document.getElementById(`${prefix}-high`);
                if (lowEl  && bp[key]?.low  != null) lowEl.value  = bp[key].low;
                if (highEl && bp[key]?.high != null) highEl.value = bp[key].high;
            };
            setBp('a1', 'accel1');
            setBp('a2', 'accel2');
            setBp('a3', 'accel3');
        }

        const uml = cfg.uml;
        if (uml) {
            const setUml = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
            setUml('uml-a1-vert-low',  uml.accel1?.vert?.low);
            setUml('uml-a1-vert-high', uml.accel1?.vert?.high);
            setUml('uml-a1-lat-low',   uml.accel1?.lat?.low);
            setUml('uml-a1-lat-high',  uml.accel1?.lat?.high);
            setUml('uml-a2-vert-low',  uml.accel2?.vert?.low);
            setUml('uml-a2-vert-high', uml.accel2?.vert?.high);
            setUml('uml-a2-lat-low',   uml.accel2?.lat?.low);
            setUml('uml-a2-lat-high',  uml.accel2?.lat?.high);
        }
    } catch (e) {
        console.warn('[config] Could not load limits-config:', e.message);
    }
}

function numOrNull(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const v = el.value.trim();
    return v === '' ? null : Number(v);
}

// Saves Sample Distance + bandpass (all 3 sensors) + ODR (accel1/accel3) +
// UML (accel1/accel2). Called from the same "Save Configuration" button as
// the threshold/axis-limit save, so one click persists everything on this page.
async function saveSamplingBandpassConfig() {
    try {
        const odrRes = await fetch('/api/odr-config', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                accel1: numOrNull('a1-sf') || undefined,
                accel3: numOrNull('a3-sf') || undefined,
            }),
        });
        if (!odrRes.ok) throw new Error(`HTTP ${odrRes.status} on /api/odr-config`);

        const bandpass = {
            accel1: { low: numOrNull('a1-low'), high: numOrNull('a1-high') },
            accel2: { low: numOrNull('a2-low'), high: numOrNull('a2-high') },
            accel3: { low: numOrNull('a3-low'), high: numOrNull('a3-high') },
        };
        const uml = {
            accel1: {
                vert: { low: numOrNull('uml-a1-vert-low'), high: numOrNull('uml-a1-vert-high') },
                lat:  { low: numOrNull('uml-a1-lat-low'),  high: numOrNull('uml-a1-lat-high')  },
            },
            accel2: {
                vert: { low: numOrNull('uml-a2-vert-low'), high: numOrNull('uml-a2-vert-high') },
                lat:  { low: numOrNull('uml-a2-lat-low'),  high: numOrNull('uml-a2-lat-high')  },
            },
        };
        const limRes = await fetch('/api/limits-config', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ bandpass, uml, sampleDistanceMm: numOrNull('sampleDistance') }),
        });
        if (!limRes.ok) throw new Error(`HTTP ${limRes.status} on /api/limits-config`);
    } catch (e) {
        showError(`Could not save sampling/bandpass configuration: ${e.message}`);
        throw e;
    }
}

// ── Combined save — one "Save Configuration" button now persists
// thresholds, axis limits' own buttons aside, plus sampling/bandpass/UML. ──
async function saveAllConfig() {
    await saveSamplingBandpassConfig();
    await saveThresholdConfig();
}

// ── Expose to HTML onclick handlers ──────────────────────────────────────
window.saveAxisLimit  = saveAxisLimit;
window.resetToDefault = resetToDefault;
window.saveAllConfig  = saveAllConfig;

// ── Start ─────────────────────────────────────────────────────────────────
loadConfig();
loadSamplingBandpassConfig();