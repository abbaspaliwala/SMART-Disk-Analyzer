import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildReadArgs, detectSmartctl, parseScanOutput } from '../server/smartctl.js';
import { HistoryStore } from '../server/store.js';
import { parseConfig, summarizeDevices, startServer } from '../server/index.js';
import { loadDemoDevices } from '../server/demo.js';

test('parseConfig applies defaults and CLI overrides', () => {
  const defaults = parseConfig([], {});
  assert.equal(defaults.port, 7373);
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.mode, 'live');
  assert.equal(defaults.useSudo, false);
  assert.equal(defaults.designLifeHours, 43800);

  const custom = parseConfig(['--port', '8080', '--demo', '--sudo', '--refresh', '5', '--no-auto-capture'], {});
  assert.equal(custom.port, 8080);
  assert.equal(custom.mode, 'demo');
  assert.equal(custom.useSudo, true);
  assert.equal(custom.refreshSeconds, 5);
  assert.equal(custom.autoCapture, false);

  const fromEnv = parseConfig([], { PORT: '9000', SMART_MODE: 'demo', SMARTCTL_SUDO: '1', CAPTURE_INTERVAL_HOURS: '12' });
  assert.equal(fromEnv.port, 9000);
  assert.equal(fromEnv.mode, 'demo');
  assert.equal(fromEnv.useSudo, true);
  assert.equal(fromEnv.captureIntervalHours, 12);
});

test('parseScanOutput reads normal and open-failed scan lines', () => {
  const devices = parseScanOutput([
    '/dev/sda -d scsi # /dev/sda, SCSI device',
    '/dev/nvme0 -d nvme # /dev/nvme0, NVMe device',
    '# /dev/sdb -d scsi # /dev/sdb, SCSI device open failed: Permission denied',
    '',
    '/dev/sdc',
  ].join('\n'));

  assert.equal(devices.length, 4);
  assert.deepEqual(devices[0], { device: '/dev/sda', type: 'scsi', comment: '/dev/sda, SCSI device', openFailed: false });
  assert.equal(devices[1].type, 'nvme');
  assert.equal(devices[2].openFailed, true);
  assert.match(devices[2].comment, /Permission denied/);
  assert.equal(devices[3].type, '');
});

test('buildReadArgs omits -d for auto detected buses and passes exotic ones', () => {
  assert.deepEqual(buildReadArgs({ device: '/dev/nvme0', type: 'nvme' }), ['-a', '-j', '/dev/nvme0']);
  assert.deepEqual(buildReadArgs({ device: '/dev/sda', type: 'scsi' }), ['-a', '-j', '/dev/sda']);
  assert.deepEqual(buildReadArgs({ device: '/dev/sda', type: '' }), ['-a', '-j', '/dev/sda']);
  assert.deepEqual(buildReadArgs({ device: '/dev/sda', type: 'sat,12' }), ['-a', '-j', '-d', 'sat,12', '/dev/sda']);
  assert.deepEqual(buildReadArgs({ device: '/dev/bus/0', type: 'megaraid,3' }), ['-a', '-j', '-d', 'megaraid,3', '/dev/bus/0']);
});

test('detectSmartctl reports a missing binary instead of throwing', async () => {
  const result = await detectSmartctl({ binary: 'definitely-not-smartctl-xyz', timeoutMs: 2000 });
  assert.equal(result.available, false);
  assert.equal(typeof result.error, 'string');
});

test('summarizeDevices buckets health and finds the nearest end of life', () => {
  const summary = summarizeDevices([
    { smartAvailable: true, capacityBytes: 100, health: { score: 97 }, forecast: { rul: { days: 3000, date: 1 } } },
    { smartAvailable: true, capacityBytes: 200, health: { score: 72 }, forecast: { rul: { days: 400, date: 2 } } },
    { smartAvailable: true, capacityBytes: 300, health: { score: 30 }, forecast: { rul: { days: 20, date: 3 } } },
    { smartAvailable: false, health: { score: null }, forecast: { rul: { days: null } } },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.accessible, 3);
  assert.equal(summary.unavailable, 1);
  assert.equal(summary.excellent, 1);
  assert.equal(summary.fair, 1);
  assert.equal(summary.critical, 1);
  assert.equal(summary.totalCapacityBytes, 600);
  assert.equal(summary.averageHealth, 66.3);
  assert.equal(summary.nearestEndOfLife.days, 20);
});

test('HistoryStore persists, enforces the interval and reloads', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smart-store-'));
  const file = path.join(dir, 'history.json');
  const store = await new HistoryStore({ file, minIntervalMs: 1000 }).load();

  const first = await store.record('disk-a', { t: 1000, wearPercent: 1 }, { model: 'Test' });
  assert.equal(first.added, true);
  assert.equal(first.points, 1);
  assert.equal((await store.record('disk-a', { t: 1500, wearPercent: 2 })).added, false);

  const later = await store.record('disk-a', { t: 5000, wearPercent: 3 });
  assert.equal(later.added, true);
  assert.equal(later.points, 2);

  const reloaded = await new HistoryStore({ file }).load();
  assert.equal(reloaded.get('disk-a').length, 2);
  assert.equal(reloaded.meta('disk-a').model, 'Test');
  assert.equal(reloaded.summary().devices, 1);

  await reloaded.clear('disk-a');
  assert.equal(reloaded.get('disk-a').length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('demo fixtures produce drives with enough history to forecast', () => {
  const { devices, histories } = loadDemoDevices({ now: Date.now() });
  assert.equal(devices.length, 5);
  for (const device of devices) {
    const history = histories[device.key];
    assert.ok(history.length >= 10, `${device.model} has ${history.length} snapshots`);
    assert.ok(history[0].t < history[history.length - 1].t);
    assert.ok(history.every((snapshot) => typeof snapshot.t === 'number' && typeof snapshot.healthScore === 'number'));
  }
});
test('the HTTP API serves demo disks, import, capture and static assets', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smart-api-'));
  const { server, baseUrl } = await startServer({
    ...parseConfig([], {}),
    port: 0,
    mode: 'demo',
    historyFile: path.join(dir, 'history.json'),
    refreshSeconds: 0,
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  const disksResponse = await fetch(`${baseUrl}/api/disks`);
  assert.equal(disksResponse.status, 200);
  const payload = await disksResponse.json();
  assert.equal(payload.mode, 'demo');
  assert.equal(payload.disks.length, 5);
  assert.ok(payload.disks.every((disk) => disk.attributes.length > 0));
  assert.ok(payload.disks.every((disk) => typeof disk.forecast.rul.confidence === 'number'));
  assert.equal(payload.status.privileges.canReadSmart, true);
  assert.equal(typeof payload.summary.averageHealth, 'number');

  const first = payload.disks[0];
  const detail = await (await fetch(`${baseUrl}/api/disks/${encodeURIComponent(first.key)}`)).json();
  assert.equal(detail.disk.key, first.key);
  assert.equal((await fetch(`${baseUrl}/api/disks/nope`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/unknown`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/status`)).status, 200);

  const history = await (await fetch(`${baseUrl}/api/history/${encodeURIComponent(first.key)}`)).json();
  assert.ok(history.snapshots.length > 0);

  const captureResponse = await fetch(`${baseUrl}/api/capture`, { method: 'POST' });
  assert.equal(captureResponse.status, 200);
  assert.ok(Array.isArray((await captureResponse.json()).disks));

  // import a smartctl payload produced elsewhere
  const importedSource = {
    smartctl: { exit_status: 0 },
    device: { name: '/dev/sdx', type: 'sat', protocol: 'ATA' },
    model_name: 'Imported Disk',
    serial_number: 'IMP-1',
    rotation_rate: 7200,
    user_capacity: { bytes: 2000000000000 },
    smart_status: { passed: true },
    ata_smart_attributes: {
      table: [
        { id: 9, name: 'Power_On_Hours', value: 90, worst: 90, thresh: 0, raw: { value: 1000, string: '1000' } },
        { id: 5, name: 'Reallocated_Sector_Ct', value: 100, worst: 100, thresh: 10, raw: { value: 0, string: '0' } },
      ],
    },
  };
  const importResponse = await fetch(`${baseUrl}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(importedSource),
  });
  assert.equal(importResponse.status, 200);
  const imported = await importResponse.json();
  assert.equal(imported.imported, 1);
  assert.equal(imported.disks[0].model, 'Imported Disk');
  assert.ok(imported.disks[0].health.score > 0);

  // static hosting
  assert.equal((await fetch(`${baseUrl}/`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/shared/forecast.js`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/js/app.js`)).status, 200);
});

