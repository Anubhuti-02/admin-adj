require('dotenv').config();
const express   = require('express');
const http      = require('http');
const https     = require('https');
const socketIo  = require('socket.io');
const mqtt      = require('mqtt');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const { DateTime } = require("luxon");
const net           = require('net');
const multer        = require('multer');

// ── Timezone configuration ─────────────────────────────────────────────────
const TIMEZONE = "Asia/Kolkata";
function getTimezoneTimestamp() {
    return DateTime.now().setZone(TIMEZONE).toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS");
}

// ═════════════════════════════════════════════════════════════════════════
// ── SENSOR REGISTRY — single source of truth for every accelerometer ──────
// To add a new accelerometer in future: add one entry here, assign it an
// unused packetType byte, and everything else (DB inserts, health tracking,
// MQTT topics, ODR config, REST endpoints) picks it up automatically.
// ═════════════════════════════════════════════════════════════════════════
const SENSORS = [
    {
        id:          'left',                 // device_id / sensor column value in DB
        label:       'Left (S1)',
        packetType:  0x01,                   // binary MQTT packet type byte
        healthKey:   'adxl345_s1',            // key inside system-health payload
        odrKey:      'accel1',                // key inside odrConfig
        mqttTopic:   'adj/datalogger/sensors/left',
        topicMatch:  t => t.includes('left'), // for legacy text-protocol topic routing
    },
    {
        id:          'right',
        label:       'Right (S2)',
        packetType:  0x02,
        healthKey:   'adxl345_s2',
        odrKey:      'accel2',
        mqttTopic:   'adj/datalogger/sensors/right',
        topicMatch:  t => t.includes('right'),
    },
    {
        id:          'pivot',
        label:       'Pivot (S3)',
        packetType:  0x04,                   // 0x03 is reserved for the EVENT packet type
        healthKey:   'adxl345_s3',
        odrKey:      'accel3',
        mqttTopic:   'adj/datalogger/sensors/pivot',
        topicMatch:  t => t.includes('pivot'),
    },
    {
        id:          'aux',
        label:       'Auxiliary (S4)',
        packetType:  0x05,
        healthKey:   'adxl345_s4',
        odrKey:      'accel4',
        mqttTopic:   'adj/datalogger/sensors/aux',
        topicMatch:  t => t.includes('aux'),
    },
];

const SENSOR_IDS = SENSORS.map(s => s.id);                                   // ['left','right','pivot']
const sensorById  = id => SENSORS.find(s => s.id === id);
const sensorByPacketType = pt => SENSORS.find(s => s.packetType === pt);

// ── ODR config persistence ──────────────────────────────────────────────
const ODR_CONFIG_FILE = path.join(__dirname, 'odr_config.json');
const FALLBACK_ODR_HZ = 100;

function defaultOdrShape() {
    const shape = {};
    SENSORS.forEach(s => { shape[s.odrKey] = FALLBACK_ODR_HZ; });
    return shape;
}

function loadOdrConfig() {
    const fallback = defaultOdrShape();
    try {
        if (fs.existsSync(ODR_CONFIG_FILE)) {
            const saved = JSON.parse(fs.readFileSync(ODR_CONFIG_FILE, 'utf8'));
            return {
                current:  { ...fallback, ...(saved.current  || {}) },
                defaults: { ...fallback, ...(saved.defaults || {}) },
            };
        }
    } catch (e) { console.error('odr_config.json read error:', e.message); }
    return { current: { ...fallback }, defaults: { ...fallback } };
}
function saveOdrConfig(cfg) {
    try { fs.writeFileSync(ODR_CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
    catch (e) { console.error('odr_config.json write error:', e.message); }
}

let odrStore = loadOdrConfig();
const odrConfig = odrStore.current;
console.log('[ODR] Config loaded:', JSON.stringify(odrStore));

const sensorLastSeen = {};
const odrCounters    = {};
SENSORS.forEach(s => { sensorLastSeen[s.id] = 0; odrCounters[s.id] = 0; });

const SENSOR_TIMEOUT_MS = 10000;

function shouldEmit(sensorId) {
    const s = sensorById(sensorId);
    if (!s) return true;
    const odr    = odrConfig[s.odrKey] || 200;
    const factor = Math.round(200 / odr);
    odrCounters[sensorId] = (odrCounters[sensorId] + 1) % factor;
    return odrCounters[sensorId] === 0;
}

// ── Persistent JSON fallback ──────────────────────────────────────────────
const PEAKS_LOG_FILE     = path.join(__dirname, 'peaks_log.json');
const LIMITS_CONFIG_FILE = path.join(__dirname, 'limits_config.json');
const AXIS_LIMITS_FILE = path.join(__dirname, 'axis_limits.json');
const DEFAULT_AXIS_LIMIT = 2;
const AXIS_LIMIT_BANDS = ['p1', 'p2', 'p3'];

function defaultAxisBand() {
    return { p1: DEFAULT_AXIS_LIMIT, p2: DEFAULT_AXIS_LIMIT, p3: DEFAULT_AXIS_LIMIT };
}

function defaultAxisLimitsShape() {
    return {
        generic: { x: defaultAxisBand(), y: defaultAxisBand(), z: defaultAxisBand() },
        a1:      { x: defaultAxisBand(), y: defaultAxisBand(), z: defaultAxisBand() },
        a2:      { x: defaultAxisBand(), y: defaultAxisBand(), z: defaultAxisBand() },
    };
}

function coerceAxisBand(saved, fallback) {
    if (saved != null && typeof saved === 'object') {
        return {
            p1: typeof saved.p1 === 'number' ? saved.p1 : fallback.p1,
            p2: typeof saved.p2 === 'number' ? saved.p2 : fallback.p2,
            p3: typeof saved.p3 === 'number' ? saved.p3 : fallback.p3,
        };
    }
    if (typeof saved === 'number') return { p1: saved, p2: saved, p3: saved };
    return fallback;
}

function loadAxisLimits() {
    try {
        if (fs.existsSync(AXIS_LIMITS_FILE)) {
            const saved = JSON.parse(fs.readFileSync(AXIS_LIMITS_FILE, 'utf8'));
            const defaults = defaultAxisLimitsShape();
            const out = {};
            for (const unit of ['generic', 'a1', 'a2']) {
                out[unit] = {};
                for (const axis of ['x', 'y', 'z']) {
                    out[unit][axis] = coerceAxisBand(
                        saved[unit] && saved[unit][axis],
                        defaults[unit][axis]
                    );
                }
            }
            return out;
        }
    } catch (e) { console.error('axis_limits.json read error:', e.message); }
    return defaultAxisLimitsShape();
}
function saveAxisLimitsToFile(cfg) {
    try { fs.writeFileSync(AXIS_LIMITS_FILE, JSON.stringify(cfg, null, 2)); }
    catch (e) { console.error('axis_limits.json write error:', e.message); }
}
let axisLimitsConfig = loadAxisLimits();

const FALLBACK_IMPACT_DETECTION_THRESHOLD_G = 2;

function flattenAxisLimitUnit(unitCfg) {
    const out = [];
    for (const axisBands of Object.values(unitCfg || {})) {
        if (axisBands && typeof axisBands === 'object') out.push(...Object.values(axisBands));
        else out.push(axisBands);
    }
    return out;
}

function impactDetectionThreshold() {
    const all = [
        pClassThresholds?.p1Min,
        pivotClassThresholds?.p1Min,
    ].filter(v => typeof v === 'number' && !isNaN(v) && v > 0);
    return all.length ? Math.min(...all) : FALLBACK_IMPACT_DETECTION_THRESHOLD_G;
}

function axisLimitUnitForSensor(sensorId) {
    return sensorId === 'left' ? 'a1' : sensorId === 'right' ? 'a2' : 'generic';
}

function crossesAxisLimit(sensorId, x, y) {
    const unit = axisLimitUnitForSensor(sensorId);
    const cfg = axisLimitsConfig[unit];
    if (!cfg) return false;
    const xLimit = cfg.x?.p1;
    const yLimit = cfg.y?.p1;
    const xHit = typeof xLimit === 'number' && !isNaN(xLimit) && Math.abs(x) >= xLimit;
    const yHit = typeof yLimit === 'number' && !isNaN(yLimit) && Math.abs(y) >= yLimit;
    return xHit || yHit;
}

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
        for (const addr of iface) {
            if (addr.family === 'IPv4' && !addr.internal) return addr.address;
        }
    }
    return '127.0.0.1';
}
const LOCAL_IP = getLocalIP();

const PEAKS_LOG_MAX_ENTRIES = 2000;

function loadPeaksLog() {
    try {
        if (fs.existsSync(PEAKS_LOG_FILE)) return JSON.parse(fs.readFileSync(PEAKS_LOG_FILE, 'utf8'));
    } catch (e) { console.error('peaks_log.json read error:', e.message); }
    return [];
}
function savePeaksLog(log) {
    try { fs.writeFileSync(PEAKS_LOG_FILE, JSON.stringify(log, null, 2)); }
    catch (e) { console.error('peaks_log.json write error:', e.message); }
}
function pushToPeaksLog(impact) {
    peaksLog.push(impact);
    if (peaksLog.length > PEAKS_LOG_MAX_ENTRIES) {
        peaksLog.splice(0, peaksLog.length - PEAKS_LOG_MAX_ENTRIES);
    }
}
let peaksLog = loadPeaksLog();
if (peaksLog.length > PEAKS_LOG_MAX_ENTRIES) {
    peaksLog = peaksLog.slice(-PEAKS_LOG_MAX_ENTRIES);
    savePeaksLog(peaksLog);
}
console.log(`Loaded ${peaksLog.length} existing impact records from JSON fallback`);

function loadLimitsConfig() {
    try {
        if (fs.existsSync(LIMITS_CONFIG_FILE)) return JSON.parse(fs.readFileSync(LIMITS_CONFIG_FILE, 'utf8'));
    } catch (e) { console.error('limits_config.json read error:', e.message); }
    return { uml: null, limitClass: null, bandpass: null, sampleDistanceMm: null };
}
function saveLimitsConfig(cfg) {
    try { fs.writeFileSync(LIMITS_CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
    catch (e) { console.error('limits_config.json write error:', e.message); }
}
let limitsConfig = loadLimitsConfig();
console.log('[limits] Config loaded:', JSON.stringify(limitsConfig));

const ROUTE_CONFIG_FILE = path.join(__dirname, 'route_config.json');
function loadRouteConfig() {
    try {
        if (fs.existsSync(ROUTE_CONFIG_FILE)) return JSON.parse(fs.readFileSync(ROUTE_CONFIG_FILE, 'utf8'));
    } catch (e) { console.error('route_config.json read error:', e.message); }
    return { origin: null, destination: null };
}
function saveRouteConfig(cfg) {
    try { fs.writeFileSync(ROUTE_CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
    catch (e) { console.error('route_config.json write error:', e.message); }
}
let routeConfig = loadRouteConfig();
console.log('[route] Config loaded:', JSON.stringify(routeConfig));

function routePrefix() {
    if (!routeConfig.origin || !routeConfig.destination) return '';
    return `${routeConfig.origin}-${routeConfig.destination}_`;
}

const SECTION_CONFIG_FILE = path.join(__dirname, 'section_config.json');
function loadSectionConfig() {
    try {
        if (fs.existsSync(SECTION_CONFIG_FILE)) return JSON.parse(fs.readFileSync(SECTION_CONFIG_FILE, 'utf8'));
    } catch (e) { console.error('section_config.json read error:', e.message); }
    return { railway: null, divisionCode: null, division: null, section: null, line: null, block: null, railLH: null, railRH: null };
}
function saveSectionConfig(cfg) {
    try { fs.writeFileSync(SECTION_CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
    catch (e) { console.error('section_config.json write error:', e.message); }
}
let sectionConfig = loadSectionConfig();
console.log('[section] Config loaded:', JSON.stringify(sectionConfig));

const CHAINAGE_PREVIEW_FILE = path.join(__dirname, 'chainage_preview.json');
function loadChainagePreview() {
    try {
        if (fs.existsSync(CHAINAGE_PREVIEW_FILE)) return JSON.parse(fs.readFileSync(CHAINAGE_PREVIEW_FILE, 'utf8'));
    } catch (e) { console.error('chainage_preview.json read error:', e.message); }
    return null;
}
function saveChainagePreview(data) {
    try { fs.writeFileSync(CHAINAGE_PREVIEW_FILE, JSON.stringify(data, null, 2)); }
    catch (e) { console.error('chainage_preview.json write error:', e.message); }
}
let chainagePreview = loadChainagePreview();
console.log('[chainage-preview] Loaded:', chainagePreview ? `${chainagePreview.rows.length} rows` : 'none');

// ── Report archival — on-demand export archives + continuous raw log ──────
const GEONIX_LABEL = 'Geonix PowerShell S3 - PHDD';

function findGeonixMountPoint() {
    try {
        const byLabelPath = `/dev/disk/by-label/${GEONIX_LABEL.replace(/ /g, '\\x20')}`;
        if (!fs.existsSync(byLabelPath)) return null;
        const devicePath = fs.realpathSync(byLabelPath);

        const mounts = fs.readFileSync('/proc/mounts', 'utf8');
        for (const line of mounts.split('\n')) {
            const [device, mountPoint] = line.split(' ');
            if (device && fs.existsSync(device) && fs.realpathSync(device) === devicePath) {
                return mountPoint.replace(/\\040/g, ' ');
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}

// ── Live "is the drive actually here right now" check ─────────────────────
// Re-checked on every archiver tick (not just once at boot) so a mid-run
// disconnect just causes that hour's cycle to skip — the setInterval timers
// themselves never stop — and the very next tick after the drive reappears
// resumes writing normally, with no restart required.
function geonixCurrentlyMounted() {
    return !!findGeonixMountPoint();
}

function resolveReportsDir() {
    if (process.env.REPORTS_DIR_OVERRIDE) return process.env.REPORTS_DIR_OVERRIDE;

    const liveMount = findGeonixMountPoint();
    if (liveMount) {
        console.log(`[reports] Geonix drive found mounted at ${liveMount}`);
        return path.join(liveMount, 'reports');
    }

    console.warn(`[reports] Geonix drive (label "${GEONIX_LABEL}") not found mounted anywhere — falling back to local reports/ folder.`);
    return path.join(__dirname, 'reports');
}
const REPORTS_DIR         = resolveReportsDir();

const IMPACT_REPORTS_DIR  = path.join(REPORTS_DIR, 'impact_events');
const TESTRUN_REPORTS_DIR = path.join(REPORTS_DIR, 'test_runs');
const KMWISE_REPORTS_DIR  = path.join(REPORTS_DIR, 'km_wise');
const RAW_LOG_DIR         = path.join(REPORTS_DIR, 'raw_log');
const RAW_MONITORING_BACKUP_DIR = path.join(REPORTS_DIR, 'raw_monitoring_backup');

[IMPACT_REPORTS_DIR, TESTRUN_REPORTS_DIR, KMWISE_REPORTS_DIR, RAW_LOG_DIR, RAW_MONITORING_BACKUP_DIR].forEach(d => {
    try { fs.mkdirSync(d, { recursive: true }); }
    catch (e) { console.error(`[reports] Could not create ${d}:`, e.message); }
});

function archiveTimestamp() {
    return getTimezoneTimestamp().slice(0, 19).replace('T', '_').replace(/:/g, '-');
}

const latestSensorReading = {};
const SENSOR_COLUMN_PAIR = { left: 'AB-L', right: 'AB-R', pivot: 'TRC-P', aux: 'TV-P' };
const RAW_LOG_HEADER = 'Counter,Block,Railway,Division code,Division,Section,Line,SPD,KM,Meter,Millimeter,AB-L-VERT,AB-L-LAT,AB-R-VERT,AB-R-LAT,TRC-P-VERT,TRC-P-LAT,TV-P-VERT,TV-P-LAT,Rail: LH,Rail: RH,GPS Lat,GPS Lon\n';
const RAW_LOG_COUNTER_START = 100000;
const RAW_LOG_COUNTER_STEP  = 250;
let rawLogCounter = RAW_LOG_COUNTER_START;
let rawLogCurrentFile = null;

function appendRawLog(sensorId, row) {
    try {
        latestSensorReading[sensorId] = { x: row.x, y: row.y };

        const dateStr = getTimezoneTimestamp().slice(0, 10);
        const file = path.join(RAW_LOG_DIR, `${routePrefix()}${dateStr}.csv`);
        const isNew = !fs.existsSync(file);
        if (isNew || file !== rawLogCurrentFile) { rawLogCounter = RAW_LOG_COUNTER_START; rawLogCurrentFile = file; }
        else { rawLogCounter += RAW_LOG_COUNTER_STEP; }

        const totalM = totalDistanceM || 0;
        const km = Math.floor(totalM / 1000);
        const m  = Math.floor(totalM % 1000);
        const mm = Math.round((totalM % 1) * 1000);

        const cols = {};
        Object.values(SENSOR_COLUMN_PAIR).forEach(pair => { cols[`${pair}-VERT`] = ''; cols[`${pair}-LAT`] = ''; });
        Object.entries(SENSOR_COLUMN_PAIR).forEach(([sid, pair]) => {
            const last = latestSensorReading[sid];
            if (last) { cols[`${pair}-VERT`] = last.y; cols[`${pair}-LAT`] = last.x; }
        });

        const gpsLat = lastGpsCoord?.lat ?? '';
        const gpsLon = lastGpsCoord?.lng ?? '';
        const spd    = lastGpsCoord?.speedKmh ?? '';

        const line = [
            rawLogCounter,
            sectionConfig.block ?? '', sectionConfig.railway ?? '',
            sectionConfig.divisionCode ?? '', sectionConfig.division ?? '',
            sectionConfig.section ?? '', sectionConfig.line ?? '',
            spd,
            km, m, mm,
            cols['AB-L-VERT'], cols['AB-L-LAT'], cols['AB-R-VERT'], cols['AB-R-LAT'],
            cols['TRC-P-VERT'], cols['TRC-P-LAT'], cols['TV-P-VERT'], cols['TV-P-LAT'],
            sectionConfig.railLH ?? '', sectionConfig.railRH ?? '',
            gpsLat, gpsLon,
        ].join(',') + '\n';

        fs.appendFileSync(file, isNew ? RAW_LOG_HEADER + line : line);
    } catch (e) { console.error('[raw_log] append failed:', e.message); }
}

// ── Express / Socket.IO / Postgres ─────────────────────────────────────────
const { Pool } = require('pg');
const pool = new Pool({
    host:     process.env.PG_HOST     || 'localhost',
    port:     parseInt(process.env.PG_PORT) || 5432,
    database: process.env.PG_DB       || 'uabams',
    user:     process.env.PG_USER     || 'uabams_user',
    password: process.env.PG_PASSWORD || 'uabams123',
});

const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function loadNotifyEmails() {
    try {
        const result = await pool.query(
            `SELECT emails, min_severity, cooldown_sec, enabled 
             FROM notification_config LIMIT 1`
        );
        if (result.rows.length) {
            const row = result.rows[0];
            return {
                emails: row.emails || [],
                minSeverity: row.min_severity || 'MEDIUM',
                cooldownSec: row.cooldown_sec || 60,
                enabled: row.enabled !== undefined ? row.enabled : true,
            };
        }
    } catch (e) {
        console.error('[notify] DB load error, falling back to JSON:', e.message);
    }
    const NOTIFY_FILE = path.join(__dirname, 'notify_emails.json');
    try {
        if (fs.existsSync(NOTIFY_FILE)) {
            const data = JSON.parse(fs.readFileSync(NOTIFY_FILE, 'utf8'));
            return data;
        }
    } catch (e) { /* ignore */ }
    return { emails: [], minSeverity: 'MEDIUM', cooldownSec: 60, enabled: true };
}

async function saveNotifyEmails(cfg) {
    try {
        await pool.query(
            `UPDATE notification_config 
             SET emails = $1, 
                 min_severity = $2, 
                 cooldown_sec = $3, 
                 enabled = $4,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = (SELECT id FROM notification_config LIMIT 1)`,
            [cfg.emails || [], cfg.minSeverity || 'MEDIUM', cfg.cooldownSec ?? 60, cfg.enabled !== undefined ? cfg.enabled : true]
        );
        console.log('[notify] Config saved to DB');
    } catch (e) {
        console.error('[notify] DB save error, falling back to JSON:', e.message);
        const NOTIFY_FILE = path.join(__dirname, 'notify_emails.json');
        fs.writeFileSync(NOTIFY_FILE, JSON.stringify(cfg, null, 2));
    }
}

let notifyConfig = { emails: [], minSeverity: 'MEDIUM', cooldownSec: 60, enabled: true };

(async function initNotifyConfig() {
    notifyConfig = await loadNotifyEmails();
    console.log('[notify] Config loaded:', notifyConfig);
})();

const lastEmailAt = {};

function severityRank(s) {
    const map = { LOW: 1, MEDIUM: 2, HIGH: 3 };
    return map[s] || 0;
}

async function maybeSendImpactEmail(impact) {
     if (!notifyConfig.enabled) return;
    if (!notifyConfig.emails.length) return;
    if (severityRank(impact.severity) < severityRank(notifyConfig.minSeverity)) return;

    const now = Date.now();
    const last = lastEmailAt[impact.sensor] || 0;
    if (now - last < notifyConfig.cooldownSec * 1000) return;
    lastEmailAt[impact.sensor] = now;

    const mapsLink = (lastGpsCoord?.lat && lastGpsCoord?.lng)
        ? `https://maps.google.com/?q=${lastGpsCoord.lat},${lastGpsCoord.lng}` : 'No GPS fix';

    const html = `
        <h3>Impact Alert — ${impact.p_class || '—'} (${impact.severity})</h3>
        <table>
            <tr><td>Time (IST)</td><td>${getTimezoneTimestamp()}</td></tr>
            <tr><td>Sensor</td><td>${impact.sensor}</td></tr>
            <tr><td>Peak</td><td>${impact.peak_g.toFixed(3)} g</td></tr>
            <tr><td>Class</td><td>${impact.p_class || '—'}</td></tr>
            <tr><td>Distance</td><td>${(impact.distance_m/1000).toFixed(3)} km</td></tr>
            <tr><td>GPS</td><td><a href="${mapsLink}">${mapsLink}</a></td></tr>
            <tr><td>RMS V/L</td><td>${impact.rmsV?.toFixed(3)} / ${impact.rmsL?.toFixed(3)}</td></tr>
            <tr><td>SD V/L</td><td>${impact.sdV?.toFixed(3)} / ${impact.sdL?.toFixed(3)}</td></tr>
            <tr><td>Axes (X/Y/Z)</td><td>${impact.x?.toFixed(3)} / ${impact.y?.toFixed(3)} / ${impact.z?.toFixed(3)}</td></tr>
        </table>`;

    try {
        await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: notifyConfig.emails.join(','),
            subject: `[IMPACT] ${impact.severity} Alert (${impact.p_class}) on ${impact.sensor}`,
            html,
        });
        console.log(`[email] Alert sent for ${impact.sensor} ${impact.peak_g}g`);
    } catch (e) {
        console.error('[email] Send failed:', e.message);
    }
}

// ── Express app ──────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.json({limit: '15mb'}));
app.use(express.static(path.join(__dirname, '../client')));

let pgReady = false; 

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS accelerometer_events (
                id          SERIAL PRIMARY KEY,
                timestamp   TIMESTAMPTZ NOT NULL,
                sensor      TEXT NOT NULL,
                severity    TEXT NOT NULL,
                peak_g      REAL, g_force REAL,
                rms_v REAL, rms_l REAL, sd_v REAL, sd_l REAL,
                p2p_v REAL, p2p_l REAL,
                x REAL, y REAL, z REAL,
                fs REAL, window_ms REAL, distance_m REAL, p_class TEXT,
                lat REAL, lng REAL
            );
            ALTER TABLE accelerometer_events ADD COLUMN IF NOT EXISTS lat REAL;
            ALTER TABLE accelerometer_events ADD COLUMN IF NOT EXISTS lng REAL;
            CREATE TABLE IF NOT EXISTS monitoring_data (
                id        SERIAL PRIMARY KEY,
                timestamp TIMESTAMPTZ NOT NULL,
                type      TEXT DEFAULT 'accelerometer',
                device_id TEXT NOT NULL,
                x_axis REAL, y_axis REAL, z_axis REAL,
                g_force REAL, rms_v REAL, rms_l REAL,
                sd_v REAL, sd_l REAL, p2p_v REAL, p2p_l REAL,
                peak REAL, fs REAL, window_ms REAL, distance_m REAL
            );
            ALTER TABLE monitoring_data ADD COLUMN IF NOT EXISTS distance_m REAL;
            CREATE TABLE IF NOT EXISTS realtime_data (
                id        SERIAL PRIMARY KEY,
                timestamp TIMESTAMPTZ NOT NULL,
                sensor    TEXT NOT NULL,
                x REAL, y REAL, z REAL,
                g_force REAL, rms_v REAL, rms_l REAL,
                sd_v REAL, sd_l REAL, p2p_v REAL, p2p_l REAL, peak REAL, fs REAL, window_ms REAL, distance_m REAL   
            );
            CREATE TABLE IF NOT EXISTS rm_gps (
                id               SERIAL PRIMARY KEY,
                timestamp        TIMESTAMPTZ NOT NULL,
                lat REAL, lng REAL, speed_kmh REAL, total_distance_m REAL
            );
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_ae_timestamp   ON accelerometer_events(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_ae_ts_sev      ON accelerometer_events(timestamp DESC, severity);
            CREATE INDEX IF NOT EXISTS idx_ae_sensor      ON accelerometer_events(sensor, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_md_timestamp   ON monitoring_data(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_md_device      ON monitoring_data(device_id, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_rd_timestamp   ON realtime_data(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_rd_sensor_ts   ON realtime_data(sensor, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_gps_timestamp  ON rm_gps(timestamp DESC);
        `);
        pgReady = true;
        console.log('PostgreSQL connected and schema ready');
    } catch (e) {
        console.error('PostgreSQL init error:', e.message);
    }
}
initDB();

function normImpact(r) {
    return {
        timestamp:  r.timestamp, sensor: r.sensor, severity: r.severity,
        peak_g:     r.peak_g,    gForce: r.g_force,
        rmsV:  r.rms_v,  rmsL:  r.rms_l,
        sdV:   r.sd_v,   sdL:   r.sd_l,
        p2pV:  r.p2p_v,  p2pL:  r.p2p_l,
        x: r.x, y: r.y, z: r.z,
        fs: r.fs, window_ms: r.window_ms,
        distance_m: r.distance_m, p_class: r.p_class,
        lat: r.lat || null, lng: r.lng || null
    };
}
function normMonitoring(r) {
    return {
        timestamp: r.timestamp, device_id: r.device_id, type: r.type,
        x_axis: r.x_axis, y_axis: r.y_axis, z_axis: r.z_axis,
        gForce: r.g_force,
        rmsV: r.rms_v, rmsL: r.rms_l,
        sdV:  r.sd_v,  sdL:  r.sd_l,
        p2pV: r.p2p_v, p2pL: r.p2p_l,
        peak: r.peak, fs: r.fs, window_ms: r.window_ms,
        distance_m: r.distance_m
    };
}

let _dbLatestTs = null;
async function getDBNow() {
    try {
        const r = await pool.query('SELECT timestamp FROM realtime_data ORDER BY timestamp DESC LIMIT 1');
        if (r.rows.length) {
            let dbTs = new Date(r.rows[0].timestamp);
            if (peaksLog && peaksLog.length) {
                const logLatest = new Date(peaksLog[peaksLog.length - 1].timestamp);
                if (logLatest > dbTs) dbTs = logLatest;
            }
            _dbLatestTs = dbTs;
        }
    } catch (e) { /* use cached or server clock */ }
    return _dbLatestTs || new Date();
}
setInterval(() => getDBNow(), 30000);

let lastDataTimestamp = null;
let mqttConnected     = false;
const mqttClient = mqtt.connect(`mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`);

function parseHealthMessage(msgStr) {
    const get = pattern => {
        const m = msgStr.match(pattern);
        if (!m) return 'UNKNOWN';
        return m[1].trim().toUpperCase() === 'OK' ? 'OK' : 'FAIL';
    };
    const health = {
        usart2:  get(/USART2\s*:\s*(OK|FAIL)/i),
        spi1:    get(/SPI1\s*:\s*(OK|FAIL)/i),
        w5500:   get(/W5500\s*:\s*(OK|FAIL)/i),
        phyLink: get(/PHY\s*Link\s*:\s*(OK|FAIL)/i),
        tcp:     get(/TCP\s*:\s*(OK|FAIL)/i),
        timestamp: new Date().toISOString(),
        raw: msgStr.trim()
    };
    SENSORS.forEach(s => {
        const re = new RegExp(`ADXL345\\s+${s.id}\\s*:\\s*(OK|FAIL)`, 'i');
        health[s.healthKey] = get(re);
    });
    return health;
}

const THRESHOLDS_FILE = path.join(__dirname, 'thresholds.json');
function loadThresholds() {
    try {
        if (fs.existsSync(THRESHOLDS_FILE)) return JSON.parse(fs.readFileSync(THRESHOLDS_FILE, 'utf8'));
    } catch (e) { console.error('thresholds.json read error:', e.message); }
    return { p1Min: 5, p1Max: 10, p2Min: 10, p2Max: 20, p3Min: 20 };
}
function saveThresholds(t) {
    try { fs.writeFileSync(THRESHOLDS_FILE, JSON.stringify(t, null, 2)); }
    catch (e) { console.error('thresholds.json write error:', e.message); }
}
let pClassThresholds = loadThresholds();
console.log('[thresholds] Loaded:', pClassThresholds);

const PIVOT_THRESHOLDS_FILE = path.join(__dirname, 'thresholds_pivot.json');
const AXIS_THRESHOLDS_FILE = path.join(__dirname, 'thresholds_axis.json');
const DEFAULT_AXIS_THRESHOLD = { p1Min: 5, p1Max: 10, p2Min: 10, p2Max: 20, p3Min: 20 };
function loadAxisThresholds() {
    try {
        if (fs.existsSync(AXIS_THRESHOLDS_FILE)) return JSON.parse(fs.readFileSync(AXIS_THRESHOLDS_FILE, 'utf8'));
    } catch (e) { console.error('thresholds_axis.json read error:', e.message); }
    return { x: { ...DEFAULT_AXIS_THRESHOLD }, y: { ...DEFAULT_AXIS_THRESHOLD }, z: { ...DEFAULT_AXIS_THRESHOLD } };
}
function saveAxisThresholds(t) {
    try { fs.writeFileSync(AXIS_THRESHOLDS_FILE, JSON.stringify(t, null, 2)); }
    catch (e) { console.error('thresholds_axis.json write error:', e.message); }
}
let axisThresholds = loadAxisThresholds();

function loadPivotThresholds() {
    try {
        if (fs.existsSync(PIVOT_THRESHOLDS_FILE)) return JSON.parse(fs.readFileSync(PIVOT_THRESHOLDS_FILE, 'utf8'));
    } catch (e) { console.error('thresholds_pivot.json read error:', e.message); }
    return { p1Min: 2, p1Max: 4, p2Min: 4, p2Max: 8, p3Min: 8 };
}
function savePivotThresholds(t) {
    try { fs.writeFileSync(PIVOT_THRESHOLDS_FILE, JSON.stringify(t, null, 2)); }
    catch (e) { console.error('thresholds_pivot.json write error:', e.message); }
}
let pivotClassThresholds = loadPivotThresholds();
console.log('[thresholds] Pivot loaded:', pivotClassThresholds);

function thresholdsFor(sensorId) {
    return sensorId === 'pivot' ? pivotClassThresholds : pClassThresholds;
}

function getPClass(peakG, sensorId) {
    if (peakG == null) return null;
    const t = thresholdsFor(sensorId);
    const g = +peakG;
    if (g >= t.p3Min)                           return 'P3';
    if (g >= t.p2Min && g < t.p2Max)            return 'P2';
    if (g >= t.p1Min && g < t.p1Max)            return 'P1';
    return null;
}
function getSeverity(peakG, sensorId) {
    const pc = getPClass(peakG, sensorId);
    if (pc === 'P3') return 'HIGH';
    if (pc === 'P2') return 'MEDIUM';
    if (pc === 'P1') return 'LOW';
    return 'LOW';
}

app.get('/api/thresholds', (req, res) => res.json(pClassThresholds));

app.post('/api/thresholds', (req, res) => {
    const { p1Min, p1Max, p2Min, p2Max, p3Min } = req.body;
    if ([p1Min, p1Max, p2Min, p2Max, p3Min].some(v => v == null || isNaN(v)))
        return res.status(400).json({ error: 'All threshold values required' });
    pClassThresholds = { p1Min: +p1Min, p1Max: +p1Max, p2Min: +p2Min, p2Max: +p2Max, p3Min: +p3Min };
    saveThresholds(pClassThresholds);
    console.log('[thresholds] Updated and saved:', pClassThresholds);
    io.emit('thresholds-updated', pClassThresholds);
    res.json({ success: true, thresholds: pClassThresholds });
});

app.delete('/api/thresholds', (req, res) => {
    pClassThresholds = { p1Min: 5, p1Max: 10, p2Min: 10, p2Max: 20, p3Min: 20 };
    saveThresholds(pClassThresholds);
    console.log('[thresholds] Reset to default:', pClassThresholds);
    io.emit('thresholds-updated', pClassThresholds);
    res.json({ success: true, thresholds: pClassThresholds });
});

app.get('/api/thresholds/pivot', (req, res) => res.json(pivotClassThresholds));

app.post('/api/thresholds/pivot', (req, res) => {
    const { p1Min, p1Max, p2Min, p2Max, p3Min } = req.body;
    if ([p1Min, p1Max, p2Min, p2Max, p3Min].some(v => v == null || isNaN(v)))
        return res.status(400).json({ error: 'All pivot threshold values required' });
    pivotClassThresholds = { p1Min: +p1Min, p1Max: +p1Max, p2Min: +p2Min, p2Max: +p2Max, p3Min: +p3Min };
    savePivotThresholds(pivotClassThresholds);
    console.log('[thresholds] Pivot updated and saved:', pivotClassThresholds);
    io.emit('pivot-thresholds-updated', pivotClassThresholds);
    res.json({ success: true, thresholds: pivotClassThresholds });
});

app.delete('/api/thresholds/pivot', (req, res) => {
    pivotClassThresholds = { p1Min: 2, p1Max: 4, p2Min: 4, p2Max: 8, p3Min: 8 };
    savePivotThresholds(pivotClassThresholds);
    console.log('[thresholds] Pivot reset to default:', pivotClassThresholds);
    io.emit('pivot-thresholds-updated', pivotClassThresholds);
    res.json({ success: true, thresholds: pivotClassThresholds });
});

app.get('/api/thresholds/axis', (req, res) => res.json(axisThresholds));

app.post('/api/thresholds/axis', (req, res) => {
    const body = req.body || {};
    const updated = {};
    for (const axis of ['x', 'y', 'z']) {
        const t = body[axis];
        if (!t) return res.status(400).json({ error: `Missing thresholds for axis '${axis}'` });
        const { p1Min, p1Max, p2Min, p2Max, p3Min } = t;
        if ([p1Min, p1Max, p2Min, p2Max, p3Min].some(v => v == null || isNaN(v)))
            return res.status(400).json({ error: `All threshold values required for axis '${axis}'` });
        updated[axis] = { p1Min: +p1Min, p1Max: +p1Max, p2Min: +p2Min, p2Max: +p2Max, p3Min: +p3Min };
    }
    axisThresholds = updated;
    saveAxisThresholds(axisThresholds);
    console.log('[thresholds] Axis updated and saved:', axisThresholds);
    io.emit('axis-thresholds-updated', axisThresholds);
    res.json({ success: true, thresholds: axisThresholds });
});

app.delete('/api/thresholds/axis', (req, res) => {
    axisThresholds = { x: { ...DEFAULT_AXIS_THRESHOLD }, y: { ...DEFAULT_AXIS_THRESHOLD }, z: { ...DEFAULT_AXIS_THRESHOLD } };
    saveAxisThresholds(axisThresholds);
    console.log('[thresholds] Axis reset to default:', axisThresholds);
    io.emit('axis-thresholds-updated', axisThresholds);
    res.json({ success: true, thresholds: axisThresholds });
});

app.get('/api/axis-limits', (req, res) => res.json(axisLimitsConfig));

app.post('/api/axis-limits', (req, res) => {
    const { unit, axis, band, value } = req.body || {};
    if (!['generic', 'a1', 'a2'].includes(unit))
        return res.status(400).json({ error: `Invalid unit '${unit}'` });
    if (!['x', 'y', 'z'].includes(axis))
        return res.status(400).json({ error: `Invalid axis '${axis}'` });
    if (!AXIS_LIMIT_BANDS.includes(band))
        return res.status(400).json({ error: `Invalid band '${band}'` });
    const v = Number(value);
    if (value == null || isNaN(v) || v <= 0)
        return res.status(400).json({ error: 'value must be a positive number' });

    axisLimitsConfig[unit][axis][band] = v;
    saveAxisLimitsToFile(axisLimitsConfig);
    console.log(`[axis-limits] Updated ${unit}.${axis}.${band}:`, v);
    io.emit('axis-limits-updated', axisLimitsConfig);
    res.json({ success: true, axisLimits: axisLimitsConfig });
});

app.delete('/api/axis-limits', (req, res) => {
    axisLimitsConfig = defaultAxisLimitsShape();
    saveAxisLimitsToFile(axisLimitsConfig);
    console.log('[axis-limits] Reset to default (2g all bands):', axisLimitsConfig);
    io.emit('axis-limits-updated', axisLimitsConfig);
    res.json({ success: true, axisLimits: axisLimitsConfig });
});

app.get('/api/notify-emails', async (req, res) => {
    try {
        const cfg = await loadNotifyEmails();
        res.json(cfg);
    } catch (e) {
        console.error('/api/notify-emails error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/notify-emails', async (req, res) => {
    const { emails, minSeverity, cooldownSec, enabled } = req.body;
    const newCfg = {
        emails: emails || [],
        minSeverity: ['LOW', 'MEDIUM', 'HIGH'].includes(minSeverity) ? minSeverity : 'MEDIUM',
        cooldownSec: (typeof cooldownSec === 'number' && cooldownSec >= 0) ? cooldownSec : 60,
        enabled: enabled !== undefined ? enabled : true,
    };
    try {
        await saveNotifyEmails(newCfg);
        notifyConfig = newCfg;
        console.log('[notify] Config updated:', JSON.stringify(newCfg));
        io.emit('notify-config-changed', newCfg);
        res.json({ success: true, notifyConfig: newCfg });
    } catch (e) {
        console.error('/api/notify-emails POST error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

let lastHealthStatus = null;
let totalDistanceM = 0;
let speedDistanceM = 0;
let lastSpeedFixAt = null;
let lastGpsCoord   = null;
let lastGpsFixAt   = 0;

async function computeStats(hours = 24) {
    const dbNow  = await getDBNow();
    const isnow = DateTime.fromJSDate(dbNow).setZone(TIMEZONE);
    const cutoff = isnow.startOf('day').toUTC().toISO();

    if (pgReady) {
        try {
            const agg = await pool.query(`
                SELECT
                    COUNT(*)                                        AS total,
                    COUNT(*) FILTER (WHERE severity = 'HIGH')      AS high,
                    COUNT(*) FILTER (WHERE severity = 'MEDIUM')    AS medium,
                    COUNT(*) FILTER (WHERE severity = 'LOW')       AS low,
                    COALESCE(MAX(peak_g), 0)                       AS max_peak,
                    COALESCE(AVG(peak_g), 0)                       AS avg_peak
                FROM accelerometer_events
                WHERE timestamp >= $1
            `, [cutoff]);

            const last = await pool.query(`
                SELECT peak_g, sensor, timestamp, p_class
                FROM accelerometer_events
                WHERE timestamp >= $1
                ORDER BY timestamp DESC LIMIT 1
            `, [cutoff]);

            const row     = agg.rows[0];
            const lastDoc = last.rows[0] || null;
            const stats   = {
                total:             parseInt(row.total),
                highSeverity:      parseInt(row.high),
                medium:            parseInt(row.medium),
                low:               parseInt(row.low),
                maxPeak:           parseFloat(row.max_peak),
                avgPeak:           parseFloat(row.avg_peak),
                lastPeak:          lastDoc ? (lastDoc.peak_g || 0) : 0,
                lastPeakClass:     lastDoc ? (lastDoc.p_class || getPClass(lastDoc.peak_g, lastDoc.sensor) || '—') : '—',
                lastPeakTimestamp: lastDoc ? lastDoc.timestamp : null,
                lastPeakSensor:    lastDoc ? lastDoc.sensor    : null,
                totalDistanceM,
                speedDistanceM,
                source: 'postgres'
            };
            console.log(`[stats] PG: ${stats.total} impacts, lastPeak=${stats.lastPeak}g (${stats.lastPeakClass})`);
            return stats;
        } catch (e) {
            console.error('[stats] PG failed, falling back to JSON:', e.message);
        }
    }

    const recent  = peaksLog
        .filter(p => p.timestamp >= cutoff)
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const peaks   = recent.map(p => p.peak_g || 0);
    const lastDoc = recent[0];
    const stats   = {
        total:              recent.length,
        highSeverity:       recent.filter(p => p.severity === 'HIGH').length,
        medium:             recent.filter(p => p.severity === 'MEDIUM').length,
        low:                recent.filter(p => p.severity === 'LOW').length,
        maxPeak:            peaks.length ? Math.max(...peaks) : 0,
        avgPeak:            peaks.length ? peaks.reduce((a,b) => a+b,0) / peaks.length : 0,
        lastPeak:           lastDoc ? (lastDoc.peak_g || 0) : 0,
        lastPeakClass:      lastDoc ? (getPClass(lastDoc.peak_g, lastDoc.sensor) || '—') : '—',
        lastPeakTimestamp:  lastDoc ? lastDoc.timestamp : null,
        lastPeakSensor:     lastDoc ? lastDoc.sensor    : null,
        totalDistanceM,
        source: 'json_fallback'
    };
    console.log(`[stats] JSON: ${stats.total} impacts, lastPeak=${stats.lastPeak}g (${stats.lastPeakClass})`);
    return stats;
}

app.get('/api/impacts/stats', async (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        res.json(await computeStats(hours));
    } catch (e) {
        console.error('/api/impacts/stats error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/latest/sensor', async (req, res) => {
    try {
        const result = {};
        SENSOR_IDS.forEach(id => { result[id] = null; });

        if (pgReady) {
            for (const id of SENSOR_IDS) {
                const r = await pool.query(`
                    SELECT * FROM monitoring_data
                    WHERE device_id = $1
                    ORDER BY timestamp DESC LIMIT 1
                `, [id]);
                if (r.rows.length) {
                    const d = r.rows[0];
                    result[id] = {
                        sensor: id,
                        x: d.x_axis ?? 0, y: d.y_axis ?? 0, z: d.z_axis ?? 0,
                        rmsV: d.rms_v, rmsL: d.rms_l,
                        sdV:  d.sd_v,  sdL:  d.sd_l,
                        p2pV: d.p2p_v, p2pL: d.p2p_l,
                        peak: d.peak, gForce: d.g_force,
                        fs: d.fs, window: d.window_ms,
                        timestamp: d.timestamp
                    };
                }
            }
        }

        if (SENSOR_IDS.some(id => !result[id])) {
            const sorted = [...peaksLog].sort((a,b) => b.timestamp.localeCompare(a.timestamp));
            for (const p of sorted) {
                if (SENSOR_IDS.includes(p.sensor) && !result[p.sensor]) {
                    result[p.sensor] = {
                        sensor: p.sensor, x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0,
                        rmsV: p.rmsV, rmsL: p.rmsL, sdV: p.sdV, sdL: p.sdL,
                        p2pV: p.p2pV, p2pL: p.p2pL, peak: p.peak_g,
                        gForce: p.gForce, timestamp: p.timestamp
                    };
                }
                if (SENSOR_IDS.every(id => result[id])) break;
            }
        }

        res.json(result);
    } catch (e) {
        console.error('/api/latest/sensor error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/latest/health', (req, res) => res.json(lastHealthStatus));

app.get('/api/history/sensor', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    try {
        if (pgReady) {
            const r = await pool.query(`
                SELECT sensor, x_axis, y_axis, z_axis, g_force, rms_v, rms_l, timestamp
                FROM (
                    SELECT device_id AS sensor, x_axis, y_axis, z_axis,
                           g_force, rms_v, rms_l, timestamp
                    FROM monitoring_data
                    ORDER BY timestamp DESC LIMIT $1
                ) sub
                ORDER BY timestamp ASC
            `, [limit]);
            return res.json(r.rows.map(d => ({
                sensor: d.sensor,
                x: d.x_axis ?? 0, y: d.y_axis ?? 0, z: d.z_axis ?? 0,
                rmsV: d.rms_v, rmsL: d.rms_l,
                gForce: d.g_force, timestamp: d.timestamp
            })));
        }
    } catch (e) {
        console.error('/api/history/sensor error:', e.message);
    }
    res.json([]);
});

app.get('/api/history/distance-chart', async (req, res) => {
    try {
        if (!pgReady) {
            const empty = {}; SENSOR_IDS.forEach(id => empty[id] = []);
            return res.json(empty);
        }

        const limit = Math.min(parseInt(req.query.limit) || 5000, 10000);
        let startTime, endTime;

        if (req.query.from && req.query.to) {
            startTime = new Date(req.query.from).toISOString();
            endTime   = new Date(req.query.to).toISOString();
        } else {
            const hours = parseInt(req.query.hours) || 24;
            const dbNow = await getDBNow();
            endTime   = dbNow.toISOString();
            startTime = new Date(dbNow.getTime() - hours * 3600000).toISOString();
        }

        const r = await pool.query(`
            SELECT sensor, x, y, z, timestamp
            FROM realtime_data
            WHERE timestamp >= $1 AND timestamp <= $2
            ORDER BY timestamp ASC
            LIMIT $3
        `, [startTime, endTime, limit * SENSOR_IDS.length]);

        const grouped = {};
        SENSOR_IDS.forEach(id => { grouped[id] = r.rows.filter(d => d.sensor === id); });
        res.json(grouped);
    } catch (e) {
        console.error('/api/history/distance-chart error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/impacts', async (req, res) => {
    try {
        const { from, to, hours } = req.query;
        let where = '', params = [];
        if (from && to) {
            where = 'WHERE timestamp >= $1 AND timestamp <= $2';
            params = [new Date(from).toISOString(), new Date(to).toISOString()];
        } else if (from) {
            where = 'WHERE timestamp >= $1';
            params = [new Date(from).toISOString()];
        } else if (parseInt(hours) > 0) {
            where = 'WHERE timestamp >= $1';
            params = [new Date(Date.now() - parseInt(hours) * 3600000).toISOString()];
        }

        if (pgReady) {
            const r = await pool.query(`
                SELECT * FROM accelerometer_events
                ${where}
                ORDER BY timestamp DESC LIMIT 2000
            `, params);
            if (where || r.rows.length) return res.json(r.rows.map(normImpact));
        }
    } catch (e) {
        console.error('/api/impacts error:', e.message);
    }

    let fallback = [...peaksLog].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (from) fallback = fallback.filter(p => p.timestamp >= new Date(from).toISOString());
    if (to)   fallback = fallback.filter(p => p.timestamp <= new Date(to).toISOString());
    else if (parseInt(hours) > 0) {
        const cutoff = new Date(Date.now() - parseInt(hours) * 3600000).toISOString();
        fallback = fallback.filter(p => p.timestamp >= cutoff);
    }
    res.json(fallback.slice(0, 2000));
});

app.get('/api/history/g-value', async (req, res) => {
    try {
        if (!pgReady) return res.json([]);
        const { from, to } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'from and to required' });
        const r = await pool.query(`
            SELECT sensor, peak, timestamp
            FROM realtime_data
            WHERE timestamp >= $1 AND timestamp <= $2
            ORDER BY timestamp ASC
            LIMIT 5000
        `, [new Date(from).toISOString(), new Date(to).toISOString()]);
        res.json(r.rows);
    } catch (e) {
        console.error('/api/history/g-value error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/historical/graph/:hours', async (req, res) => {
    try {
        const hours     = parseInt(req.params.hours) || 24;
        const dbNow     = await getDBNow();
        const timeLimit = new Date(dbNow.getTime() - hours * 3600000).toISOString();
        const r = await pool.query(`
            SELECT device_id, x_axis, y_axis, z_axis, timestamp,
                   rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l
            FROM monitoring_data
            WHERE timestamp >= $1
            ORDER BY timestamp ASC LIMIT 6000
        `, [timeLimit]);

        const buckets = {};
        r.rows.forEach(doc => {
            const sec = new Date(doc.timestamp).toISOString().slice(0, 19);
            if (!buckets[sec]) {
                buckets[sec] = { timestamp: doc.timestamp };
                SENSORS.forEach((s, i) => { buckets[sec][`accel${i + 1}`] = null; });
            }
            const idx = SENSOR_IDS.indexOf(doc.device_id);
            if (idx !== -1) buckets[sec][`accel${idx + 1}`] = doc.x_axis || 0;
        });

        res.json(Object.values(buckets).sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
    } catch (e) {
        console.error('/api/historical/graph error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/realtime/status', (req, res) => {
    const now = Date.now();
    const mostRecentSensorSeen = Math.max(0, ...Object.values(sensorLastSeen));
    const tcpReceivingData = mostRecentSensorSeen > 0 && (now - mostRecentSensorSeen) < SENSOR_TIMEOUT_MS;
    const effectiveLastData = Math.max(lastDataTimestamp || 0, mostRecentSensorSeen) || null;

    res.json({
        connected:          mqttConnected || tcpReceivingData,
        receiving_data:     tcpReceivingData || !!(mqttConnected && lastDataTimestamp && (now - lastDataTimestamp < 10000)),
        last_data_received: effectiveLastData,
        time_since_last:    effectiveLastData ? Math.floor((now - effectiveLastData) / 1000) : null
    });
});

app.get('/api/management/sensor-chart', async (req, res) => {
    const hours = Math.min(parseInt(req.query.hours) || 24, 168);
    try {
        const dbNow  = await getDBNow();
        const cutoff = new Date(dbNow.getTime() - hours * 3600000).toISOString();
        const r = await pool.query(`
            SELECT to_char(date_trunc('hour', timestamp AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24') AS h,
                   AVG(g_force) AS avg_g
            FROM realtime_data
            WHERE timestamp >= $1
            GROUP BY h ORDER BY h
        `, [cutoff]);

        const buckets = {};
        for (const row of r.rows) buckets[row.h] = +parseFloat(row.avg_g).toFixed(4);

        const now    = new Date();
        const result = [];
        for (let i = hours - 1; i >= 0; i--) {
            const d     = new Date(now.getTime() - i * 3600000);
            const h     = d.toISOString().slice(0, 13);
            const label = `${String(d.getHours()).padStart(2, '0')}:00`;
            result.push({ label, avg: buckets[h] ?? null });
        }
        res.json(result);
    } catch (e) {
        console.error('/api/management/sensor-chart error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

const CHANNEL_PREFIX = { left: 'l', right: 'r', pivot: 'p' };
function channelPrefixFor(id) {
    return CHANNEL_PREFIX[id] || id[0];
}

app.get('/api/acceleration/channels', async (req, res) => {
    try {
        let cutoff, upperBound = null;
        if (req.query.from && req.query.to) {
            cutoff     = new Date(req.query.from).toISOString();
            upperBound = new Date(req.query.to).toISOString();
        } else {
            const minutes  = Math.min(parseInt(req.query.minutes) || 2, 1440);
            const anchorR  = await pool.query('SELECT timestamp FROM realtime_data ORDER BY timestamp DESC LIMIT 1');
            const anchorTs = anchorR.rows.length ? new Date(anchorR.rows[0].timestamp) : new Date();
            cutoff = new Date(anchorTs.getTime() - minutes * 60000).toISOString();
        }

        const r = await pool.query(`
            SELECT sensor, x, y, z, g_force, timestamp
            FROM realtime_data
            WHERE timestamp >= $1 ${upperBound ? 'AND timestamp <= $2' : ''}
            ORDER BY timestamp ASC LIMIT 30000
        `, upperBound ? [cutoff, upperBound] : [cutoff]);

        const buckets = {};
        for (const doc of r.rows) {
            const sec = new Date(doc.timestamp).toISOString().slice(0, 19);
            if (!buckets[sec]) {
                buckets[sec] = { ts: sec };
                SENSOR_IDS.forEach(id => {
                    const p = channelPrefixFor(id);
                    buckets[sec][`${p}v`] = null;
                    buckets[sec][`${p}l`] = null;
                    buckets[sec][`${p}g`] = null;
                });
            }
            if (SENSOR_IDS.includes(doc.sensor)) {
                const p = channelPrefixFor(doc.sensor);
                buckets[sec][`${p}v`] = doc.y != null ? +parseFloat(doc.y).toFixed(4) : null;
                buckets[sec][`${p}l`] = doc.x != null ? +parseFloat(doc.x).toFixed(4) : null;
                buckets[sec][`${p}g`] = doc.g_force != null ? +parseFloat(doc.g_force).toFixed(4) : null;
            }
        }
        res.json(Object.values(buckets).sort((a, b) => a.ts.localeCompare(b.ts)));
    } catch (e) {
        console.error('/api/acceleration/channels error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/management/sensor-chart-recent', async (_req, res) => {
    try {
        const cutoff = new Date(Date.now() - 2 * 60000).toISOString();
        const r = await pool.query(`
            SELECT sensor, g_force, timestamp FROM realtime_data
            WHERE timestamp >= $1
            ORDER BY timestamp ASC LIMIT 8000
        `, [cutoff]);
        const buckets = {};
        for (const doc of r.rows) {
            const sec = new Date(doc.timestamp).toISOString().slice(0, 19);
            if (!buckets[sec]) {
                buckets[sec] = { ts: sec };
                SENSOR_IDS.forEach(id => { buckets[sec][id] = null; });
            }
            if (SENSOR_IDS.includes(doc.sensor)) buckets[sec][doc.sensor] = doc.g_force || 0;
        }
        res.json(Object.values(buckets).sort((a, b) => a.ts.localeCompare(b.ts)));
    } catch (e) {
        console.error('/api/management/sensor-chart-recent error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/management/uptime', async (req, res) => {
    const hours = 24;
    try {
        const dbNow  = await getDBNow();
        const cutoff = new Date(dbNow.getTime() - hours * 3600000).toISOString();
        const r = await pool.query(`
            SELECT COUNT(DISTINCT date_trunc('hour', timestamp AT TIME ZONE 'UTC')) AS active_hours
            FROM realtime_data WHERE timestamp >= $1
        `, [cutoff]);
        const activeHours = parseInt(r.rows[0].active_hours);
        const pct         = +((activeHours / hours) * 100).toFixed(1);
        res.json({ uptime_pct: pct, active_hours: activeHours, window_hours: hours, server_uptime_s: Math.floor(process.uptime()) });
    } catch (e) {
        console.error('/api/management/uptime error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/latest/gps', async (_req, res) => {
    try {
        const r = await pool.query(`
            SELECT lat, lng, speed_kmh AS "speedKmh",
                   total_distance_m AS "totalDistanceM", timestamp
            FROM rm_gps ORDER BY timestamp DESC LIMIT 1
        `);
        res.json(r.rows.length ? r.rows[0] : null);
    } catch (e) {
        console.error('/api/latest/gps error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/management/active-sensors', async (req, res) => {
    try {
        const cutoff10s = new Date(Date.now() - 10 * 1000).toISOString();
        const r = await pool.query(`
            SELECT DISTINCT ON (sensor) sensor, timestamp
            FROM realtime_data ORDER BY sensor, timestamp DESC
        `);
        const lastSeen = {};
        for (const row of r.rows) {
            if (SENSOR_IDS.includes(row.sensor)) lastSeen[row.sensor] = new Date(row.timestamp).toISOString();
        }
        const sensors       = Object.keys(lastSeen);
        const onlineSensors = sensors.filter(s => lastSeen[s] >= cutoff10s);
        const knownSensors  = sensors.filter(s => lastSeen[s] <  cutoff10s);
        res.json({
            count: onlineSensors.length, total_known: sensors.length,
            online: onlineSensors, last_known: knownSensors, last_seen: lastSeen,
            registered_sensors: SENSOR_IDS
        });
    } catch (e) {
        console.error('/api/management/active-sensors error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/management/active-alerts', async (req, res) => {
    try {
        const dbNow  = await getDBNow();
        const cutoff = new Date(dbNow.getTime() - 24 * 3600000).toISOString();
        const recent = peaksLog.filter(p => p.timestamp >= cutoff);
        const high   = recent.filter(p => p.severity === 'HIGH').length;
        const medium = recent.filter(p => p.severity === 'MEDIUM').length;
        const low    = recent.filter(p => p.severity === 'LOW').length;
        res.json({
            total: recent.length, high, medium, low,
            require_attention: high + medium,
            latest: [...recent].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5)
        });
    } catch (e) {
        console.error('/api/management/active-alerts error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/management/system-health', async (req, res) => {
    try {
        const cutoff10s = new Date(Date.now() - 10 * 1000).toISOString();
        const r = await pool.query(`
            SELECT DISTINCT ON (sensor) sensor, g_force, timestamp
            FROM realtime_data ORDER BY sensor, timestamp DESC
        `);
        let operational = 0, warning = 0, critical = 0;
        for (const doc of r.rows) {
            if (!SENSOR_IDS.includes(doc.sensor)) continue;
            const g      = doc.g_force || 0;
            const isLive = new Date(doc.timestamp).toISOString() >= cutoff10s;
            if (!isLive)       critical++;
            else if (g >= 15)  critical++;
            else if (g >= 5)   warning++;
            else               operational++;
        }
        if (r.rows.length === 0) critical = SENSOR_IDS.length;
        res.json({ operational, warning, critical, total: operational + warning + critical });
    } catch (e) {
        console.error('/api/management/system-health error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/monitoring/all', async (req, res) => {
    try {
        if (!pgReady) return res.status(503).json({ error: 'Database not ready' });
        const r = await pool.query(`
            SELECT device_id, x_axis, y_axis, z_axis, g_force, rms_v, rms_l,
                   sd_v, sd_l, p2p_v, p2p_l, peak, fs, window_ms, distance_m, timestamp, type
            FROM monitoring_data ORDER BY timestamp ASC LIMIT 500000
        `);
        res.json(r.rows.map(normMonitoring));
    } catch (e) {
        console.error('/api/monitoring/all error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

function rciSensorFilter(s) {
    return ['left', 'right', 'pivot'].includes(s) ? s : null;
}

app.get('/api/rci/average', async (req, res) => {
    const days   = Math.min(parseInt(req.query.days) || 1, 365);
    const sensor = rciSensorFilter(req.query.sensor);
    try {
        const dbNow  = await getDBNow();
        const cutoff = new Date(dbNow.getTime() - days * 86400000).toISOString();
        const params = sensor ? [cutoff, sensor] : [cutoff];
        const r = await pool.query(`
            SELECT rms_v FROM realtime_data
            WHERE timestamp >= $1 AND rms_v IS NOT NULL
            ${sensor ? 'AND sensor = $2' : ''}
        `, params);
        if (!r.rows.length) return res.json({ avgRms: null, sampleCount: 0, sensor: sensor || 'all' });
        const sum = r.rows.reduce((acc, row) => acc + parseFloat(row.rms_v || 0), 0);
        const avgRms = sum / r.rows.length;
        res.json({ avgRms: parseFloat(avgRms.toFixed(4)), sampleCount: r.rows.length, sensor: sensor || 'all' });
    } catch (e) {
        console.error('/api/rci/average error:', e.message);
        res.status(500).json({ error: e.message, avgRms: null });
    }
});

app.get('/api/rci/timeseries', async (req, res) => {
    const period = (req.query.period || '24h').toLowerCase();
    const sensor = rciSensorFilter(req.query.sensor);
    let hours, truncUnit, maxPoints;
    if      (period === '7d')  { hours = 7  * 24; truncUnit = 'hour';    maxPoints = 168;  }
    else if (period === '30d') { hours = 30 * 24; truncUnit = '4 hours'; maxPoints = 180;  }
    else                       { hours = 24;       truncUnit = 'minute';  maxPoints = 1440; }

    try {
        const dbNow = await getDBNow();
        let cutoff, upperBound;
        if (period === '24h') {
            const istNow           = DateTime.fromJSDate(dbNow).setZone('Asia/Kolkata');
            const startOfToday     = istNow.startOf('day');
            const startOfYesterday = startOfToday.minus({ days: 1 });
            cutoff     = startOfYesterday.toISO();
            upperBound = startOfToday.toISO();
        } else {
            cutoff     = new Date(dbNow.getTime() - hours * 3600000).toISOString();
            upperBound = dbNow.toISOString();
        }

        const params = sensor ? [truncUnit, cutoff, upperBound, maxPoints, sensor] : [truncUnit, cutoff, upperBound, maxPoints];
        const r = await pool.query(`
            SELECT date_trunc($1, timestamp AT TIME ZONE 'Asia/Kolkata') AS bucket,
                   AVG(rms_v) AS avg_rms_v, COUNT(*) AS sample_count
            FROM realtime_data
            WHERE rms_v IS NOT NULL AND rms_v > 0
              AND timestamp >= $2 AND timestamp < $3
              ${sensor ? 'AND sensor = $5' : ''}
            GROUP BY bucket ORDER BY bucket DESC LIMIT $4
        `, params);

        if (!r.rows.length) return res.json({ period, sensor: sensor || 'all', freq_hz: 100, points: [], sampleCount: 0 });

        const points = r.rows.map(row => ({
            timestamp: row.bucket,
            rms_v_g:   parseFloat(parseFloat(row.avg_rms_v).toFixed(5)),
            n:         parseInt(row.sample_count)
        }));
        res.json({ period, sensor: sensor || 'all', freq_hz: 100, points, sampleCount: points.length });
    } catch (e) {
        console.error('/api/rci/timeseries error:', e.message);
        res.status(500).json({ error: e.message, points: [] });
    }
});

app.post('/api/device/reset', (_req, res) => {
    mqttClient.publish('adj/datalogger/client_request', 'RESET', { qos: 1 }, (err) => {
        if (err) { console.error('RESET publish error:', err.message); return res.status(500).json({ success: false, error: err.message }); }
        console.log('RESET command sent to device');
        res.json({ success: true });
    });
});

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'OK', timestamp: new Date(), postgres: 'connected', mqtt: mqttConnected, last_data: lastDataTimestamp, registered_sensors: SENSOR_IDS });
    } catch (e) {
        res.json({ status: 'ERROR', timestamp: new Date(), postgres: 'disconnected', error: e.message });
    }
});

app.get('/api/map/events', async (req, res) => {
    try {
        if (!pgReady) return res.json([]);
        const severity = req.query.severity || 'all';
        let startTime, endTime;
        if (req.query.date) {
            startTime = new Date(`${req.query.date}T00:00:00+05:30`).toISOString();
            endTime   = new Date(`${req.query.date}T23:59:59+05:30`).toISOString();
        } else {
            const hours = parseInt(req.query.hours) || 24;
            const dbNow = await getDBNow();
            endTime   = dbNow.toISOString();
            startTime = new Date(dbNow.getTime() - hours * 3600000).toISOString();
        }
        let sevClause = '';
        const params  = [startTime, endTime];
        if (severity !== 'all') { params.push(severity.toUpperCase()); sevClause = `AND severity = $${params.length}`; }

        const r = await pool.query(`
            SELECT id, timestamp AT TIME ZONE 'Asia/Kolkata' AS ts,
                   sensor, severity, peak_g, g_force,
                   rms_v, rms_l, p_class, distance_m, lat, lng
            FROM accelerometer_events
            WHERE timestamp >= $1 AND timestamp <= $2
              AND lat IS NOT NULL AND lat != 0
              AND lng IS NOT NULL AND lng != 0
              ${sevClause}
            ORDER BY timestamp DESC LIMIT 2000
        `, params);

        res.json(r.rows.map(e => ({
            id: e.id, timestamp: e.ts, sensor: e.sensor, severity: e.severity,
            peak_g: e.peak_g, g_force: e.g_force, rms_v: e.rms_v, rms_l: e.rms_l,
            p_class: e.p_class, distance_m: e.distance_m, lat: e.lat, lng: e.lng
        })));
    } catch (e) {
        console.error('/api/map/events error:', e.message);
        res.status(500).json([]);
    }
});

app.get('/api/map/gps-track', async (req, res) => {
    try {
        if (!pgReady) return res.json([]);
        let startTime, endTime;
        if (req.query.date) {
            startTime = new Date(`${req.query.date}T00:00:00+05:30`).toISOString();
            endTime   = new Date(`${req.query.date}T23:59:59+05:30`).toISOString();
        } else {
            const hours = parseInt(req.query.hours) || 24;
            const dbNow = await getDBNow();
            endTime   = dbNow.toISOString();
            startTime = new Date(dbNow.getTime() - hours * 3600000).toISOString();
        }
        const r = await pool.query(`
            SELECT lat, lng, speed_kmh, total_distance_m,
                   timestamp AT TIME ZONE 'Asia/Kolkata' AS ts
            FROM (
                SELECT *, ROW_NUMBER() OVER (ORDER BY timestamp) AS rn
                FROM rm_gps
                WHERE timestamp >= $1 AND timestamp <= $2
                  AND lat IS NOT NULL AND lat != 0
                  AND lng IS NOT NULL AND lng != 0
            ) sub WHERE rn % 10 = 0 ORDER BY ts
        `, [startTime, endTime]);
        res.json(r.rows.map(p => ({ lat: p.lat, lng: p.lng, speed_kmh: p.speed_kmh, distance_m: p.total_distance_m, timestamp: p.ts })));
    } catch (e) {
        console.error('/api/map/gps-track error:', e.message);
        res.status(500).json([]);
    }
});

app.get('/api/dates-with-data', async (_req, res) => {
    try {
        if (pgReady) {
            const r = await pool.query(`
                SELECT DISTINCT to_char(DATE(timestamp AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day
                FROM realtime_data ORDER BY day DESC LIMIT 365
            `);
            return res.json(r.rows.map(r => r.day));
        }
        const days = [...new Set(peaksLog.map(p => p.timestamp.slice(0, 10)))].sort().reverse();
        res.json(days);
    } catch (e) {
        console.error('/api/dates-with-data error:', e.message);
        res.status(500).json([]);
    }
});

app.get('/api', (req, res) => {
    res.json({
        message: 'Railway Monitoring API',
        registered_sensors: SENSORS.map(s => ({ id: s.id, label: s.label })),
        endpoints: {
            impacts:          'GET /api/impacts',
            impacts_stats:    'GET /api/impacts/stats?hours=24',
            historical_graph: 'GET /api/historical/graph/:hours',
            realtime_status:  'GET /api/realtime/status',
            health:           'GET /health'
        }
    });
});

io.on('connection', async (socket) => {
    console.log('Client connected:', socket.id);
    try {
        const dbNow     = await getDBNow();
        const timeLimit = new Date(dbNow.getTime() - 86400000).toISOString();
        const r = await pool.query(`
            SELECT device_id, x_axis, y_axis, z_axis, timestamp,
                   rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l
            FROM monitoring_data
            WHERE timestamp >= $1
            ORDER BY timestamp ASC LIMIT 6000
        `, [timeLimit]);
        socket.emit('historical-data', r.rows.map((doc, i) => ({
            distance: i * 100, device_id: doc.device_id,
            x_axis: doc.x_axis || 0, y_axis: doc.y_axis || 0, z_axis: doc.z_axis || 0,
            timestamp: doc.timestamp,
            rmsV: doc.rms_v, rmsL: doc.rms_l, sdV: doc.sd_v, sdL: doc.sd_l, p2pV: doc.p2p_v, p2pL: doc.p2p_l
        })));
    } catch (e) {
        console.error('sendHistoricalData error:', e.message);
        socket.emit('historical-data', []);
    }

    try {
        const stats = await computeStats(24);
        socket.emit('stats-update', stats);
        console.log(`Sent stats to ${socket.id}: total=${stats.total}`);
    } catch (e) {
        console.error('stats-update on connect error:', e.message);
    }

    socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

mqttClient.on('error', err => { console.error('MQTT error:', err.message); mqttConnected = false; });
mqttClient.on('close', ()  => { console.warn('MQTT closed'); mqttConnected = false; });

mqttClient.on('connect', () => {
    console.log(`MQTT Connected to ${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`);
    mqttConnected = true;
    const topics = [
        ...SENSORS.map(s => s.mqttTopic),
        'adj/datalogger/sensors/event',
        'adj/datalogger/health',
        'adj/datalogger/sensors/accelerometer',
        'adj/datalogger/sensors/gps',
    ];
    topics.forEach(topic => {
        mqttClient.subscribe(topic, err => {
            if (err) console.error(`Subscribe failed ${topic}:`, err.message);
            else     console.log(`Subscribed: ${topic}`);
        });
    });
});

const GFORCE_WINDOW_MS = 250;
const gForceWindows = {};
function windowedGForce(sensorId, x, y, z) {
    const now = Date.now();
    const mag = Math.sqrt(x**2 + y**2 + z**2);
    const buf = gForceWindows[sensorId] || (gForceWindows[sensorId] = []);
    buf.push({ t: now, mag });
    while (buf.length && now - buf[0].t > GFORCE_WINDOW_MS) buf.shift();
    return Math.max(...buf.map(s => s.mag));
}

async function handleBinarySensorPacket(sensorMeta, message, timestamp) {
    const sensorId = sensorMeta.id;

    const x     = message.readFloatLE(1);
    const y     = message.readFloatLE(5);
    const z     = message.readFloatLE(9);
    const rmsV  = message.readFloatLE(13);
    const rmsL  = message.readFloatLE(17);
    const sdV   = message.readFloatLE(21);
    const sdL   = message.readFloatLE(25);
    const p2pV  = message.readFloatLE(29);
    const p2pL  = message.readFloatLE(33);
    const peak  = message.readFloatLE(37);
    const tsMs  = message.readUInt32LE(41);
    const latRaw = message.readFloatLE(45);
    const lonRaw = message.readFloatLE(49);
    const sats    = message.readUInt16LE(53);
    const speedMs = message.readFloatLE(55);
    const hh = message.readUInt8(59), mm_t = message.readUInt8(60), ss = message.readUInt8(61);
    const dd = message.readUInt8(62), mo = message.readUInt8(63), yr = message.readUInt16LE(64);

    const lat    = +(latRaw / 1e6).toFixed(6);
    const lng    = +(lonRaw / 1e6).toFixed(6);
    const gForce = windowedGForce(sensorId, x, y, z);

    console.log(`[binary] [${sensorId}]: Ax=${x.toFixed(4)} Ay=${y.toFixed(4)} Az=${z.toFixed(4)} gForce=${gForce.toFixed(4)} PEAK=${peak.toFixed(4)} GPS=${lat},${lng} SAT=${sats}`);

    sensorLastSeen[sensorId] = Date.now();

    const now = Date.now();
    const inferredHealth = Object.assign({}, lastHealthStatus || {}, {
        w5500: 'OK', phyLink: 'OK', tcp: 'OK', spi1: 'OK', usart2: 'OK',
    });
    SENSORS.forEach(s => {
        inferredHealth[s.healthKey] = (now - sensorLastSeen[s.id]) < SENSOR_TIMEOUT_MS ? 'OK' : 'FAIL';
    });
    inferredHealth.gps = (lastGpsFixAt && (now - lastGpsFixAt) < SENSOR_TIMEOUT_MS) ? 'OK' : 'FAIL';
    lastHealthStatus = inferredHealth;
    io.emit('system-health', inferredHealth);

    if (sensorId === 'left' && lat && lng) {
        if (lastGpsCoord) {
            const dLat = (lat - lastGpsCoord.lat) * Math.PI / 180;
            const dLon = (lng - lastGpsCoord.lng) * Math.PI / 180;
            const a    = Math.sin(dLat/2)**2 + Math.cos(lastGpsCoord.lat * Math.PI/180) * Math.cos(lat * Math.PI/180) * Math.sin(dLon/2)**2;
            const d    = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            if (d >= 5 && d < 500) totalDistanceM += d;
        }
        const speedKmh = +(speedMs * 0.036).toFixed(2);
        lastGpsCoord = { lat, lng, speedKmh };
        lastGpsFixAt = Date.now();
        io.emit('gps-data', { lat, lng, speedKmh, totalDistanceM, timestamp });
        if (pgReady) {
            pool.query('INSERT INTO rm_gps (timestamp, lat, lng, speed_kmh, total_distance_m) VALUES ($1,$2,$3,$4,$5)',
                [timestamp, lat, lng, speedKmh, totalDistanceM]).catch(e => console.error('gps insert:', e.message));
        }
    }

    if (pgReady) {
        pool.query(
            `INSERT INTO monitoring_data
             (timestamp, type, device_id, x_axis, y_axis, z_axis, g_force, rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l, peak, distance_m)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [timestamp, 'accelerometer', sensorId, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak, totalDistanceM]
        ).catch(e => console.error('monitoring_data insert:', e.message));

        pool.query(
            `INSERT INTO realtime_data
             (timestamp, sensor, x, y, z, g_force, rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l, peak)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [timestamp, sensorId, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak]
        ).catch(e => console.error('realtime_data insert:', e.message));
    }

    appendRawLog(sensorId, { timestamp, sensor: sensorId, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak });

    const peakVal = peak || gForce;
    if (peakVal > impactDetectionThreshold() || crossesAxisLimit(sensorId, x, y)) {
        const pClass   = getPClass(peakVal, sensorId);
        const severity = getSeverity(peakVal, sensorId);
        const impact   = {
            timestamp, sensor: sensorId, severity, peak_g: peakVal, gForce,
            rmsV, rmsL, sdV, sdL, p2pV, p2pL, x, y, z, distance_m: totalDistanceM, p_class: pClass
        };
        pushToPeaksLog(impact);
        savePeaksLog(peaksLog);
        if (pgReady) {
            const hasGpsFix = lastGpsCoord?.lat && lastGpsCoord?.lng;
            pool.query(
                `INSERT INTO accelerometer_events
                 (timestamp, sensor, severity, peak_g, g_force,
                  rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l,
                  x, y, z, distance_m, p_class, lat, lng)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
                [timestamp, sensorId, severity, peakVal, gForce,
                 rmsV, rmsL, sdV, sdL, p2pV, p2pL,
                 x, y, z, totalDistanceM, pClass,
                 hasGpsFix ? lastGpsCoord.lat : null,
                 hasGpsFix ? lastGpsCoord.lng : null]
            ).catch(e => console.error('events insert:', e.message));
        }
        io.emit('new-impact', impact);
        maybeSendImpactEmail(impact);
        computeStats(24).then(stats => io.emit('stats-update', stats)).catch(() => {});
    }

    if (shouldEmit(sensorId)) {
        io.emit('accelerometer-data', { sensor: sensorId, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak, timestamp });
    } else {
        console.log(`[ODR] Dropped: ${sensorId} @ ${odrConfig[sensorMeta.odrKey]}Hz`);
    }
}

mqttClient.on('message', async (topic, message) => {
    try {
        const timestamp = new Date().toISOString();
        lastDataTimestamp = Date.now();

        console.log(`\n=== Received on: ${topic} ===`);

        const pktType = message[0];

        if (pktType === 0x03 && message.length === 15) {
            const ts     = message.readUInt32LE(1);
            const s1_mag = message.readFloatLE(5);
            const s2_mag = message.readFloatLE(9);
            console.log(`[binary EVENT] ts=${ts} S1=${s1_mag.toFixed(3)}g S2=${s2_mag.toFixed(3)}g`);
            io.emit('binary-event', { timestamp_ms: ts, s1: { magnitude: +s1_mag.toFixed(4) }, s2: { magnitude: +s2_mag.toFixed(4) } });
            return;
        }

        const sensorMeta = sensorByPacketType(pktType);
        if (sensorMeta && message.length === 68) {
            await handleBinarySensorPacket(sensorMeta, message, timestamp);
            return;
        }

        const msgStr = message.toString();
        console.log(`Raw: ${msgStr.substring(0, 200)}`);

        if (topic === 'adj/datalogger/health') {
            const health = parseHealthMessage(msgStr);
            lastHealthStatus = health;
            console.log('Health:', health);
            io.emit('system-health', health);
            return;
        }

        if (msgStr.includes('[GPS]') || msgStr.includes('GPS:')) {
            const latM  = msgStr.match(/LAT:(\d+)([NS])/i);
            const lonM  = msgStr.match(/LON:(\d+)([EW])/i);
            const spdM  = msgStr.match(/SPD:(\d+(?:\.\d+)?)cm\/s/i);

            if (latM && lonM) {
                const rawLat = parseInt(latM[1]);
                const rawLon = parseInt(lonM[1]);
                const lat = (rawLat / 1e6) * (latM[2].toUpperCase() === 'S' ? -1 : 1);
                const lng = (rawLon / 1e6) * (lonM[2].toUpperCase() === 'W' ? -1 : 1);
                const speedCms = spdM ? parseFloat(spdM[1]) : 0;
                const speedKmh = +(speedCms * 0.036).toFixed(2);

                if (lastGpsCoord) {
                    const R    = 6371000;
                    const dLat = (lat - lastGpsCoord.lat) * Math.PI / 180;
                    const dLon = (lng - lastGpsCoord.lng) * Math.PI / 180;
                    const a    = Math.sin(dLat/2)**2 + Math.cos(lastGpsCoord.lat * Math.PI/180) * Math.cos(lat * Math.PI/180) * Math.sin(dLon/2)**2;
                    const d    = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                    if (d >= 5 && d < 500) totalDistanceM += d;
                }
                lastGpsCoord = { lat, lng, speedKmh };
                lastGpsFixAt = Date.now();
                io.emit('gps-data', { lat, lng, speedKmh, totalDistanceM, timestamp });
                if (pgReady) {
                    pool.query('INSERT INTO rm_gps (timestamp, lat, lng, speed_kmh, total_distance_m) VALUES ($1,$2,$3,$4,$5)',
                        [timestamp, lat, lng, speedKmh, totalDistanceM]).catch(e => console.error('gps insert:', e.message));
                }
                console.log(`GPS: lat=${lat} lng=${lng} spd=${speedKmh}km/h`);
            }
            if (topic === 'adj/datalogger/sensors/gps' || topic.includes('gps')) return;
        }

        const sensorMetaFromTopic = SENSORS.find(s => s.topicMatch(topic));
        if (!sensorMetaFromTopic) return;
        const sensorSide = sensorMetaFromTopic.id;

        const ax = msgStr.match(/Ax\s*:\s*([+-]?\d+\.?\d*)/i);
        const ay = msgStr.match(/Ay\s*:\s*([+-]?\d+\.?\d*)/i);
        const az = msgStr.match(/Az\s*:\s*([+-]?\d+\.?\d*)/i);
        const xm = msgStr.match(/X=([+-]?\d+\.?\d*)/);
        const ym = msgStr.match(/Y=([+-]?\d+\.?\d*)/);
        const zm = msgStr.match(/Z=([+-]?\d+\.?\d*)/);

        const x = ax ? parseFloat(ax[1]) : (xm ? parseFloat(xm[1]) : 0);
        const y = ay ? parseFloat(ay[1]) : (ym ? parseFloat(ym[1]) : 0);
        const z = az ? parseFloat(az[1]) : (zm ? parseFloat(zm[1]) : 0);

        const rmsVm = msgStr.match(/RMS-V\s*:\s*([+-]?\d+\.?\d*)/i);
        const rmsLm = msgStr.match(/RMS-L\s*:\s*([+-]?\d+\.?\d*)/i);
        const sdVm  = msgStr.match(/SD-V\s*:\s*([+-]?\d+\.?\d*)/i);
        const sdLm  = msgStr.match(/SD-L\s*:\s*([+-]?\d+\.?\d*)/i);
        const p2pVm = msgStr.match(/P2P-V\s*:\s*([+-]?\d+\.?\d*)/i);
        const p2pLm = msgStr.match(/P2P-L\s*:\s*([+-]?\d+\.?\d*)/i);
        const pkm   = msgStr.match(/PEAK\s*:\s*([+-]?\d+\.?\d*)/i);
        const fsm   = msgStr.match(/FS\s*:\s*(\d+)/i);
        const winm  = msgStr.match(/WINDOW\s*:\s*(\d+)/i);

        const rmsV = rmsVm ? parseFloat(rmsVm[1]) : null;
        const rmsL = rmsLm ? parseFloat(rmsLm[1]) : null;
        const sdV  = sdVm  ? parseFloat(sdVm[1])  : null;
        const sdL  = sdLm  ? parseFloat(sdLm[1])  : null;
        const p2pV = p2pVm ? parseFloat(p2pVm[1]) : null;
        const p2pL = p2pLm ? parseFloat(p2pLm[1]) : null;
        const peak = pkm   ? parseFloat(pkm[1])   : null;
        const fs   = fsm   ? parseInt(fsm[1])      : null;
        const win  = winm  ? parseInt(winm[1])     : null;

        const gForce = windowedGForce(sensorSide, x, y, z);
        console.log(`Parsed [${sensorSide}]: x=${x} y=${y} z=${z} peak=${peak} gForce=${gForce.toFixed(4)}`);

        if (pgReady) {
            pool.query(
                `INSERT INTO monitoring_data
                 (timestamp, type, device_id, x_axis, y_axis, z_axis, g_force, rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l, peak, fs, window_ms, distance_m)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
                [timestamp, 'accelerometer', sensorSide, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak, fs, win, totalDistanceM]
            ).catch(e => console.error('monitoring_data insert:', e.message));

            pool.query(
                `INSERT INTO realtime_data
                 (timestamp, sensor, x, y, z, g_force, rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l, peak)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                [timestamp, sensorSide, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak]
            ).catch(e => console.error('realtime_data insert:', e.message));
        }

        const peakVal = peak || gForce;
        if (peakVal > impactDetectionThreshold() || crossesAxisLimit(sensorSide, x, y)) {
            const pClass    = getPClass(peakVal, sensorSide);
            const severity  = getSeverity(peakVal, sensorSide);
            const impact    = {
                timestamp, sensor: sensorSide, severity, peak_g: peakVal, gForce,
                rmsV, rmsL, sdV, sdL, p2pV, p2pL, x, y, z, fs, window_ms: win,
                distance_m: totalDistanceM, p_class: pClass
            };
            pushToPeaksLog(impact);
            savePeaksLog(peaksLog);

            if (pgReady) {
                const hasGpsFix = lastGpsCoord && lastGpsCoord.lat && lastGpsCoord.lng;
                pool.query(
                    `INSERT INTO accelerometer_events
                     (timestamp, sensor, severity, peak_g, g_force,
                      rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l,
                      x, y, z, fs, window_ms, distance_m, p_class, lat, lng)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
                    [timestamp, sensorSide, impact.severity, impact.peak_g, gForce,
                     rmsV, rmsL, sdV, sdL, p2pV, p2pL,
                     x, y, z, fs, win, totalDistanceM, impact.p_class,
                     hasGpsFix ? lastGpsCoord.lat : null,
                     hasGpsFix ? lastGpsCoord.lng : null]
                ).catch(e => console.error('accelerometerEvents insert:', e.message));
            }

            io.emit('new-impact', impact);
            maybeSendImpactEmail(impact);
            console.log(`IMPACT: ${peakVal.toFixed(3)}g (${severity}) on ${sensorSide}`);
            computeStats(24).then(stats => {
                io.emit('stats-update', stats);
                console.log(`[stats-update] broadcast: total=${stats.total} max=${stats.maxPeak.toFixed(2)}g source=${stats.source}`);
            }).catch(e => console.error('stats broadcast error:', e.message));
        }

        if (shouldEmit(sensorSide)) {
            io.emit('accelerometer-data', { sensor: sensorSide, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak, timestamp });
            console.log(`Broadcast: X=${x}, Y=${y}, Z=${z}, gForce=${gForce.toFixed(4)}g`);
        } else {
            console.log(`[ODR] Dropped: ${sensorSide} @ ${odrConfig[sensorMetaFromTopic.odrKey]}Hz`);
        }

    } catch (error) {
        console.error('MQTT message error:', error);
    }
});

const PORT         = process.env.PORT        || 5000;
const GPS_BOARD_IP = process.env.GPS_BOARD_IP || '192.168.1.200';
const PKT_SIZE     = 14;
const SYNC0 = 0xAA, SYNC1 = 0x55;

const ACCEL_SENSOR_IPS = {
    '192.168.1.201': 'left',
    '192.168.1.202': 'right',
    '192.168.1.203': 'pivot',
    '192.168.1.204': 'aux',
};
const ACCEL_PKT_SIZE  = 16;
const ACCEL_SYNC0 = 0xAB, ACCEL_SYNC1 = 0x56;
const ACCEL_WINDOW_MS = 250;

const ACCEL_AXIS_MAP = {
    left:  { vertical: 'y', lateral: 'x' },
    right: { vertical: 'y', lateral: 'x' },
    pivot: { vertical: 'y', lateral: 'x' },
    aux:   { vertical: 'y', lateral: 'x' },
};

function crc16Ccitt(buf) {
    let crc = 0xFFFF;
    for (const b of buf) {
        crc ^= (b << 8);
        for (let i = 0; i < 8; i++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
            crc &= 0xFFFF;
        }
    }
    return crc;
}

function processGpsFix(lat, lng, speedKmh) {
    const timestamp = getTimezoneTimestamp();
    if (lastGpsCoord) {
        const R    = 6371000;
        const dLat = (lat - lastGpsCoord.lat) * Math.PI / 180;
        const dLon = (lng - lastGpsCoord.lng) * Math.PI / 180;
        const a    = Math.sin(dLat / 2) ** 2 + Math.cos(lastGpsCoord.lat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        const d    = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        if (d >= 5 && d < 500) totalDistanceM += d;
    }
    lastGpsCoord = { lat, lng, speedKmh };
    lastGpsFixAt = Date.now();
    if (lastSpeedFixAt) {
    const dtSec = (lastGpsFixAt - lastSpeedFixAt) / 1000;
    speedDistanceM += (speedKmh / 3.6) * dtSec;
    }
    lastSpeedFixAt = lastGpsFixAt;
    io.emit('gps-data', { lat, lng, speedKmh, totalDistanceM, speedDistanceM ,timestamp });
    if (pgReady) {
        pool.query('INSERT INTO rm_gps (timestamp, lat, lng, speed_kmh, total_distance_m, speed_distance_m) VALUES ($1,$2,$3,$4,$5,$6)',
            [timestamp, lat, lng, speedKmh, totalDistanceM, speedDistanceM]).catch(e => console.error('[GPS-TCP] db insert:', e.message));
    }
    console.log(`[GPS-TCP] lat=${lat.toFixed(6)} lng=${lng.toFixed(6)} spd=${speedKmh.toFixed(2)}km/h dist=${(totalDistanceM/1000).toFixed(3)}km`);
}

function handleGpsSocket(socket, firstChunk) {
    const remoteIP = (socket.remoteAddress || '').replace('::ffff:', '');
    if (remoteIP !== GPS_BOARD_IP) {
        console.log(`[GPS-TCP] rejected binary conn from ${remoteIP}`);
        socket.destroy();
        return;
    }
    console.log(`[GPS-TCP] GPS board connected from ${remoteIP}`);
    let rxBuf = Buffer.from(firstChunk);

    function drain() {
        while (rxBuf.length >= PKT_SIZE) {
            let si = -1;
            for (let i = 0; i <= rxBuf.length - PKT_SIZE; i++) {
                if (rxBuf[i] === SYNC0 && rxBuf[i + 1] === SYNC1) { si = i; break; }
            }
            if (si === -1) { rxBuf = rxBuf.slice(rxBuf.length - 1); break; }
            if (si > 0)    rxBuf = rxBuf.slice(si);
            if (rxBuf.length < PKT_SIZE) break;

            const pkt     = rxBuf.slice(0, PKT_SIZE);
            const crcCalc = crc16Ccitt(pkt.slice(2, 12));
            const crcPkt  = pkt.readUInt16BE(12);
            if (crcCalc !== crcPkt) {
                console.log(`[GPS-TCP] CRC mismatch — resyncing`);
                rxBuf = rxBuf.slice(1);
                continue;
            }
            processGpsFix(pkt.readInt32BE(2) / 1_000_000, pkt.readInt32BE(6) / 1_000_000, pkt.readUInt16BE(10) / 100);
            rxBuf = rxBuf.slice(PKT_SIZE);
        }
    }

    drain();
    socket.on('data', chunk => { rxBuf = Buffer.concat([rxBuf, chunk]); drain(); });
    socket.on('close', () => console.log('[GPS-TCP] GPS board disconnected'));
    socket.on('error', e  => console.log(`[GPS-TCP] error: ${e.message}`));
}

class AccelWindow {
    constructor(sensorId) {
        this.sensorId = sensorId;
        const axes = ACCEL_AXIS_MAP[sensorId] || { vertical: 'z', lateral: 'x' };
        this.verticalAxis = axes.vertical;
        this.lateralAxis  = axes.lateral;
        this.samples = [];
        this.windowStart = Date.now();
    }
    add(x, y, z) { this.samples.push({ x, y, z }); }
    ready() { return this.samples.length > 0 && (Date.now() - this.windowStart) >= ACCEL_WINDOW_MS; }
    computeAndReset() {
        const elapsedS = Math.max((Date.now() - this.windowStart) / 1000, 1e-6);
        const samples  = this.samples;
        const last     = samples[samples.length - 1];
        const vert = samples.map(s => s[this.verticalAxis]);
        const lat  = samples.map(s => s[this.lateralAxis]);
        const magnitudes = samples.map(s => Math.sqrt(s.x**2 + s.y**2 + s.z**2));
        const rms = vals => Math.sqrt(vals.reduce((a, v) => a + v * v, 0) / vals.length);
        const sd  = vals => {
            if (vals.length < 2) return 0;
            const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
            return Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
        };
        const peak = Math.max(...magnitudes);
        const stats = {
            x: last.x, y: last.y, z: last.z,
            gForce: peak,
            rmsV: rms(vert), rmsL: rms(lat),
            sdV: sd(vert),   sdL: sd(lat),
            p2pV: Math.max(...vert) - Math.min(...vert),
            p2pL: Math.max(...lat)  - Math.min(...lat),
            peak: Math.max(...magnitudes),
            fs: samples.length / elapsedS,
            windowMs: ACCEL_WINDOW_MS,
        };
        this.samples = [];
        this.windowStart = Date.now();
        return stats;
    }
}

async function processRawAccelReading(sensorMeta, stats, timestamp) {
    const sensorId = sensorMeta.id;
    const { x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak, fs, windowMs } = stats;

    sensorLastSeen[sensorId] = Date.now();

    const now = Date.now();
    const inferredHealth = Object.assign({}, lastHealthStatus || {}, {
        w5500: 'OK', phyLink: 'OK', tcp: 'OK', spi1: 'OK', usart2: 'OK',
    });
    SENSORS.forEach(s => {
        inferredHealth[s.healthKey] = (now - sensorLastSeen[s.id]) < SENSOR_TIMEOUT_MS ? 'OK' : 'FAIL';
    });
    inferredHealth.gps = (lastGpsFixAt && (now - lastGpsFixAt) < SENSOR_TIMEOUT_MS) ? 'OK' : 'FAIL';
    lastHealthStatus = inferredHealth;
    io.emit('system-health', inferredHealth);

    if (pgReady) {
        pool.query(
            `INSERT INTO monitoring_data
             (timestamp, type, device_id, x_axis, y_axis, z_axis, g_force, rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l, peak, fs, window_ms, distance_m)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [timestamp, 'accelerometer', sensorId, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak, fs, windowMs, totalDistanceM]
        ).catch(e => console.error('monitoring_data insert:', e.message));

        pool.query(
            `INSERT INTO realtime_data
             (timestamp, sensor, x, y, z, g_force, rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l, peak)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [timestamp, sensorId, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak]
        ).catch(e => console.error('realtime_data insert:', e.message));
    }

    appendRawLog(sensorId, { timestamp, sensor: sensorId, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak, fs, window_ms: windowMs });

    const peakVal = peak || gForce;
    if (peakVal > impactDetectionThreshold()|| crossesAxisLimit(sensorId, x, y)) {
        const pClass   = getPClass(peakVal, sensorId);
        const severity = getSeverity(peakVal, sensorId);
        const impact   = {
            timestamp, sensor: sensorId, severity, peak_g: peakVal, gForce,
            rmsV, rmsL, sdV, sdL, p2pV, p2pL, x, y, z, fs, window_ms: windowMs,
            distance_m: totalDistanceM, p_class: pClass
        };
        pushToPeaksLog(impact);
        savePeaksLog(peaksLog);
        if (pgReady) {
            const hasGpsFix = lastGpsCoord?.lat && lastGpsCoord?.lng;
            pool.query(
                `INSERT INTO accelerometer_events
                 (timestamp, sensor, severity, peak_g, g_force,
                  rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l,
                  x, y, z, fs, window_ms, distance_m, p_class, lat, lng)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
                [timestamp, sensorId, severity, peakVal, gForce,
                 rmsV, rmsL, sdV, sdL, p2pV, p2pL,
                 x, y, z, fs, windowMs, totalDistanceM, pClass,
                 hasGpsFix ? lastGpsCoord.lat : null,
                 hasGpsFix ? lastGpsCoord.lng : null]
            ).catch(e => console.error('events insert:', e.message));
        }
        io.emit('new-impact', impact);
        maybeSendImpactEmail(impact);
        console.log(`IMPACT: ${peakVal.toFixed(3)}g (${severity}) on ${sensorId}`);
        computeStats(24).then(s => io.emit('stats-update', s)).catch(() => {});
    }

    io.emit('accelerometer-data', { sensor: sensorId, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak, timestamp });
}

function handleAccelSocket(socket, firstChunk) {
    const remoteIP  = (socket.remoteAddress || '').replace('::ffff:', '');
    const sensorId  = ACCEL_SENSOR_IPS[remoteIP];
    if (!sensorId) {
        console.log(`[ACCEL-TCP] rejected conn from ${remoteIP} (not a known accel sensor IP)`);
        socket.destroy();
        return;
    }
    const sensorMeta = sensorById(sensorId);
    console.log(`[ACCEL-TCP] ${sensorId} accel board connected from ${remoteIP}`);

    let rxBuf = Buffer.from(firstChunk);
    const window = new AccelWindow(sensorId);

    function drain() {
        while (rxBuf.length >= ACCEL_PKT_SIZE) {
            let si = -1;
            for (let i = 0; i <= rxBuf.length - ACCEL_PKT_SIZE; i++) {
                if (rxBuf[i] === ACCEL_SYNC0 && rxBuf[i + 1] === ACCEL_SYNC1) { si = i; break; }
            }
            if (si === -1) { rxBuf = rxBuf.slice(rxBuf.length - 1); break; }
            if (si > 0)    rxBuf = rxBuf.slice(si);
            if (rxBuf.length < ACCEL_PKT_SIZE) break;

            const pkt     = rxBuf.slice(0, ACCEL_PKT_SIZE);
            const crcCalc = crc16Ccitt(pkt.slice(2, 14));
            const crcPkt  = pkt.readUInt16BE(14);
            if (crcCalc !== crcPkt) {
                console.log(`[ACCEL-TCP] ${sensorId}: CRC mismatch — resyncing`);
                rxBuf = rxBuf.slice(1);
                continue;
            }
            window.add(
                pkt.readInt32BE(2)  / 1_000_000,
                pkt.readInt32BE(6)  / 1_000_000,
                pkt.readInt32BE(10) / 1_000_000
            );
            rxBuf = rxBuf.slice(ACCEL_PKT_SIZE);
        }
    }

    const flushTimer = setInterval(() => {
        if (window.ready()) {
            const stats = window.computeAndReset();
            const timestamp = getTimezoneTimestamp();
            console.log(`[ACCEL-TCP] [${sensorId}] x=${stats.x.toFixed(4)} y=${stats.y.toFixed(4)} z=${stats.z.toFixed(4)} gForce=${stats.gForce.toFixed(4)} peak=${stats.peak.toFixed(4)} rmsV=${stats.rmsV.toFixed(4)} rmsL=${stats.rmsL.toFixed(4)} fs=${stats.fs.toFixed(1)}Hz`);
            processRawAccelReading(sensorMeta, stats, timestamp).catch(e => console.error(`processRawAccelReading (${sensorId}):`, e.message));
        }
    }, 100);

    drain();
    socket.on('data', chunk => { rxBuf = Buffer.concat([rxBuf, chunk]); drain(); });
    socket.on('close', () => { clearInterval(flushTimer); console.log(`[ACCEL-TCP] ${sensorId} board disconnected`); });
    socket.on('error', e  => console.log(`[ACCEL-TCP] ${sensorId} error: ${e.message}`));
}

const tcpMux = net.createServer(rawSocket => {
    let routed = false;
    const timeout = setTimeout(() => {
        if (routed) return;
        routed = true;
        server.emit('connection', rawSocket);
    }, 30000);

    rawSocket.once('data', firstChunk => {
        clearTimeout(timeout);
        if (routed) return;
        routed = true;
        if (firstChunk[0] === SYNC0) {
            handleGpsSocket(rawSocket, firstChunk);
        } else if (firstChunk[0] === ACCEL_SYNC0) {
            handleAccelSocket(rawSocket, firstChunk);
        } else {
            server.emit('connection', rawSocket);
            rawSocket.unshift(firstChunk);
        }
    });
    rawSocket.once('close', () => clearTimeout(timeout));
    rawSocket.once('error', () => clearTimeout(timeout));
});

tcpMux.listen(PORT, () => {
    console.log(`Server running on port ${PORT} — HTTP + GPS binary on same port`);
    console.log(`Local IP: ${LOCAL_IP}`);
    console.log(`Frontend: http://${LOCAL_IP}:${PORT}/index.html`);
    console.log(`Registered sensors: ${SENSOR_IDS.join(', ')}`);
    console.log(`PostgreSQL: ${process.env.PG_HOST || 'localhost'}:${process.env.PG_PORT || 5432}/${process.env.PG_DB || 'uabams'}`);
});
tcpMux.on('error', e => console.error(`[MUX] error: ${e.message}`));

const HTTPS_PORT = process.env.HTTPS_PORT || 5443;
const httpsCertPath = path.join(__dirname, 'certs', 'cert.pem');
const httpsKeyPath  = path.join(__dirname, 'certs', 'key.pem');
if (fs.existsSync(httpsCertPath) && fs.existsSync(httpsKeyPath)) {
    try {
        const httpsServer = https.createServer({
            cert: fs.readFileSync(httpsCertPath),
            key:  fs.readFileSync(httpsKeyPath),
        }, app);
        io.attach(httpsServer, { cors: { origin: '*', methods: ['GET', 'POST'] } });
        httpsServer.listen(HTTPS_PORT, () => {
            console.log(`HTTPS also available: https://${LOCAL_IP}:${HTTPS_PORT}/index.html (self-signed — accept the browser warning once per machine)`);
        });
        httpsServer.on('error', e => console.error(`[HTTPS] error: ${e.message}`));
    } catch (e) {
        console.error('[HTTPS] Failed to start:', e.message);
    }
} else {
    console.log('[HTTPS] certs/cert.pem or certs/key.pem not found — HTTPS listener not started (HTTP-only).');
}

app.post('/api/reset', async (req, res) => {
    const saveToDb = req.body?.saveToDb === true;
    console.log(`[reset] requested — saveToDb=${saveToDb}`);
    try {
        if (!saveToDb) {
            try {
                await pool.query('TRUNCATE TABLE accelerometer_events, monitoring_data, realtime_data');
                console.log('[reset] PostgreSQL tables truncated');
            } catch (e) { console.error('[reset] Failed to truncate tables:', e.message); }
            peaksLog = [];
            savePeaksLog(peaksLog);
            console.log('[reset] JSON fallback cleared');
        }
        const zeroStats = { total: 0, highSeverity: 0, medium: 0, low: 0, maxPeak: 0, avgPeak: 0, source: 'reset' };
        io.emit('stats-update', zeroStats);
        io.emit('display-reset', { saveToDb });
        console.log(`[reset] Complete — saveToDb=${saveToDb}`);
        res.json({ success: true, saveToDb, message: saveToDb ? 'Display reset — DB preserved' : 'Full reset — DB cleared' });
    } catch (e) {
        console.error('[reset] Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

async function buildTestRunReportCsv(from, to) {
    const r = await pool.query(`
        SELECT rd.sensor, rd.timestamp, rd.x, rd.y, rd.z, rd.g_force,
               rd.rms_v, rd.rms_l, rd.sd_v, rd.sd_l, rd.p2p_v, rd.p2p_l, rd.peak,
               g.lat, g.lng, g.speed_kmh, g.total_distance_m
        FROM realtime_data rd
        LEFT JOIN LATERAL (
            SELECT lat, lng, speed_kmh, total_distance_m
            FROM rm_gps WHERE timestamp <= rd.timestamp
            ORDER BY timestamp DESC LIMIT 1
        ) g ON true
        WHERE rd.timestamp >= $1 AND rd.timestamp <= $2
        ORDER BY rd.timestamp ASC
    `, [new Date(from).toISOString(), new Date(to).toISOString()]);

    const bySensor = {};
    SENSOR_IDS.forEach(id => { bySensor[id] = r.rows.filter(row => row.sensor === id); });
    const n = Math.max(...SENSOR_IDS.map(id => bySensor[id].length), 0);

    const fromDt  = new Date(from);
    const toDt    = new Date(to);
    const durSec  = Math.round((toDt - fromDt) / 1000);
    const durStr  = `${Math.floor(durSec/60)}m ${durSec%60}s`;

    const lines = [];
    lines.push(`# TEST RUN REPORT`);
    lines.push(`# Date,${fromDt.toLocaleDateString('en-IN')}`);
    lines.push(`# Start Time,${fromDt.toLocaleTimeString('en-IN')}`);
    lines.push(`# End Time,${toDt.toLocaleTimeString('en-IN')}`);
    lines.push(`# Duration,${durStr}`);
    lines.push(`# Total Windows,${n}`);
    SENSORS.forEach(s => lines.push(`# ${s.label} Readings,${bySensor[s.id].length}`));
    lines.push('#');

    const header = ['Window#', 'Timestamp'];
    SENSORS.forEach((s, i) => {
        const tag = `S${i + 1}`;
        header.push(
            `${tag}_Ax(g)`, `${tag}_Ay(g)`, `${tag}_Az(g)`, `${tag}_GForce(g)`,
            `${tag}_RMS_V`, `${tag}_RMS_L`, `${tag}_SD_V`, `${tag}_SD_L`,
            `${tag}_P2P_V`, `${tag}_P2P_L`, `${tag}_Peak(g)`
        );
    });
    header.push('Lat', 'Lng', 'Speed_kmh', 'Distance_m');
    lines.push(header.join(','));

    const fmt  = (v, d=4) => v != null ? (+v).toFixed(d) : '';
    const fmt6 = (v)      => v != null ? (+v).toFixed(6) : '';

    for (let i = 0; i < n; i++) {
        const row = [i + 1];
        let ts = '', gps = null;
        SENSORS.forEach(s => {
            const rec = bySensor[s.id][i] || {};
            if (!ts && rec.timestamp) ts = rec.timestamp.toString();
            if (!gps && rec.lat != null) gps = rec;
            row.push(
                fmt(rec.x), fmt(rec.y), fmt(rec.z), fmt(rec.g_force),
                fmt(rec.rms_v), fmt(rec.rms_l), fmt(rec.sd_v), fmt(rec.sd_l),
                fmt(rec.p2p_v), fmt(rec.p2p_l), fmt(rec.peak)
            );
        });
        row.splice(1, 0, ts);
        gps = gps || {};
        row.push(fmt6(gps.lat), fmt6(gps.lng), fmt(gps.speed_kmh, 2), fmt(gps.total_distance_m, 1));
        lines.push(row.join(','));
    }

    const filename = `${routePrefix()}test_report_${fromDt.toISOString().slice(0,10)}_${fromDt.toTimeString().slice(0,8).replace(/:/g,'-')}.csv`;
    const csvBody  = lines.join('\r\n');
    return { csvBody, filename, rowCount: n };
}

app.get('/api/test-report/csv', async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).send('from and to required');

    try {
        if (!pgReady) return res.status(503).send('DB not ready');

        const { csvBody, filename } = await buildTestRunReportCsv(from, to);

        const archiveName = filename.replace(/\.csv$/, `_${archiveTimestamp()}.csv`);
        try {
            fs.writeFileSync(path.join(TESTRUN_REPORTS_DIR, archiveName), csvBody);
            console.log(`[reports] Archived to ${archiveName}`);
        } catch (e) { console.error('[reports] Archive write failed:', e.message); }

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csvBody);
    } catch (e) {
        console.error('/api/test-report/csv error:', e.message);
        res.status(500).send('Export failed: ' + e.message);
    }
});

const IMPACT_CSV_HEADERS = ['timestamp', 'sensor', 'severity', 'p_class', 'peak_g', 'rmsV', 'rmsL', 'sdV', 'sdL', 'p2pV', 'p2pL', 'x', 'y', 'z', 'fs', 'window_ms', 'distance_m', 'lat', 'lng'];
function buildImpactCsv(docs) {
    const fmt = v => (v == null || v === undefined) ? '' : String(v);
    const rows = docs.map(d => [
        fmt(d.timestamp), fmt(d.sensor), fmt(d.severity),
        fmt(d.p_class || getPClass(d.peak_g, d.sensor) || ''),
        fmt(d.peak_g != null ? (+d.peak_g).toFixed(6) : ''),
        fmt(d.rmsV != null ? (+d.rmsV).toFixed(3) : ''), fmt(d.rmsL != null ? (+d.rmsL).toFixed(3) : ''),
        fmt(d.sdV != null ? (+d.sdV).toFixed(3) : ''), fmt(d.sdL != null ? (+d.sdL).toFixed(3) : ''),
        fmt(d.p2pV != null ? (+d.p2pV).toFixed(3) : ''), fmt(d.p2pL != null ? (+d.p2pL).toFixed(3) : ''),
        fmt(d.x != null ? (+d.x).toFixed(3) : ''), fmt(d.y != null ? (+d.y).toFixed(3) : ''), fmt(d.z != null ? (+d.z).toFixed(3) : ''),
        fmt(d.fs != null ? d.fs : ''), fmt(d.window_ms != null ? d.window_ms : ''),
        fmt(d.distance_m != null ? d.distance_m : '0'),
        fmt(d.lat != null ? (+d.lat).toFixed(6) : ''), fmt(d.lng != null ? (+d.lng).toFixed(6) : '')
    ].join(','));
    return [IMPACT_CSV_HEADERS.join(','), ...rows].join('\n');
}

// ── Automatic impact-report archiving — hourly, disconnect-safe ───────────
const AUTO_IMPACT_ARCHIVE_STATE_FILE = path.join(__dirname, 'auto_impact_archive_state.json');
const AUTO_IMPACT_ARCHIVE_INTERVAL_MS = parseInt(process.env.AUTO_IMPACT_ARCHIVE_INTERVAL_MS, 10) || 3600000;

function loadAutoImpactArchiveState() {
    try {
        if (fs.existsSync(AUTO_IMPACT_ARCHIVE_STATE_FILE)) {
            const saved = JSON.parse(fs.readFileSync(AUTO_IMPACT_ARCHIVE_STATE_FILE, 'utf8'));
            if (saved.lastArchivedAt) return saved.lastArchivedAt;
        }
    } catch (e) { console.error('auto_impact_archive_state.json read error:', e.message); }
    return null;
}
function saveAutoImpactArchiveState(lastArchivedAt) {
    try { fs.writeFileSync(AUTO_IMPACT_ARCHIVE_STATE_FILE, JSON.stringify({ lastArchivedAt }, null, 2)); }
    catch (e) { console.error('auto_impact_archive_state.json write error:', e.message); }
}

let autoImpactArchiveCursor = loadAutoImpactArchiveState() || new Date().toISOString();

async function autoArchiveImpactEvents() {
    if (!pgReady) return;
    if (!geonixCurrentlyMounted()) {
        console.warn('[auto-archive] Impact events: Geonix drive not mounted — skipping this cycle, will retry next hour.');
        return;
    }
    try {
        const since = autoImpactArchiveCursor;
        const r = await pool.query(
            `SELECT * FROM accelerometer_events WHERE timestamp > $1 ORDER BY timestamp ASC`,
            [since]
        );
        if (!r.rows.length) return;

        const docs = r.rows.map(normImpact);
        const csv  = buildImpactCsv(docs);
        const newestTs = docs[docs.length - 1].timestamp;
        const archiveName = `${routePrefix()}impact_report_auto_${archiveTimestamp()}.csv`;

        fs.writeFileSync(path.join(IMPACT_REPORTS_DIR, archiveName), csv);
        console.log(`[auto-archive] Wrote ${docs.length} impact record(s) → ${archiveName}`);

        autoImpactArchiveCursor = newestTs;
        saveAutoImpactArchiveState(autoImpactArchiveCursor);
    } catch (e) {
        console.error('[auto-archive] Failed:', e.message);
    }
}
setTimeout(autoArchiveImpactEvents, 10000);
setInterval(autoArchiveImpactEvents, AUTO_IMPACT_ARCHIVE_INTERVAL_MS);

// ── Automatic raw-session backup — hourly, disconnect-safe ─────────────────
const AUTO_KMWISE_ARCHIVE_STATE_FILE = path.join(__dirname, 'auto_kmwise_archive_state.json');
const AUTO_KMWISE_ARCHIVE_INTERVAL_MS = parseInt(process.env.AUTO_KMWISE_ARCHIVE_INTERVAL_MS, 10) || 3600000;

function loadAutoKmWiseArchiveState() {
    try {
        if (fs.existsSync(AUTO_KMWISE_ARCHIVE_STATE_FILE)) {
            const saved = JSON.parse(fs.readFileSync(AUTO_KMWISE_ARCHIVE_STATE_FILE, 'utf8'));
            if (saved.lastArchivedAt) return saved.lastArchivedAt;
        }
    } catch (e) { console.error('auto_kmwise_archive_state.json read error:', e.message); }
    return null;
}
function saveAutoKmWiseArchiveState(lastArchivedAt) {
    try { fs.writeFileSync(AUTO_KMWISE_ARCHIVE_STATE_FILE, JSON.stringify({ lastArchivedAt }, null, 2)); }
    catch (e) { console.error('auto_kmwise_archive_state.json write error:', e.message); }
}

let autoKmWiseArchiveCursor = loadAutoKmWiseArchiveState() || '1970-01-01T00:00:00.000Z';

const KMWISE_CSV_HEADERS = [
    'id','timestamp','device_id','x_axis','y_axis','z_axis','g_force',
    'rms_v','rms_l','sd_v','sd_l','p2p_v','p2p_l','peak','fs','window_ms','distance_m'
];
function buildKmWiseCsv(rows) {
    const body = rows.map(r => KMWISE_CSV_HEADERS.map(k => {
        const v = r[k];
        return v == null ? '' : (v instanceof Date ? v.toISOString() : v);
    }).join(','));
    return [KMWISE_CSV_HEADERS.join(','), ...body].join('\n');
}

async function autoArchiveKmWise() {
    if (!pgReady) return;
    if (!geonixCurrentlyMounted()) {
        console.warn('[auto-archive] Session backup: Geonix drive not mounted — skipping this cycle, will retry next hour.');
        return;
    }
    try {
        const since = autoKmWiseArchiveCursor;
        const r = await pool.query(
            `SELECT * FROM monitoring_data WHERE timestamp > $1 ORDER BY timestamp ASC`,
            [since]
        );
        if (!r.rows.length) return;

        const csv = buildKmWiseCsv(r.rows);
        const newestTs = r.rows[r.rows.length - 1].timestamp;
        const isFirstRun = since === '1970-01-01T00:00:00.000Z';
        const tag = isFirstRun ? 'full_history' : 'hourly';
        const archiveName = `${routePrefix()}raw_monitoring_backup_${tag}_${archiveTimestamp()}.csv`;

        fs.writeFileSync(path.join(RAW_MONITORING_BACKUP_DIR, archiveName), csv);
        console.log(`[auto-archive] Wrote ${r.rows.length} km-wise record(s) → ${archiveName}`);

        autoKmWiseArchiveCursor = newestTs;
        saveAutoKmWiseArchiveState(autoKmWiseArchiveCursor);
    } catch (e) {
        console.error('[auto-archive] Session backup archive failed:', e.message);
    }
}
setTimeout(autoArchiveKmWise, 12000);
setInterval(autoArchiveKmWise, AUTO_KMWISE_ARCHIVE_INTERVAL_MS);

// ── Automatic test-run report — hourly, disconnect-safe ────────────────────
const AUTO_TESTRUN_ARCHIVE_STATE_FILE = path.join(__dirname, 'auto_testrun_archive_state.json');
const AUTO_TESTRUN_ARCHIVE_INTERVAL_MS = parseInt(process.env.AUTO_TESTRUN_ARCHIVE_INTERVAL_MS, 10) || 3600000;

function loadAutoTestrunArchiveState() {
    try {
        if (fs.existsSync(AUTO_TESTRUN_ARCHIVE_STATE_FILE)) {
            const saved = JSON.parse(fs.readFileSync(AUTO_TESTRUN_ARCHIVE_STATE_FILE, 'utf8'));
            if (saved.lastArchivedAt) return saved.lastArchivedAt;
        }
    } catch (e) { console.error('auto_testrun_archive_state.json read error:', e.message); }
    return null;
}
function saveAutoTestrunArchiveState(lastArchivedAt) {
    try { fs.writeFileSync(AUTO_TESTRUN_ARCHIVE_STATE_FILE, JSON.stringify({ lastArchivedAt }, null, 2)); }
    catch (e) { console.error('auto_testrun_archive_state.json write error:', e.message); }
}

let autoTestrunArchiveCursor = loadAutoTestrunArchiveState() || '1970-01-01T00:00:00.000Z';

async function autoArchiveTestRunReport() {
    if (!pgReady) return;
    if (!geonixCurrentlyMounted()) {
        console.warn('[auto-archive] Test-run report: Geonix drive not mounted — skipping this cycle, will retry next hour.');
        return;
    }
    try {
        const from = autoTestrunArchiveCursor;
        const to   = new Date().toISOString();

        const { csvBody, filename, rowCount } = await buildTestRunReportCsv(from, to);
        if (!rowCount) { autoTestrunArchiveCursor = to; saveAutoTestrunArchiveState(to); return; }

        const archiveName = filename.replace(/\.csv$/, `_${archiveTimestamp()}.csv`);
        fs.writeFileSync(path.join(TESTRUN_REPORTS_DIR, archiveName), csvBody);
        console.log(`[auto-archive] Wrote test-run report (${rowCount} windows) → ${archiveName}`);

        autoTestrunArchiveCursor = to;
        saveAutoTestrunArchiveState(to);
    } catch (e) {
        console.error('[auto-archive] Test-run report archive failed:', e.message);
    }
}
setTimeout(autoArchiveTestRunReport, 14000);
setInterval(autoArchiveTestRunReport, AUTO_TESTRUN_ARCHIVE_INTERVAL_MS);

app.get('/api/impacts/export/csv', async (req, res) => {
    const { from, to, hours } = req.query;

    let where = '', params = [], label = '';
    if (from && to) {
        where  = 'WHERE timestamp >= $1 AND timestamp <= $2';
        params = [new Date(from).toISOString(), new Date(to).toISOString()];
        label  = new Date(from).toISOString().slice(0, 10);
    } else {
        const h      = parseInt(hours) || 24;
        const dbNow  = await getDBNow();
        const cutoff = new Date(dbNow.getTime() - h * 3600000).toISOString();
        where  = 'WHERE timestamp >= $1';
        params = [cutoff];
        label  = `last_${h}h`;
    }

    let docs = [];
    if (pgReady) {
        try {
            const r = await pool.query(`SELECT * FROM accelerometer_events ${where} ORDER BY timestamp DESC`, params);
            docs = r.rows.map(normImpact);
        } catch (e) { console.error('[csv] PG read failed, using JSON fallback:', e.message); }
    }
    if (!docs.length && !where.includes('$2')) {
        docs = peaksLog.filter(p => p.timestamp >= params[0]).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }

    console.log(`[csv] Exporting ${docs.length} records (${label})`);

    const headers = ['timestamp', 'sensor', 'severity', 'p_class', 'peak_g', 'rmsV', 'rmsL', 'sdV', 'sdL', 'p2pV', 'p2pL', 'x', 'y', 'z', 'fs', 'window_ms', 'distance_m', 'lat', 'lng'];
    const fmt = v => (v == null || v === undefined) ? '' : String(v);
    const rows = docs.map(d => [
        fmt(d.timestamp), fmt(d.sensor), fmt(d.severity),
        fmt(d.p_class || getPClass(d.peak_g, d.sensor) || ''),
        fmt(d.peak_g != null ? (+d.peak_g).toFixed(6) : ''),
        fmt(d.rmsV != null ? (+d.rmsV).toFixed(3) : ''), fmt(d.rmsL != null ? (+d.rmsL).toFixed(3) : ''),
        fmt(d.sdV != null ? (+d.sdV).toFixed(3) : ''), fmt(d.sdL != null ? (+d.sdL).toFixed(3) : ''),
        fmt(d.p2pV != null ? (+d.p2pV).toFixed(3) : ''), fmt(d.p2pL != null ? (+d.p2pL).toFixed(3) : ''),
        fmt(d.x != null ? (+d.x).toFixed(3) : ''), fmt(d.y != null ? (+d.y).toFixed(3) : ''), fmt(d.z != null ? (+d.z).toFixed(3) : ''),
        fmt(d.fs != null ? d.fs : ''), fmt(d.window_ms != null ? d.window_ms : ''),
        fmt(d.distance_m != null ? d.distance_m : '0'),
        fmt(d.lat != null ? (+d.lat).toFixed(6) : ''), fmt(d.lng != null ? (+d.lng).toFixed(6) : '')
    ].join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    const filename = `${routePrefix()}impact_report_${label}.csv`;

    const archiveName = filename.replace(/\.csv$/, `_${archiveTimestamp()}.csv`);
    try {
        fs.writeFileSync(path.join(IMPACT_REPORTS_DIR, archiveName), csv);
        console.log(`[reports] Archived to ${archiveName}`);
    } catch (e) { console.error('[reports] Archive write failed:', e.message); }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(csv);
});

app.post('/api/reports/km-wise', express.json({ limit: '15mb' }), (req, res) => {
    const { csv, reportDate, auto, reason } = req.body || {};
    if (!csv || typeof csv !== 'string') {
        return res.status(400).json({ success: false, error: 'csv (string) required' });
    }
    const safeDate = (reportDate || new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, '');
    const tag = auto ? `_auto_${(reason || 'unspecified').replace(/[^a-z0-9-]/gi, '')}` : '';
    const archiveName = `${routePrefix()}KM_Report_${safeDate}${tag}_${archiveTimestamp()}.csv`;
    try {
        fs.writeFileSync(path.join(KMWISE_REPORTS_DIR, archiveName), csv);
        console.log(`[reports] Archived to ${archiveName}${auto ? ` (auto: ${reason})` : ''}`);
        res.json({ success: true, archived: archiveName });
    } catch (e) {
        console.error('[reports] Archive write failed:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ═════════════════════════════════════════════════════════════════════════
// ── Server-side port of acceleration-km.js's REAL km-wise report builder ──
// ═════════════════════════════════════════════════════════════════════════
function kmBlocksForLength(lengthM) {
    const full = Math.floor(lengthM / 200);
    const rem  = lengthM % 200;
    const lens = Array(full).fill(200);
    if (rem > 0) lens.push(rem);
    return lens;
}
function kmSplitRecordsByDistance(docs, kmStart, blockLengths) {
    let blockStart = kmStart;
    return blockLengths.map(len => {
        const blockEnd = blockStart + len;
        const slice = docs.filter(d => d.distance_m != null && d.distance_m >= blockStart && d.distance_m < blockEnd);
        blockStart = blockEnd;
        return slice;
    });
}
function kmMaxVal(arr) {
    const valid = arr.filter(v => v != null && !isNaN(v));
    return valid.length ? Math.max(...valid) : null;
}
function kmComputeBlock(docs, blkIdx) {
    const left  = docs.filter(d => d.device_id === 'left');
    const right = docs.filter(d => d.device_id === 'right');
    const pivot = docs.filter(d => d.device_id === 'pivot');
    const pick  = (arr, f) => arr.map(d => d[f]).filter(v => v != null);
    return {
        label: `BLK${blkIdx + 1}`,
        left:  { rmsV: kmMaxVal(pick(left, 'rmsV')),  rmsL: kmMaxVal(pick(left, 'rmsL')),  sdV: kmMaxVal(pick(left, 'sdV')),  sdL: kmMaxVal(pick(left, 'sdL')) },
        right: { rmsV: kmMaxVal(pick(right, 'rmsV')), rmsL: kmMaxVal(pick(right, 'rmsL')), sdV: kmMaxVal(pick(right, 'sdV')), sdL: kmMaxVal(pick(right, 'sdL')) },
        pivot: { rmsV: kmMaxVal(pick(pivot, 'rmsV')), rmsL: kmMaxVal(pick(pivot, 'rmsL')), sdV: kmMaxVal(pick(pivot, 'sdV')), sdL: kmMaxVal(pick(pivot, 'sdL')) },
    };
}
function kmGetAxisLimitBand(side, axisLetter) {
    if (!axisLimitsConfig) return null;
    const unit = axisLimitUnitForSensor(side);
    return (axisLimitsConfig[unit] && axisLimitsConfig[unit][axisLetter]) || null;
}
function kmClassifyAxisLimitPeak(g, band) {
    if (g == null || isNaN(g) || !band) return null;
    const v = Math.abs(g);
    if (band.p3 != null && v >= +band.p3) return 'P3';
    if (band.p2 != null && v >= +band.p2) return 'P2';
    if (band.p1 != null && v >= +band.p1) return 'P1';
    return null;
}
function kmComputePeakDist(docs) {
    const out = {
        left:  { V: { P1: 0, P2: 0, P3: 0 }, L: { P1: 0, P2: 0, P3: 0 } },
        right: { V: { P1: 0, P2: 0, P3: 0 }, L: { P1: 0, P2: 0, P3: 0 } },
        pivot: { V: { P1: 0, P2: 0, P3: 0 }, L: { P1: 0, P2: 0, P3: 0 } },
    };
    for (const d of docs) {
        const side = d.device_id === 'right' ? 'right' : (d.device_id === 'pivot' ? 'pivot' : 'left');
        const pV = kmClassifyAxisLimitPeak(d.y_axis, kmGetAxisLimitBand(side, 'y'));
        const pL = kmClassifyAxisLimitPeak(d.x_axis, kmGetAxisLimitBand(side, 'x'));
        if (pV) out[side].V[pV]++;
        if (pL) out[side].L[pL]++;
    }
    return out;
}
function kmComputeWorstPeaks(docs, kmStart, blockLengths) {
    const keys  = ['L-LAT', 'L-VERT', 'R-LAT', 'R-VERT', 'P-LAT', 'P-VERT'];
    const empty = () => Object.fromEntries(keys.map(k => [k, []]));
    if (!docs || !docs.length) return empty();

    function maxInDocs(slice) {
        const cur = Object.fromEntries(keys.map(k => [k, null]));
        for (const d of slice) {
            const side    = d.device_id === 'right' ? 'right' : (d.device_id === 'pivot' ? 'pivot' : 'left');
            const latKey  = side === 'left' ? 'L-LAT' : side === 'right' ? 'R-LAT' : 'P-LAT';
            const vertKey = side === 'left' ? 'L-VERT' : side === 'right' ? 'R-VERT' : 'P-VERT';
            const lat  = d.x_axis != null ? Math.abs(d.x_axis) : null;
            const vert = d.y_axis != null ? Math.abs(d.y_axis) : null;
            if (lat  != null) cur[latKey]  = cur[latKey]  == null ? lat  : Math.max(cur[latKey], lat);
            if (vert != null) cur[vertKey] = cur[vertKey] == null ? vert : Math.max(cur[vertKey], vert);
        }
        return cur;
    }

    let slices = [];
    if (kmStart != null && blockLengths && blockLengths.length) {
        let blockStart = kmStart;
        for (const len of blockLengths) {
            const blockEnd = blockStart + len;
            const slice = docs.filter(d => d.distance_m != null && d.distance_m >= blockStart && d.distance_m < blockEnd);
            if (slice.length) slices.push(slice);
            blockStart = blockEnd;
        }
    }

    const series = Object.fromEntries(keys.map(k => [k, []]));
    for (const slice of slices) {
        const cur = maxInDocs(slice);
        for (const k of keys) if (cur[k] != null) series[k].push(+cur[k].toFixed(1));
    }

    const out = empty();
    for (const k of keys) out[k] = series[k].slice(-10);
    return out;
}
function kmBuildDayCards(docsForDay) {
    if (!chainagePreview || !chainagePreview.kmLengths || !Object.keys(chainagePreview.kmLengths).length) return null;

    const nums   = Object.keys(chainagePreview.kmLengths).map(Number);
    const kmNums = chainagePreview.direction === 'DN' ? nums.sort((a, b) => b - a) : nums.sort((a, b) => a - b);

    const cards = [];
    let cursor  = 0;
    const maxDistDoc = docsForDay.reduce((m, d) => (d.distance_m != null && d.distance_m > m) ? d.distance_m : m, 0);

    for (const km of kmNums) {
        const len     = chainagePreview.kmLengths[km] || 1000;
        const kmStart = cursor;
        const kmEnd   = cursor + len;
        const kmDocsSlice = docsForDay.filter(d => d.distance_m != null && d.distance_m >= kmStart && d.distance_m < kmEnd);
        cursor = kmEnd;

        if (kmDocsSlice.length || maxDistDoc > kmStart) {
            const blockLengths = kmBlocksForLength(len);
            const blockSplits  = kmSplitRecordsByDistance(kmDocsSlice, kmStart, blockLengths);
            const blocks = blockLengths.map((blen, i) => {
                const c = kmComputeBlock(blockSplits[i] || [], i);
                c.label = `BLK${i + 1} (${blen}m)`;
                return c;
            });
            const isDn = chainagePreview.direction === 'DN';
            cards.push({
                kmFrom: km, kmTo: isDn ? km - 1 : km + 1, kmLengthM: len,
                blocks,
                peakDist:   kmComputePeakDist(kmDocsSlice),
                worstPeaks: kmComputeWorstPeaks(kmDocsSlice, kmStart, blockLengths),
            });
        } else if (kmStart >= maxDistDoc && cards.length > 0) {
            break;
        }
    }
    return cards;
}
function kmFmt(v, d = 2) { return (v == null || isNaN(v)) ? '—' : (+v).toFixed(d); }

function buildKmWiseReportCsv(docsForDay, reportDate) {
    if (!docsForDay.length) return null;
    const cards = kmBuildDayCards(docsForDay);
    if (!cards) return null;

    const rows = [];
    rows.push("Datalogger - Full Day KM Wise Acceleration Report");
    rows.push(`Date,${reportDate}`);
    rows.push(`Total Records,${docsForDay.length}`);
    rows.push(`Generated On,${new Date().toLocaleString()}`);
    rows.push(`Route Tape,${chainagePreview.sourceFileName}`);
    rows.push("");

    for (const card of cards) {
        rows.push(`=== KM ${card.kmFrom} TO ${card.kmTo}${card.kmLengthM ? ` (${card.kmLengthM}m)` : ''} ===`);
        rows.push("");

        rows.push("BLOCKS SUMMARY");
        rows.push("LOC,Left RMS V,Left RMS L,Left SD V,Left SD L,Right RMS V,Right RMS L,Right SD V,Right SD L,Pivot RMS V,Pivot RMS L,Pivot SD V,Pivot SD L");
        card.blocks.forEach(blk => {
            const l = blk.left || {}, r = blk.right || {}, p = blk.pivot || {};
            rows.push([
                blk.label,
                kmFmt(l.rmsV), kmFmt(l.rmsL), kmFmt(l.sdV, 3), kmFmt(l.sdL, 3),
                kmFmt(r.rmsV), kmFmt(r.rmsL), kmFmt(r.sdV, 3), kmFmt(r.sdL, 3),
                kmFmt(p.rmsV), kmFmt(p.rmsL), kmFmt(p.sdV, 3), kmFmt(p.sdL, 3),
            ].join(','));
        });
        rows.push("");

        rows.push("PEAK DISTRIBUTION");
        const axisLimitNote = side => {
            const bx = kmGetAxisLimitBand(side, 'x'), by = kmGetAxisLimitBand(side, 'y');
            if (!bx || !by) return 'not configured';
            return `V P1=${by.p1 ?? '—'}g P2=${by.p2 ?? '—'}g P3=${by.p3 ?? '—'}g | L P1=${bx.p1 ?? '—'}g P2=${bx.p2 ?? '—'}g P3=${bx.p3 ?? '—'}g`;
        };
        rows.push(`Axis Limit Values,Left: ${axisLimitNote('left')}`);
        rows.push(`,Right: ${axisLimitNote('right')}`);
        rows.push(`,Pivot: ${axisLimitNote('pivot')}`);
        rows.push("Band,Left Vertical (V),Left Lateral (L),Right Vertical (V),Right Lateral (L),Pivot Vertical (V),Pivot Lateral (L)");
        const pd = card.peakDist;
        ['P1', 'P2', 'P3'].forEach(band => {
            rows.push([band, pd.left.V[band] || 0, pd.left.L[band] || 0, pd.right.V[band] || 0, pd.right.L[band] || 0, pd.pivot.V[band] || 0, pd.pivot.L[band] || 0].join(','));
        });
        rows.push("");

        rows.push("WORST PEAKS (Top 10)");
        rows.push("Parameter,1,2,3,4,5,6,7,8,9,10");
        const wp = card.worstPeaks || {};
        ['L-LAT', 'L-VERT', 'R-LAT', 'R-VERT', 'P-LAT', 'P-VERT'].forEach(param => {
            const vals = (wp[param] || []).map(v => kmFmt(v, 1));
            while (vals.length < 10) vals.push('—');
            rows.push([param, ...vals].join(','));
        });

        rows.push("");
        rows.push("");
    }
    return rows.join("\n");
}

// ── Filesystem-truth dedupe for past-day KM-wise reports ──────────────────
// autoKmWiseArchivedPastDates (below) is a fast-path cache only. This is
// the real guard: does ANY file for this date already exist in
// KMWISE_REPORTS_DIR — auto-generated OR manually exported? If so, that
// day is considered "already saved" and is never written again, no matter
// what the JSON cursor says, even if the cursor was lost/reset or this is
// a different/replacement drive that already carries old archives.
// Matches on "_YYYY-MM-DD_" so it catches both:
//   NDLS-LJN_KM_Report_2026-07-04_auto_backfill_2026-08-21_09-00-00.csv
//   NDLS-LJN_KM_Report_2026-07-04_2026-08-21_09-05-00.csv   (manual export)
function pastDayAlreadyArchived(day) {
    try {
        const files = fs.readdirSync(KMWISE_REPORTS_DIR);
        return files.some(f => f.includes(`_${day}_`) || f.includes(`_${day}.csv`));
    } catch (e) {
        console.error('[auto-archive] Could not read KMWISE_REPORTS_DIR for dedupe check:', e.message);
        return false; // fail open — risk one dupe rather than silently stop backfilling forever
    }
}

// ── Automatic KM-wise report ────────────────────────────────────────────
// PAST days: written exactly once, ever — verified against what's actually
// on the drive (pastDayAlreadyArchived), not just the JSON cursor. Once a
// past day has any file for it, it is permanently skipped.
//
// TODAY (the live run): regenerated on every single hourly tick, no dedupe
// check at all, by design — this is the "keep saving every hour regardless
// of filename" behavior. If the drive disconnects mid-run, this cycle just
// skips (geonixCurrentlyMounted() gate below); the moment the drive comes
// back, the very next hourly tick resumes writing "today" normally — no
// restart needed. Once that calendar day ends, it becomes a "past day" on
// the next run and falls under the once-only dedupe rule above.
const AUTO_KMWISE_REPORT_STATE_FILE = path.join(__dirname, 'auto_kmwise_report_state.json');
const AUTO_KMWISE_REPORT_INTERVAL_MS = parseInt(process.env.AUTO_KMWISE_REPORT_INTERVAL_MS, 10) || 3600000;

function loadAutoKmWiseReportState() {
    try {
        if (fs.existsSync(AUTO_KMWISE_REPORT_STATE_FILE)) {
            const saved = JSON.parse(fs.readFileSync(AUTO_KMWISE_REPORT_STATE_FILE, 'utf8'));
            if (Array.isArray(saved.archivedPastDates)) return saved.archivedPastDates;
        }
    } catch (e) { console.error('auto_kmwise_report_state.json read error:', e.message); }
    return [];
}
function saveAutoKmWiseReportState(archivedPastDates) {
    try { fs.writeFileSync(AUTO_KMWISE_REPORT_STATE_FILE, JSON.stringify({ archivedPastDates }, null, 2)); }
    catch (e) { console.error('auto_kmwise_report_state.json write error:', e.message); }
}
let autoKmWiseArchivedPastDates = loadAutoKmWiseReportState();

async function autoArchiveKmWiseReport() {
    if (!pgReady) return;
    if (!geonixCurrentlyMounted()) {
        console.warn('[auto-archive] KM-wise report: Geonix drive not mounted — skipping this cycle, will retry next hour.');
        return;
    }
    if (!chainagePreview || !chainagePreview.kmLengths) {
        console.warn('[auto-archive] KM-wise report skipped: no route tape uploaded yet (upload one via Chainage Preview).');
        return;
    }
    try {
        const daysR = await pool.query(`
            SELECT DISTINCT to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
            FROM monitoring_data ORDER BY day ASC
        `);
        const todayUtc = new Date().toISOString().slice(0, 10);

        for (const { day } of daysR.rows) {
            const isToday = day === todayUtc;

            if (!isToday) {
                // Ground-truth check first — the actual drive contents,
                // not the JSON cursor. A day with any file already there
                // (auto or manual) is skipped, permanently.
                if (pastDayAlreadyArchived(day)) {
                    if (!autoKmWiseArchivedPastDates.includes(day)) {
                        autoKmWiseArchivedPastDates.push(day); // heal the cursor cache
                        saveAutoKmWiseReportState(autoKmWiseArchivedPastDates);
                    }
                    continue;
                }
                if (autoKmWiseArchivedPastDates.includes(day)) continue; // fast-path skip
            }
            // isToday: always falls through — regenerated every hour, no dedupe.

            const dr = await pool.query(`
                SELECT * FROM monitoring_data
                WHERE to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD') = $1
                ORDER BY timestamp ASC
            `, [day]);
            const docs = dr.rows.map(normMonitoring);

            const csvBody = buildKmWiseReportCsv(docs, day);
            if (!csvBody) continue;

            const tag = isToday ? 'auto_today' : 'auto_backfill';
            const archiveName = `${routePrefix()}KM_Report_${day}_${tag}_${archiveTimestamp()}.csv`;
            fs.writeFileSync(path.join(KMWISE_REPORTS_DIR, archiveName), csvBody);
            console.log(`[auto-archive] Wrote KM-wise report for ${day} (${docs.length} records) → ${archiveName}`);

            if (!isToday) {
                autoKmWiseArchivedPastDates.push(day);
                saveAutoKmWiseReportState(autoKmWiseArchivedPastDates);
            }
        }
    } catch (e) {
        console.error('[auto-archive] KM-wise report failed:', e.message);
    }
}
setTimeout(autoArchiveKmWiseReport, 16000);
setInterval(autoArchiveKmWiseReport, AUTO_KMWISE_REPORT_INTERVAL_MS);

app.get('/api/odr-config', (req, res) => res.json({ ...odrConfig, defaults: odrStore.defaults }));

const VALID_ODR_HZ = [50, 100, 200];
function parseOdrUpdates(body) {
    const updated = {};
    for (const s of SENSORS) {
        if (body[s.odrKey] !== undefined) {
            const n = Number(body[s.odrKey]);
            if (!VALID_ODR_HZ.includes(n)) return { error: `${s.odrKey} ODR must be 50, 100, or 200 Hz` };
            updated[s.odrKey] = n;
        }
    }
    return { updated };
}

app.post('/api/odr-config', (req, res) => {
    const body = req.body || {};

    const { updated, error } = parseOdrUpdates(body);
    if (error) return res.status(400).json({ error });
    if (!Object.keys(updated).length) {
        return res.status(400).json({ error: 'No valid sensor ODR keys provided' });
    }

    Object.assign(odrConfig, updated);
    if (body.setAsDefault) Object.assign(odrStore.defaults, updated);

    SENSORS.forEach(s => { odrCounters[s.id] = 0; });
    saveOdrConfig(odrStore);
    console.log('[ODR] Updated →', odrConfig, body.setAsDefault ? '(also saved as default)' : '');
    io.emit('odr-config-changed', odrConfig);
    res.json({ success: true, odrConfig, defaults: odrStore.defaults });
});

app.delete('/api/odr-config', (req, res) => {
    const { sensor } = req.query;

    if (sensor) {
        const s = SENSORS.find(s => s.odrKey === sensor);
        if (!s) return res.status(400).json({ error: `Unknown sensor key: ${sensor}` });
        odrConfig[s.odrKey] = odrStore.defaults[s.odrKey];
        odrCounters[s.id] = 0;
    } else {
        Object.assign(odrConfig, odrStore.defaults);
        SENSORS.forEach(s => { odrCounters[s.id] = 0; });
    }

    saveOdrConfig(odrStore);
    console.log('[ODR] Reset to defaults →', odrConfig);
    io.emit('odr-config-changed', odrConfig);
    res.json({ success: true, odrConfig, defaults: odrStore.defaults });
});

app.get('/api/limits-config', (req, res) => res.json(limitsConfig));

app.post('/api/limits-config', (req, res) => {
    // Only touches keys actually present in the request body — this endpoint
    // is now called separately for UML/limitClass (Reset) and for
    // bandpass/sampleDistanceMm (Sampling & Bandpass save on the merged
    // Threshold Configuration page), and neither call should wipe the
    // other's already-saved values.
    const body = req.body || {};
    if ('uml'        in body) limitsConfig.uml        = body.uml        ?? null;
    if ('limitClass' in body) limitsConfig.limitClass = body.limitClass ?? null;
    if ('bandpass'   in body) limitsConfig.bandpass   = body.bandpass   ?? null;
    if ('sampleDistanceMm' in body) limitsConfig.sampleDistanceMm = body.sampleDistanceMm ?? null;
    saveLimitsConfig(limitsConfig);
    console.log('[limits] Config updated and saved to limits_config.json');
    io.emit('limits-config-changed', limitsConfig);
    res.json({ success: true, limitsConfig });
});

app.get('/api/route-config', (req, res) => res.json(routeConfig));

app.post('/api/route-config', (req, res) => {
    const { origin, destination } = req.body;
    routeConfig.origin      = (origin || '').trim().toUpperCase() || null;
    routeConfig.destination = (destination || '').trim().toUpperCase() || null;
    saveRouteConfig(routeConfig);
    console.log('[route] Config updated and saved to route_config.json');
    io.emit('route-config-changed', routeConfig);
    res.json({ success: true, routeConfig });
});

app.get('/api/section-config', (req, res) => res.json(sectionConfig));

app.post('/api/section-config', (req, res) => {
    const { railway, divisionCode, division, section, line, block, railLH, railRH } = req.body;
    sectionConfig = {
        railway:      (railway || '').trim() || null,
        divisionCode: (divisionCode || '').trim() || null,
        division:     (division || '').trim() || null,
        section:      (section || '').trim() || null,
        line:         (line || '').trim() || null,
        block:        (block || '').trim() || null,
        railLH:       (railLH || '').trim() || null,
        railRH:       (railRH || '').trim() || null,
    };
    saveSectionConfig(sectionConfig);
    console.log('[section] Config updated and saved to section_config.json');
    io.emit('section-config-changed', sectionConfig);
    res.json({ success: true, sectionConfig });
});

function dmsToDecimal(dmsStr) {
    const m = dmsStr.match(/(\d+)°(\d+)'([\d.]+)"?([NSEW])/);
    if (!m) return null;
    const [, deg, min, sec, hemi] = m;
    let decimal = (+deg) + (+min) / 60 + (+sec) / 3600;
    if (hemi === 'S' || hemi === 'W') decimal = -decimal;
    return +decimal.toFixed(6);
}

function parseChainageFile(text) {
    const rows = [];
    for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
        const parts = line.split(',').map(p => p.trim());
        const km = parseInt(parts[0], 10), meter = parseInt(parts[1], 10), featureCode = parseInt(parts[2], 10);
        if (isNaN(km) || isNaN(meter) || isNaN(featureCode)) continue;
        let lat = null, lon = null;
        if (parts[3] && parts[4]) { lat = dmsToDecimal(parts[3]); lon = dmsToDecimal(parts[4]); }
        rows.push({ km, meter, featureCode, lat, lon });
    }
    return rows;
}

function deriveKmLengths(rows) {
    const lengths = {};
    for (const r of rows) if (r.featureCode === 1) lengths[r.km] = r.meter;
    return lengths;
}

function deriveRouteDirection(rows) {
    if (!rows.length) return { direction: null, kmFrom: null, kmTo: null };
    const firstKm = rows[0].km;
    const lastKm  = rows[rows.length - 1].km;
    return {
        direction: lastKm < firstKm ? 'DN' : (lastKm > firstKm ? 'UP' : null),
        kmFrom: firstKm,
        kmTo: lastKm,
    };
}

function deriveTotalRouteMeters(rows, kmLengths) {
    if (!rows.length) return 0;
    const { kmFrom, kmTo } = deriveRouteDirection(rows);
    const lo = Math.min(kmFrom, kmTo), hi = Math.max(kmFrom, kmTo);
    let total = 0;
    for (let k = lo; k < hi; k++) total += (kmLengths[k] || 1000);
    return total;
}

const chainagePreviewUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.get('/api/chainage-preview', (req, res) => res.json(chainagePreview));

app.post('/api/chainage-preview', chainagePreviewUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected field name "file")' });
    let rows;
    try {
        rows = parseChainageFile(req.file.buffer.toString('utf8'));
    } catch (e) {
        return res.status(400).json({ error: `Parse failed: ${e.message}` });
    }
    if (!rows.length) return res.status(400).json({ error: 'No parseable rows found in file' });

    const routeMeta = deriveRouteDirection(rows);
    const kmLengths = deriveKmLengths(rows);
    chainagePreview = {
        sourceFileName: req.file.originalname,
        uploadedAt: getTimezoneTimestamp(),
        rows,
        kmLengths,
        direction: routeMeta.direction,
        kmFrom: routeMeta.kmFrom,
        kmTo: routeMeta.kmTo,
        totalRouteMeters: deriveTotalRouteMeters(rows, kmLengths),
    };
    saveChainagePreview(chainagePreview);
    console.log(`[chainage-preview] Uploaded ${req.file.originalname}: ${rows.length} rows`);
    res.json({ success: true, chainagePreview });
});

app.delete('/api/chainage-preview', (req, res) => {
    chainagePreview = null;
    saveChainagePreview(chainagePreview);
    res.json({ success: true });
});

app.get('/api/sensors', (req, res) => {
    res.json(SENSORS.map(s => ({ id: s.id, label: s.label, odrKey: s.odrKey, healthKey: s.healthKey })));
});