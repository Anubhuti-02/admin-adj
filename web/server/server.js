require('dotenv').config();
const express   = require('express');
const http      = require('http');
const socketIo  = require('socket.io');
const mqtt      = require('mqtt');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const { DateTime } = require("luxon");
const net           = require('net');

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
    // ── To add a 4th sensor in the future, uncomment/copy this block: ──────
    // {
    //     id:          'aux',
    //     label:       'Auxiliary (S4)',
    //     packetType:  0x05,
    //     healthKey:   'adxl345_s4',
    //     odrKey:      'accel4',
    //     mqttTopic:   'adj/datalogger/sensors/aux',
    //     topicMatch:  t => t.includes('aux'),
    // },
];

const SENSOR_IDS = SENSORS.map(s => s.id);                                   // ['left','right','pivot']
const sensorById  = id => SENSORS.find(s => s.id === id);
const sensorByPacketType = pt => SENSORS.find(s => s.packetType === pt);

// Default ODR config, generated from the registry (all default to 100 Hz)
const odrConfig = {};
SENSORS.forEach(s => { odrConfig[s.odrKey] = 100; });

// Sensor liveness + ODR decimation counters, keyed by sensor id
const sensorLastSeen = {};
const odrCounters    = {};
SENSORS.forEach(s => { sensorLastSeen[s.id] = 0; odrCounters[s.id] = 0; });

const SENSOR_TIMEOUT_MS = 10000; // 10s — mark FAIL if no packet in this window

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
let peaksLog = loadPeaksLog();
console.log(`Loaded ${peaksLog.length} existing impact records from JSON fallback`);

function loadLimitsConfig() {
    try {
        if (fs.existsSync(LIMITS_CONFIG_FILE)) return JSON.parse(fs.readFileSync(LIMITS_CONFIG_FILE, 'utf8'));
    } catch (e) { console.error('limits_config.json read error:', e.message); }
    return { uml: null, limitClass: null };
}
function saveLimitsConfig(cfg) {
    try { fs.writeFileSync(LIMITS_CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
    catch (e) { console.error('limits_config.json write error:', e.message); }
}
let limitsConfig = loadLimitsConfig();
console.log('[limits] Config loaded:', JSON.stringify(limitsConfig));

// ── Express / Socket.IO / Postgres ─────────────────────────────────────────
const { Pool } = require('pg');
const pool = new Pool({
    host:     process.env.PG_HOST     || 'localhost',
    port:     parseInt(process.env.PG_PORT) || 5432,
    database: process.env.PG_DB       || 'uabams',
    user:     process.env.PG_USER     || 'uabams_user',
    password: process.env.PG_PASSWORD || 'uabams123',
});

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// ── PostgreSQL schema init ────────────────────────────────────────────────
// NOTE: sensor/device_id columns are TEXT — no schema change needed to add
// new sensors. Just add them to SENSORS[] above.
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
                peak REAL, fs REAL, window_ms REAL
            );
            CREATE TABLE IF NOT EXISTS realtime_data (
                id        SERIAL PRIMARY KEY,
                timestamp TIMESTAMPTZ NOT NULL,
                sensor    TEXT NOT NULL,
                x REAL, y REAL, z REAL,
                g_force REAL, rms_v REAL, rms_l REAL,
                sd_v REAL, sd_l REAL, p2p_v REAL, p2p_l REAL, peak REAL
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

// ── Row → camelCase normaliser ──────────────────────────────────────────
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
        peak: r.peak, fs: r.fs, window_ms: r.window_ms
    };
}

// ── DB clock anchor ─────────────────────────────────────────────────────
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

// ── MQTT ──────────────────────────────────────────────────────────────────
let lastDataTimestamp = null;
let mqttConnected     = false;
const mqttClient = mqtt.connect(`mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`);

// ── Health parser (legacy text protocol) ───────────────────────────────────
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
    // Generic per-sensor health parse: "ADXL345 S1: OK", "ADXL345 PIVOT: OK", etc.
    SENSORS.forEach(s => {
        const re = new RegExp(`ADXL345\\s+${s.id}\\s*:\\s*(OK|FAIL)`, 'i');
        health[s.healthKey] = get(re);
    });
    return health;
}

// ═════════════════════════════════════════════════════════════════════════
// ── P-class thresholds (persisted) ─────────────────────────────────────────
// Axle (left/right) thresholds — unchanged file/shape/endpoints so every
// existing consumer (events.js, acceleration-analysis.js, operator-dashboard.js,
// acceleration-km.js LC thresholds) keeps working exactly as before.
// ═════════════════════════════════════════════════════════════════════════
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

// ★ PIVOT CHANGE — separate threshold set + file for the pivot sensor, since
// pivot sees fewer/smaller peaks than the axle sensors and needs its own bands.
const PIVOT_THRESHOLDS_FILE = path.join(__dirname, 'thresholds_pivot.json');
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

// ★ PIVOT CHANGE — picks the right threshold set for a given sensor id
function thresholdsFor(sensorId) {
    return sensorId === 'pivot' ? pivotClassThresholds : pClassThresholds;
}

// ★ PIVOT CHANGE — getPClass/getSeverity now take sensorId so pivot impacts
// are classified against pivotClassThresholds instead of the axle bands.
// Call sites that don't care about sensor (none should remain) still work
// since thresholdsFor(undefined) falls back to the axle set.
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

// ── Axle threshold endpoints (unchanged shape/paths) ───────────────────────
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

// ★ PIVOT CHANGE — pivot threshold endpoints, mirror the axle ones above
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

// ── Last health status ───────────────────────────────────────────────────
let lastHealthStatus = null;

let totalDistanceM = 0;
let lastGpsCoord   = null;

// ── computeStats ──────────────────────────────────────────────────────────
async function computeStats(hours = 24) {
    const dbNow  = await getDBNow();
    const cutoff = new Date(dbNow.getTime() - hours * 3600000).toISOString();

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
                // ★ PIVOT CHANGE — pass lastDoc.sensor so a pivot last-peak is
                // classified against pivotClassThresholds, not the axle bands
                lastPeakClass:     lastDoc ? (lastDoc.p_class || getPClass(lastDoc.peak_g, lastDoc.sensor) || '—') : '—',
                lastPeakTimestamp: lastDoc ? lastDoc.timestamp : null,
                lastPeakSensor:    lastDoc ? lastDoc.sensor    : null,
                totalDistanceM,
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
        // ★ PIVOT CHANGE — same sensor-aware fix for the JSON fallback path
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

// ── GET /api/latest/sensor — now generic over all registered sensors ──────
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

        // Fallback: use peaksLog for any sensor still null
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

// ── GET /api/history/sensor ───────────────────────────────────────────────
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

// ── GET /api/history/distance-chart — generic, returns one array per sensor
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
        // Also include 'left'/'right' aliases for legacy frontend compatibility
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

        // Bucket by second, one column per registered sensor (accel1/accel2/accel3/...)
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
    res.json({
        connected:          mqttConnected,
        receiving_data:     mqttConnected && lastDataTimestamp && (Date.now() - lastDataTimestamp < 10000),
        last_data_received: lastDataTimestamp,
        time_since_last:    lastDataTimestamp ? Math.floor((Date.now() - lastDataTimestamp) / 1000) : null
    });
});

// ── Management Dashboard APIs ─────────────────────────────────────────────

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

// ── GET /api/acceleration/channels — generic, keys named lv/ll/rv/rl/pv/pl…
// Convention: two-letter prefix per sensor slot (l=left,r=right,p=pivot,4th=q…)
// then v (vertical, from z) / l (lateral, from x).
const CHANNEL_PREFIX = { left: 'l', right: 'r', pivot: 'p' };
// For any future sensor not in this map, falls back to first letter of id.
function channelPrefixFor(id) {
    return CHANNEL_PREFIX[id] || id[0];
}

app.get('/api/acceleration/channels', async (req, res) => {
    try {
        const minutes = Math.min(parseInt(req.query.minutes) || 2, 1440);
        const anchorR = await pool.query('SELECT timestamp FROM realtime_data ORDER BY timestamp DESC LIMIT 1');
        const anchorTs = anchorR.rows.length ? new Date(anchorR.rows[0].timestamp) : new Date();
        const cutoff   = new Date(anchorTs.getTime() - minutes * 60000).toISOString();

        const r = await pool.query(`
            SELECT sensor, x, y, z, timestamp
            FROM realtime_data
            WHERE timestamp >= $1
            ORDER BY timestamp ASC LIMIT 30000
        `, [cutoff]);

        const buckets = {};
        for (const doc of r.rows) {
            const sec = new Date(doc.timestamp).toISOString().slice(0, 19);
            if (!buckets[sec]) {
                buckets[sec] = { ts: sec };
                SENSOR_IDS.forEach(id => {
                    const p = channelPrefixFor(id);
                    buckets[sec][`${p}v`] = null;
                    buckets[sec][`${p}l`] = null;
                });
            }
            if (SENSOR_IDS.includes(doc.sensor)) {
                const p = channelPrefixFor(doc.sensor);
                buckets[sec][`${p}v`] = doc.z != null ? +parseFloat(doc.z).toFixed(4) : null;
                buckets[sec][`${p}l`] = doc.x != null ? +parseFloat(doc.x).toFixed(4) : null;
            }
        }
        res.json(Object.values(buckets).sort((a, b) => a.ts.localeCompare(b.ts)));
    } catch (e) {
        console.error('/api/acceleration/channels error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── GET /api/management/sensor-chart-recent — generic, one key per sensor id
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

// ── GET /api/management/active-sensors — generic over SENSOR_IDS ──────────
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
            registered_sensors: SENSOR_IDS   // full list, incl. never-seen ones
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
                   sd_v, sd_l, p2p_v, p2p_l, peak, fs, window_ms, timestamp, type
            FROM monitoring_data ORDER BY timestamp ASC LIMIT 500000
        `);
        res.json(r.rows.map(normMonitoring));
    } catch (e) {
        console.error('/api/monitoring/all error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── RCI endpoints — unchanged, left-sensor is still the calibrated reference
app.get('/api/rci/average', async (req, res) => {
    const days = Math.min(parseInt(req.query.days) || 1, 365);
    try {
        const dbNow  = await getDBNow();
        const cutoff = new Date(dbNow.getTime() - days * 86400000).toISOString();
        const r = await pool.query(`
            SELECT rms_v FROM realtime_data
            WHERE timestamp >= $1 AND sensor = 'left' AND rms_v IS NOT NULL
        `, [cutoff]);
        if (!r.rows.length) return res.json({ avgRms: null, sampleCount: 0 });
        const sum = r.rows.reduce((acc, row) => acc + parseFloat(row.rms_v || 0), 0);
        const avgRms = sum / r.rows.length;
        res.json({ avgRms: parseFloat(avgRms.toFixed(4)), sampleCount: r.rows.length });
    } catch (e) {
        console.error('/api/rci/average error:', e.message);
        res.status(500).json({ error: e.message, avgRms: null });
    }
});

app.get('/api/rci/timeseries', async (req, res) => {
    const period = (req.query.period || '24h').toLowerCase();
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

        const r = await pool.query(`
            SELECT date_trunc($1, timestamp AT TIME ZONE 'Asia/Kolkata') AS bucket,
                   AVG(rms_v) AS avg_rms_v, COUNT(*) AS sample_count
            FROM realtime_data
            WHERE sensor = 'left' AND rms_v IS NOT NULL AND rms_v > 0
              AND timestamp >= $2 AND timestamp < $3
            GROUP BY bucket ORDER BY bucket DESC LIMIT $4
        `, [truncUnit, cutoff, upperBound, maxPoints]);

        if (!r.rows.length) return res.json({ period, freq_hz: 100, points: [], sampleCount: 0 });

        const points = r.rows.map(row => ({
            timestamp: row.bucket,
            rms_v_g:   parseFloat(parseFloat(row.avg_rms_v).toFixed(5)),
            n:         parseInt(row.sample_count)
        }));
        res.json({ period, freq_hz: 100, points, sampleCount: points.length });
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

// ── Map endpoints ────────────────────────────────────────────────────────
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

// ── WebSocket ─────────────────────────────────────────────────────────────
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

// ═════════════════════════════════════════════════════════════════════════
// ── MQTT handler ────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════
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

// ── Shared helper: process one sensor's 68-byte binary reading, generic ────
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
    const gForce = Math.sqrt(x**2 + y**2 + z**2);

    console.log(`[binary] [${sensorId}]: Ax=${x.toFixed(4)} Ay=${y.toFixed(4)} Az=${z.toFixed(4)} gForce=${gForce.toFixed(4)} PEAK=${peak.toFixed(4)} GPS=${lat},${lng} SAT=${sats}`);

    sensorLastSeen[sensorId] = Date.now();

    // Health — generic across all registered sensors
    const now = Date.now();
    const inferredHealth = Object.assign({}, lastHealthStatus || {}, {
        w5500: 'OK', phyLink: 'OK', tcp: 'OK', spi1: 'OK', usart2: 'OK',
    });
    SENSORS.forEach(s => {
        inferredHealth[s.healthKey] = (now - sensorLastSeen[s.id]) < SENSOR_TIMEOUT_MS ? 'OK' : 'FAIL';
    });
    lastHealthStatus = inferredHealth;
    io.emit('system-health', inferredHealth);

    // GPS — only sensor "left" is treated as the reference GPS source, same as before
    if (sensorId === 'left' && lat && lng) {
        if (lastGpsCoord) {
            const dLat = (lat - lastGpsCoord.lat) * Math.PI / 180;
            const dLon = (lng - lastGpsCoord.lng) * Math.PI / 180;
            const a    = Math.sin(dLat/2)**2 + Math.cos(lastGpsCoord.lat * Math.PI/180) * Math.cos(lat * Math.PI/180) * Math.sin(dLon/2)**2;
            const d    = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            if (d >= 5 && d < 500) totalDistanceM += d;
        }
        lastGpsCoord = { lat, lng };
        const speedKmh = +(speedMs * 0.036).toFixed(2);
        io.emit('gps-data', { lat, lng, speedKmh, totalDistanceM, timestamp });
        if (pgReady) {
            pool.query('INSERT INTO rm_gps (timestamp, lat, lng, speed_kmh, total_distance_m) VALUES ($1,$2,$3,$4,$5)',
                [timestamp, lat, lng, speedKmh, totalDistanceM]).catch(e => console.error('gps insert:', e.message));
        }
    }

    // Store readings — device_id/sensor = sensorId, generic
    if (pgReady) {
        pool.query(
            `INSERT INTO monitoring_data
             (timestamp, type, device_id, x_axis, y_axis, z_axis, g_force, rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l, peak)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [timestamp, 'accelerometer', sensorId, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak]
        ).catch(e => console.error('monitoring_data insert:', e.message));

        pool.query(
            `INSERT INTO realtime_data
             (timestamp, sensor, x, y, z, g_force, rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l, peak)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [timestamp, sensorId, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak]
        ).catch(e => console.error('realtime_data insert:', e.message));
    }

    // Impact detection — generic, works for any registered sensor
    const peakVal = peak || gForce;
    if (peakVal > 2) {
        // ★ PIVOT CHANGE — pass sensorId through so pivot classifies against
        // pivotClassThresholds instead of the axle bands
        const pClass   = getPClass(peakVal, sensorId);
        const severity = getSeverity(peakVal, sensorId);
        const impact   = {
            timestamp, sensor: sensorId, severity, peak_g: peakVal, gForce,
            rmsV, rmsL, sdV, sdL, p2pV, p2pL, x, y, z, distance_m: totalDistanceM, p_class: pClass
        };
        peaksLog.push(impact);
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
        computeStats(24).then(stats => io.emit('stats-update', stats)).catch(() => {});
    }

    // Real-time broadcast, respecting per-sensor ODR decimation
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

        // EVENT packet (fixed type 0x03, unaffected by SENSORS registry)
        if (pktType === 0x03 && message.length === 15) {
            const ts     = message.readUInt32LE(1);
            const s1_mag = message.readFloatLE(5);
            const s2_mag = message.readFloatLE(9);
            console.log(`[binary EVENT] ts=${ts} S1=${s1_mag.toFixed(3)}g S2=${s2_mag.toFixed(3)}g`);
            io.emit('binary-event', { timestamp_ms: ts, s1: { magnitude: +s1_mag.toFixed(4) }, s2: { magnitude: +s2_mag.toFixed(4) } });
            return;
        }

        // Generic sensor packet — matched against SENSORS registry by packetType byte
        const sensorMeta = sensorByPacketType(pktType);
        if (sensorMeta && message.length === 68) {
            await handleBinarySensorPacket(sensorMeta, message, timestamp);
            return;
        }

        // ── Legacy text path (health / GPS / older firmware) ──────────────
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
                lastGpsCoord = { lat, lng };
                io.emit('gps-data', { lat, lng, speedKmh, totalDistanceM, timestamp });
                if (pgReady) {
                    pool.query('INSERT INTO rm_gps (timestamp, lat, lng, speed_kmh, total_distance_m) VALUES ($1,$2,$3,$4,$5)',
                        [timestamp, lat, lng, speedKmh, totalDistanceM]).catch(e => console.error('gps insert:', e.message));
                }
                console.log(`GPS: lat=${lat} lng=${lng} spd=${speedKmh}km/h`);
            }
            if (topic === 'adj/datalogger/sensors/gps' || topic.includes('gps')) return;
        }

        // Match topic to a registered sensor generically
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

        const gForce = Math.sqrt(x**2 + y**2 + z**2);
        console.log(`Parsed [${sensorSide}]: x=${x} y=${y} z=${z} peak=${peak} gForce=${gForce.toFixed(4)}`);

        if (pgReady) {
            pool.query(
                `INSERT INTO monitoring_data
                 (timestamp, type, device_id, x_axis, y_axis, z_axis, g_force, rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l, peak, fs, window_ms)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
                [timestamp, 'accelerometer', sensorSide, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak, fs, win]
            ).catch(e => console.error('monitoring_data insert:', e.message));

            pool.query(
                `INSERT INTO realtime_data
                 (timestamp, sensor, x, y, z, g_force, rms_v, rms_l, sd_v, sd_l, p2p_v, p2p_l, peak)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                [timestamp, sensorSide, x, y, z, gForce, rmsV, rmsL, sdV, sdL, p2pV, p2pL, peak]
            ).catch(e => console.error('realtime_data insert:', e.message));
        }

        const peakVal = peak || gForce;
        if (peakVal > 2) {
            // ★ PIVOT CHANGE — pass sensorSide through so pivot classifies
            // against pivotClassThresholds instead of the axle bands
            const pClass    = getPClass(peakVal, sensorSide);
            const severity  = getSeverity(peakVal, sensorSide);
            const impact    = {
                timestamp, sensor: sensorSide, severity, peak_g: peakVal, gForce,
                rmsV, rmsL, sdV, sdL, p2pV, p2pL, x, y, z, fs, window_ms: win,
                distance_m: totalDistanceM, p_class: pClass
            };
            peaksLog.push(impact);
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

// ── Start — single port: HTTP + binary GPS multiplexed ────────────────────
const PORT         = process.env.PORT        || 5000;
const GPS_BOARD_IP = process.env.GPS_BOARD_IP || '192.168.1.200';
const PKT_SIZE     = 14;
const SYNC0 = 0xAA, SYNC1 = 0x55;

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
    lastGpsCoord = { lat, lng };
    io.emit('gps-data', { lat, lng, speedKmh, totalDistanceM, timestamp });
    if (pgReady) {
        pool.query('INSERT INTO rm_gps (timestamp, lat, lng, speed_kmh, total_distance_m) VALUES ($1,$2,$3,$4,$5)',
            [timestamp, lat, lng, speedKmh, totalDistanceM]).catch(e => console.error('[GPS-TCP] db insert:', e.message));
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

// ── Reset endpoint ────────────────────────────────────────────────────────
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

// ── Test-report CSV — now includes every registered sensor column set ─────
app.get('/api/test-report/csv', async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).send('from and to required');

    try {
        if (!pgReady) return res.status(503).send('DB not ready');

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
        lines.push(`# UABAMS TEST RUN REPORT`);
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
            row.splice(1, 0, ts); // insert timestamp after Window#
            gps = gps || {};
            row.push(fmt6(gps.lat), fmt6(gps.lng), fmt(gps.speed_kmh, 2), fmt(gps.total_distance_m, 1));
            lines.push(row.join(','));
        }

        const filename = `test_report_${fromDt.toISOString().slice(0,10)}_${fromDt.toTimeString().slice(0,8).replace(/:/g,'-')}.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(lines.join('\r\n'));
    } catch (e) {
        console.error('/api/test-report/csv error:', e.message);
        res.status(500).send('Export failed: ' + e.message);
    }
});

// ── Impacts CSV export — unchanged, already sensor-agnostic ────────────────
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
        // ★ PIVOT CHANGE — pass d.sensor so a fallback classification (when
        // p_class wasn't stored) uses the right threshold set for pivot rows
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
    const filename = `impact_report_${label}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(csv);
});

// ── ODR config endpoints — now generic over SENSORS registry ──────────────
app.get('/api/odr-config', (req, res) => res.json(odrConfig));

app.post('/api/odr-config', (req, res) => {
    const valid = [50, 100, 200];
    const body  = req.body || {};
    const updated = {};

    for (const s of SENSORS) {
        if (body[s.odrKey] !== undefined) {
            if (!valid.includes(Number(body[s.odrKey]))) {
                return res.status(400).json({ error: `${s.odrKey} ODR must be 50, 100, or 200 Hz` });
            }
            updated[s.odrKey] = Number(body[s.odrKey]);
        }
    }
    if (!Object.keys(updated).length) {
        return res.status(400).json({ error: 'No valid sensor ODR keys provided' });
    }

    Object.assign(odrConfig, updated);
    SENSORS.forEach(s => { odrCounters[s.id] = 0; }); // reset all so next sample is accepted
    console.log('[ODR] Updated →', odrConfig);
    io.emit('odr-config-changed', odrConfig);
    res.json({ success: true, odrConfig });
});

// ── Limits config endpoints (unchanged) ─────────────────────────────────
app.get('/api/limits-config', (req, res) => res.json(limitsConfig));

app.post('/api/limits-config', (req, res) => {
    const { uml, limitClass } = req.body;
    limitsConfig.uml        = uml        ?? null;
    limitsConfig.limitClass = limitClass ?? null;
    saveLimitsConfig(limitsConfig);
    console.log('[limits] Config updated and saved to limits_config.json');
    io.emit('limits-config-changed', limitsConfig);
    res.json({ success: true, limitsConfig });
});

// ── GET /api/sensors — new: lets frontend discover registered sensors dynamically
app.get('/api/sensors', (req, res) => {
    res.json(SENSORS.map(s => ({ id: s.id, label: s.label, odrKey: s.odrKey, healthKey: s.healthKey })));
});