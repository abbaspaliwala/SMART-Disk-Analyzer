import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ataInfo,
  decodeNvmeCriticalWarning,
  nvmeDataUnitsToBytes,
  parseRawNumber,
  rateAtaAttribute,
  rateNvmeField,
  rateScsiField,
  worstSeverity,
} from '../shared/attributes.js';

test('ATA attribute metadata falls back gracefully', () => {
  assert.equal(ataInfo(5).name, 'Reallocated Sector Count');
  assert.equal(ataInfo(5, 'Reallocated_Sector_Ct').name, 'Reallocated_Sector_Ct');
  assert.equal(ataInfo(999, 'Vendor_Thing').category, 'vendor');
  assert.match(ataInfo(999).description, /Vendor specific/);
});

test('parses raw value strings', () => {
  assert.equal(parseRawNumber('12345 (0 0 0)'), 12345);
  assert.equal(parseRawNumber('0'), 0);
  assert.equal(parseRawNumber('n/a'), null);
  assert.equal(parseRawNumber(undefined), null);
});

test('reallocated sector tiers escalate', () => {
  const status = (raw) => rateAtaAttribute({ id: 5, raw, rawString: String(raw), value: 100, threshold: 10 }).status;
  assert.equal(status(0), 'ok');
  assert.equal(status(3), 'watch');
  assert.equal(status(48), 'warning');
  assert.equal(status(1040), 'critical');
});

test('pending and uncorrectable sectors are severe', () => {
  assert.equal(rateAtaAttribute({ id: 197, raw: 1, rawString: '1' }).status, 'warning');
  assert.equal(rateAtaAttribute({ id: 197, raw: 24, rawString: '24' }).status, 'critical');
  assert.equal(rateAtaAttribute({ id: 198, raw: 1, rawString: '1' }).status, 'critical');
  assert.equal(rateAtaAttribute({ id: 187, raw: 0, rawString: '0' }).status, 'ok');
});

test('CRC errors are reported as a connection issue', () => {
  const rating = rateAtaAttribute({ id: 199, raw: 4, rawString: '4' });
  assert.equal(rating.status, 'watch');
  assert.match(rating.note, /cable/i);
});

test('temperature thresholds', () => {
  const temp = (raw) => rateAtaAttribute({ id: 194, raw, rawString: String(raw) }).status;
  assert.equal(temp(38), 'ok');
  assert.equal(temp(52), 'watch');
  assert.equal(temp(62), 'warning');
  assert.equal(temp(75), 'critical');
});

test('endurance gauges count down from 100', () => {
  const gauge = (value) => rateAtaAttribute({ id: 231, value, raw: 0, rawString: '0' }).status;
  assert.equal(gauge(100), 'ok');
  assert.equal(gauge(45), 'watch');
  assert.equal(gauge(15), 'warning');
  assert.equal(gauge(3), 'critical');
  // attribute 202 reports the remaining percentage as the raw value
  assert.equal(rateAtaAttribute({ id: 202, raw: 90, rawString: '90' }).status, 'ok');
  assert.equal(rateAtaAttribute({ id: 202, raw: 10, rawString: '10' }).status, 'warning');
});

test('firmware failing flag always wins', () => {
  const rating = rateAtaAttribute({ id: 5, raw: 1, rawString: '1', whenFailed: 'FAILING_NOW' });
  assert.equal(rating.status, 'critical');
  assert.match(rating.note, /FAILING_NOW/);
});

test('NVMe health fields are rated', () => {
  assert.equal(rateNvmeField('percentage_used', 12).status, 'ok');
  assert.equal(rateNvmeField('percentage_used', 75).status, 'watch');
  assert.equal(rateNvmeField('percentage_used', 95).status, 'warning');
  assert.equal(rateNvmeField('percentage_used', 105).status, 'critical');

  assert.equal(rateNvmeField('available_spare', 100, { available_spare_threshold: 10 }).status, 'ok');
  assert.equal(rateNvmeField('available_spare', 12, { available_spare_threshold: 10 }).status, 'warning');
  assert.equal(rateNvmeField('available_spare', 4, { available_spare_threshold: 10 }).status, 'critical');

  assert.equal(rateNvmeField('media_errors', 0).status, 'ok');
  assert.equal(rateNvmeField('media_errors', 3).status, 'warning');
  assert.equal(rateNvmeField('media_errors', 30).status, 'critical');

  assert.equal(rateNvmeField('temperature', 85).status, 'critical');
  assert.equal(rateNvmeField('critical_warning', 0).status, 'ok');
  assert.equal(rateNvmeField('critical_warning', 4).status, 'critical');
});

test('NVMe critical warning bitmask decodes', () => {
  assert.deepEqual(decodeNvmeCriticalWarning(0), []);
  assert.deepEqual(decodeNvmeCriticalWarning(1), ['available spare below threshold']);
  assert.equal(decodeNvmeCriticalWarning(0b1011).length, 3);
});

test('NVMe data units convert to bytes', () => {
  assert.equal(nvmeDataUnitsToBytes(1000), 1000 * 512000);
  assert.equal(nvmeDataUnitsToBytes(null), null);
});

test('SCSI counters are rated', () => {
  assert.equal(rateScsiField('scsi_grown_defect_list', 0).status, 'ok');
  assert.equal(rateScsiField('scsi_grown_defect_list', 3).status, 'warning');
  assert.equal(rateScsiField('scsi_grown_defect_list', 40).status, 'critical');
  assert.equal(rateScsiField('scsi_temperature', 38).status, 'ok');
  assert.equal(rateScsiField('scsi_temperature', 70).status, 'warning');
});

test('worstSeverity picks the higher rank', () => {
  assert.equal(worstSeverity('ok', 'critical'), 'critical');
  assert.equal(worstSeverity('watch', 'warning'), 'warning');
  assert.equal(worstSeverity('info', 'ok'), 'info', 'ties keep the first argument');
  assert.equal(worstSeverity('ok', 'info'), 'ok', 'ties keep the first argument');
});
