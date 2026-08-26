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
    // ── DISTANCE-BASED BUCKETING (the only path) ───────────────────────────
    // Each monitoring_data row carries its own real distance_m, stamped
    // server-side from the odometer encoder (server.js's totalDistanceM,
    // updated on every ENCODER,... reading — see handleOdometerSocket) or
    // simulate-distance.js (bench testing). We equalize the route tape's
    // real meter values directly against each record's own distance_m — so
    // a record only lands in a block/KM if its measured position actually
    // falls inside that block/KM's real span. There is no record-count
    // estimation anywhere in this file: if a session hasn't shown real
    // distance movement yet, the report waits instead of guessing.
    // ═════════════════════════════════════════════════════════════════════

    // "Real" distance means the system is moving RIGHT NOW — checked via the
    // most recent record only, not "has any record in this batch ever shown
    // distance_m > 0". That distinction matters: if simulate-distance.js (or
    // the real odometer) was active earlier in this same uninterrupted run
    // and then stopped, the sensor keeps streaming — but every NEW row
    // reverts to distance_m = 0 (server.js's own totalDistanceM only
    // advances on a new encoder reading; simulate-distance.js only patches
    // the DB directly, it doesn't touch that in-memory value). A stale
    // non-zero record from earlier in the run would otherwise wrongly commit
    // the whole batch to distance-based bucketing, and every current static
    // record (distance_m = 0) would pile into BLK1. Checking only the latest
    // record reflects "is it dynamic right now" — exactly what should decide
    // the mode.
    function hasDistanceData(docs) {
        if (!docs.length) return false;
        const latest = docs[docs.length - 1]; // docs are timestamp-sorted asc
        return latest.distance_m != null && latest.distance_m >= 0;
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

    // Decides which route-tape KM a set of "current session" docs is
    // presently within. Checks only the MOST RECENT record's distance_m —
    // not "does any record in the session have distance_m > 0" — so stale
    // distance data from an earlier phase of this same run (see
    // hasDistanceData() above) can't wrongly commit the session to
    // distance-based resolution while it's actually sitting static now.
    // Returns { usedDistance: false } if no real distance data exists yet —
    // the caller is responsible for showing a "waiting" state in that case,
    // there is no record-count guess to fall back to.
    function resolveCurrentKm(sessionDocs) {
        if (!sessionDocs.length) return { usedDistance: false };
        const latest = sessionDocs[sessionDocs.length - 1]; // timestamp-sorted asc
        if (latest.distance_m != null && latest.distance_m >= 0) {
            return { usedDistance: true, loc: routeTapeKmForDistance(latest.distance_m) };
        }
        return { usedDistance: false };
    }

    // Builds a KM card using real route-tape block lengths, purely from each
    // record's own distance_m — no record-count estimation anywhere. Caller
    // (updateReport) only invokes this once resolveCurrentKm() has confirmed
    // real distance data exists for the session. Empty blocks render as
    // dashes (no "Collecting…" placeholder).
    function buildRouteTapeCard(kmDocsSlice, kmNum, kmStart, hwLive, worstPeaksScopeDocs) {
        const L = routeTapeData.kmLengths[kmNum];
        const kmEnd = kmStart + L;
        const blockLengths = blocksForKmLength(L);

        const maxDist = kmDocsSlice.reduce((m, d) => d.distance_m != null ? Math.max(m, d.distance_m) : m, kmStart);
        const isPartial = maxDist < kmEnd;

        const blockSplits = splitRecordsByDistance(kmDocsSlice, kmStart, blockLengths);

        // Always render every block in real time. Empty slices show as "—"
        // via computeBlock([]) — no "Collecting…" placeholder rows.
        const blocks = blockLengths.map((len, i) => {
            const bdocs = blockSplits[i] || [];
            const c = computeBlock(bdocs, i);
            c.label = `BLK${i + 1} (${len}m)`;
            return c;
        });

        const isDn = routeTapeData.direction === 'DN';
        const distanceCoveredM = Math.max(0, maxDist - kmStart);
        // Worst Peaks is scoped strictly to THIS KM's real distance range
        // [kmStart, kmEnd). While the system is LIVE, source it from
        // kmDocsSlice — the current session's own records for this km —
        // so the numbers actually move with real-time readings instead of
        // sitting fixed at whatever was worst across all past
        // sessions/days. When offline, prefer the caller-supplied
        // worstPeaksScopeDocs (e.g. today's docs only) if given, so the
        // report stays scoped to today's date instead of silently reaching
        // back into all-time history. Only true historical/CSV-export call
        // sites (which don't pass this) fall back to scanning allDocs.
        const worstPeaksSourceDocs = hwLive
            ? kmDocsSlice
            : (worstPeaksScopeDocs || allDocs).filter(d => d.distance_m != null && d.distance_m >= kmStart && d.distance_m < kmEnd);
        const worstPeaks = computeWorstPeaks(worstPeaksSourceDocs);

        return {
            kmFrom:        kmNum,
            kmTo:          isDn ? kmNum - 1 : kmNum + 1,
            kmLengthM:     L,
            recordsSoFar:  kmDocsSlice.length,
            distanceBased: true,
            distanceCoveredM,
            isPartial,
            lastTimestamp: kmDocsSlice[kmDocsSlice.length - 1]?.timestamp ?? null,
            blocks,
            peakDist:      computePeakDist(worstPeaks),
            worstPeaks,
            usedRouteTape: true,
        };
    }

    // Builds one card per route-tape KM for a full day's worth of docs (used
    // by CSV export) — purely distance_m-driven. Returns [] if the day has
    // no real distance data at all (nothing to export by distance).
    function buildDayCardsFromRouteTape(docsForDay) {
        const cards = [];
        if (!hasDistanceData(docsForDay)) return cards;
        let cursor = 0; // meters

        for (const km of routeTapeKmNums) {
            const len = routeTapeData.kmLengths[km];
            const kmStart = cursor;
            const kmEnd = cursor + len;
            const kmDocsSlice = docsForDay.filter(d => d.distance_m != null && d.distance_m >= kmStart && d.distance_m < kmEnd);
            cursor = kmEnd;

            if (kmDocsSlice.length) cards.push(buildRouteTapeCard(kmDocsSlice, km, kmStart, false));
        }
        return cards;
    }
    const POLL_MS = 5000;
    let lastCard = null;
    let allDocs = [];
    let todayDocs = [];
    let lastFetchTime = 0;
    let limitsConfig = null;   // loaded from /api/limits-config

    // ── Peak-distribution thresholds — same source as the Configuration page
    // (axle: /api/thresholds, pivot: /api/thresholds/pivot). These are the
    // P1/P2/P3 min/max RAW-value bands a person sets on Configuration, and
    // peak distribution here now classifies every raw x_axis/y_axis reading
    // against them directly — left+right both use the axle set, pivot uses
    // its own set, exactly mirroring server.js's thresholdsFor()/getPClass().
    // No hardcoded defaults here — null until loadThresholdsConfig() fetches
    // whatever the user has actually configured (or not configured) server-side. ──
    let thresholdsConfig = {
        axle:  null,
        pivot: null,
    };

    // ── Axis Limit values — same source as Configuration page's "Axis Limit
    // Values" section (/api/axis-limits). Shape: { generic:{x,y,z}, a1:{x,y,z},
    // a2:{x,y,z} }, each leaf { p1, p2, p3 } as single raw-g cutoffs (not
    // min/max ranges). Unit mapping mirrors configuration.html exactly:
    // a1 = Left, a2 = Right, generic = Pivot. Peak Distribution below now
    // classifies every raw y_axis (V) / x_axis (L) reading against these
    // per-axis cutoffs instead of the old axle/pivot min-max thresholds.
    // Null until loadAxisLimitsConfig() fetches the real saved values.
    let axisLimitsConfig = null;
    function unitForSide(side) {
        return side === 'right' ? 'a2' : (side === 'pivot' ? 'generic' : 'a1');
    }
    async function loadAxisLimitsConfig() {
        try {
            const res = await fetch('/api/axis-limits');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data && data.generic && data.a1 && data.a2) axisLimitsConfig = data;
            console.log('[km] Axis limits loaded:', axisLimitsConfig);
        } catch (e) {
            console.warn('[km] Could not load axis limits:', e.message);
        }
    }
    if (typeof io !== 'undefined') {
        const _kmAxisLimitSocket = io(window.location.origin);
        _kmAxisLimitSocket.on('axis-limits-updated', (data) => {
            axisLimitsConfig = data;
            if (lastCard) renderCard(lastCard);
        });
    }

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
    // rms/sd for a block now take the MAXIMUM value recorded, not the
    // average — a block should reflect its worst rms/sd reading, same
    // reasoning as Worst Peaks showing real highest values rather than a
    // smoothed-out mean.
    function maxVal(arr) {
        const valid = arr.filter(v => v != null && !isNaN(v));
        return valid.length ? Math.max(...valid) : null;
    }
    function computeBlock(docs, blkIdx) {
        const left  = docs.filter(d => d.device_id === 'left');
        const right = docs.filter(d => d.device_id === 'right');
        const pivot = docs.filter(d => d.device_id === 'pivot');
        const pick  = (arr, f) => arr.map(d => d[f]).filter(v => v != null);
        return {
            label: `BLK${blkIdx + 1}`,
            left: {
                rmsV: maxVal(pick(left, 'rmsV')),
                rmsL: maxVal(pick(left, 'rmsL')),
                sdV:  maxVal(pick(left, 'sdV')),
                sdL:  maxVal(pick(left, 'sdL')),
            },
            right: {
                rmsV: maxVal(pick(right, 'rmsV')),
                rmsL: maxVal(pick(right, 'rmsL')),
                sdV:  maxVal(pick(right, 'sdV')),
                sdL:  maxVal(pick(right, 'sdL')),
            },
            pivot: {
                rmsV: maxVal(pick(pivot, 'rmsV')),
                rmsL: maxVal(pick(pivot, 'rmsL')),
                sdV:  maxVal(pick(pivot, 'sdV')),
                sdL:  maxVal(pick(pivot, 'sdL')),
            }
        };
    }

    // ─── Peak-distribution thresholds (axle + pivot raw-value bands) ─────────────
    async function loadThresholdsConfig() {
        try {
            const [axleRes, pivotRes] = await Promise.all([
                fetch('/api/thresholds'),
                fetch('/api/thresholds/pivot'),
            ]);
            if (axleRes.ok) {
                const axle = await axleRes.json();
                if ([axle.p1Min, axle.p1Max, axle.p2Min, axle.p2Max, axle.p3Min].every(v => v != null && !isNaN(v))) {
                    thresholdsConfig.axle = axle;
                }
            }
            if (pivotRes.ok) {
                const pivot = await pivotRes.json();
                if ([pivot.p1Min, pivot.p1Max, pivot.p2Min, pivot.p2Max, pivot.p3Min].every(v => v != null && !isNaN(v))) {
                    thresholdsConfig.pivot = pivot;
                }
            }
            console.log('[km] Peak-distribution thresholds loaded:', thresholdsConfig);
        } catch (e) {
            console.warn('[km] Could not load axle/pivot thresholds:', e.message);
        }
    }
    if (typeof io !== 'undefined') {
        const _kmThresholdSocket = io(window.location.origin);
        _kmThresholdSocket.on('thresholds-updated', (t) => {
            thresholdsConfig.axle = t;
            if (lastCard) renderCard(lastCard);
        });
        _kmThresholdSocket.on('pivot-thresholds-updated', (t) => {
            thresholdsConfig.pivot = t;
            if (lastCard) renderCard(lastCard);
        });
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

    // Returns the raw-value P1/P2/P3 min/max band set for a given side —
    // left+right both use the axle band (thresholdsConfig.axle), pivot uses
    // its own (thresholdsConfig.pivot). Same set for both V and L axes,
    // mirroring server.js's thresholdsFor(sensorId). Kept around for the
    // tooltip helper below; no longer drives the P1/P2/P3 counts themselves.
    function getRawPeakThresholds(side) {
        return side === 'pivot' ? thresholdsConfig.pivot : thresholdsConfig.axle;
    }

    // Returns the per-axis { p1, p2, p3 } cutoff set from the Configuration
    // page's "Axis Limit Values" section (/api/axis-limits) for a given
    // side + axis letter ('x' = Lateral/L, 'y' = Vertical/V). Null if axis
    // limits haven't loaded from the server yet.
    function getAxisLimitBand(side, axisLetter) {
        if (!axisLimitsConfig) return null;
        const unit = unitForSide(side);
        return (axisLimitsConfig[unit] && axisLimitsConfig[unit][axisLetter]) || null;
    }

    // "# Threshold Configuration: ..." banner — first line of every
    // generated report on this page, mirroring server.js's
    // thresholdConfigBanner() so raw log / impact / km-wise reports are all
    // self-documenting about which limits were active without having to
    // cross-reference the Configuration page separately.
    function thresholdConfigBannerLine() {
        const fmtRange = t => t ? `P1:${t.p1Min}G,P2:${t.p2Min}G,P3:${t.p3Min}G(Min)` : 'not configured';
        const axle  = fmtRange(thresholdsConfig.axle);
        const pivot = fmtRange(thresholdsConfig.pivot);
        return `# Threshold Configuration — AXLE ${axle} | PIVOT ${pivot}`;
    }

    // Classifies a raw axis reading into P1/P2/P3 using the Axis Limit
    // Values' single g cutoffs (not min/max ranges) — a reading crosses a
    // band once |value| >= that band's configured value, same semantics as
    // configuration.js. Reading is bucketed into the highest band it
    // crosses. Returns null (unclassified) if the band isn't configured yet
    // — never falls back to a made-up default.
    function classifyAxisLimitPeak(g, band) {
        if (g == null || isNaN(g) || !band) return null;
        const v = Math.abs(g);
        if (band.p3 != null && v >= +band.p3) return 'P3';
        if (band.p2 != null && v >= +band.p2) return 'P2';
        if (band.p1 != null && v >= +band.p1) return 'P1';
        return null;
    }

    const WORST_PEAK_KEY_META = {
        'L-LAT':  { side: 'left',  axis: 'L', axisLetter: 'x' },
        'L-VERT': { side: 'left',  axis: 'V', axisLetter: 'y' },
        'R-LAT':  { side: 'right', axis: 'L', axisLetter: 'x' },
        'R-VERT': { side: 'right', axis: 'V', axisLetter: 'y' },
        'P-LAT':  { side: 'pivot', axis: 'L', axisLetter: 'x' },
        'P-VERT': { side: 'pivot', axis: 'V', axisLetter: 'y' },
    };

    // Classifies the KM's worst-peaks (per-parameter top 10, see
    // computeWorstPeaks) into P1/P2/P3 bands using the Axis Limit Values
    // from Configuration — so Peak Distribution reflects which band the
    // KM's actual worst readings fell into, and on which accelerometer.
    function computePeakDist(worstPeaks) {
        const out = {
            left:  { V: { P1:0, P2:0, P3:0 }, L: { P1:0, P2:0, P3:0 } },
            right: { V: { P1:0, P2:0, P3:0 }, L: { P1:0, P2:0, P3:0 } },
            pivot: { V: { P1:0, P2:0, P3:0 }, L: { P1:0, P2:0, P3:0 } },
        };
        for (const key of Object.keys(worstPeaks || {})) {
            const meta = WORST_PEAK_KEY_META[key];
            if (!meta) continue;
            const band = getAxisLimitBand(meta.side, meta.axisLetter);
            for (const peak of worstPeaks[key]) {
                const p = classifyAxisLimitPeak(peak.value, band);
                if (p) out[meta.side][meta.axis][p]++;
            }
        }
        return out;
    }

    // Top 10 highest individual readings for EACH of the 6 sensor/axis
    // parameters within this KM, independently ranked. Deduped to the
    // highest reading PER DISTINCT METER first — distance_m only advances
    // on a GPS fix while the accelerometer samples much faster in between,
    // so many raw readings can share the same rounded meter. Without this
    // dedupe, a pure value-sort can fill all 10 slots from one GPS-static
    // window; deduping first spreads the top 10 across as many distinct
    // meters as actually exist in the KM's data.
    function computeWorstPeaks(docs) {
        const keys = ['L-LAT', 'L-VERT', 'R-LAT', 'R-VERT', 'P-LAT', 'P-VERT'];
        const empty = () => Object.fromEntries(keys.map(k => [k, []]));
        if (!docs || !docs.length) return empty();

        const buckets = Object.fromEntries(keys.map(k => [k, []]));
        for (const d of docs) {
            const side = d.device_id === 'right' ? 'right' : (d.device_id === 'pivot' ? 'pivot' : 'left');
            const latKey  = side === 'left' ? 'L-LAT'  : side === 'right' ? 'R-LAT'  : 'P-LAT';
            const vertKey = side === 'left' ? 'L-VERT' : side === 'right' ? 'R-VERT' : 'P-VERT';
            // Absolute distance_m (real ground-truth meter, not relative to
            // kmStart) — the caller (buildRouteTapeCard) now already scopes
            // the docs passed in to this KM's real [kmStart, kmEnd) range
            // from the RT file, so the raw distance_m doubles as a
            // human-readable meter within that KM. Shown whenever
            // distance_m is present, whether climbing (train moving) or
            // flat (stationary).
            const meter = d.distance_m != null ? Math.round(d.distance_m) : null;
            if (d.x_axis != null) buckets[latKey].push({ value: +Math.abs(d.x_axis).toFixed(2), meter, timestamp: d.timestamp });
            if (d.y_axis != null) buckets[vertKey].push({ value: +Math.abs(d.y_axis).toFixed(2), meter, timestamp: d.timestamp });
        }

        // No meter-based dedupe: real-world distance_m jitters slightly
        // even while parked (GPS noise, simulate-distance rounding), which
        // was enough to defeat a "distinct meter count" heuristic and keep
        // collapsing genuine high-g events down to 1-2 survivors per
        // parameter. The Worst Peaks table's whole purpose is to show the
        // actual highest recorded readings, so every raw sample now
        // competes on value alone — top 10 by |value|, period, regardless
        // of where distance_m happens to be.
        const out = empty();
        for (const k of keys) {
            out[k] = buckets[k].sort((a, b) => b.value - a.value).slice(0, 10);
        }
        return out;
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
                    <tr><th>V</th><th>L</th><th>V</th><th>L</th><th>V</th><th>L</th><th>V</th><th>L</th><th>V</th><th>L</th><th>V</th><th>L</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }

    function renderPeakDistTable(peakDist) {
        if (!peakDist) return '<p class="no-data">No distribution data yet.</p>';
        const l = peakDist.left, r = peakDist.right, p = peakDist.pivot || { V:{}, L:{} };

        // Tooltips still pull live from the Configuration page's "Axis
        // Limit Values" section (/api/axis-limits) per band/side/axis, just
        // no longer surfaced as a banner above the table.
        const bandTip = (side, axisCol, band) => {
            const axisLetter = axisCol === 'V' ? 'y' : 'x';
            const b = getAxisLimitBand(side, axisLetter);
            if (!b) return 'Not configured yet';
            const v = b[band.toLowerCase()];
            return v != null ? `${band}: ≥ ${v}g` : `${band}: not set`;
        };

        const bandRow = band => {
            const cls = band.toLowerCase();
            return `<tr>
                <td><span class="badge badge-${cls}">${band}</span></td>
                <td class="count-badge count-${cls}" title="${bandTip('left','V',band)}">${l.V[band]||0}</td>
                <td class="count-badge count-${cls}" title="${bandTip('left','L',band)}">${l.L[band]||0}</td>
                <td class="count-badge count-${cls}" title="${bandTip('right','V',band)}">${r.V[band]||0}</td>
                <td class="count-badge count-${cls}" title="${bandTip('right','L',band)}">${r.L[band]||0}</td>
                <td class="count-badge count-${cls}" title="${bandTip('pivot','V',band)}">${p.V[band]||0}</td>
                <td class="count-badge count-${cls}" title="${bandTip('pivot','L',band)}">${p.L[band]||0}</td>
            </tr>`;
        };
        return `<div class="table-container">
            <table>
                <thead><tr><th rowspan="2">BANDS</th><th colspan="2">LEFT</th><th colspan="2">RIGHT</th><th colspan="2">PIVOT</th></tr>
                <tr><th>V</th><th>L</th><th>V</th><th>L</th><th>V</th><th>L</th></tr></thead>
                <tbody>${bandRow('P1')}${bandRow('P2')}${bandRow('P3')}</tbody>
            </table>
        </div>`;
    }

    function renderWorstPeaksTable(worstPeaks, meta) {
        if (!worstPeaks) return '<p class="no-data">No peak data yet.</p>';
        const params = ['L-LAT','L-VERT','R-LAT','R-VERT','P-LAT','P-VERT'];
        const header = `<tr><th>Parameter</th>${[1,2,3,4,5,6,7,8,9,10].map(i=>`<th>${i}</th>`).join('')}</tr>`;
        const rows = params.map(param => {
            const vals = worstPeaks[param] || [];
            const cells = Array.from({length: 10}, (_, i) => {
                const v = vals[i];
                if (!v) return `<td>—</td>`;
                // "value g @ meter m" — meter is the real distance_m where
                // that peak was recorded (see computeWorstPeaks()), shown
                // whenever distance_m exists on the record, whether the
                // train is moving (meter climbs peak to peak) or parked
                // (meter stays flat, still shown rather than hidden).
                const text = `${fmt(v.value,2)}${v.meter != null ? `/${v.meter}` : ''}`;
                const title = v.timestamp ? new Date(v.timestamp).toLocaleString() : '';
                return `<td class="${peakClass(v.value)}" title="${title}">${text}</td>`;
            }).join('');
            return `<tr><td>${param}</td>${cells}</tr>`;
        }).join('');

        return `<div class="table-container">
            <table>
                <thead>${header}</thead>
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
            badge = `<span class="live-badge"><i class="fas fa-circle blink"></i> LIVE &nbsp;<span style="font-size:11px">${data.recordsSoFar} pts</span></span>`;
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
                ${renderWorstPeaksTable(data.worstPeaks, data)}
            </div>
        </div>`;
    }

    // ─── Status helpers ─────────────────────────────────────────────────────────
    let isLive = false; // tracks hardware-live status; read by renderCard()'s LIVE badge logic
    let prevHwLive = null; // null = not yet known (startup); used only to detect a live→offline EDGE
    function setStatus(live) {
        // Detect the moment hardware goes from live → offline and fire a
        // silent, one-shot archive of today's report. Guarded so it only
        // fires on the transition (not every poll tick while offline), and
        // skipped on the very first status read after page load (prevHwLive
        // === null) so opening the dashboard while hardware is already
        // offline doesn't trigger a spurious "disconnect" save.
        if (prevHwLive === true && live === false) {
            autoSaveTodayReport('hardware-disconnected');
        }
        prevHwLive = live;

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

    // Isolates the trailing CONTIGUOUS run of records from a day's worth of
    // docs — i.e. the current test session, not "everything logged today."
    // Without this, a disconnect/reconnect on the bench means the new
    // static-test records get lumped in with an earlier run from the same
    // day that had real distance_m > 0 (e.g. a moving test, or
    // simulate-distance.js). resolveCurrentKm() would then find that old
    // non-zero distance data, commit the whole day to distance-based
    // bucketing, and every new static record (distance_m = 0) would pile
    // into BLK1 since 0 always satisfies ">= kmStart && < 200". A run break
    // is detected as any gap between consecutive records wider than
    // RUN_GAP_MINUTES — a disconnect/reconnect always produces one.
    const RUN_GAP_MINUTES = 5;
    function currentRunDocs(docs, gapMinutes = RUN_GAP_MINUTES) {
        if (docs.length <= 1) return docs;
        const gapMs = gapMinutes * 60000;
        for (let i = docs.length - 1; i > 0; i--) {
            const gap = new Date(docs[i].timestamp) - new Date(docs[i - 1].timestamp);
            if (gap > gapMs) return docs.slice(i);
        }
        return docs; // no gap found — the whole day is one continuous run
    }

    // Scans the ENTIRE historical dataset (not date-limited) for the index
    // of the most recent record that carried real distance_m — no matter
    // how long ago. Returns -1 only if distance_m has never once been
    // recorded across the whole database.
    function findLastDistanceAnchorIdx(docsAll) {
        for (let i = docsAll.length - 1; i >= 0; i--) {
            if (docsAll[i].distance_m != null && docsAll[i].distance_m >= 0) return i;
        }
        return -1;
    }

    // Given the index of a record known to carry real distance_m, pulls
    // together every doc from that record's own contiguous run (same
    // gap-detection rule as currentRunDocs) so the KM card is built only
    // from that one session's data — not blended with older/unrelated runs
    // before or after it.
    function runDocsAroundAnchor(docsAll, anchorIdx, gapMinutes = RUN_GAP_MINUTES) {
        const gapMs = gapMinutes * 60000;
        let start = anchorIdx, end = anchorIdx;
        while (start > 0 && (new Date(docsAll[start].timestamp) - new Date(docsAll[start - 1].timestamp)) <= gapMs) start--;
        while (end < docsAll.length - 1 && (new Date(docsAll[end + 1].timestamp) - new Date(docsAll[end].timestamp)) <= gapMs) end++;
        return docsAll.slice(start, end + 1);
    }

    // Last-resort fallback: no distance data for today, and none for the
    // most recent day either. Instead of leaving the report blank, walks
    // ALL of allDocs backward — regardless of date, even months old — for
    // the last time distance_m ever advanced, and renders that KM so the
    // page always shows at least one real KM's worth of data when any
    // distance-based session exists anywhere in history.
    function renderFromHistoricalAnchor(hwLive) {
        const anchorIdx = findLastDistanceAnchorIdx(allDocs);

        if (anchorIdx === -1) {
            document.getElementById('km-container').innerHTML = `
                <div class="no-data-banner">
                    <i class="fas fa-satellite-dish"></i>
                    <p>No distance data has ever been recorded.</p>
                    <p style="color:#94a3b8;font-size:12px">KM blocks require real distance_m against the uploaded route tape.</p>
                </div>`;
            setStatus(hwLive);
            setToolbarCount(0);
            lastCard = null;
            return;
        }

        const anchor  = allDocs[anchorIdx];
        const runDocs = runDocsAroundAnchor(allDocs, anchorIdx);
        const loc     = routeTapeKmForDistance(anchor.distance_m);

        if (!loc) {
            // That old session's distance had run past the end of the
            // CURRENTLY uploaded route tape — show the last KM closed out.
            const lastIdx = routeTapeKmNums.length - 1;
            const lastKm  = routeTapeKmNums[lastIdx];
            const kmStart = cumulativeDistanceStart(lastIdx);
            const lastKmDocs = runDocs.filter(d => d.distance_m != null && d.distance_m >= kmStart);
            const card = buildRouteTapeCard(lastKmDocs, lastKm, kmStart, false);
            card.historical = true;
            card.routeTapeExhausted = true;
            setStatus(hwLive);
            setToolbarCount(routeTapeKmNums.length);
            lastCard = card;
            renderCard(card);
            return;
        }

        const { km, kmIdx, kmStart, kmEnd } = loc;
        const kmDocsSlice = runDocs.filter(d => d.distance_m != null && d.distance_m >= kmStart && d.distance_m < kmEnd);
        const card = buildRouteTapeCard(kmDocsSlice, km, kmStart, false);
        card.historical = true;
        setStatus(hwLive);
        setToolbarCount(kmIdx);
        lastCard = card;
        renderCard(card);
    }

    async function updateReport() {
      try {
        // 0. Fetch limits config + axle/pivot P-class thresholds (keeps peak
        // distribution in sync with the Configuration page)
        await loadLimitsConfig();
        await loadThresholdsConfig();
        await loadAxisLimitsConfig();
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
            // Use today's data for live session — but only the current,
            // contiguous run (see currentRunDocs() above), not everything
            // logged today, so an earlier same-day run's distance_m can't
            // leak into a later, unrelated session.
            sessionDocs = currentRunDocs(todayDocs);
            historical = false;

            // ── Route-tape-driven KM sizing: real KM lengths from the RT
            // file, 200m blocks, resolved purely from each record's own
            // real distance_m (GPS in production, simulate-distance.js on
            // the bench). No record-count guessing anywhere — if the
            // session hasn't shown real distance movement yet, we wait. ──
            const resolved = resolveCurrentKm(sessionDocs);

            if (!resolved.usedDistance) {
                renderFromHistoricalAnchor(hwLive);
                return;
            }

            if (hwLive) {
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
            } else if (lastCard) {
                // Just went offline (or reloaded while a live card was
                // already cached) — freeze exactly what was last showing
                // live instead of recomputing a different "last completed
                // km" card. Only setStatus() runs here so the LIVE/OFFLINE
                // badge and auto-save-on-disconnect logic still fire
                // correctly; the card itself, its blocks, peak
                // distribution, and worst peaks are left untouched.
                setStatus(hwLive);
                renderCard(lastCard);
            } else {
                // No live card cached yet (e.g. fresh page load while
                // hardware is already offline) — fall back to showing the
                // last completed route-tape KM, same as before.
                const completedIdx = resolved.loc ? resolved.loc.kmIdx : routeTapeKmNums.length;
                if (completedIdx > 0) {
                    const lastIdx = completedIdx - 1;
                    const lastKm = routeTapeKmNums[lastIdx];
                    const kmStart = cumulativeDistanceStart(lastIdx);
                    const kmEnd = kmStart + routeTapeData.kmLengths[lastKm];
                    const lastKmDocs = sessionDocs.filter(d => d.distance_m != null && d.distance_m >= kmStart && d.distance_m < kmEnd);
                    const card = buildRouteTapeCard(lastKmDocs, lastKm, kmStart, false, todayDocs);
                    card.historical = false;
                    setStatus(hwLive);
                    setToolbarCount(completedIdx);
                    lastCard = card;
                    renderCard(card);
                } else {
                    const firstKm = routeTapeKmNums[0];
                    const kmDocsSlice = sessionDocs.filter(d => d.distance_m != null && d.distance_m < routeTapeData.kmLengths[firstKm]);
                    const card = buildRouteTapeCard(kmDocsSlice, firstKm, 0, false, todayDocs);
                    card.historical = false;
                    setStatus(hwLive);
                    setToolbarCount(0);
                    lastCard = card;
                    renderCard(card);
                }
            }
            return;
        }

        // 4. No data today → fallback to the most recent date that has data,
        // isolated to its own trailing contiguous run for the same reason.
        const lastDoc = allDocs[allDocs.length - 1];
        const lastDate = lastDoc.timestamp.slice(0, 10);
        const prevDayDocs = currentRunDocs(allDocs.filter(d => isSameDate(d.timestamp, lastDate)));

        const resolvedPrev = resolveCurrentKm(prevDayDocs);

        if (!resolvedPrev.usedDistance) {
            renderFromHistoricalAnchor(hwLive);
            return;
        }

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
      } catch (err) {
        // Surface the real error on-screen instead of silently leaving the
        // static HTML skeleton untouched — makes runtime bugs visible
        // without needing to open DevTools.
        console.error('[km] updateReport failed:', err);
        const container = document.getElementById('km-container');
        if (container) {
            container.innerHTML = `
                <div class="no-data-banner">
                    <i class="fas fa-triangle-exclamation"></i>
                    <p>Report failed to render.</p>
                    <p style="color:#dc2626;font-size:12px;font-family:monospace;white-space:pre-wrap;text-align:left;max-width:700px;margin:8px auto;">${(err && err.stack) ? err.stack : String(err)}</p>
                </div>`;
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

        const csvContent = buildFullDayCSVString(docsForDay, reportDate);
        if (!csvContent) return;

        archiveReportToServer(csvContent, reportDate, false);

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

    // Pure CSV-string builder — shared by the manual "Export CSV" button and
    // the silent auto-save paths below, so both always produce byte-identical
    // reports and both land in the exact same server-side archive folder.
    function buildFullDayCSVString(docsForDay, reportDate) {
        if (!docsForDay.length) return null;
        if (!(routeTapeData && routeTapeKmNums.length)) return null;

        const rows = [];

        // Threshold Configuration banner — always the very first line of any
        // generated report, so the CSV is self-documenting about which
        // limits were in effect without cross-referencing the Configuration
        // page separately. Mirrors server.js's thresholdConfigBanner().
        rows.push(thresholdConfigBannerLine());

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
            // Axis Limit Values driving the counts below (Configuration page,
            // /api/axis-limits: a1=Left, a2=Right, generic=Pivot). Printed so
            // the report is self-documenting about which cutoffs were active
            // when this KM was recorded.
            const axisLimitNote = side => {
                const bx = getAxisLimitBand(side, 'x'), by = getAxisLimitBand(side, 'y');
                if (!bx || !by) return 'not configured';
                return `V P1=${by.p1 ?? '—'}g P2=${by.p2 ?? '—'}g P3=${by.p3 ?? '—'}g | L P1=${bx.p1 ?? '—'}g P2=${bx.p2 ?? '—'}g P3=${bx.p3 ?? '—'}g`;
            };
            rows.push(`Axis Limit Values,Left: ${axisLimitNote('left')}`);
            rows.push(`,Right: ${axisLimitNote('right')}`);
            rows.push(`,Pivot: ${axisLimitNote('pivot')}`);
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

        return rows.join("\n");
    }

    // Posts a built CSV to the server archive endpoint — same endpoint, same
    // KMWISE_REPORTS_DIR folder, regardless of whether the save was a manual
    // "Export CSV" click or a silent auto-save. `auto`/`reason` just let the
    // server tag the filename so auto-saves are distinguishable from manual
    // exports on disk without living in a different folder.
    function archiveReportToServer(csvContent, reportDate, auto, reason) {
        return fetch('/api/reports/km-wise', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ csv: csvContent, reportDate, auto: !!auto, reason: reason || null })
        }).catch(e => console.warn('[km-wise] Server archive failed:', e));
    }

    // ─── Auto-save (hardware disconnect / system shutdown) ─────────────────────
    // Silently builds + archives *today's* report server-side — no download,
    // no prompt. Debounced per reportDate so a flapping connection (repeated
    // live→offline→live→offline within the same day) can't spam the reports
    // folder; at most one auto-save per date every AUTO_SAVE_COOLDOWN_MS.
    const AUTO_SAVE_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
    let lastAutoSaveAt = 0;
    let lastAutoSaveDate = null;

    function autoSaveTodayReport(reason) {
        try {
            if (!allDocs || !allDocs.length) return;
            if (!(routeTapeData && routeTapeKmNums.length)) return; // nothing sane to build yet

            const reportDate = getTodayStart();
            const now = Date.now();
            if (reportDate === lastAutoSaveDate && (now - lastAutoSaveAt) < AUTO_SAVE_COOLDOWN_MS) return;

            const docsForDay = allDocs.filter(d => isSameDate(d.timestamp, reportDate));
            if (!docsForDay.length) return;

            const csvContent = buildFullDayCSVString(docsForDay, reportDate);
            if (!csvContent) return;

            lastAutoSaveAt = now;
            lastAutoSaveDate = reportDate;
            console.log(`[km-wise] Auto-saving today's report (${reason})`);
            archiveReportToServer(csvContent, reportDate, true, reason);
        } catch (e) {
            console.warn('[km-wise] Auto-save skipped due to error:', e);
        }
    }

    // Safety net for "the system turns off" while the dashboard tab is still
    // open: browser/tab close, page navigation away, or the OS shutting down
    // the machine all fire pagehide/beforeunload before the page dies.
    // sendBeacon is used instead of fetch() because it's guaranteed to be
    // sent even as the page is being torn down — a normal fetch can get
    // cancelled mid-flight during unload.
    function beaconSaveTodayReport(reason) {
        try {
            if (!allDocs || !allDocs.length) return;
            if (!(routeTapeData && routeTapeKmNums.length)) return;
            if (typeof navigator.sendBeacon !== 'function') return;

            const reportDate = getTodayStart();
            const docsForDay = allDocs.filter(d => isSameDate(d.timestamp, reportDate));
            if (!docsForDay.length) return;

            const csvContent = buildFullDayCSVString(docsForDay, reportDate);
            if (!csvContent) return;

            const payload = new Blob(
                [JSON.stringify({ csv: csvContent, reportDate, auto: true, reason })],
                { type: 'application/json' }
            );
            navigator.sendBeacon('/api/reports/km-wise', payload);
        } catch (e) {
            // Nothing more we can do — the page is unloading.
        }
    }
    window.addEventListener('pagehide', () => beaconSaveTodayReport('page-closed'));
    window.addEventListener('beforeunload', () => beaconSaveTodayReport('page-closed'));

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