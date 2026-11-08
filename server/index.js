/**
 * SMART Disk Analyzer - local web server.
 *
 * Zero runtime dependencies: node:http serves the static single page app and a
 * small JSON API. The API shells out to smartctl (which needs root for raw
 * device access) and the analytical work lives in ../shared so the browser can
 * run exactly the same code on imported smartctl JSON.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeSmartctlJson, normalizeMany } from '../shared/normalize.js';
import { buildSnapshot, enrichDevice } from '../shared/forecast.js';
import { slugify } from '../shared/format.js';
import { HistoryStore } from './store.js';
import { detectSmartctl, readDevices, scanDevices } from './smartctl.js';
import { loadDemoDevices } from './demo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const SHARED_DIR = path.join(PROJECT_ROOT, 'shared');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Parse CLI arguments and environment overrides. */
export function parseConfig(argv = process.argv.slice(2), env = process.env) {
  const config = {
    port: Number(env.PORT || 7373),
    host: env.HOST || '127.0.0.1',
    mode: env.SMART_MODE === 'demo' ? 'demo' : 'live',
    smartctl: env.SMARTCTL_BIN || 'smartctl',
    useSudo: env.SMARTCTL_SUDO === '1',
    refreshSeconds: Number(env.REFRESH_SECONDS || 30),
    captureIntervalHours: Number(env.CAPTURE_INTERVAL_HOURS || 6),
    designLifeHours: Number(env.DESIGN_LIFE_HOURS || 43800),
    autoCapture: env.AUTO_CAPTURE !== '0',
    historyFile: env.HISTORY_FILE || path.join(DATA_DIR, 'history.json'),
    verbose: env.VERBOSE === '1',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    switch (arg) {
      case '--port': case '-p': config.port = Number(next()); break;
      case '--host': config.host = next(); break;
      case '--demo': config.mode = 'demo'; break;
      case '--live': config.mode = 'live'; break;
      case '--sudo': config.useSudo = true; break;
      case '--smartctl': config.smartctl = next(); break;
      case '--refresh': config.refreshSeconds = Number(next()); break;
      case '--capture-interval': config.captureIntervalHours = Number(next()); break;
      case '--design-life': config.designLifeHours = Number(next()); break;
      case '--no-auto-capture': config.autoCapture = false; break;
      case '--verbose': config.verbose = true; break;
      case '--help': case '-h': config.help = true; break;
      default:
        if (arg.startsWith('--')) console.warn(`[config] ignoring unknown option ${arg}`);
        break;
    }
  }
  if (!Number.isFinite(config.port) || config.port <= 0) config.port = 7373;
  return config;
}

const HELP_TEXT = `SMART Disk Analyzer

Usage: node server/index.js [options]

  -p, --port <n>              HTTP port (default 7373, env PORT)
      --host <addr>           bind address (default 127.0.0.1, env HOST)
      --demo                  use the bundled fixtures + synthetic history
      --live                  force live smartctl reads (default)
      --sudo                  run smartctl through "sudo -n"
      --smartctl <path>       smartctl binary (default "smartctl")
      --refresh <seconds>     device scan cache TTL (default 30)
      --capture-interval <h>  minimum hours between automatic snapshots (default 6)
      --design-life <hours>   design life used for the age model (default 43800)
      --no-auto-capture       never write snapshots automatically
      --verbose               log every request
  -h, --help                  show this help

Raw SMART data requires root. Either run with sudo or install the sudoers rule
once with:  ./bin/setup-sudoers.sh   then start with  npm run elevated
`;
/** A device placeholder for disks whose SMART data could not be read. */
function stubDevice(read, scanEntry) {
  const message = read.error || 'smartctl returned no data';
  const permissionDenied = /permission denied|operation not permitted|sudo/i.test(message);
  const label = (scanEntry?.comment || '').split(',')[0].trim();
  return {
    key: slugify(path.basename(read.device)),
    device: read.device,
    infoName: scanEntry?.comment || read.device,
    type: read.type || 'unknown',
    protocol: 'unknown',
    kind: 'unknown',
    form: 'Unknown',
    model: label || read.device,
    modelFamily: '',
    serial: '',
    firmware: '',
    rotationRate: null,
    capacityBytes: null,
    logicalBlockSize: 512,
    smartAvailable: false,
    smartPassed: null,
    permissionDenied,
    messages: [{ severity: 'error', string: message }],
    exitStatus: read.exitCode ?? null,
    exitStatusNotes: [],
    metrics: {},
    attributes: [],
    parameterCount: 0,
    overallStatus: 'unknown',
    collectedAt: Date.now(),
    mode: 'live',
    scanType: read.type || '',
    readCommand: `smartctl ${(read.args || []).join(' ')}`,
    raw: null,
  };
}

/** Attach history, health and forecast to a normalised device. */
function decorateDevice(device, history, config) {
  const enriched = enrichDevice(device, history, { designLifeHours: config.designLifeHours });
  return {
    ...enriched,
    history: history.slice(-180),
    readCommand: device.readCommand || null,
  };
}

/** Aggregate numbers for the dashboard header. */
export function summarizeDevices(devices) {
  const summary = {
    total: devices.length,
    accessible: 0,
    unavailable: 0,
    excellent: 0,
    good: 0,
    fair: 0,
    warning: 0,
    critical: 0,
    unknown: 0,
    totalCapacityBytes: 0,
    averageHealth: null,
    nearestEndOfLife: null,
  };
  const scores = [];
  for (const device of devices) {
    if (!device.smartAvailable) {
      summary.unavailable += 1;
      summary.unknown += 1;
      continue;
    }
    summary.accessible += 1;
    if (typeof device.capacityBytes === 'number') summary.totalCapacityBytes += device.capacityBytes;
    const score = device.health?.score;
    if (typeof score !== 'number') {
      summary.unknown += 1;
    } else {
      scores.push(score);
      if (score >= 92) summary.excellent += 1;
      else if (score >= 85) summary.good += 1;
      else if (score >= 70) summary.fair += 1;
      else if (score >= 45) summary.warning += 1;
      else summary.critical += 1;
    }
    const days = device.forecast?.rul?.days;
    if (typeof days === 'number') {
      if (!summary.nearestEndOfLife || days < summary.nearestEndOfLife.days) {
        summary.nearestEndOfLife = {
          key: device.key,
          model: device.model,
          device: device.device,
          days,
          date: device.forecast.rul.date,
          healthScore: score ?? null,
        };
      }
    }
  }
  if (scores.length) {
    summary.averageHealth = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
  }
  return summary;
}

/** Read live SMART data for every attached disk. */
async function collectLive(config) {
  const scan = await scanDevices({ binary: config.smartctl, useSudo: config.useSudo });
  if (!scan.devices.length) {
    return { devices: [], scan, error: 'No disks were reported by smartctl --scan' };
  }
  const reads = await readDevices(scan.devices, {
    binary: config.smartctl,
    useSudo: config.useSudo,
    timeoutMs: 25000,
  });
  const devices = reads.map((read, index) => {
    const scanEntry = scan.devices[index];
    const scanLabel = (scanEntry?.comment || '').split(',')[0].trim();
    if (read.json) {
      const device = normalizeSmartctlJson(read.json, {
        device: read.device,
        model: scanLabel || undefined,
        collectedAt: Date.now(),
        mode: 'live',
      });
      device.scanType = read.type || '';
      device.readCommand = `smartctl ${(read.args || []).join(' ')}`;
      return device;
    }
    return stubDevice(read, scanEntry);
  });
  return { devices, scan, error: null };
}

/** Read the demo fixtures (never touches the real disks). */
function collectDemo(state) {
  if (!state.demo) {
    state.demo = loadDemoDevices({ now: Date.now() });
    console.log(`[demo] loaded ${state.demo.devices.length} fixture drives with synthetic history`);
  }
  return { devices: state.demo.devices, histories: state.demo.histories, error: null };
}
/** Try the smartctl detection once and cache it on the state object. */
async function ensureSmartctl(state) {
  if (!state.smartctl || !state.smartctl.available) {
    state.smartctl = await detectSmartctl({
      binary: state.config.smartctl,
      useSudo: state.config.useSudo,
    });
  }
  return state.smartctl;
}

function historyMeta(device) {
  return {
    model: device.model,
    serial: device.serial,
    device: device.device,
    kind: device.kind,
  };
}

/**
 * Build the full dashboard payload: every disk with attributes, health,
 * forecast and (optionally refreshed) history.
 */
async function buildPayload(state, { force = false, capture = 'auto' } = {}) {
  const config = state.config;
  const now = Date.now();
  if (!force && state.cache.payload && now - state.cache.at < config.refreshSeconds * 1000) {
    return { ...state.cache.payload, cached: true };
  }

  let sourceDevices = [];
  let histories = null;
  let scanInfo = null;
  let sourceError = null;

  if (config.mode === 'demo') {
    const demo = collectDemo(state);
    sourceDevices = demo.devices;
    histories = demo.histories;
  } else {
    const live = await collectLive(config);
    sourceDevices = live.devices;
    sourceError = live.error;
    scanInfo = live.scan
      ? { flag: live.scan.flag, attempts: live.scan.attempts, deviceCount: live.scan.devices.length }
      : null;
  }

  const disks = [];
  const captureResults = [];
  for (const device of sourceDevices) {
    let history = histories ? (histories[device.key] || []) : state.store.get(device.key);

    const wantCapture = capture === 'force'
      || (capture === 'auto' && config.autoCapture && config.mode === 'live' && device.smartAvailable);
    if (wantCapture) {
      const last = history[history.length - 1];
      const minInterval = capture === 'force' ? 0 : config.captureIntervalHours * 3600 * 1000;
      if (!last || now - last.t >= minInterval) {
        const provisional = decorateDevice(device, history, config);
        const snapshot = buildSnapshot(provisional, now);
        const result = await state.store.record(device.key, snapshot, historyMeta(device));
        if (result.added) {
          history = state.store.get(device.key);
          captureResults.push({ key: device.key, points: result.points });
        }
      }
    }

    disks.push(decorateDevice(device, history, config));
  }

  const smartctl = await ensureSmartctl(state);
  const historySummary = histories
    ? {
      devices: Object.keys(histories).length,
      points: Object.values(histories).reduce((total, list) => total + list.length, 0),
      updatedAt: now,
    }
    : state.store.summary();
  const payload = {
    mode: config.mode,
    cached: false,
    generatedAt: now,
    summary: summarizeDevices(disks),
    status: {
      mode: config.mode,
      smartctl: { ...smartctl },
      privileges: {
        isRoot: typeof process.getuid === 'function' ? process.getuid() === 0 : null,
        useSudo: config.useSudo,
        canReadSmart: disks.some((disk) => disk.smartAvailable),
      },
      host: {
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        uptimeSeconds: Math.round(os.uptime()),
        cpus: os.cpus().length,
      },
      config: {
        refreshSeconds: config.refreshSeconds,
        captureIntervalHours: config.captureIntervalHours,
        designLifeHours: config.designLifeHours,
        autoCapture: config.autoCapture,
        smartctl: config.smartctl,
      },
      scan: scanInfo,
      history: historySummary,
      captured: captureResults,
      warning: sourceError,
      serverStartedAt: state.startedAt,
      nodeVersion: process.version,
    },
    disks,
  };

  state.cache = { at: now, payload };
  return payload;
}
function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(text);
}

/** Read and parse a JSON request body with a size guard. */
function readJsonBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

/** Serve a file from one of the allowed static roots. */
async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return true;
  }
  let root = PUBLIC_DIR;
  let relative = pathname;
  if (pathname === '/') {
    relative = '/index.html';
  } else if (pathname.startsWith('/shared/')) {
    root = SHARED_DIR;
    relative = pathname.slice('/shared'.length);
  }

  const resolved = path.resolve(root, `.${relative}`);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    sendText(res, 403, 'Forbidden');
    return true;
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      sendText(res, 404, 'Not found');
      return true;
    }
    const ext = path.extname(resolved).toLowerCase();
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' || ext === '.js' ? 'no-store' : 'public, max-age=300',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    res.end(await fs.readFile(resolved));
    return true;
  } catch {
    sendText(res, 404, 'Not found');
    return true;
  }
}
/** Dispatch an /api/* request. */
async function handleApi(req, res, state, url) {
  const { pathname, searchParams } = url;
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]

  try {
    // GET /api/status
    if (parts[1] === 'status' && parts.length === 2) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      const payload = await buildPayload(state, { force: false });
      return sendJson(res, 200, {
        mode: payload.mode,
        generatedAt: payload.generatedAt,
        cached: payload.cached,
        status: payload.status,
        summary: payload.summary,
      });
    }

    // GET /api/disks  |  GET /api/disks/:key
    if (parts[1] === 'disks') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      const force = searchParams.get('refresh') === '1' || searchParams.get('force') === '1';
      const payload = await buildPayload(state, { force });
      if (parts.length === 2) return sendJson(res, 200, payload);
      const key = decodeURIComponent(parts[2]);
      const disk = payload.disks.find((entry) => entry.key === key);
      if (!disk) return sendJson(res, 404, { error: `unknown disk key "${key}"` });
      return sendJson(res, 200, {
        mode: payload.mode,
        generatedAt: payload.generatedAt,
        status: payload.status,
        disk,
      });
    }

    // POST /api/capture - force a snapshot of every readable disk
    if (parts[1] === 'capture' && parts.length === 2) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      const payload = await buildPayload(state, { force: true, capture: 'force' });
      state.cache = { at: 0, payload: null };
      return sendJson(res, 200, {
        captured: payload.status.captured,
        history: payload.status.history,
        generatedAt: payload.generatedAt,
        summary: payload.summary,
        disks: payload.disks,
      });
    }

    // GET/DELETE /api/history/:key
    if (parts[1] === 'history' && parts.length === 3) {
      const key = decodeURIComponent(parts[2]);
      if (req.method === 'GET') {
        const demoHistory = state.config.mode === 'demo' ? state.demo?.histories?.[key] : null;
        if (demoHistory) {
          return sendJson(res, 200, {
            key,
            meta: { points: demoHistory.length, demo: true },
            snapshots: demoHistory,
          });
        }
        return sendJson(res, 200, { key, meta: state.store.meta(key), snapshots: state.store.get(key) });
      }
      if (req.method === 'DELETE') {
        const cleared = await state.store.clear(key);
        state.cache = { at: 0, payload: null };
        return sendJson(res, cleared ? 200 : 404, { cleared, key });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    return handleApiTwo(req, res, state, parts, pathname);
  } catch (error) {
    console.error(`[api] ${req.method} ${pathname} failed: ${error.stack || error.message}`);
    return sendJson(res, 500, { error: error.message });
  }
}
/** Import + download endpoints (split out to keep the router readable). */
async function handleApiTwo(req, res, state, parts, pathname) {
  // POST /api/import - analyse smartctl JSON pasted/uploaded from the GUI
  if (parts[1] === 'import' && parts.length === 2) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const body = await readJsonBody(req);
    if (!body) return sendJson(res, 400, { error: 'empty body - expected smartctl -a -j output' });
    const list = Array.isArray(body) ? body : (Array.isArray(body.disks) ? body.disks : [body]);
    const devices = normalizeMany(list, { mode: 'import' });
    const analysed = devices.map((device) => decorateDevice({ ...device, mode: 'import' }, [], state.config));
    return sendJson(res, 200, {
      imported: analysed.length,
      summary: summarizeDevices(analysed),
      disks: analysed,
    });
  }

  // GET /api/download/:key - raw smartctl JSON for one disk
  if (parts[1] === 'download' && parts.length === 3) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    const key = decodeURIComponent(parts[2]);
    const payload = await buildPayload(state, { force: false });
    const disk = payload.disks.find((entry) => entry.key === key);
    if (!disk || !disk.raw) return sendJson(res, 404, { error: 'no raw smartctl JSON for this disk' });
    const filename = `smartctl-${slugify(disk.model)}-${slugify(disk.serial || disk.device)}.json`;
    const body = JSON.stringify(disk.raw, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }

  // GET /api/history-sample?days=30 - how the demo history looks (handy for docs)
  return sendJson(res, 404, { error: `unknown endpoint ${pathname}` });
}

/** Create the HTTP server (exported so tests can drive it in-process). */
export function createServer(state) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (state.config.verbose) console.log(`[http] ${req.method} ${url.pathname}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, state, url);
      return;
    }
    await serveStatic(req, res, url.pathname);
  });
}

/** Wire up state and start listening. */
export async function startServer(config) {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const state = {
    config,
    startedAt: Date.now(),
    store: await new HistoryStore({ file: config.historyFile }).load(),
    cache: { at: 0, payload: null },
    demo: null,
    smartctl: null,
  };

  const smartctl = await ensureSmartctl(state);
  const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : null;
  const server = createServer(state);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const baseUrl = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`;

  console.log('');
  console.log('  SMART Disk Analyzer');
  console.log(`  ${baseUrl}`);
  console.log(`  mode:      ${config.mode}${config.mode === 'demo' ? '  (fixtures + synthetic history)' : ''}`);
  console.log(`  smartctl:  ${smartctl.available ? `${smartctl.version} (${config.smartctl})` : 'NOT FOUND'}`);
  console.log(`  history:   ${config.historyFile}`);
  if (config.mode === 'live') {
    if (smartctl.available && !isRoot && !config.useSudo) {
      console.log('');
      console.log('  ! SMART data needs root: disks will be listed but unreadable.');
      console.log('    Start with:  sudo npm start    |    npm run elevated');
      console.log('    Or install the sudoers rule once:  ./bin/setup-sudoers.sh');
    }
    if (config.useSudo && !smartctl.available) {
      console.log('  ! smartctl could not run through "sudo -n" (password required?).');
    }
  }
  console.log('');

  return { server, state, baseUrl, port };
}

/** CLI entry point. */
async function main() {
  const config = parseConfig();
  if (config.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  try {
    await startServer(config);
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      console.error(`[fatal] port ${config.port} is already in use - try --port ${config.port + 1}`);
    } else {
      console.error(`[fatal] ${error.message}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();





