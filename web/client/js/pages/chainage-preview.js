/* chainage-preview.js — standalone, read-only chainage comparison tool.
 * Does not touch acceleration-km.js, server GPS handling, or any existing
 * report. Uses the existing, unmodified /api/monitoring/all endpoint for
 * real historical data, and a separate /api/chainage-preview backend for
 * the uploaded route-tape file.
 */

const API = window.location.origin;

// ── Today's existing logic, duplicated locally (not imported) to keep this
// page fully decoupled from acceleration-km.js, per the plan's scope.
const RECORDS_PER_BLOCK = 50;
const BLOCKS_PER_KM = 7;
const RECORDS_PER_KM = RECORDS_PER_BLOCK * BLOCKS_PER_KM;

const BLOCK_LENGTH_M = 200;

let chainagePreview = null; // { sourceFileName, uploadedAt, rows, kmLengths }

// ── Upload ───────────────────────────────────────────────────────────────
async function uploadChainageFile() {
    const input = document.getElementById('chainageFile');
    if (!input.files.length) { setUploadStatus('Please choose a file first.'); return; }

    const form = new FormData();
    form.append('file', input.files[0]);

    setUploadStatus('Uploading…');
    try {
        const res = await fetch(`${API}/api/chainage-preview`, { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        chainagePreview = data.chainagePreview;
        renderUploadStatus();
        renderParsedRows();
        document.getElementById('compareCard').style.display = '';
    } catch (e) {
        setUploadStatus('Upload failed: ' + e.message);
    }
}
window.uploadChainageFile = uploadChainageFile;

async function clearChainageFile() {
    try {
        await fetch(`${API}/api/chainage-preview`, { method: 'DELETE' });
    } catch (_) {}
    chainagePreview = null;
    document.getElementById('parsedRowsCard').style.display = 'none';
    document.getElementById('compareCard').style.display = 'none';
    setUploadStatus('No file uploaded yet.');
}
window.clearChainageFile = clearChainageFile;

function setUploadStatus(msg) {
    document.getElementById('uploadStatus').textContent = msg;
}

function renderUploadStatus() {
    if (!chainagePreview) { setUploadStatus('No file uploaded yet.'); return; }
    const kmCount = Object.keys(chainagePreview.kmLengths).length;
    setUploadStatus(
        `${chainagePreview.sourceFileName} — ${chainagePreview.rows.length} rows, ${kmCount} KM lengths derived — uploaded ${chainagePreview.uploadedAt}`
    );
}

function renderParsedRows() {
    const card = document.getElementById('parsedRowsCard');
    const body = document.getElementById('parsedRowsBody');
    if (!chainagePreview || !chainagePreview.rows.length) { card.style.display = 'none'; return; }
    card.style.display = '';
    body.innerHTML = chainagePreview.rows.map(r => `
        <tr>
            <td>${r.km}</td>
            <td>${r.meter}</td>
            <td>${r.featureCode}</td>
            <td>${r.lat != null ? r.lat.toFixed(6) : '—'}</td>
            <td>${r.lon != null ? r.lon.toFixed(6) : '—'}</td>
        </tr>
    `).join('');
}

// ── Load on page open (in case a file was already uploaded this session) ──
async function loadExistingPreview() {
    try {
        const res = await fetch(`${API}/api/chainage-preview`);
        const data = await res.json();
        if (data) {
            chainagePreview = data;
            renderUploadStatus();
            renderParsedRows();
            document.getElementById('compareCard').style.display = '';
        }
    } catch (e) { console.warn('[chainage-preview] load failed:', e.message); }
}
loadExistingPreview();

// ── Block-sizing math ────────────────────────────────────────────────────
function blocksForKmLength(kmLengthM) {
    const full = Math.floor(kmLengthM / BLOCK_LENGTH_M);
    const rem  = kmLengthM % BLOCK_LENGTH_M;
    const lens = Array(full).fill(BLOCK_LENGTH_M);
    if (rem > 0) lens.push(rem);
    return lens; // e.g. 987 -> [200,200,200,200,187]
}

// Approximation only — no per-record GPS/chainage position exists yet in
// this preview, so each KM's already-fetched record slice is proportionally
// redistributed across the chainage-derived block lengths (weighted by
// block length, not fixed count). True per-record placement requires the
// GPS-snapping work planned separately.
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

// ── Data fetch (reuses the existing, unmodified endpoint) ───────────────
async function fetchAllMonitoringData() {
    const res = await fetch(`${API}/api/monitoring/all`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    data.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return data;
}

// ── Comparison ────────────────────────────────────────────────────────────
async function runComparison() {
    const dateEl = document.getElementById('reportDate');
    const statusEl = document.getElementById('compareStatus');
    const gridEl = document.getElementById('compareGrid');

    if (!chainagePreview) { statusEl.textContent = 'Upload a chainage file first.'; return; }
    if (!dateEl.value) { statusEl.textContent = 'Pick a date first.'; return; }

    statusEl.textContent = 'Loading…';
    gridEl.innerHTML = '';

    let allDocs;
    try {
        allDocs = await fetchAllMonitoringData();
    } catch (e) {
        statusEl.textContent = 'Failed to load monitoring data: ' + e.message;
        return;
    }

    const docsForDay = allDocs.filter(d => d.timestamp.startsWith(dateEl.value));
    if (!docsForDay.length) {
        statusEl.textContent = `No accelerometer data found for ${dateEl.value}.`;
        return;
    }

    // ── Today's logic: fixed RECORDS_PER_KM chunks ──────────────────────
    const totalKmsToday = Math.ceil(docsForDay.length / RECORDS_PER_KM);
    const todayBlocks = [];
    for (let km = 0; km < totalKmsToday; km++) {
        const start = km * RECORDS_PER_KM;
        const end   = Math.min(start + RECORDS_PER_KM, docsForDay.length);
        const kmDocs = docsForDay.slice(start, end);
        const doneBlocks = Math.floor(kmDocs.length / RECORDS_PER_BLOCK);
        todayBlocks.push({ kmIndex: km + 1, totalRecords: kmDocs.length, blockCount: doneBlocks, discarded: kmDocs.length - doneBlocks * RECORDS_PER_BLOCK });
    }

    // ── Chainage-based logic: real KM lengths from the uploaded file ────
    const kmNumbers = Object.keys(chainagePreview.kmLengths).map(Number).sort((a, b) => a - b);
    const chainageBlocks = [];
    let recordCursor = 0;
    for (const kmNum of kmNumbers) {
        if (recordCursor >= docsForDay.length) break;
        const kmLengthM = chainagePreview.kmLengths[kmNum];
        const blockLengths = blocksForKmLength(kmLengthM);
        // Approximate this KM's record slice the same way today's logic does
        // (next RECORDS_PER_KM records), then redistribute by block weight —
        // keeps the comparison apples-to-apples record-count-wise.
        const kmDocs = docsForDay.slice(recordCursor, recordCursor + RECORDS_PER_KM);
        recordCursor += kmDocs.length;
        const blockSplits = splitRecordsByBlockWeight(kmDocs, blockLengths);
        chainageBlocks.push({
            kmNum, kmLengthM, totalRecords: kmDocs.length,
            blocks: blockLengths.map((len, i) => ({ lengthM: len, recordCount: blockSplits[i].length, isShort: len < BLOCK_LENGTH_M })),
        });
    }

    statusEl.textContent = `Showing ${docsForDay.length} records for ${dateEl.value} — ${totalKmsToday} KM(s) under today's logic, ${chainageBlocks.length} KM(s) matched from the chainage file.`;

    gridEl.innerHTML = `
        <div class="compare-col today">
            <h3>Today's Logic (fixed ${RECORDS_PER_KM} records/KM, ${BLOCKS_PER_KM} blocks of ${RECORDS_PER_BLOCK})</h3>
            ${todayBlocks.map(k => `
                <div style="margin-bottom:8px;">
                    <strong>KM ${k.kmIndex}</strong> — ${k.totalRecords} records, ${k.blockCount}/${BLOCKS_PER_KM} full blocks computed
                    ${k.discarded > 0 ? `<span class="block-chip short">${k.discarded} trailing records discarded</span>` : ''}
                </div>
            `).join('')}
        </div>
        <div class="compare-col chainage">
            <h3>Chainage-Based Logic (real KM lengths, ≤200m blocks)</h3>
            ${chainageBlocks.map(k => `
                <div style="margin-bottom:8px;">
                    <strong>KM ${k.kmNum}</strong> — real length ${k.kmLengthM}m, ${k.totalRecords} records
                    <div>${k.blocks.map((b, i) => `<span class="block-chip${b.isShort ? ' short' : ''}">B${i+1}: ${b.lengthM}m / ${b.recordCount} rec</span>`).join('')}</div>
                </div>
            `).join('')}
        </div>
    `;
}
window.runComparison = runComparison;
