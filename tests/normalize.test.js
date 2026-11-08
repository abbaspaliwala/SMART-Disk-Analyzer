import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeSmartctlJson, normalizeMany, classifyDrive, decodeExitStatus, deviceKey } from '../shared/normalize.js';
import { formatBytes, formatDays, formatHours, formatNumber, clamp, round } from '../shared/format.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(HERE, '..', 'fixtures', name), 'utf8'));

test('normalises an NVMe drive', () => {
  const device = normalizeSmartctlJson(fixture('nvme-ssd-healthy.json'));
  assert.equal(device.kind, 'ssd');
  assert.equal(device.form, 'NVMe SSD');
  assert.equal(device.protocol, 'NVMe');
  assert.equal(device.smartPassed, true);
  assert.equal(device.smartAvailable, true);
  assert.equal(device.metrics.wearPercent, 38);
  assert.match(device.metrics.wearSource, /Percentage Used/);
  // 222656250 data units * 1000 * 512 bytes = 114 TB
  assert.equal(device.metrics.writtenBytes, 222656250 * 512000);
  assert.equal(device.metrics.temperature, 41);
  assert.equal(device.metrics.powerOnHours, 35040);
  assert.equal(device.metrics.mediaErrors, 0);
  assert.equal(device.metrics.spareAvailable, 100);
  assert.ok(device.parameterCount >= 15, 'every NVMe health field becomes a parameter');
  assert.ok(device.attributes.some((attribute) => attribute.id === 'percentage_used'));
  assert.equal(device.attributes.find((a) => a.id === 'percentage_used').status, 'ok');
});

test('normalises a SATA SSD with ATA attributes', () => {
  const device = normalizeSmartctlJson(fixture('sata-ssd-worn.json'));
  assert.equal(device.kind, 'ssd');
  assert.equal(device.form, 'SATA SSD');
  assert.equal(device.protocol, 'ATA');
  assert.equal(device.metrics.wearPercent, 12); // attribute 202 reports 88% remaining
  assert.equal(device.attributes.length, 19);
  const reallocated = device.attributes.find((a) => a.id === 5);
  assert.equal(reallocated.status, 'ok');
  assert.equal(reallocated.raw, 0);
  // 148926410 LBAs * 512 bytes
  assert.equal(device.metrics.writtenBytes, 148926410 * 512);
  assert.equal(device.metrics.selfTestFailures, 0);
});

test('normalises a failing HDD and reflects it in the overall status', () => {
  const device = normalizeSmartctlJson(fixture('hdd-failing.json'));
  assert.equal(device.kind, 'hdd');
  assert.equal(device.smartPassed, false);
  assert.equal(device.overallStatus, 'critical');
  assert.equal(device.metrics.reallocated, 1040);
  assert.equal(device.metrics.pendingSectors, 24);
  assert.equal(device.metrics.offlineUncorrectable, 8);
  assert.equal(device.metrics.wearPercent, null, 'HDDs have no endurance gauge');
  const pending = device.attributes.find((a) => a.id === 197);
  assert.equal(pending.status, 'critical');
  const failing = device.attributes.find((a) => a.id === 5);
  assert.equal(failing.status, 'critical');
  assert.match(failing.note, /failing/i);
});

test('handles a permission denied smartctl response without inventing data', () => {
  const device = normalizeSmartctlJson(fixture('permission-denied.json'));
  assert.equal(device.smartAvailable, false);
  assert.equal(device.permissionDenied, true);
  assert.equal(device.parameterCount, 0);
  assert.equal(device.metrics.wearPercent, null);
  assert.match(device.messages[0].string, /Permission denied/i);
});

test('normalises SCSI error counters and skips them for NVMe devices', () => {
  const scsi = normalizeSmartctlJson(fixture('scsi-sas-hdd.json'));
  assert.equal(scsi.kind, 'hdd');
  assert.equal(scsi.metrics.grownDefects, 3);
  assert.ok(scsi.attributes.some((attribute) => attribute.key === 'scsi:read_uncorrected'));

  const nvme = normalizeSmartctlJson(fixture('nvme-ssd-healthy.json'));
  assert.equal(nvme.attributes.filter((attribute) => attribute.source === 'SCSI').length, 0,
    'NVMe drives must not gain phantom SCSI rows');
});

test('classifies drive types from the protocol and rotation rate', () => {
  assert.equal(classifyDrive({ nvme_smart_health_information_log: {} }).kind, 'ssd');
  assert.equal(classifyDrive({ rotation_rate: 7200 }).form, 'HDD');
  assert.equal(classifyDrive({ rotation_rate: 0 }).form, 'SATA SSD');
  assert.equal(classifyDrive({}).form, 'Unknown');
});

test('decodes smartctl exit status bits', () => {
  assert.deepEqual(decodeExitStatus(0), []);
  assert.match(decodeExitStatus(2).join(), /device open failed/);
  assert.match(decodeExitStatus(8).join(), /DISK FAILING/);
  assert.equal(decodeExitStatus(9).length, 2);
});

test('builds a stable device key from model and serial', () => {
  const json = { model_name: 'Samsung SSD 970 EVO', serial_number: 'ABC123' };
  assert.equal(deviceKey(json), 'samsung-ssd-970-evo-abc123');
  assert.equal(deviceKey(json), deviceKey({ ...json }));
  assert.equal(deviceKey({}), 'disk');
});

test('normalizeMany accepts a single object or an array', () => {
  const single = normalizeMany(fixture('nvme-ssd-healthy.json'));
  assert.equal(single.length, 1);
  const many = normalizeMany([fixture('nvme-ssd-healthy.json'), fixture('hdd-failing.json')]);
  assert.equal(many.length, 2);
  assert.notEqual(many[0].key, many[1].key);
});

test('formatting helpers behave', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(114000000000000), '104 TB');
  assert.equal(formatNumber(1234567), '1,234,567');
  assert.equal(formatHours(30), '30 h');
  assert.equal(formatHours(35040), '4y');
  assert.equal(formatDays(0.2), '< 1 d');
  assert.equal(clamp(120, 0, 100), 100);
  assert.equal(round(1.2345, 2), 1.23);
  assert.equal(round(0.30000000000000004, 2), 0.3);
  assert.equal(round(-0.04, 1), 0, 'never returns -0');
});
