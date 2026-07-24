/* acceleration-km.js – Frontend‑side KM report computation with proper historical KM indexing */

'use strict';

const POLL_MS = 5000;
const RECORDS_PER_BLOCK = 50;
const BLOCKS_PER_KM = 7;
const RECORDS_PER_KM = RECORDS_PER_BLOCK * BLOCKS_PER_KM;

function getRecordsPerKm() {
    if (typeof AccelConfig === 'undefined') return RECORDS_PER_KM;
    const avg = (AccelConfig.getOdr(1) + AccelConfig.getOdr(2)) / 2;
    return Math.max(Math.round(RECORDS_PER_KM / Math.round(200 / avg)), 1);
}

let isLive = false;
let lastCard = null;
let allDocs = [];
let todayDocs = [];
let lastFetchTime = 0;
let limitsConfig = null;   // loaded from /api/limits-config


// Tab / Section toggle
let activeSections = { blocks: true, peakDist: false, worstPeaks: false };

function toggleSection(section) {
    const map = {
        blocks:     { chk: 'blocksCheck',     tab: 'blocksTab'     },
        peakDist:   { chk: 'peakDistCheck',   tab: 'peakDistTab'   },
        worstPeaks: { chk: 'worstPeaksCheck', tab: 'worstPeaksTab' },
    };
    const { chk, tab } = map[section];
    const el = document.getElementById(chk);
    if (!el) return;
    el.checked = !el.checked;
    activeSections[section] = el.checked;
    document.getElementById(tab)?.classList.toggle('active', el.checked);
    if (lastCard) renderCard(lastCard);
}
window.toggleSection = toggleSection;

// Format helpers
function fmt(v, d = 2)  { return (v == null || isNaN(v)) ? '—' : (+v).toFixed(d); }
function rmsClass(v) {
    if (v == null) return '';
    if (v >= 0.55) return 'value-high';
    if (v >= 0.40) return 'value-medium';
    return '';
}
function peakClass(v) {
    if (v == null) return '';
    if (v >= 10) return 'value-high';
    if (v >= 5)  return 'value-medium';
    return 'value-low';
}

// ─── Computation helpers ───────────────────────────────────────────────
function avg(arr) {
    const valid = arr.filter(v => v != null && !isNaN(v));
    return valid.length ? valid.reduce((s, x) => s + x, 0) / valid.length : null;
}
function computeBlock(docs, blkIdx) {
    const left  = docs.filter(d => d.device_id === 'left');
    const right = docs.filter(d => d.device_id === 'right');
    const pivot = docs.filter(d => d.device_id === 'pivot');
    const pick  = (arr, f) => arr.map(d => d[f]).filter(v => v != null);
    return {
        label: `BLK${blkIdx + 1}`,
        left: {
            rmsV: avg(pick(left, 'rmsV')),
            rmsL: avg(pick(left, 'rmsL')),
            sdV:  avg(pick(left, 'sdV')),
            sdL:  avg(pick(left, 'sdL')),
        },
        right: {
            rmsV: avg(pick(right, 'rmsV')),
            rmsL: avg(pick(right, 'rmsL')),
            sdV:  avg(pick(right, 'sdV')),
            sdL:  avg(pick(right, 'sdL')),
        },
        pivot: {
            rmsV: avg(pick(pivot, 'rmsV')),
            rmsL: avg(pick(pivot, 'rmsL')),
            sdV:  avg(pick(pivot, 'sdV')),
            sdL:  avg(pick(pivot, 'sdL')),
        }
    };
}

// ─── Limits config ───────────────────────────────────────────────────────────
async function loadLimitsConfig() {
    try {
        const res = await fetch('/api/limits-config');
        if (!res.ok) return;
        limitsConfig = await res.json();
        console.log('[km] Limits config loaded:', limitsConfig);
    } catch (e) {
        console.warn('[km] Could not load limits config:', e.message);
    }
}

// Returns { p1, p2, p3 } thresholds for a given side+axis from LC config.
// Falls back to hardcoded values if not configured.
function getLCPeakThresholds(side, axis) {
   const accelKey = side === 'right' ? 'accel2' : side === 'pivot' ? 'accel3' : 'accel1';
    const axisKey  = axis === 'V'     ? 'vert'   : 'lat';
    const lc = limitsConfig?.limitClass?.[accelKey]?.[axisKey]?.peak;
    if (lc?.p1 != null && lc?.p2 != null && lc?.p3 != null) return lc;
    return { p1: 5, p2: 10, p3: 20 };
}


function computePeakDist(docs) {
    const out = {
        left:  { V: { P1:0, P2:0, P3:0 }, L: { P1:0, P2:0, P3:0 } },
        right: { V: { P1:0, P2:0, P3:0 }, L: { P1:0, P2:0, P3:0 } },
        pivot: { V: { P1:0, P2:0, P3:0 }, L: { P1:0, P2:0, P3:0 } }
        
    };
    // Classify a value against { p1, p2, p3 } thresholds from LC config (or fallback)
    const getPClass = (g, thresholds) => {
        if (g == null || isNaN(g)) return null;
        const v = Math.abs(g);
        if (v >= +thresholds.p3) return 'P3';
        if (v >= +thresholds.p2) return 'P2';
        if (v >= +thresholds.p1) return 'P1';
        return null;
    };
    for (const d of docs) {
        const side = d.device_id === 'right' ? 'right' : (d.device_id === 'pivot' ? 'pivot' : 'left');
        const pV = getPClass(d.z_axis, getLCPeakThresholds(side, 'V'));
        const pL = getPClass(d.x_axis, getLCPeakThresholds(side, 'L'));
        if (pV) out[side].V[pV]++;
        if (pL) out[side].L[pL]++;
    }
    return out;
}

function computeWorstPeaks(docs) {
    const b = { 'L-LAT': [], 'L-VERT': [], 'R-LAT': [], 'R-VERT': [], 'P-LAT': [], 'P-VERT': [] };
    for (const d of docs) {
        const side = d.device_id === 'right' ? 'right' : (d.device_id === 'pivot' ? 'pivot' : 'left');
        const vert = d.z_axis != null ? Math.abs(d.z_axis) : null;
        const lat  = d.x_axis != null ? Math.abs(d.x_axis) : null;
        if (side === 'left') {
            if (vert != null) b['L-VERT'].push(vert);
            if (lat != null)  b['L-LAT'].push(lat);
        } else if (side === 'right') {
            if (vert != null) b['R-VERT'].push(vert);
            if (lat != null)  b['R-LAT'].push(lat);
        } else if (side === 'pivot') {
            if (vert != null) b['P-VERT'].push(vert);
            if (lat != null)  b['P-LAT'].push(lat);
        }
    }
    const top10 = arr => arr.sort((a,b)=>b-a).slice(0,10).map(v=>+v.toFixed(1));
    return {
        'L-LAT':  top10(b['L-LAT']),
        'L-VERT': top10(b['L-VERT']),
        'R-LAT':  top10(b['R-LAT']),
        'R-VERT': top10(b['R-VERT']),
        'P-LAT':  top10(b['P-LAT']),
        'P-VERT': top10(b['P-VERT']),
    };
}

function buildCard(docs, kmIndex, hwLive) {
    const RECORDS_PER_KM = getRecordsPerKm(); // shadows outer const — ODR-adjusted
    const isPartial = docs.length < RECORDS_PER_KM;
    const doneBlocks = Math.floor(docs.length / RECORDS_PER_BLOCK);
    const blocks = [];
    for (let b = 0; b < BLOCKS_PER_KM; b++) {
        if (b < doneBlocks) {
            const start = b * RECORDS_PER_BLOCK;
            const end   = start + RECORDS_PER_BLOCK;
            blocks.push(computeBlock(docs.slice(start, end), b));
        } else if (hwLive) {
            blocks.push({ label: `BLK${b+1}`, pending: true });
        } else {
            const empty = { rmsV: null, rmsL: null, sdV: null, sdL: null };
            blocks.push({ label: `BLK${b+1}`, left: empty, right: empty, pivot: empty });
        }
    }
    return {
        kmFrom:        kmIndex,
        kmTo:          kmIndex + 1,
        recordsSoFar:  docs.length,
        isPartial,
        lastTimestamp: docs[docs.length-1]?.timestamp ?? null,
        blocks,
        peakDist:      computePeakDist(docs),
        worstPeaks:    computeWorstPeaks(docs),
    };
}

// ─── Render functions (unchanged) ───────────────────────────────────────────
function renderBlocksTable(blocks) {
    if (!blocks?.length) return '<p class="no-data">No block data yet.</p>';
    const rows = blocks.map(blk => {
        if (blk.pending) {
            return `<tr class="pending-row">
                <td>${blk.label}</td>
                <td colspan="8" style="color:#94a3b8;font-style:italic;font-size:11px">Collecting…</td>
            </tr>`;
        }
        const l = blk.left || {}, r = blk.right || {}, p = blk.pivot || {};
        return `<tr>
            <td>${blk.label}</td>
            <td class="${rmsClass(l.rmsV)}">${fmt(l.rmsV)}</td>
            <td class="${rmsClass(l.rmsL)}">${fmt(l.rmsL)}</td>
            <td class="sd-value">${fmt(l.sdV,3)}</td>
            <td class="sd-value">${fmt(l.sdL,3)}</td>
            <td class="${rmsClass(r.rmsV)}">${fmt(r.rmsV)}</td>
            <td class="${rmsClass(r.rmsL)}">${fmt(r.rmsL)}</td>
            <td class="sd-value">${fmt(r.sdV,3)}</td>
            <td class="sd-value">${fmt(r.sdL,3)}</td>
            <td class="${rmsClass(p.rmsV)}">${fmt(p.rmsV)}</td>
            <td class="${rmsClass(p.rmsL)}">${fmt(p.rmsL)}</td>
            <td class="sd-value">${fmt(p.sdV,3)}</td>
            <td class="sd-value">${fmt(p.sdL,3)}</td>
        </tr>`;
    }).join('');
    return `<div class="table-container">
        <table>
            <thead>
                <tr><th rowspan="3">LOC</th><th colspan="4">LEFT</th><th colspan="4">RIGHT</th><th colspan="4">PIVOT</th></tr>
                <tr><th colspan="2">RMS</th><th colspan="2">SD</th><th colspan="2">RMS</th><th colspan="2">SD</th><th colspan="2">RMS</th><th colspan="2">SD</th></tr>
                <tr><th>V</th><th>L</th><th>V</th><th>L</th><th>V</th><th>L</th><th>V</th><th>L</th></tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
}

function renderPeakDistTable(peakDist) {
    if (!peakDist) return '<p class="no-data">No distribution data yet.</p>';
    const l = peakDist.left, r = peakDist.right, p = peakDist.pivot || { V:{}, L:{} };

    // Show which thresholds are driving the classification
    const lcConfigured = limitsConfig?.limitClass != null;
    const thresholdNote = lcConfigured
        ? (() => {
            const t = getLCPeakThresholds('left', 'V');   // representative row
            return `<div style="font-size:10px;color:#64748b;margin-bottom:6px;font-style:italic;">
                Using LC thresholds — P1 ≥ ${t.p1}g &nbsp;·&nbsp; P2 ≥ ${t.p2}g &nbsp;·&nbsp; P3 ≥ ${t.p3}g
                <span style="color:#94a3b8">(per axis — hover row for details)</span>
            </div>`;
          })()
        : `<div style="font-size:10px;color:#c2410c;margin-bottom:6px;font-style:italic;">
               ⚠ Limit Class not configured — using defaults (P1≥5g, P2≥10g, P3≥20g).
               <a href="sampling-frequency.html" style="color:#c2410c;">Configure →</a>
           </div>`;

    const bandRow = band => {
        const cls = band.toLowerCase();
        // Per-axis thresholds for tooltip
        const tip = (side, axis) => {
            const t = getLCPeakThresholds(side, axis);
            return `${band} ≥ ${t[band.toLowerCase()]}g`;
        };
        return `<tr>
            <td><span class="badge badge-${cls}">${band}</span></td>
            <td class="count-badge count-${cls}" title="${tip('left','V')}">${l.V[band]||0}</td>
            <td class="count-badge count-${cls}" title="${tip('left','L')}">${l.L[band]||0}</td>
            <td class="count-badge count-${cls}" title="${tip('right','V')}">${r.V[band]||0}</td>
            <td class="count-badge count-${cls}" title="${tip('right','L')}">${r.L[band]||0}</td>
            <td class="count-badge count-${cls}" title="${tip('pivot','V')}">${p.V[band]||0}</td>
            <td class="count-badge count-${cls}" title="${tip('pivot','L')}">${p.L[band]||0}</td>
        </tr>`;
    };
    return `<div class="table-container">
        ${thresholdNote}
        <table>
            <thead><tr><th rowspan="2">BANDS</th><th colspan="2">LEFT</th><th colspan="2">RIGHT</th><th colspan="2">PIVOT</th></tr>
            <tr><th>V</th><th>L</th><th>V</th><th>L</th><th>V</th><th>L</th></tr></thead>
            <tbody>${bandRow('P1')}${bandRow('P2')}${bandRow('P3')}</tbody>
        </table>
    </div>`;
}

function renderWorstPeaksTable(worstPeaks) {
    if (!worstPeaks) return '<p class="no-data">No peak data yet.</p>';

    const params = ['L-LAT', 'L-VERT', 'R-LAT', 'R-VERT', 'P-LAT', 'P-VERT'];

    const rows = params.map(param => {
        const vals = worstPeaks[param] || [];
        const cells = Array.from({length: 10}, (_, i) => {
            const v = vals[i];
            return v == null 
                ? `<td class="peak-meter">—</td>` 
                : `<td class="peak-meter ${peakClass(v)}">${fmt(v, 1)}</td>`;
        }).join('');

        return `<tr>
            <td><strong>${param}</strong></td>
            ${cells}
        </tr>`;
    }).join('');

    return `
    <div class="table-container worst-peaks-table">
        <table>
            <thead>
                <tr>
                    <th>Parameter</th>
                    <th>1</th><th>2</th><th>3</th><th>4</th><th>5</th>
                    <th>6</th><th>7</th><th>8</th><th>9</th><th>10</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
}

function renderCard(data) {
    const container = document.getElementById('km-container');
    if (!container) return;
    const bD = activeSections.blocks     ? 'block' : 'none';
    const pD = activeSections.peakDist   ? 'block' : 'none';
    const wD = activeSections.worstPeaks ? 'block' : 'none';
    const updatedStr = data.lastTimestamp ? new Date(data.lastTimestamp).toLocaleTimeString() : 'Just now';

    let badge = '';
    if (data.historical) {
        badge = `<span class="historical-badge"><i class="fas fa-history"></i> Last Session</span>`;
    } else if (data.isPartial && isLive) {
        badge = `<span class="live-badge"><i class="fas fa-circle blink"></i> LIVE &nbsp;<span style="font-size:11px">${data.recordsSoFar}/${RECORDS_PER_KM}</span></span>`;
    }

    container.innerHTML = `
    <div class="km-block${data.isPartial && isLive ? ' km-live' : ''}">
        <div class="km-header">
            <div class="km-header-left">
                <span><i class="fas fa-map-pin"></i> Km From: ${data.kmFrom}</span>
                <span><i class="fas fa-map-pin"></i> Km To: ${data.kmTo}</span>
                ${badge}
            </div>
            <div class="km-header-right">
                <i class="fas fa-clock"></i> Updated: ${updatedStr}
            </div>
        </div>
        <div class="section" style="display:${bD}">
            <div class="section-title"><i class="fas fa-cubes"></i> Blocks</div>
            ${renderBlocksTable(data.blocks)}
        </div>
        <div class="section" style="display:${pD}">
            <div class="section-title"><i class="fas fa-chart-pie"></i> Peak Distribution</div>
            ${renderPeakDistTable(data.peakDist)}
        </div>
        <div class="section" style="display:${wD}">
            <div class="section-title"><i class="fas fa-chart-line"></i> Worst Peaks</div>
            ${renderWorstPeaksTable(data.worstPeaks)}
        </div>
    </div>`;
}

// ─── Status helpers ─────────────────────────────────────────────────────────
function setStatus(live) {
    isLive = live;
    const dot    = document.getElementById('hw-status');
    const label  = document.getElementById('hw-status-label');
    const banner = document.getElementById('offline-banner');
    if (dot)    dot.className        = live ? 'status-dot live' : 'status-dot offline';
    if (label)  label.textContent    = live ? 'Live' : 'Offline';
    if (banner) banner.style.display = live ? 'none' : 'flex';
}

function setToolbarCount(n) {
    const el = document.querySelector('.toolbar-label');
    if (el) el.textContent = `Recorded Accelerations Km (${n})`;
}

// ─── Data processing ────────────────────────────────────────────────────────
function getTodayStart() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function isSameDate(timestamp, dateStr) {
    return timestamp.startsWith(dateStr);
}

async function fetchRawData() {
    try {
        const res = await fetch('/api/monitoring/all');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        data.sort((a,b) => a.timestamp.localeCompare(b.timestamp));
        return data;
    } catch (err) {
        console.error('[km] fetch raw error:', err);
        return [];
    }
}

async function fetchLiveStatus() {
    try {
        const res = await fetch('/api/realtime/status');
        const data = await res.json();
        return data.receiving_data === true;
    } catch (err) {
        return false;
    }
}

async function updateReport() {
    const RECORDS_PER_KM = getRecordsPerKm();
    // 0. Fetch limits config (keeps peak distribution in sync with configuration page)
    await loadLimitsConfig();
    // 1. Fetch raw data
    allDocs = await fetchRawData();
    if (!allDocs.length) {
        document.getElementById('km-container').innerHTML = `
            <div class="no-data-banner">
                <i class="fas fa-satellite-dish"></i>
                <p>No records in database yet.</p>
                <p style="color:#94a3b8;font-size:12px">Connect hardware to begin.</p>
            </div>`;
        setStatus(false);
        return;
    }

    // 2. Determine today's date and filter today's docs
    const todayStart = getTodayStart();
    todayDocs = allDocs.filter(d => isSameDate(d.timestamp, todayStart));
    const hasTodayData = todayDocs.length > 0;

    // 3. Fetch hardware liveness
    const hwLive = await fetchLiveStatus();

    let sessionDocs, historical, kmIndexOffset;

    if (hasTodayData) {
        // Use today's data for live session
        sessionDocs = todayDocs;
        historical = false;
        // km index is based on the number of complete KMs already built from today's data
        const completedKms = Math.floor(sessionDocs.length / RECORDS_PER_KM);
        if (hwLive) {
            // Show current in-progress KM (index = completedKms)
            const partialStart = completedKms * RECORDS_PER_KM;
            const partialDocs = sessionDocs.slice(partialStart);
            const card = buildCard(partialDocs, completedKms, true);
            card.historical = false;
            setStatus(hwLive);
            setToolbarCount(completedKms);
            lastCard = card;
            renderCard(card);
        } else {
            // Offline but today has data: show last completed KM if any, else show partial
            if (completedKms > 0) {
                const lastKmStart = (completedKms - 1) * RECORDS_PER_KM;
                const lastKmDocs = sessionDocs.slice(lastKmStart, lastKmStart + RECORDS_PER_KM);
                const card = buildCard(lastKmDocs, completedKms - 1, false);
                card.historical = false;
                setStatus(hwLive);
                setToolbarCount(completedKms);
                lastCard = card;
                renderCard(card);
            } else {
                // No complete KM – show partial data without "Collecting…"
                const card = buildCard(sessionDocs, 0, false);
                card.historical = false;
                setStatus(hwLive);
                setToolbarCount(0);
                lastCard = card;
                renderCard(card);
            }
        }
        return;
    }

    // 4. No data today → fallback to the most recent date that has data
    // Find the date of the last record in the whole database
    const lastDoc = allDocs[allDocs.length - 1];
    const lastDate = lastDoc.timestamp.slice(0, 10);
    const prevDayDocs = allDocs.filter(d => isSameDate(d.timestamp, lastDate));
    const totalPrevRecords = prevDayDocs.length;
    const completedKmsPrev = Math.floor(totalPrevRecords / RECORDS_PER_KM);

    if (completedKmsPrev > 0) {
        // Take the last completed KM from that day
        const startIdx = (completedKmsPrev - 1) * RECORDS_PER_KM;
        const endIdx = completedKmsPrev * RECORDS_PER_KM;
        const lastKmDocs = prevDayDocs.slice(startIdx, endIdx);
        const card = buildCard(lastKmDocs, completedKmsPrev - 1, false);
        card.historical = true;
        setStatus(hwLive);
        setToolbarCount(completedKmsPrev);
        lastCard = card;
        renderCard(card);
    } else {
        // The most recent day has fewer than 350 records – show its partial card (0→1)
        const card = buildCard(prevDayDocs, 0, false);
        card.historical = true;
        setStatus(hwLive);
        setToolbarCount(0);
        lastCard = card;
        renderCard(card);
    }
}

// ─── CSV Export (today's data only) ─────────────────────────────────────────
function exportCSV() {
    if (!allDocs || allDocs.length === 0) {
        alert("No data available in the database yet.");
        return;
    }

    let selectedDate = getTodayStart();   // default = today

    // Ask user for date (optional)
    const userDate = prompt(
        "Enter date for report (YYYY-MM-DD)\n\nLeave blank for latest available day.", 
        selectedDate
    );

    if (userDate && userDate.trim() !== "") {
        selectedDate = userDate.trim();
    }

    // Filter documents for the selected date
    const filteredDocs = allDocs.filter(d => d.timestamp.startsWith(selectedDate));

    if (filteredDocs.length === 0) {
        alert(`No data found for date: ${selectedDate}\n\nTrying the most recent day with data...`);
        
        // Fallback: find the most recent date that has data
        const dates = [...new Set(allDocs.map(d => d.timestamp.slice(0,10)))].sort().reverse();
        if (dates.length === 0) {
            alert("No data available.");
            return;
        }
        selectedDate = dates[0];
        const fallbackDocs = allDocs.filter(d => d.timestamp.startsWith(selectedDate));
        
        if (fallbackDocs.length === 0) {
            alert("No data available.");
            return;
        }
        generateFullDayCSV(fallbackDocs, selectedDate);
        return;
    }

    generateFullDayCSV(filteredDocs, selectedDate);
}

// Helper function to generate the actual CSV
function generateFullDayCSV(docsForDay, reportDate) {
    
    const RECORDS_PER_KM = getRecordsPerKm();
    if (docsForDay.length === 0) return;

    const rows = [];

    // Report Header
    rows.push("Datalogger - Full Day KM Wise Acceleration Report");
    rows.push(`Date,${reportDate}`);
    rows.push(`Total Records,${docsForDay.length}`);
    rows.push(`Generated On,${new Date().toLocaleString()}`);
    rows.push("");

    const totalKms = Math.ceil(docsForDay.length / RECORDS_PER_KM);

    for (let km = 0; km < totalKms; km++) {
        const startIdx = km * RECORDS_PER_KM;
        const endIdx   = Math.min(startIdx + RECORDS_PER_KM, docsForDay.length);
        const kmDocs   = docsForDay.slice(startIdx, endIdx);

        const card = buildCard(kmDocs, km, false);   // false = not live

        // KM Header
        rows.push(`=== KM ${card.kmFrom} TO ${card.kmTo} ===`);
        rows.push("");

        // BLOCKS
        rows.push("BLOCKS SUMMARY");
        rows.push("LOC,Left RMS V,Left RMS L,Left SD V,Left SD L,Right RMS V,Right RMS L,Right SD V,Right SD L,Pivot RMS V,Pivot RMS L,Pivot SD V,Pivot SD L");

        card.blocks.forEach(blk => {
            if (blk.pending) return;
            const l = blk.left || {};
            const r = blk.right || {};
            const p = blk.pivot || {};
            rows.push([
                blk.label,
                fmt(l.rmsV) || '—',
                fmt(l.rmsL) || '—',
                fmt(l.sdV, 3) || '—',
                fmt(l.sdL, 3) || '—',
                fmt(r.rmsV) || '—',
                fmt(r.rmsL) || '—',
                fmt(r.sdV, 3) || '—',
                fmt(r.sdL, 3) || '—',
                fmt(p.rmsV) || '—',
                fmt(p.rmsL) || '—',
                fmt(p.sdV, 3) || '—',
                fmt(p.sdL, 3) || '—'
            ].join(','));
        });
        rows.push("");

        // PEAK DISTRIBUTION
        rows.push("PEAK DISTRIBUTION");
        rows.push("Band,Left Vertical (V),Left Lateral (L),Right Vertical (V),Right Lateral (L),Pivot Vertical (V),Pivot Lateral (L)");

        const pd = card.peakDist || { left: { V: {}, L: {} }, right: { V: {}, L: {} }, pivot: { V: {}, L: {} } };
        ['P1','P2','P3'].forEach(band => {
            rows.push([
                band,
                pd.left.V[band] || 0,
                pd.left.L[band] || 0,
                pd.right.V[band] || 0,
                pd.right.L[band] || 0,
                pd.pivot.V[band] || 0,
                pd.pivot.L[band] || 0
            ].join(','));
        });
        rows.push("");

        // WORST PEAKS
        rows.push("WORST PEAKS (Top 10)");
        rows.push("Parameter,1,2,3,4,5,6,7,8,9,10");

        const wp = card.worstPeaks || {};
        ['L-LAT','L-VERT','R-LAT','R-VERT','P-LAT','P-VERT'].forEach(param => {
            const vals = (wp[param] || []).map(v => fmt(v,1));
            while (vals.length < 10) vals.push('—');
            rows.push([param, ...vals].join(','));
        });

        rows.push("");
        rows.push("");   // separator between KMs
    }

    // Download
    const csvContent = rows.join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `KM_Report_${reportDate}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}
window.exportCSV = exportCSV;

// ─── Polling ─────────────────────────────────────────────────────────────────
async function poll() {
    await updateReport();
}

// ─── Initialise ─────────────────────────────────────────────────────────────
window.onload = async function () {
    document.getElementById('blocksCheck').checked = true;
    document.getElementById('peakDistCheck').checked = false;
    document.getElementById('worstPeaksCheck').checked = false;
    document.getElementById('blocksTab').classList.add('active');
    document.getElementById('peakDistTab').classList.remove('active');
    document.getElementById('worstPeaksTab').classList.remove('active');

    await poll();
    if (typeof AccelConfig !== 'undefined') {
    AccelConfig.onChange(() => {
        console.log('[accel-km] ODR changed → reprocessing');
        poll();
    });
}
    setInterval(poll, POLL_MS);
};
