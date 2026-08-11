/* ============================================================
   common.js — Shared utilities for all datalogger  html_pages
   ============================================================ */

// localStorage key constants
const RM_THRESHOLDS_KEY  = 'railmonitor_thresholds';
const RM_LIMITS_KEY      = 'railmonitor_peak_limits';
const TEST_RUN_START_KEY = 'uabams_test_run_start';
const DARK_MODE_KEY      = 'railmonitor-dark';

// ── Dark Mode ───────────────────────────────────────────────────────────
// Shared across the shell (index.html) and every page loaded into its
// iframe — each is a separate document, so each needs this applied
// independently. The shell's own toggle button lives in index.js (only
// index.html has the button); this just applies/reads the saved
// preference so every page's own CSS reacts consistently.
const DarkMode = {
    isDark() { return localStorage.getItem(DARK_MODE_KEY) === '1'; },

    apply(dark) {
        document.body.classList.toggle('dark', dark);
        const icon = document.getElementById('darkModeIcon');
        if (icon) icon.className = dark ? 'fas fa-sun' : 'fas fa-moon';
    },

    set(dark) {
        localStorage.setItem(DARK_MODE_KEY, dark ? '1' : '0');
        DarkMode.apply(dark);
        // Tell the parent shell (if this page is inside its iframe) and/or
        // the iframe (if this page is the shell) to stay in sync.
        try {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage({ type: 'railmonitor-dark-mode', dark }, window.location.origin);
            }
            const iframe = document.getElementById('dynamicContent')?.querySelector('iframe');
            if (iframe) iframe.contentWindow.postMessage({ type: 'railmonitor-dark-mode', dark }, window.location.origin);
        } catch (e) { /* cross-origin or no iframe yet — ignore */ }
    },

    init() {
        DarkMode.apply(DarkMode.isDark());
    }
};

document.addEventListener('DOMContentLoaded', () => DarkMode.init());

// Receive the preference from the other side of the iframe boundary
// (shell → iframe on toggle, or iframe page → shell if it ever changes it).
window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin) return;
    if (e.data && e.data.type === 'railmonitor-dark-mode') DarkMode.apply(e.data.dark);
});

// ── Global Test Run state (persists across page navigation) ───────────────
const TestRun = {
    isRecording() { return !!localStorage.getItem(TEST_RUN_START_KEY); },
    startTime()   { const v = localStorage.getItem(TEST_RUN_START_KEY); return v ? new Date(v) : null; },

    start() {
        localStorage.setItem(TEST_RUN_START_KEY, new Date().toISOString());
        TestRun._syncUI();
    },

    stop() {
        const t = TestRun.startTime();
        localStorage.removeItem(TEST_RUN_START_KEY);
        TestRun._syncUI();
        return t;   // caller uses this as the "from" time
    },

    _timerRef: null,

    _syncUI() {
        const bar   = document.getElementById('globalTestBar');
        if (!bar) return;
        if (TestRun.isRecording()) {
            bar.style.display = 'flex';
            clearInterval(TestRun._timerRef);
            TestRun._timerRef = setInterval(() => {
                const el = document.getElementById('globalTestTimer');
                if (!el) return;
                const s = Math.round((Date.now() - TestRun.startTime()) / 1000);
                el.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
            }, 1000);
        } else {
            bar.style.display = 'none';
            clearInterval(TestRun._timerRef);
        }
    },

    init() { TestRun._syncUI(); }
};

// Auto-init on every page load
document.addEventListener('DOMContentLoaded', () => TestRun.init());

// Default values (mirror what configuration.html saves)
const DEFAULT_THRESHOLDS = {
    p1Min: 5, p1Max: 10,
    p2Min: 10, p2Max: 20,
    p3Min: 20
};

const DEFAULT_LIMITS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];

/** Load thresholds from localStorage, falling back to defaults on error. */
function loadStoredThresholds() {
    try {
        const saved = localStorage.getItem(RM_THRESHOLDS_KEY);
        return saved ? JSON.parse(saved) : { ...DEFAULT_THRESHOLDS };
    } catch (e) {
        console.error('Error loading thresholds:', e);
        return { ...DEFAULT_THRESHOLDS };
    }
}

/** Load peak limits from localStorage, falling back to defaults on error. */
function loadStoredLimits() {
    try {
        const saved = localStorage.getItem(RM_LIMITS_KEY);
        return saved ? JSON.parse(saved) : [...DEFAULT_LIMITS];
    } catch (e) {
        console.error('Error loading peak limits:', e);
        return [...DEFAULT_LIMITS];
    }
}

/** Persist thresholds to localStorage. */
function saveThresholds(thresholds) {
    localStorage.setItem(RM_THRESHOLDS_KEY, JSON.stringify(thresholds));
}

/** Persist peak limits to localStorage. */
function saveLimits(limits) {
    localStorage.setItem(RM_LIMITS_KEY, JSON.stringify(limits));
}

/* ============================================================
   ReportSaveTarget — remembers a chosen folder (e.g. on an external
   drive like the 1TB Geonix disk) and silently writes report exports
   there on every subsequent generate, instead of prompting a Save As
   dialog every time.

   Browsers cannot be pointed at an arbitrary path/drive letter by
   script — the File System Access API (Chrome/Edge only; no Firefox/
   Safari support as of this writing) is the only way to get a
   reusable, permission-granted folder handle, and even that still
   requires one explicit user gesture (showDirectoryPicker()) the
   first time. Once granted, the handle is persisted in IndexedDB
   (handles aren't structured-cloneable into localStorage) and reused
   silently as long as the browser still has permission for it — which
   normally survives across tabs/reloads on the same profile+origin,
   but not across a different computer or browser profile, since the
   permission and the handle are both local to where they were granted.
   ============================================================ */
const ReportSaveTarget = (() => {
    const DB_NAME = 'uabams_report_save_target';
    const STORE = 'handles';
    const KEY = 'reportsFolder';

    function isSupported() {
        return typeof window.showDirectoryPicker === 'function';
    }

    function openDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function getStoredHandle() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).get(KEY);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async function setStoredHandle(handle) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(handle, KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function verifyPermission(handle, forWrite) {
        const opts = forWrite ? { mode: 'readwrite' } : {};
        if ((await handle.queryPermission(opts)) === 'granted') return true;
        return (await handle.requestPermission(opts)) === 'granted';
    }

    /** Returns the remembered folder handle if one exists and still has write permission, else null (never prompts). */
    async function getExistingHandle() {
        if (!isSupported()) return null;
        const handle = await getStoredHandle();
        if (!handle) return null;
        if (!(await verifyPermission(handle, true))) return null;
        return handle;
    }

    /** Prompts the user to pick a folder (e.g. a location on the Geonix drive) and remembers it for future exports. */
    async function chooseFolder() {
        if (!isSupported()) throw new Error('This browser does not support choosing a save folder (Chrome/Edge only).');
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        await setStoredHandle(handle);
        return handle;
    }

    async function clearFolder() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Writes `blob` as `filename` into the remembered folder. Returns true
     * if it was written there; false if no folder is remembered/granted
     * (caller should fall back to a normal browser download in that case).
     */
    async function saveBlob(blob, filename) {
        const dirHandle = await getExistingHandle();
        if (!dirHandle) return false;

        const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
    }

    return { isSupported, getExistingHandle, chooseFolder, clearFolder, saveBlob };
})();
window.ReportSaveTarget = ReportSaveTarget;

// Shared "Save Folder" button wiring — any page with a
// #reportSaveFolderStatus element and a chooseReportSaveFolder() button can
// use these; the chosen folder handle is shared across every page via the
// same IndexedDB store, so picking it once on any page covers all of them.
async function chooseReportSaveFolder() {
    try {
        const handle = await ReportSaveTarget.chooseFolder();
        showReportSaveStatus(`Saving future exports to "${handle.name}"`, false);
    } catch (e) {
        if (e.name !== 'AbortError') { // user just cancelled the picker — not an error
            console.error('[chooseReportSaveFolder] Failed:', e);
            showReportSaveStatus(e.message || 'Could not set a save folder.', true);
        }
    }
}
window.chooseReportSaveFolder = chooseReportSaveFolder;

function showReportSaveStatus(text, isError) {
    const el = document.getElementById('reportSaveFolderStatus');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#dc2626' : '#64748b';
}
window.showReportSaveStatus = showReportSaveStatus;

// Reflect whether a save folder is already remembered as soon as any page
// with the status element loads, rather than only after the user explicitly
// picks one this session.
(async () => {
    if (!document.getElementById('reportSaveFolderStatus')) return; // page doesn't have the UI for this
    if (!ReportSaveTarget.isSupported()) {
        showReportSaveStatus('Direct-to-folder saving needs Chrome/Edge.', false);
        return;
    }
    const handle = await ReportSaveTarget.getExistingHandle();
    if (handle) showReportSaveStatus(`Saving exports to "${handle.name}"`, false);
})();

/**
 * Start a running clock that updates DOM elements every second.
 * @param {string} timeId  - element id to receive the time string
 * @param {string} [dateId] - element id to receive the date string (optional)
 * @param {'long'|'short'} [dateFormat='short']
 *   'short' → "Mar 17, 2026"
 *   'long'  → "Tuesday, March 17"
 */
function startClock(timeId, dateId, dateFormat) {
    function tick() {
        const now = new Date();
        const timeEl = document.getElementById(timeId);
        if (timeEl) timeEl.textContent = now.toLocaleTimeString('en-US', { hour12: false });

        if (dateId) {
            const dateEl = document.getElementById(dateId);
            if (dateEl) {
                const fmt = dateFormat === 'long'
                    ? { weekday: 'long', month: 'long', day: 'numeric' }
                    : { month: 'short', day: 'numeric', year: 'numeric' };
                dateEl.textContent = now.toLocaleDateString('en-US', fmt);
            }
        }
    }
    tick();
    setInterval(tick, 1000);
}
