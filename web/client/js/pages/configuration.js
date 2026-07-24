/* configuration.js
 * Axle thresholds  → /api/thresholds        (unchanged shape, other pages still work)
 * Pivot thresholds → /api/thresholds/pivot  (new — pivot classified separately)
 * Axis limits (X/Y/Z) replace the old single "peak limit" list — stored locally.
 */

let axisLimits = { x: [], y: [], z: [] };

const AXIS_LIMIT_KEYS = { x: 'railmonitor_limits_x', y: 'railmonitor_limits_y', z: 'railmonitor_limits_z' };
const DEFAULT_AXIS_LIMITS = [2, 4, 6, 8, 10, 15, 20];

function loadAxisLimits(axis) {
    try {
        const saved = localStorage.getItem(AXIS_LIMIT_KEYS[axis]);
        return saved ? JSON.parse(saved) : [...DEFAULT_AXIS_LIMITS];
    } catch (e) { return [...DEFAULT_AXIS_LIMITS]; }
}
function saveAxisLimits(axis, arr) {
    localStorage.setItem(AXIS_LIMIT_KEYS[axis], JSON.stringify(arr));
}

// ── Boot: fetch axle + pivot thresholds from server, populate inputs ──────
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

    axisLimits.x = loadAxisLimits('x');
    axisLimits.y = loadAxisLimits('y');
    axisLimits.z = loadAxisLimits('z');

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
    displayAxisLimits('x');
    displayAxisLimits('y');
    displayAxisLimits('z');
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

function displayAxisLimits(axis) {
    const c = document.getElementById(`limitsContainer${axis.toUpperCase()}`);
    if (!c) return;
    c.innerHTML = axisLimits[axis].map(l => `
        <div class="limit-tag">
            <span>${l}g</span>
            <button onclick="removeAxisLimit('${axis}', ${l})" title="Remove">&times;</button>
        </div>`).join('');
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

// ── Axis limit management (X / Y / Z) ──────────────────────────────────────
function addAxisLimit(axis) {
    const input = document.getElementById(`newLimit${axis.toUpperCase()}`);
    const v     = parseFloat(input.value);
    if (isNaN(v) || v <= 0)              { showError(`Enter a valid ${axis.toUpperCase()}-axis limit`); return; }
    if (axisLimits[axis].includes(v))    { showError('This limit already exists'); return; }
    axisLimits[axis].push(v);
    axisLimits[axis].sort((a,b) => a-b);
    displayAxisLimits(axis);
    input.value = '';
    hideError();
}

function removeAxisLimit(axis, limit) {
    if (axisLimits[axis].length <= 1) { showError(`Must have at least one ${axis.toUpperCase()}-axis limit`); return; }
    axisLimits[axis] = axisLimits[axis].filter(l => l !== limit);
    displayAxisLimits(axis);
    hideError();
}

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

// ── Save ──────────────────────────────────────────────────────────────────
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

    saveAxisLimits('x', axisLimits.x);
    saveAxisLimits('y', axisLimits.y);
    saveAxisLimits('z', axisLimits.z);

    hideError();
    const msg = document.getElementById('successMessage');
    if (msg) { msg.style.display = 'flex'; setTimeout(() => msg.style.display = 'none', 4000); }
}

// ── Clear ─────────────────────────────────────────────────────────────────
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

        axisLimits = { x: [...DEFAULT_AXIS_LIMITS], y: [...DEFAULT_AXIS_LIMITS], z: [...DEFAULT_AXIS_LIMITS] };
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

// ── Expose to HTML onclick handlers ──────────────────────────────────────
window.addAxisLimit    = addAxisLimit;
window.removeAxisLimit = removeAxisLimit;
window.saveAllConfig   = saveAllConfig;
window.resetToDefault  = resetToDefault;

// ── Start ─────────────────────────────────────────────────────────────────
loadConfig();