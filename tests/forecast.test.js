import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeSmartctlJson } from '../shared/normalize.js';
import {
  assessHealth,
  buildSnapshot,
  enrichDevice,
  forecast,
  gradeFor,
  historySpanDays,
  linearTrend,
  mergeHistory,
  DEFAULT_DESIGN_LIFE_HOURS,
} from '../shared/forecast.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => normalizeSmartctlJson(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'fixtures', name), 'utf8')));

const DAY = 86400000;

/** Build a synthetic history with a linear wear ramp ending at `endWear`. */
function rampHistory({ points = 13, spanDays = 84, endWear = 38, endWritten = 114e12, endHours = 35040, perStepWear = 0.33 }) {
  const now = Date.now();
  const history = [];
  for (let i = points - 1; i >= 0; i -= 1) {
    history.push({
      t: now - i * (spanDays / (points - 1)) * DAY,
      powerOnHours: endHours - i * 168,
      powerCycles: 500,
      temperature: 41,
      wearPercent: endWear - i * perStepWear,
      writtenBytes: endWritten - i * 6.5e11,
      readBytes: 6e13,
      reallocated: 0,
      pendingSectors: 0,
      uncorrectable: 0,
      crcErrors: 0,
      spareAvailable: 100,
      healthScore: 95,
      smartPassed: true,
    });
  }
  return history;
}

test('linearTrend fits a straight line', () => {
  const fit = linearTrend([{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 6 }]);
  assert.equal(fit.slope, 2);
  assert.equal(fit.intercept, 0);
  assert.equal(fit.r2, 1);
  assert.equal(linearTrend([{ x: 1, y: 1 }]), null);
  assert.equal(linearTrend([]), null);
});

test('gradeFor maps scores to letters', () => {
  assert.equal(gradeFor(100).grade, 'A+');
  assert.equal(gradeFor(88).grade, 'A');
  assert.equal(gradeFor(73).grade, 'C');
  assert.equal(gradeFor(0).verdict, 'Critical');
});

test('a clean NVMe drive scores high and gets a long remaining life', () => {
  const result = forecast(fixture('nvme-ssd-healthy.json'), []);
  assert.ok(result.health.score >= 90, `expected a high score, got ${result.health.score}`);
  assert.equal(result.health.risks.filter((risk) => risk.severity === 'critical').length, 0);
  assert.ok(result.rul.days > 1000 && result.rul.days < 4000, `unexpected RUL ${result.rul.days}`);
  assert.ok(result.rul.date > Date.now());
  assert.equal(result.recommendation.level, 'ok');
  assert.equal(result.wear.percentUsed, 38);
  assert.equal(result.wear.percentRemaining, 62);
  assert.equal(result.wear.rateSource, 'lifetime-average', 'without history the rate is the lifetime average');
  assert.ok(result.wear.ratePerDay > 0);
});

test('measured history overrides the lifetime average and raises confidence', () => {
  const device = fixture('nvme-ssd-healthy.json');
  const without = forecast(device, []);
  const withHistory = forecast(device, rampHistory({}));
  assert.ok(withHistory.rul.confidence > without.rul.confidence, 'history must increase confidence');
  assert.equal(withHistory.rul.confidenceLabel, 'high');
  assert.equal(withHistory.rul.label, 'Endurance consumption');
  assert.match(withHistory.rul.method, /measured trend/);
  assert.ok(withHistory.wear.ratePerMonth > 0);
  assert.ok(withHistory.rul.days > 1000 && withHistory.rul.days < 1800, `unexpected RUL ${withHistory.rul.days}`);
});

test('a faster wear rate shortens the forecast', () => {
  const device = fixture('nvme-ssd-healthy.json');
  const slow = forecast(device, rampHistory({ perStepWear: 0.2 }));
  const fast = forecast(device, rampHistory({ perStepWear: 1.2 }));
  assert.ok(fast.rul.days < slow.rul.days, 'more wear per week must reduce the remaining life');
});
test('endurance projection reproduces the rated TBW of the drive', () => {
  const result = forecast(fixture('nvme-ssd-healthy.json'), rampHistory({}));
  // 114 TB written at 38% used implies a 300 TB rating (the real 970 EVO Plus spec)
  const tbw = result.endurance.impliedTotalBytes / 1e12;
  assert.ok(Math.abs(tbw - 300) < 1, `expected ~300 TB implied endurance, got ${tbw}`);
  assert.ok(result.endurance.remainingBytes > 0);
  assert.ok(result.endurance.writeBytesPerDay > 0);
});

test('a failing drive collapses in score and remaining life', () => {
  const result = forecast(fixture('hdd-failing.json'), []);
  assert.equal(result.health.score <= 15, true, `score should collapse, got ${result.health.score}`);
  assert.equal(result.rul.days, 0);
  assert.equal(result.recommendation.level, 'critical');
  assert.match(result.recommendation.headline, /Replace/);
  assert.ok(result.health.risks.some((risk) => risk.id === 'smart-failing'));
  assert.ok(result.health.risks.some((risk) => risk.id === 'pending'));
});

test('health score is reduced by reallocated sectors and age', () => {
  const result = forecast(fixture('hdd-reallocated.json'), []);
  assert.ok(result.health.score < 85);
  assert.ok(result.health.risks.some((risk) => risk.id === 'reallocated'));
  assert.ok(result.health.penalties.some((penalty) => penalty.id === 'reallocated'));
  assert.ok(result.rul.days > 0, 'a 7 year old but otherwise healthy drive keeps a grace period');
});

test('pending sectors cap an otherwise long forecast', () => {
  // A drive with a healthy wear curve but unstable sectors must not be given years.
  const device = fixture('nvme-ssd-healthy.json');
  const unstable = { ...device, metrics: { ...device.metrics, pendingSectors: 2 } };
  const result = forecast(unstable, rampHistory({}));
  assert.equal(result.rul.days, 60, 'the pending-sector cap wins over the wear curve');
  assert.match(result.rul.caps.map((cap) => cap.reason).join(' '), /pending/i);

  const failing = forecast(fixture('hdd-failing.json'), []);
  assert.equal(failing.rul.days, 0, 'an already failing drive is capped to zero');
});

test('the design life projection needs power-on hours', () => {
  const device = fixture('nvme-ssd-healthy.json');
  const withoutHours = forecast({ ...device, metrics: { ...device.metrics, powerOnHours: null } }, []);
  assert.equal(withoutHours.projections.some((projection) => projection.id === 'design-life'), false);
  // No history and no power-on hours means no rate is measurable - the model
  // says so instead of inventing a number.
  assert.equal(withoutHours.rul.days, null);
  assert.equal(withoutHours.rul.confidenceLabel, 'low');
  assert.match(withoutHours.recommendation.headline, /Not enough data/i);

  // With history the wear rate is measurable even without power-on hours.
  const withHistory = forecast({ ...device, metrics: { ...device.metrics, powerOnHours: null } }, rampHistory({}));
  assert.ok(withHistory.rul.days > 0);
});

test('a degraded drive never outlives a healthy one', () => {
  const healthy = fixture('hdd-reallocated.json');
  const healthyRun = forecast({ ...healthy, smartPassed: true }, []);
  const degradedRun = forecast(
    { ...healthy, smartPassed: true, metrics: { ...healthy.metrics, reallocated: 400, errorLogCount: 90 } },
    [],
  );
  assert.ok(degradedRun.rul.days <= healthyRun.rul.days);
});

test('drives without SMART data get an honest empty forecast', () => {
  const device = normalizeSmartctlJson({
    smartctl: { exit_status: 2, messages: [{ string: 'Smartctl open device: /dev/sdb failed: Permission denied', severity: 'error' }] },
    device: { name: '/dev/sdb', type: 'scsi' },
  });
  const result = forecast(device, []);
  assert.equal(result.dataAvailable, false);
  assert.equal(result.rul.days, null);
  assert.equal(result.health.score, null);
  assert.equal(result.rul.confidence, 0);
  assert.match(result.recommendation.headline, /unavailable/i);
});

test('every projection is exposed with its method', () => {
  const result = forecast(fixture('nvme-ssd-healthy.json'), rampHistory({}));
  assert.ok(result.rul.drivers.length >= 2);
  for (const driver of result.rul.drivers) {
    assert.equal(typeof driver.label, 'string');
    assert.equal(typeof driver.days, 'number');
    assert.equal(typeof driver.method, 'string');
  }
  assert.equal(result.designLifeHours, DEFAULT_DESIGN_LIFE_HOURS);
});

test('buildSnapshot keeps only the forecast inputs', () => {
  const device = enrichDevice(fixture('nvme-ssd-healthy.json'), []);
  const snapshot = buildSnapshot(device, 1000);
  assert.equal(snapshot.t, 1000);
  assert.equal(snapshot.wearPercent, 38);
  assert.equal(snapshot.healthScore, device.health.score);
  assert.equal(snapshot.smartPassed, true);
  assert.equal('attributes' in snapshot, false);
});

test('mergeHistory dedupes, enforces the interval and trims', () => {
  let history = mergeHistory([], { t: 1000, wearPercent: 1 });
  assert.equal(history.length, 1);
  assert.equal(mergeHistory(history, { t: 1000, wearPercent: 2 }).length, 1, 'same timestamp is ignored');
  history = mergeHistory(history, { t: 2000, wearPercent: 2 }, { minIntervalMs: 5000 });
  assert.equal(history.length, 1, 'too soon after the previous snapshot');
  history = mergeHistory(history, { t: 9000, wearPercent: 3 }, { minIntervalMs: 5000 });
  assert.equal(history.length, 2);
  const trimmed = mergeHistory([{ t: 1000 }], { t: 2000 }, { maxPoints: 1 });
  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0].t, 2000, 'the newest snapshot wins');
});

test('historySpanDays measures the window', () => {
  assert.equal(historySpanDays([]), 0);
  assert.equal(historySpanDays([{ t: 0 }]), 0);
  assert.equal(historySpanDays([{ t: 0 }, { t: 2 * DAY }]), 2);
});

test('assessHealth reports penalties with their attribute', () => {
  const health = assessHealth(fixture('hdd-failing.json'), []);
  assert.ok(health.penalties.length > 0);
  assert.equal(typeof health.score, 'number');
  assert.ok(health.risks.every((risk) => ['critical', 'warning', 'watch'].includes(risk.severity)));
});

test('enrichDevice attaches health and forecast', () => {
  const enriched = enrichDevice(fixture('sata-ssd-worn.json'), []);
  assert.ok(enriched.health.score > 0);
  assert.equal(enriched.forecast.wear.percentUsed, 12);
  assert.equal(enriched.forecast.health.score, enriched.health.score);
});

