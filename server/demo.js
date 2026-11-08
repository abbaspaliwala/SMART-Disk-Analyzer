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

/**
 * Synthetic volume layouts for the demo drives. `share` is a fraction of the
 * drive capacity; whatever is left over becomes the "Free Space" segment, just
 * like an unpartitioned tail on a real disk.
 */
const DEMO_LAYOUTS = {
  'nvme-ssd-healthy.json': [
    { partn: 1, label: 'EFI System', fstype: 'vfat', share: 0.0006 },
    { partn: 2, label: 'kubuntu_2604', fstype: 'ext4', share: 0.2794 },
    { partn: 3, label: 'Home', fstype: 'ext4', share: 0.6 },
  ],
  'sata-ssd-worn.json': [
    { partn: 1, label: 'System', fstype: 'ext4', share: 0.25 },
    { partn: 2, label: 'Data', fstype: 'ntfs', share: 0.7 },
  ],
  'hdd-reallocated.json': [
    { partn: 1, label: 'System Reserved', fstype: 'ntfs', share: 0.0002 },
    { partn: 2, label: 'Win8', fstype: 'ntfs', share: 0.4998 },
    { partn: 3, label: 'Recovery', fstype: 'ntfs', share: 0.002 },
  ],
  'hdd-failing.json': [
    { partn: 1, label: 'Media', fstype: 'ext4', share: 0.45 },
    { partn: 2, label: 'Archive', fstype: 'ext4', share: 0.45 },
  ],
  'scsi-sas-hdd.json': [
    { partn: 1, label: 'root', fstype: 'xfs', share: 0.2 },
    { partn: 2, label: 'data', fstype: 'xfs', share: 0.79 },
  ],
};

/** Device node for partition `partn` of `diskName` (sda1, nvme0n1p1, mmcblk0p1). */
function partitionNode(diskName, partn) {
  if (/^nvme\d+$/.test(diskName)) return `${diskName}n1p${partn}`;
  if (/^mmcblk\d+$/.test(diskName)) return `${diskName}p${partn}`;
  return `${diskName}${partn}`;
}

/**
 * Fabricate the volume map of a demo drive. Nothing here exists on the host -
 * every volume is flagged `demo` so the GUI never asks to open it.
 */
export function buildDemoPartitions(device, layout = []) {
  const totalBytes = device.capacityBytes || 0;
  if (!totalBytes || !layout.length) return null;
  const diskName = String(device.device || '').replace(/\s*\(demo\)\s*$/i, '').replace(/^\/dev\//, '');
  if (!diskName) return null;
  const volumes = layout.map((entry) => ({
    path: `/dev/${partitionNode(diskName, entry.partn)}`,
    number: entry.partn,
    label: entry.label,
    fstype: entry.fstype,
    sizeBytes: Math.round(totalBytes * entry.share),
    mountpoint: null,
    mounted: false,
    fsUsePercent: entry.usePercent ?? null,
    fsAvailableBytes: null,
    demo: true,
  }));
  const allocatedBytes = volumes.reduce((total, volume) => total + volume.sizeBytes, 0);
  return {
    device: `/dev/${diskName}`,
    totalBytes,
    allocatedBytes,
    freeBytes: Math.max(0, totalBytes - allocatedBytes),
    volumes,
    demo: true,
    source: 'demo',
  };
}

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
    device.partitions = buildDemoPartitions(device, DEMO_LAYOUTS[file] || []);
    histories[device.key] = buildDemoHistory(device, now);
    devices.push(device);
  }
  return { devices, histories };
}

export const DEMO_FIXTURE_DIR = FIXTURE_DIR;
