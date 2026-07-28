/* route-settings.js
 * Global origin/destination route → /api/route-config
 * Global section metadata (Railway/Division/Section/Line/Block/Rail LH-RH) → /api/section-config
 * Both are prefixed/written onto every server-generated report filename and
 * raw_log row.
 */

function displayRouteBadges(cfg) {
    const badges = document.getElementById('routeBadges');
    if (!badges) return;
    badges.innerHTML = (cfg && cfg.origin && cfg.destination)
        ? `<div class="config-badge-item">${cfg.origin} → ${cfg.destination}</div>`
        : `<div class="config-badge-item" style="color:#94a3b8;">No route configured yet — enter station codes and save.</div>`;
}

function displaySectionBadges(cfg) {
    const badges = document.getElementById('sectionBadges');
    if (!badges) return;
    const parts = cfg ? [cfg.railway, cfg.division, cfg.section, cfg.line].filter(Boolean) : [];
    badges.innerHTML = parts.length
        ? `<div class="config-badge-item">${parts.join(' / ')}</div>`
        : `<div class="config-badge-item" style="color:#94a3b8;">No section metadata configured yet.</div>`;
}

async function loadRouteConfig() {
    try {
        const res = await fetch('/api/route-config');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const cfg = await res.json();
        document.getElementById('originCode').value = cfg.origin || '';
        document.getElementById('destinationCode').value = cfg.destination || '';
        displayRouteBadges(cfg);
    } catch (e) {
        console.warn('[route] Could not load config:', e.message);
        showError('Could not load route config from server. Is the server running?');
    }
}

async function loadSectionConfig() {
    try {
        const res = await fetch('/api/section-config');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const cfg = await res.json();
        document.getElementById('railwayName').value = cfg.railway || '';
        document.getElementById('divisionCode').value = cfg.divisionCode || '';
        document.getElementById('divisionName').value = cfg.division || '';
        document.getElementById('sectionCode').value = cfg.section || '';
        document.getElementById('lineCode').value = cfg.line || '';
        document.getElementById('blockCode').value = cfg.block || '';
        document.getElementById('railLH').value = cfg.railLH || '';
        document.getElementById('railRH').value = cfg.railRH || '';
        displaySectionBadges(cfg);
    } catch (e) {
        console.warn('[section] Could not load config:', e.message);
        showError('Could not load section metadata from server. Is the server running?');
    }
}

async function saveAllConfig() {
    const origin = document.getElementById('originCode').value;
    const destination = document.getElementById('destinationCode').value;
    const railway = document.getElementById('railwayName').value;
    const divisionCode = document.getElementById('divisionCode').value;
    const division = document.getElementById('divisionName').value;
    const section = document.getElementById('sectionCode').value;
    const line = document.getElementById('lineCode').value;
    const block = document.getElementById('blockCode').value;
    const railLH = document.getElementById('railLH').value;
    const railRH = document.getElementById('railRH').value;

    try {
        const routeRes = await fetch('/api/route-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ origin, destination })
        });
        if (!routeRes.ok) throw new Error(`HTTP ${routeRes.status}`);
        const routeData = await routeRes.json();
        document.getElementById('originCode').value = routeData.routeConfig.origin || '';
        document.getElementById('destinationCode').value = routeData.routeConfig.destination || '';
        displayRouteBadges(routeData.routeConfig);

        const sectionRes = await fetch('/api/section-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ railway, divisionCode, division, section, line, block, railLH, railRH })
        });
        if (!sectionRes.ok) throw new Error(`HTTP ${sectionRes.status}`);
        const sectionData = await sectionRes.json();
        displaySectionBadges(sectionData.sectionConfig);

        hideError();
        const msg = document.getElementById('successMessage');
        if (msg) { msg.style.display = 'flex'; setTimeout(() => msg.style.display = 'none', 4000); }
    } catch (e) {
        showError(`Save failed: ${e.message}`);
    }
}

async function clearAll() {
    ['originCode', 'destinationCode', 'railwayName', 'divisionCode', 'divisionName',
     'sectionCode', 'lineCode', 'blockCode', 'railLH', 'railRH'].forEach(id => {
        document.getElementById(id).value = '';
    });
    await saveAllConfig();
}

// ── Error display ──────────────────────────────────────────────────────────
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

// ── Expose to HTML onclick handlers ─────────────────────────────────────────
window.saveAllConfig = saveAllConfig;
window.clearAll      = clearAll;

// ── Start ────────────────────────────────────────────────────────────────
loadRouteConfig();
loadSectionConfig();
