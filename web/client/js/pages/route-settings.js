/* route-settings.js
 * Global origin/destination route setting → /api/route-config
 * Prefixed onto every server-generated report filename (impact/test-run/
 * KM-wise archives + the continuous per-sensor raw_log files).
 */

function displayRouteBadges(cfg) {
    const badges = document.getElementById('routeBadges');
    if (!badges) return;
    badges.innerHTML = (cfg && cfg.origin && cfg.destination)
        ? `<div class="config-badge-item">${cfg.origin} → ${cfg.destination}</div>`
        : `<div class="config-badge-item" style="color:#94a3b8;">No route configured yet — enter station codes and save.</div>`;
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

async function saveRouteConfig() {
    const origin = document.getElementById('originCode').value;
    const destination = document.getElementById('destinationCode').value;
    try {
        const res = await fetch('/api/route-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ origin, destination })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        document.getElementById('originCode').value = data.routeConfig.origin || '';
        document.getElementById('destinationCode').value = data.routeConfig.destination || '';
        displayRouteBadges(data.routeConfig);
        hideError();
        const msg = document.getElementById('successMessage');
        if (msg) { msg.style.display = 'flex'; setTimeout(() => msg.style.display = 'none', 4000); }
    } catch (e) {
        showError(`Save failed: ${e.message}`);
    }
}

async function clearRoute() {
    document.getElementById('originCode').value = '';
    document.getElementById('destinationCode').value = '';
    await saveRouteConfig();
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
window.saveRouteConfig = saveRouteConfig;
window.clearRoute      = clearRoute;

// ── Start ────────────────────────────────────────────────────────────────
loadRouteConfig();
