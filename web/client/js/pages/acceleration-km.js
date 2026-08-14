/* acceleration-km.js – Frontend‑side KM report computation with proper historical KM indexing */

    'use strict';

    // Splits a KM's real length into 200m blocks with the remainder (if any) as
    // one final shorter block — e.g. 848m -> [200,200,200,200,48], 1183m ->
    // [200,200,200,200,200,183], 603m -> [200,200,200,3]. Same rule as
    // chainage-preview.js's blocksForKmLength(). UNCHANGED — this part was
    // already correct.
    function blocksForKmLength(lengthM) {
        const full = Math.floor(lengthM / 200);
        const rem  = lengthM % 200;
        const lens = Array(full).fill(200);
        if (rem > 0) lens.push(rem);
        return lens;
    }

    // ═════════════════════════════════════════════════════════════════════
    // ── DISTANCE-BASED BUCKETING (primary path) ────────────────────────────
    // Each monitoring_data row now carries its own real distance_m, stamped
    // server-side from live GPS (production) or simulate-distance.js (bench
    // testing). Instead of guessing how many records a KM "should" contain,
    // we equalize the route tape's real meter values directly against each
    // record's own distance_m — so a record only lands in a block/KM if its
    // measured position actually falls inside that block/KM's real span.
    // ═════════════════════════════════════════════════════════════════════

    function hasDistanceData(docs) {
        return docs.some(d => d.distance_m != null);
    }

    // Cumulative real distance (m) at the START of route-tape KM index idx,
    // walked in the tape's own travel order (routeTapeKmNums is already
    // sorted to match UP/DN direction — see loadRouteTapeData()).
    function cumulativeDistanceStart(idx) {
        let cursor = 0;
        for (let i = 0; i < idx; i++) {
            cursor += routeTapeData.kmLengths[routeTapeKmNums[i]];
        }
        return cursor;
    }

    // Finds which route-tape KM a given real distance_m value currently
    // falls into. Returns null once the distance has run past the whole tape.
    function routeTapeKmForDistance(distanceM) {
        let cursor = 0;
        for (let idx = 0; idx < routeTapeKmNums.length; idx++) {
            const km = routeTapeKmNums[idx];
            const len = routeTapeData.kmLengths[km];
            if (distanceM < cursor + len) return { kmIdx: idx, km, kmStart: cursor, kmEnd: cursor + len };
            cursor += len;
        }
        return null;
    }

    // Splits a KM's docs into its real 200m blocks using each record's own
    // distance_m value — a record lands in exactly the block whose real
    // meter range it measured inside, no weighting/approximation involved.
    function splitRecordsByDistance(docs, kmStart, blockLengths) {
        let blockStart = kmStart;
        return blockLengths.map(len => {
            const blockEnd = blockStart + len;
            const slice = docs.filter(d => d.distance_m != null && d.distance_m >= blockStart && d.distance_m < blockEnd);
            blockStart = blockEnd;
            return slice;
        });
    }

    // ═════════════════════════════════════════════════════════════════════
    // ── LEGACY RECORD-COUNT FALLBACK ────────────────────────────────────────
    // Only used when a KM's docs have NO distance_m at all — e.g. a bench
    // test with no GPS fix and simulate-distance.js not running. Keeps the
    // report showing *something* instead of going blank, using the old
    // ODR-based estimate. Any record with a real distance_m always takes
    // the precise path above instead.
    // ═════════════════════════════════════════════════════════════════════
    const RECORDS_PER_KM = 250;

    function getRecordsPerKm() {
        if (typeof AccelConfig === 'undefined') return RECORDS_PER_KM;
        const avg = (AccelConfig.getOdr(1) + AccelConfig.getOdr(2)) / 2;
        return Math.max(Math.round(RECORDS_PER_KM / Math.round(200 / avg)), 1);
    }

    function splitRecordsByBlockWeight(docs, blockLengths) {
        const totalLen = blockLengths.reduce((a, b) => a + b, 0);
        let idx = 0;
        return blockLengths.map(len => {
            const count = Math.round(docs.length * (len / totalLen));
            const slice = docs.slice(idx, idx + count);
            idx += count;
            return slice;
        });
    }

    function expectedRecordsForKmLength(lengthM) {
        return Math.max(1, Math.round(getRecordsPerKm() * (lengthM / 1000)));
    }

    function cumulativeCursorUpTo(idx) {
        let cursor = 0;
        for (let i = 0; i < idx; i++) {
            cursor += expectedRecordsForKmLength(routeTapeData.kmLengths[routeTapeKmNums[i]]);
        }
        return cursor;
    }

    function routeTapeProgress(sessionDocsLen) {
        let cursor = 0;
        for (let idx = 0; idx < routeTapeKmNums.length; idx++) {
            const km = routeTapeKmNums[idx];
            const expected = expectedRecordsForKmLength(routeTapeData.kmLengths[km]);
            if (cursor + expected > sessionDocsLen) return { kmIdx: idx, km, cursor, expected };
            cursor += expected;
        }
        return null;
    }

    // Decides which route-tape KM a set of "current session" docs is
    // presently within. Prefers real distance_m; falls back to the
    // ODR-based record-count estimate only when none of the docs carry a
    // distance_m value at all.
    function resolveCurrentKm(sessionDocs) {
        const distDocs = sessionDocs.filter(d => d.distance_m != null);
        if (distDocs.length) {
            const latestDistance = distDocs[distDocs.length - 1].distance_m; // docs are timestamp-sorted asc
            return { usedDistance: true, loc: routeTapeKmForDistance(latestDistance) };
        }
        return { usedDistance: false, progress: routeTapeProgress(sessionDocs.length) };
    }

    // Builds a KM card using real route-tape block lengths. Prefers
    // distance-based block placement (equalizing route-tape meters against
    // each record's real distance_m); falls back to the old length-weighted
    // record split only for docs with no distance_m at all. hwLive+isPartial
    // blocks with no records yet assigned show as "Collecting…".
    function buildRouteTapeCard(kmDocsSlice, kmNum, kmStart, hwLive) {
        const L = routeTapeData.kmLengths[kmNum];
        const kmEnd = kmStart + L;
        const blockLengths = blocksForKmLength(L);
        const useDistance = hasDistanceData(kmDocsSlice);

        const blockSplits = useDistance
            ? splitRecordsByDistance(kmDocsSlice, kmStart, blockLengths)
            : splitRecordsByBlockWeight(kmDocsSlice, blockLengths);

        const expectedRecords = useDistance ? null : expectedRecordsForKmLength(L);
        const isPartial = useDistance
            ? kmDocsSlice.reduce((m, d) => d.distance_m != null ? Math.max(m, d.distance_m) : m, kmStart) < kmEnd
            : kmDocsSlice.length < expectedRecords;

        const blocks = blockLengths.map((len, i) => {
            const bdocs = blockSplits[i] || [];
            if (!bdocs.length && hwLive && isPartial) {
                return { label: `BLK${i + 1} (${len}m)`, pending: true };
            }
            const c = computeBlock(bdocs, i);
            c.label = `BLK${i + 1} (${len}m)`;
            return c;
        });

        const isDn = routeTapeData.direction === 'DN';
        return {
            kmFrom:        kmNum,
            kmTo:          isDn ? kmNum - 1 : kmNum + 1,
            kmLengthM:     L,
            recordsSoFar:  kmDocsSlice.length,
            recordsExpected: expectedRecords,
            distanceBased: useDistance,
            isPartial,
            lastTimestamp: kmDocsSlice[kmDocsSlice.length - 1]?.timestamp ?? null,
            blocks,
            peakDist:      computePeakDist(kmDocsSlice),
            worstPeaks:    computeWorstPeaks(kmDocsSlice),
            usedRouteTape: true,
        };
    }

    // Builds one card per route-tape KM for a full day's worth of docs (used
    // by CSV export) — distance-based when the day's docs carry distance_m,
    // record-count based otherwise.
    function buildDayCardsFromRouteTape(docsForDay) {
        const cards = [];
        const useDistance = hasDistanceData(docsForDay);
        let cursor = 0; // meters if useDistance, else record index

        for (const km of routeTapeKmNums) {
            const len = routeTapeData.kmLengths[km];
            let kmDocsSlice, kmStart;

            if (useDistance) {
                kmStart = cursor;
                const kmEnd = cursor + len;
                kmDocsSlice = docsForDay.filter(d => d.distance_m != null && d.distance_m >= kmStart && d.distance_m < kmEnd);
                cursor = kmEnd;
            } else {
                if (cursor >= docsForDay.length) break;
                kmStart = 0;
                const expected = expectedRecordsForKmLength(len);
                kmDocsSlice = docsForDay.slice(cursor, cursor + expected);
                cursor += expected;
            }

            if (kmDocsSlice.length) cards.push(buildRouteTapeCard(kmDocsSlice, km, kmStart, false));
        }
        return cards;
    }
    let lastCard = null;
    let allDocs = [];
    let todayDocs = [];
    let lastFetchTime = 0;
    let limitsConfig = null;   // loaded from /api/limits-config
    let isLive = false;        // set by setStatus(); read by renderCard()

    // ── Route tape (real KM chainage) ───────────────────────────────────────────
    // When a route tape has been uploaded via Chainage Preview, /api/chainage-preview
    // returns { sourceFileName, uploadedAt, rows, kmLengths, direction, kmFrom, kmTo,
    // totalRouteMeters }. kmLengths maps km-number -> real length in meters (e.g.
    // {0:1000, 1:1000, 7:970, ...}) derived from consecutive rows in the .DAT file.
    // When present, KM blocks below use these real lengths instead of the fixed
    // 350-record/7-block assumption.
    let routeTapeData    = null; // { sourceFileName, uploadedAt, rows, kmLengths, direction, ... } | null
    let routeTapeKmNums  = [];   // km numbers in real travel order, cached alongside routeTapeData

    async function loadRouteTapeData() {
        try {
            const res = await fetch('/api/chainage-preview');
            if (!res.ok) { routeTapeData = null; routeTapeKmNums = []; return; }
            const data = await res.json();
            if (data && data.kmLengths && Object.keys(data.kmLengths).length) {
                routeTapeData = data;
                // Order KM numbers to match the tape's own travel direction —
                // a DN tape runs from a high KM down to a low KM (e.g. 80 → 0),
                // so distance accumulated from a standing start (0m) must map
                // onto the tape's starting KM (kmFrom), not KM 0. Sorting
                // ascending unconditionally was walking every DN route
                // backwards, which is why the report was stuck showing early
                // low-numbered KMs instead of the real starting end of the
                // route.
                const nums = Object.keys(data.kmLengths).map(Number);
                routeTapeKmNums = data.direction === 'DN'
                    ? nums.sort((a, b) => b - a)
                    : nums.sort((a, b) => a - b);
            } else {
                routeTapeData = null; routeTapeKmNums = [];
            }
        } catch (e) {
            console.warn('[km] Could not load route tape data:', e.message);
            routeTapeData = null; routeTapeKmNums = [];
        }
    }

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
            const pV = getPClass(d.y_axis, getLCPeakThresholds(side, 'V'));
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
            const vert = d.y_axis != null ? Math.abs(d.y_axis) : null;
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

    // buildCard() (the fixed/nominal-KM fallback used when no route tape is
    // uploaded) has been removed. The report now does nothing until a route
    // tape is uploaded via Chainage Preview — see updateReport()/
    // generateFullDayCSV() below, which show an "upload a route tape" prompt
    // in that case instead of guessing KM boundaries.

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
            const progressLabel = data.distanceBased
                ? `${data.recordsSoFar} pts`
                : `${data.recordsSoFar}/${data.recordsExpected}`;
            badge = `<span class="live-badge"><i class="fas fa-circle blink"></i> LIVE &nbsp;<span style="font-size:11px">${progressLabel}</span></span>`;
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
        // 0. Fetch limits config (keeps peak distribution in sync with configuration page)
        await loadLimitsConfig();
        // 0b. Fetch route tape data (Chainage Preview upload) — this is the ONLY
        // source of KM boundaries now. No route tape → no guessed fallback →
        // report shows a prompt instead of building anything.
        await loadRouteTapeData();
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

        // 3. Fetch hardware liveness
        const hwLive = await fetchLiveStatus();

        const useRouteTape = !!(routeTapeData && routeTapeKmNums.length);
        if (!useRouteTape) {
            document.getElementById('km-container').innerHTML = `
                <div class="no-data-banner">
                    <i class="fas fa-route"></i>
                    <p>No route tape uploaded yet.</p>
                    <p style="color:#94a3b8;font-size:12px">Upload a route tape (.DAT) on the Chainage Preview page to see the KM-wise report.</p>
                </div>`;
            setStatus(hwLive);
            setToolbarCount(0);
            lastCard = null;
            return;
        }

        // 2. Determine today's date and filter today's docs
        const todayStart = getTodayStart();
        todayDocs = allDocs.filter(d => isSameDate(d.timestamp, todayStart));
        const hasTodayData = todayDocs.length > 0;

        let sessionDocs, historical;

        if (hasTodayData) {
            // Use today's data for live session
            sessionDocs = todayDocs;
            historical = false;

            // ── Route-tape-driven KM sizing: real KM lengths from the RT file,
            // 200m blocks. resolveCurrentKm() prefers each record's own real
            // distance_m (GPS in production, simulate-distance.js on the
            // bench); it only falls back to the ODR-based record-count guess
            // when none of the session's docs carry a distance_m at all. ──
            const resolved = resolveCurrentKm(sessionDocs);

            if (hwLive) {
                if (resolved.usedDistance) {
                    if (resolved.loc) {
                        const { km, kmIdx, kmStart, kmEnd } = resolved.loc;
                        const kmDocsSlice = sessionDocs.filter(d => d.distance_m != null && d.distance_m >= kmStart && d.distance_m < kmEnd);
                        const card = buildRouteTapeCard(kmDocsSlice, km, kmStart, true);
                        card.historical = false;
                        setStatus(hwLive);
                        setToolbarCount(kmIdx);
                        lastCard = card;
                        renderCard(card);
                    } else {
                        // Distance has run past the end of the uploaded route
                        // tape — show the last KM fully closed out.
                        const lastIdx = routeTapeKmNums.length - 1;
                        const lastKm = routeTapeKmNums[lastIdx];
                        const kmStart = cumulativeDistanceStart(lastIdx);
                        const lastKmDocs = sessionDocs.filter(d => d.distance_m != null && d.distance_m >= kmStart);
                        const card = buildRouteTapeCard(lastKmDocs, lastKm, kmStart, false);
                        card.historical = false;
                        card.routeTapeExhausted = true;
                        setStatus(hwLive);
                        setToolbarCount(routeTapeKmNums.length);
                        lastCard = card;
                        renderCard(card);
                    }
                } else if (resolved.progress) {
                    const progress = resolved.progress;
                    const partialStart = cumulativeCursorUpTo(progress.kmIdx);
                    const partialDocs = sessionDocs.slice(partialStart);
                    const card = buildRouteTapeCard(partialDocs, progress.km, 0, true);
                    card.historical = false;
                    setStatus(hwLive);
                    setToolbarCount(progress.kmIdx);
                    lastCard = card;
                    renderCard(card);
                } else {
                    const lastIdx = routeTapeKmNums.length - 1;
                    const lastKm = routeTapeKmNums[lastIdx];
                    const start = cumulativeCursorUpTo(lastIdx);
                    const lastKmDocs = sessionDocs.slice(start);
                    const card = buildRouteTapeCard(lastKmDocs, lastKm, 0, false);
                    card.historical = false;
                    card.routeTapeExhausted = true;
                    setStatus(hwLive);
                    setToolbarCount(routeTapeKmNums.length);
                    lastCard = card;
                    renderCard(card);
                }
            } else {
                // Offline but today has data: show last completed route-tape KM if any
                if (resolved.usedDistance) {
                    const completedIdx = resolved.loc ? resolved.loc.kmIdx : routeTapeKmNums.length;
                    if (completedIdx > 0) {
                        const lastIdx = completedIdx - 1;
                        const lastKm = routeTapeKmNums[lastIdx];
                        const kmStart = cumulativeDistanceStart(lastIdx);
                        const kmEnd = kmStart + routeTapeData.kmLengths[lastKm];
                        const lastKmDocs = sessionDocs.filter(d => d.distance_m != null && d.distance_m >= kmStart && d.distance_m < kmEnd);
                        const card = buildRouteTapeCard(lastKmDocs, lastKm, kmStart, false);
                        card.historical = false;
                        setStatus(hwLive);
                        setToolbarCount(completedIdx);
                        lastCard = card;
                        renderCard(card);
                    } else {
                        const firstKm = routeTapeKmNums[0];
                        const kmDocsSlice = sessionDocs.filter(d => d.distance_m != null && d.distance_m < routeTapeData.kmLengths[firstKm]);
                        const card = buildRouteTapeCard(kmDocsSlice, firstKm, 0, false);
                        card.historical = false;
                        setStatus(hwLive);
                        setToolbarCount(0);
                        lastCard = card;
                        renderCard(card);
                    }
                } else {
                    const progress = resolved.progress;
                    const completedIdx = progress ? progress.kmIdx : routeTapeKmNums.length;
                    if (completedIdx > 0) {
                        const lastIdx = completedIdx - 1;
                        const lastKm = routeTapeKmNums[lastIdx];
                        const start = cumulativeCursorUpTo(lastIdx);
                        const expected = expectedRecordsForKmLength(routeTapeData.kmLengths[lastKm]);
                        const lastKmDocs = sessionDocs.slice(start, start + expected);
                        const card = buildRouteTapeCard(lastKmDocs, lastKm, 0, false);
                        card.historical = false;
                        setStatus(hwLive);
                        setToolbarCount(completedIdx);
                        lastCard = card;
                        renderCard(card);
                    } else {
                        const firstKm = routeTapeKmNums[0];
                        const card = buildRouteTapeCard(sessionDocs, firstKm, 0, false);
                        card.historical = false;
                        setStatus(hwLive);
                        setToolbarCount(0);
                        lastCard = card;
                        renderCard(card);
                    }
                }
            }
            return;
        }

        // 4. No data today → fallback to the most recent date that has data
        const lastDoc = allDocs[allDocs.length - 1];
        const lastDate = lastDoc.timestamp.slice(0, 10);
        const prevDayDocs = allDocs.filter(d => isSameDate(d.timestamp, lastDate));

        const resolvedPrev = resolveCurrentKm(prevDayDocs);

        if (resolvedPrev.usedDistance) {
            const completedIdxPrev = resolvedPrev.loc ? resolvedPrev.loc.kmIdx : routeTapeKmNums.length;
            if (completedIdxPrev > 0) {
                const lastIdx = completedIdxPrev - 1;
                const lastKm = routeTapeKmNums[lastIdx];
                const kmStart = cumulativeDistanceStart(lastIdx);
                const kmEnd = kmStart + routeTapeData.kmLengths[lastKm];
                const lastKmDocs = prevDayDocs.filter(d => d.distance_m != null && d.distance_m >= kmStart && d.distance_m < kmEnd);
                const card = buildRouteTapeCard(lastKmDocs, lastKm, kmStart, false);
                card.historical = true;
                setStatus(hwLive);
                setToolbarCount(completedIdxPrev);
                lastCard = card;
                renderCard(card);
            } else {
                const firstKm = routeTapeKmNums[0];
                const kmDocsSlice = prevDayDocs.filter(d => d.distance_m != null && d.distance_m < routeTapeData.kmLengths[firstKm]);
                const card = buildRouteTapeCard(kmDocsSlice, firstKm, 0, false);
                card.historical = true;
                setStatus(hwLive);
                setToolbarCount(0);
                lastCard = card;
                renderCard(card);
            }
        } else {
            const progressPrev = resolvedPrev.progress;
            const completedIdxPrev = progressPrev ? progressPrev.kmIdx : routeTapeKmNums.length;

            if (completedIdxPrev > 0) {
                const lastIdx = completedIdxPrev - 1;
                const lastKm = routeTapeKmNums[lastIdx];
                const start = cumulativeCursorUpTo(lastIdx);
                const expected = expectedRecordsForKmLength(routeTapeData.kmLengths[lastKm]);
                const lastKmDocs = prevDayDocs.slice(start, start + expected);
                const card = buildRouteTapeCard(lastKmDocs, lastKm, 0, false);
                card.historical = true;
                setStatus(hwLive);
                setToolbarCount(completedIdxPrev);
                lastCard = card;
                renderCard(card);
            } else {
                const firstKm = routeTapeKmNums[0];
                const card = buildRouteTapeCard(prevDayDocs, firstKm, 0, false);
                card.historical = true;
                setStatus(hwLive);
                setToolbarCount(0);
                lastCard = card;
                renderCard(card);
            }
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

        if (docsForDay.length === 0) return;

        const useRouteTape = !!(routeTapeData && routeTapeKmNums.length);
        if (!useRouteTape) {
            alert('No route tape uploaded yet.\n\nUpload a route tape (.DAT) on the Chainage Preview page before exporting a KM-wise report.');
            return;
        }

        const rows = [];

        // Report Header
        rows.push("Datalogger - Full Day KM Wise Acceleration Report");
        rows.push(`Date,${reportDate}`);
        rows.push(`Total Records,${docsForDay.length}`);
        rows.push(`Generated On,${new Date().toLocaleString()}`);
        rows.push(`Route Tape,${routeTapeData.sourceFileName}`);
        rows.push("");

        // Route-tape-driven cards: real KM lengths, 200m blocks throughout.
        const cards = buildDayCardsFromRouteTape(docsForDay);

        for (const card of cards) {

            // KM Header
            rows.push(`=== KM ${card.kmFrom} TO ${card.kmTo}${card.kmLengthM ? ` (${card.kmLengthM}m)` : ''} ===`);
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

        // Fire-and-forget server-side archive — must never delay/block the download
        fetch('/api/reports/km-wise', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ csv: csvContent, reportDate })
        }).catch(e => console.warn('[km-wise] Server archive failed (download unaffected):', e));

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const filename = `KM_Report_${reportDate}.csv`;

        saveOrDownloadCSV(blob, filename);
    }

    // Prefer the remembered save folder (e.g. the external drive) — same
    // pattern as events.js's exportEvents(): falls back to the browser's
    // normal download if nothing's been chosen yet, the write fails, or the
    // browser doesn't support the File System Access API (Firefox/Safari).
    async function saveOrDownloadCSV(blob, filename) {
        try {
            if (typeof ReportSaveTarget !== 'undefined') {
                const savedToFolder = await ReportSaveTarget.saveBlob(blob, filename);
                if (savedToFolder) {
                    if (typeof showReportSaveStatus === 'function') {
                        showReportSaveStatus(`Saved "${filename}" to the chosen folder.`, false);
                    }
                    return;
                }
            }
        } catch (e) {
            console.error('[km] Direct save failed, falling back to browser download:', e);
        }

        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }
    window.exportCSV = exportCSV;

    // ─── Polling ─────────────────────────────────────────────────────────────────
    async function poll() {
        try {
            await updateReport();
        } catch (e) {
            console.error('[km] updateReport failed:', e);
            const container = document.getElementById('km-container');
            if (container) {
                container.innerHTML = `
                    <div class="no-data-banner">
                        <i class="fas fa-triangle-exclamation"></i>
                        <p>Report failed to render.</p>
                        <p style="color:#94a3b8;font-size:12px">${(e && e.message) || e}</p>
                    </div>`;
            }
        }
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