/* map-content.js — GPS map with real peak event markers from database */

let map, trackLayer, markerLayer;
let allEvents   = [];
let trackPoints = [];
let markerById  = {};

// ── Focus request from Events page (?eventId=&lat=&lng=&date=) ────────────
let pendingFocus = null;
(function readFocusParams() {
    const p = new URLSearchParams(window.location.search);
    const lat = parseFloat(p.get('lat'));
    const lng = parseFloat(p.get('lng'));
    if (!isNaN(lat) && !isNaN(lng)) {
        pendingFocus = {
            eventId: p.get('eventId') != null ? Number(p.get('eventId')) : null,
            lat, lng
        };
    }
})();

// ── Init ─────────────────────────────────────────────────────────────────
function initMap() {
    if (typeof L === 'undefined') { console.error('Leaflet not loaded'); return; }

    map = L.map('mapid', { zoomControl: true }).setView([26.85, 80.93], 11);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);

    trackLayer  = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);

    // Populate date picker with dates that have data
    loadAvailableDates();

    // Default: load today's date, unless a specific event asked for a date
    const urlDate = new URLSearchParams(window.location.search).get('date');
    const today = new Date().toISOString().slice(0, 10);
    const datePicker = document.getElementById('datePicker');
    if (datePicker) datePicker.value = urlDate || today;

    loadMapData();

    // Live socket updates — add new impact markers in real time
    if (window.socket) {
        window.socket.on('new-impact', impact => {
            if (impact.lat && impact.lng && impact.lat !== 0) {
                allEvents.unshift(impact);
                addMarker(impact);
                updateSidebar();
                updateSummaryBadges();
            }
        });
    }
}

// ── Data loading ──────────────────────────────────────────────────────────
async function loadMapData() {
    setStatus('Loading…');
    const severity = document.getElementById('eventTypeFilter')?.value || 'all';
    const date     = document.getElementById('datePicker')?.value || '';

    const evtUrl   = date
        ? `/api/map/events?severity=${severity}&date=${date}`
        : `/api/map/events?severity=${severity}&hours=24`;
    const trackUrl = date
        ? `/api/map/gps-track?date=${date}`
        : `/api/map/gps-track?hours=24`;

    try {
        const [evtRes, trackRes] = await Promise.all([fetch(evtUrl), fetch(trackUrl)]);
        allEvents   = await evtRes.json();
        trackPoints = await trackRes.json();
    } catch (e) {
        console.error('Map data fetch error:', e);
        allEvents   = [];
        trackPoints = [];
    }

    renderAll();
    applyPendingFocus();
    setStatus('');
}

// ── Jump to & open the marker requested by the Events page ────────────────
function applyPendingFocus() {
    if (!pendingFocus) return;
    const focus = pendingFocus;
    pendingFocus = null; // only ever apply once

    let marker = focus.eventId != null ? markerById[focus.eventId] : null;

    if (!marker) {
        // Fall back to nearest marker by coordinates
        let bestId = null, bestDist = Infinity;
        allEvents.forEach(e => {
            if (e.lat == null || e.lng == null) return;
            const d = Math.hypot(e.lat - focus.lat, e.lng - focus.lng);
            if (d < bestDist) { bestDist = d; bestId = e.id; }
        });
        if (bestId != null) marker = markerById[bestId];
    }

    if (marker) {
        map.flyTo(marker.getLatLng(), 17);
        setTimeout(() => marker.openPopup(), 400);
    }
}

// ── Render ────────────────────────────────────────────────────────────────
function renderAll() {
    trackLayer.clearLayers();
    markerLayer.clearLayers();

    drawTrack();
    drawMarkers();
    updateSidebar();
    updateSummaryBadges();
    autoBounds();
}

function drawTrack() {
    if (!trackPoints.length) return;
    const latlngs = trackPoints.map(p => [p.lat, p.lng]);
    L.polyline(latlngs, {
        color: '#3b82f6',
        weight: 3,
        opacity: 0.7
    }).addTo(trackLayer);
}

function drawMarkers() {
    markerById = {};
    const severityFilter = document.getElementById('eventTypeFilter')?.value || 'all';
    const filtered = severityFilter === 'all'
        ? allEvents
        : allEvents.filter(e => e.severity?.toLowerCase() === severityFilter);

    filtered.forEach(addMarker);
}

function addMarker(event) {
    if (!event.lat || !event.lng) return;
    const sev   = (event.severity || 'low').toLowerCase();
    const color = sev === 'high' ? '#ef4444' : sev === 'medium' ? '#d97706' : '#22c55e';
    const r     = sev === 'high' ? 11 : sev === 'medium' ? 8 : 6;

    const ts = event.timestamp
        ? new Date(event.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
        : '—';

    const marker = L.circleMarker([event.lat, event.lng], {
        radius: r, fillColor: color, color: '#fff',
        weight: 2, opacity: 1, fillOpacity: 0.85
    }).addTo(markerLayer);

    marker.bindPopup(`
        <div style="min-width:200px;font-family:sans-serif;font-size:13px;">
            <div style="font-weight:700;font-size:14px;color:${color};margin-bottom:6px;">
                ${(event.severity || 'LOW')} — ${event.p_class || '—'}
            </div>
            <table style="width:100%;border-collapse:collapse;">
                <tr><td style="color:#666;padding:2px 0;">Sensor</td>
                    <td style="font-weight:600">${event.sensor || '—'}</td></tr>
                <tr><td style="color:#666;padding:2px 0;">Peak G</td>
                    <td style="font-weight:600">${Number(event.peak_g || 0).toFixed(3)} g</td></tr>
                <tr><td style="color:#666;padding:2px 0;">gForce</td>
                    <td>${Number(event.g_force || 0).toFixed(3)} g</td></tr>
                <tr><td style="color:#666;padding:2px 0;">RMS-V</td>
                    <td>${Number(event.rms_v || 0).toFixed(3)}</td></tr>
                <tr><td style="color:#666;padding:2px 0;">RMS-L</td>
                    <td>${Number(event.rms_l || 0).toFixed(3)}</td></tr>
                <tr><td style="color:#666;padding:2px 0;">Distance</td>
                    <td>${event.distance_m ? (event.distance_m / 1000).toFixed(3) + ' km' : '—'}</td></tr>
                <tr><td style="color:#666;padding:2px 0;">Time (IST)</td>
                    <td style="font-size:11px;">${ts}</td></tr>
                <tr><td style="color:#666;padding:2px 0;">Location</td>
                    <td style="font-size:11px;">${Number(event.lat).toFixed(5)}°, ${Number(event.lng).toFixed(5)}°</td></tr>
            </table>
        </div>
    `);

    if (event.id != null) markerById[event.id] = marker;
}

// ── Sidebar ───────────────────────────────────────────────────────────────
function updateSidebar() {
    const list = document.getElementById('recentEventsList');
    if (!list) return;
    const top = allEvents.slice(0, 12);
    if (!top.length) { list.innerHTML = '<p style="color:#888;font-size:13px;">No events for this period.</p>'; return; }

    list.innerHTML = top.map(e => {
        const sev = (e.severity || 'low').toLowerCase();
        const ts  = e.timestamp
            ? new Date(e.timestamp).toLocaleString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })
            : '—';
        return `
        <div class="recent-event-item ${sev}" onclick="flyTo(${e.lat},${e.lng})" title="Fly to location">
            <div class="event-time">${ts}</div>
            <div class="event-peak">${Number(e.peak_g || 0).toFixed(2)} g · ${e.sensor || '?'} · ${e.p_class || '—'}</div>
        </div>`;
    }).join('');
}

function updateSummaryBadges() {
    const high   = allEvents.filter(e => e.severity === 'HIGH').length;
    const medium = allEvents.filter(e => e.severity === 'MEDIUM').length;
    const low    = allEvents.filter(e => e.severity === 'LOW').length;

    const el = id => document.getElementById(id);
    if (el('countHigh'))   el('countHigh').textContent   = high;
    if (el('countMedium')) el('countMedium').textContent = medium;
    if (el('countLow'))    el('countLow').textContent    = low;
    if (el('countTotal'))  el('countTotal').textContent  = allEvents.length;
}

// ── Controls ──────────────────────────────────────────────────────────────
function autoBounds() {
    const pts = [
        ...trackPoints.map(p => [p.lat, p.lng]),
        ...allEvents.filter(e => e.lat && e.lng).map(e => [e.lat, e.lng])
    ];
    if (pts.length > 1) {
        try { map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] }); } catch (_) {}
    }
}

function centerMap()   { autoBounds(); }
function refreshMap()  { loadMapData(); }
function flyTo(lat, lng) { map.flyTo([lat, lng], 16); }

function filterMapMarkers() {
    markerLayer.clearLayers();
    drawMarkers();
    updateSidebar();
    updateSummaryBadges();
}

async function loadAvailableDates() {
    try {
        const res  = await fetch('/api/dates-with-data');
        const days = await res.json();
        const sel  = document.getElementById('datePicker');
        if (!sel || !days.length) return;
        // If browser supports datalist, populate it
        const dl = document.getElementById('dateList');
        if (dl) days.forEach(d => { const o = document.createElement('option'); o.value = d; dl.appendChild(o); });
    } catch (_) {}
}

function setStatus(msg) {
    const el = document.getElementById('mapStatus');
    if (el) el.textContent = msg;
}

// ── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const tryInit = setInterval(() => {
        if (typeof L !== 'undefined') { clearInterval(tryInit); initMap(); }
    }, 100);
});

window.filterMapMarkers = filterMapMarkers;
window.centerMap        = centerMap;
window.refreshMap       = refreshMap;
window.flyTo            = flyTo;
window.loadMapData      = loadMapData;
