/**
 * Demo data source.
 *
 * Loads the captured smartctl fixtures from `fixtures/` and fabricates a
 * plausible 12 week snapshot history for each drive, so the GUI, the trend
 * charts and the forecast can be demonstrated on a machine where smartctl
 * cannot open the disks (for example without root).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSmartctlJson } from '../shared/normalize.js';
import { assessHealth } from '../shared/forecast.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, '..', 'fixtures');

const DEMO_FILES = [
  'nvme-ssd-healthy.json',
  'sata-ssd-worn.json',
  'hdd-reallocated.json',
  'hdd-failing.json',
  'scsi-sas-hdd.json',
];

const WEEK_MS = 7 * 86400000;
const HISTORY_WEEKS = 12;

function decrementTowards(current, perWeek, weeks) {
  if (current === null || current === undefined) return null;
  return Math.max(0, current - perWeek * weeks);
}

/**
 * Build a synthetic but internally consistent history that ends at the
 * fixture's current values.
 */
export function buildDemoHistory(device, now = Date.now(), weeks = HISTORY_WEEKS) {
  const m = device.metrics || {};
  const lifetimeHours = m.powerOnHours && m.powerOnHours > 0 ? m.powerOnHours : 8760;
  const lifetimeWeeks = Math.max(weeks, lifetimeHours / 168);

  const perWeek = {
    wear: m.wearPercent !== null && m.wearPercent !== undefined ? m.wearPercent / lifetimeWeeks : 0,
    written: m.writtenBytes ? m.writtenBytes / lifetimeWeeks : 0,
    read: m.readBytes ? m.readBytes / lifetimeWeeks : 0,
    reallocated: m.reallocated ? m.reallocated / lifetimeWeeks : 0,
    pending: m.pendingSectors ? m.pendingSectors / lifetimeWeeks : 0,
    uncorrectable: m.mediaErrorsTotal ? m.mediaErrorsTotal / lifetimeWeeks : 0,
    crc: m.crcErrors ? m.crcErrors / lifetimeWeeks : 0,
  };

  const snapshots = [];
  for (let back = weeks; back >= 0; back -= 1) {
    const t = now - back * WEEK_MS;
    const metrics = {
      ...m,
      wearPercent: m.wearPercent === null || m.wearPercent === undefined ? null : decrementTowards(m.wearPercent, perWeek.wear, back),
      writtenBytes: m.writtenBytes ? Math.round(decrementTowards(m.writtenBytes, perWeek.written, back)) : null,
      readBytes: m.readBytes ? Math.round(decrementTowards(m.readBytes, perWeek.read, back)) : null,
      reallocated: m.reallocated === null || m.reallocated === undefined ? null : Math.round(decrementTowards(m.reallocated, perWeek.reallocated, back)),
      pendingSectors: m.pendingSectors === null || m.pendingSectors === undefined ? null : Math.round(decrementTowards(m.pendingSectors, perWeek.pending, back)),
      mediaErrorsTotal: Math.round(decrementTowards(m.mediaErrorsTotal ?? 0, perWeek.uncorrectable, back)),
      crcErrors: Math.round(decrementTowards(m.crcErrors ?? 0, perWeek.crc, back)),
      powerOnHours: m.powerOnHours ? Math.round(decrementTowards(m.powerOnHours, 168, back)) : null,
      powerCycles: m.powerCycles ? Math.round(decrementTowards(m.powerCycles, 1.2, back)) : null,
      temperature: typeof m.temperature === 'number'
        ? Math.round(m.temperature + Math.sin(back / 1.7) * 2)
        : null,
    };
    const health = assessHealth({ ...device, metrics }, []);
    snapshots.push({
      t,
      powerOnHours: metrics.powerOnHours,
      powerCycles: metrics.powerCycles,
      temperature: metrics.temperature,
      wearPercent: metrics.wearPercent,
      writtenBytes: metrics.writtenBytes,
      readBytes: metrics.readBytes,
      reallocated: metrics.reallocated,
      pendingSectors: metrics.pendingSectors,
      uncorrectable: metrics.mediaErrorsTotal,
      crcErrors: metrics.crcErrors,
      spareAvailable: metrics.spareAvailable,
      healthScore: health.score,
      smartPassed: device.smartPassed,
    });
  }
  return snapshots;
}

/**
 * Load every demo drive plus its synthetic history.
 * @returns {{devices:Array, histories:Object}}
 */
export function loadDemoDevices({ now = Date.now() } = {}) {
  const devices = [];
  const histories = {};
  for (const file of DEMO_FILES) {
    const fullPath = path.join(FIXTURE_DIR, file);
    let json;
    try {
      json = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (error) {
      console.warn(`[demo] skipping ${file}: ${error.message}`);
      continue;
    }
    json.smartctl = { ...(json.smartctl || {}), exit_status: 0 };
    const device = normalizeSmartctlJson(json, { collectedAt: now, mode: 'demo' });
    device.mode = 'demo';
    device.device = `${device.device} (demo)`;
    device.key = `demo-${device.key}`;
    histories[device.key] = buildDemoHistory(device, now);
    devices.push(device);
  }
  return { devices, histories };
}

export const DEMO_FIXTURE_DIR = FIXTURE_DIR;
