/**
 * Health scoring and remaining-useful-life (RUL) forecasting.
 *
 * Pure ES module: runs on the Node backend (live SMART data) and in the
 * browser (imported smartctl JSON), so both paths produce identical numbers.
 */

import { clamp, isNum, round } from './format.js';

/**
 * Design life assumptions used when a drive reports no endurance gauge.
 * 43800 h = 5 years of continuous operation, the usual desktop/nearline
 * warranty envelope. Override with `opts.designLifeHours`.
 */
export const DEFAULT_DESIGN_LIFE_HOURS = 43800;

const GRADES = [
  { min: 92, grade: 'A+', verdict: 'Excellent' },
  { min: 85, grade: 'A', verdict: 'Good' },
  { min: 75, grade: 'B', verdict: 'Fair' },
  { min: 62, grade: 'C', verdict: 'Wearing' },
  { min: 45, grade: 'D', verdict: 'Degraded' },
  { min: 25, grade: 'E', verdict: 'Poor' },
  { min: 0, grade: 'F', verdict: 'Critical' },
];

/** Letters + verdict for a 0-100 health score. */
export function gradeFor(score) {
  return GRADES.find((entry) => score >= entry.min) ?? GRADES[GRADES.length - 1];
}

/**
 * Least squares linear fit over [{x, y}] points.
 * @returns {{slope:number,intercept:number,r2:number,n:number}|null}
 */
export function linearTrend(points) {
  const usable = (points || []).filter((p) => isNum(p?.x) && isNum(p?.y));
  if (usable.length < 2) return null;
  const n = usable.length;
  const meanX = usable.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = usable.reduce((sum, p) => sum + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of usable) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = syy === 0 ? 0 : clamp((sxy * sxy) / (sxx * syy), 0, 1);
  return { slope, intercept, r2, n };
}

/** Convert a history array into regression points on a day axis. */
function dayPoints(history, pick) {
  return (history || [])
    .map((snap) => ({ x: snap.t / 86400000, y: pick(snap) }))
    .filter((p) => isNum(p.y));
}

/**
 * Build one compact history snapshot from a normalised device.
 * Only the fields the forecast needs are stored, which keeps the JSON small.
 */
export function buildSnapshot(device, at = Date.now()) {
  const m = device?.metrics || {};
  return {
    t: at,
    powerOnHours: m.powerOnHours ?? null,
    powerCycles: m.powerCycles ?? null,
    temperature: m.temperature ?? null,
    wearPercent: m.wearPercent ?? null,
    writtenBytes: m.writtenBytes ?? null,
    readBytes: m.readBytes ?? null,
    reallocated: m.reallocated ?? null,
    pendingSectors: m.pendingSectors ?? null,
    uncorrectable: m.mediaErrorsTotal ?? null,
    crcErrors: m.crcErrors ?? null,
    spareAvailable: m.spareAvailable ?? null,
    healthScore: device?.health?.score ?? null,
    smartPassed: device?.smartPassed ?? null,
  };
}

/**
 * Merge a snapshot into a history array: keeps the series sorted, skips
 * duplicates inside `minIntervalMs`, and trims to `maxPoints`.
 */
export function mergeHistory(history, snapshot, { minIntervalMs = 0, maxPoints = 2000 } = {}) {
  const list = Array.isArray(history) ? [...history] : [];
  const last = list[list.length - 1];
  if (last && snapshot.t - last.t < minIntervalMs) return list;
  if (last && snapshot.t <= last.t) return list;
  list.push(snapshot);
  list.sort((a, b) => a.t - b.t);
  return list.length > maxPoints ? list.slice(list.length - maxPoints) : list;
}
const RISK_ORDER = { critical: 3, warning: 2, watch: 1, ok: 0, info: 0 };

const PENALTY_LIMIT = 100;

/**
 * Score drive health from its SMART parameters plus the collected trend.
 * @param {object} device normalised device
 * @param {Array} history snapshots, oldest first
 * @returns {{score:number,grade:string,verdict:string,penalties:Array,risks:Array}}
 */
export function assessHealth(device, history = []) {
  const m = device?.metrics || {};
  const penalties = [];
  const risks = [];

  const apply = (id, label, points, severity, detail, attribute = null) => {
    if (points > 0) penalties.push({ id, label, points, severity });
    if (RISK_ORDER[severity] > 0) risks.push({ id, label, severity, detail, attribute });
  };

  if (device?.smartPassed === false) {
    apply('smart-failing', 'SMART self-assessment failing', 60, 'critical',
      'The drive firmware itself reports that a failure threshold has been exceeded.', 'SMART status');
  }

  const warningBits = m.criticalWarning || 0;
  if (warningBits > 0) {
    apply('nvme-critical-warning', 'NVMe critical warning raised', Math.min(45, 15 * popcount(warningBits)), 'critical',
      `Controller raised critical warning bitmask 0x${warningBits.toString(16)}.`, 'NVMe critical_warning');
  }

  // ---- endurance ----------------------------------------------------------
  if (isNum(m.wearPercent)) {
    const wear = m.wearPercent;
    if (wear >= 100) {
      apply('wear', 'Endurance exhausted', 35, 'critical', `${round(wear)}% of the rated write endurance is consumed.`, m.wearSource);
    } else if (wear >= 90) {
      apply('wear', 'Endurance nearly exhausted', 25, 'warning', `${round(wear)}% of the rated write endurance is consumed.`, m.wearSource);
    } else if (wear >= 70) {
      apply('wear', 'High endurance consumption', 15, 'watch', `${round(wear)}% of the rated write endurance is consumed.`, m.wearSource);
    } else if (wear >= 50) {
      apply('wear', 'Half the endurance consumed', 6, 'ok', `${round(wear)}% of the rated write endurance is consumed.`, m.wearSource);
    } else {
      apply('wear', 'Normal endurance consumption', clamp(wear * 0.1, 0, 4), 'ok', `${round(wear)}% consumed.`, m.wearSource);
    }
  }

  // ---- media integrity ----------------------------------------------------
  const realloc = m.reallocated;
  if (isNum(realloc) && realloc > 0) {
    const points = realloc >= 500 ? 40 : realloc >= 100 ? 25 : realloc >= 10 ? 12 : 5;
    const severity = realloc >= 100 ? 'critical' : realloc >= 10 ? 'warning' : 'watch';
    apply('reallocated', 'Reallocated sectors', points, severity,
      `${realloc} sector(s) remapped to the spare area - the media has already lost storage.`, 'ATA 5');
  }

  if (isNum(m.pendingSectors) && m.pendingSectors > 0) {
    apply('pending', 'Pending sectors', m.pendingSectors >= 9 ? 28 : 15, m.pendingSectors >= 9 ? 'critical' : 'warning',
      `${m.pendingSectors} unstable sector(s) are waiting to be reallocated; their data may be unreadable.`, 'ATA 197');
  }

  if (isNum(m.offlineUncorrectable) && m.offlineUncorrectable > 0) {
    apply('uncorrectable', 'Uncorrectable sectors', m.offlineUncorrectable >= 10 ? 30 : 20, 'critical',
      `${m.offlineUncorrectable} sector(s) failed offline reads without correction.`, 'ATA 198');
  } else if (isNum(m.reportedUncorrectable) && m.reportedUncorrectable > 0) {
    apply('reported-uncorrectable', 'Reported uncorrectable errors', 20, 'critical',
      `${m.reportedUncorrectable} read error(s) reached the host uncorrected.`, 'ATA 187');
  }

  if (isNum(m.mediaErrors) && m.mediaErrors > 0) {
    apply('media-errors', 'Unrecovered media errors', m.mediaErrors >= 10 ? 22 : 10, m.mediaErrors >= 10 ? 'critical' : 'warning',
      `${m.mediaErrors} unrecovered data integrity error(s) logged by the controller.`, 'NVMe media_errors');
  }

  if (isNum(m.grownDefects) && m.grownDefects > 0) {
    apply('grown-defects', 'Grown defect list', 10, 'warning',
      `${m.grownDefects} media defect(s) appeared after manufacturing.`, 'SCSI grown defect list');
  }

  if (isNum(m.selfTestFailures) && m.selfTestFailures > 0) {
    apply('selftest', 'Self-test failures', Math.min(24, 12 * m.selfTestFailures), m.selfTestFailures > 1 ? 'critical' : 'warning',
      `${m.selfTestFailures} of ${m.selfTestCount} recorded self-test(s) failed.`, 'SMART self-test log');
  }
  return finishHealth(device, penalties, risks, history);
}
/**
 * Second half of the health assessment: environment, mechanics, age and
 * trend based penalties, then the final score.
 */
function finishHealth(device, penalties, risks, history) {
  const m = device?.metrics || {};
  const apply = (id, label, points, severity, detail, attribute = null) => {
    if (points > 0) penalties.push({ id, label, points, severity });
    if (RISK_ORDER[severity] > 0) risks.push({ id, label, severity, detail, attribute });
  };

  // ---- interface ----------------------------------------------------------
  if (isNum(m.crcErrors) && m.crcErrors > 0) {
    apply('crc', 'Interface CRC errors', m.crcErrors >= 100 ? 8 : 3, 'watch',
      `${m.crcErrors} CRC error(s) - usually the cable, backplane or controller rather than the disk.`, 'ATA 199');
  }

  // ---- environment --------------------------------------------------------
  const temp = m.temperature;
  if (isNum(temp)) {
    if (temp >= 75) apply('temp', 'Overheating', 16, 'critical', `${round(temp)} °C is above the safe operating envelope.`, 'SMART temperature');
    else if (temp >= 65) apply('temp', 'High temperature', 10, 'warning', `${round(temp)} °C accelerates wear and can trigger throttling.`, 'SMART temperature');
    else if (temp >= 55) apply('temp', 'Warm drive', 4, 'watch', `${round(temp)} °C is warmer than ideal for long-term reliability.`, 'SMART temperature');
  }

  if (isNum(m.spareAvailable) && isNum(m.spareThreshold)) {
    if (m.spareAvailable < m.spareThreshold) {
      apply('spare', 'Spare blocks below threshold', 20, 'critical', `${m.spareAvailable}% spare is below the ${m.spareThreshold}% threshold.`, 'NVMe available_spare');
    } else if (m.spareAvailable < m.spareThreshold + 5) {
      apply('spare', 'Spare blocks running low', 10, 'warning', `${m.spareAvailable}% spare is close to the ${m.spareThreshold}% threshold.`, 'NVMe available_spare');
    }
  }

  // ---- mechanics ----------------------------------------------------------
  if (isNum(m.spinRetryCount) && m.spinRetryCount > 0) {
    apply('spin-retry', 'Spin-up retries', 12, 'warning', `${m.spinRetryCount} attempt(s) to reach full spindle speed failed - motor or bearing wear.`, 'ATA 10');
  }
  if (isNum(m.heliumLevel) && m.heliumLevel < 90) {
    apply('helium', 'Helium seal failure', 20, 'critical', `Helium level dropped to ${m.heliumLevel}% - the sealed enclosure leaked.`, 'ATA 22');
  }

  // ---- age / usage --------------------------------------------------------
  const hours = m.powerOnHours;
  if (isNum(hours)) {
    if (hours > 87600) apply('age', 'Very high power-on hours', 15, 'warning', `${round(hours / 8760)} years powered on - well past the design life.`, 'Power-On Hours');
    else if (hours > 43800) apply('age', 'Past design life', 8, 'watch', `${round(hours / 8760)} years powered on - past the typical 5 year design life.`, 'Power-On Hours');
  }

  if (isNum(m.errorLogCount) && m.errorLogCount > 0) {
    apply('error-log', 'Error log entries', Math.min(8, 1 + m.errorLogCount / 10), 'watch',
      `${m.errorLogCount} entr${m.errorLogCount === 1 ? 'y' : 'ies'} in the drive error log.`, 'Error log');
  }

  // ---- trend based penalties ---------------------------------------------
  const reallocTrend = linearTrend(dayPoints(history, (s) => s.reallocated));
  if (reallocTrend && reallocTrend.slope > 0) {
    apply('realloc-growth', 'Sectors failing over time', 6, 'watch',
      `Reallocated sector count is climbing by ${round(reallocTrend.slope * 30, 2)} per month.`, 'ATA 5 trend');
  }
  const healthTrend = linearTrend(dayPoints(history, (s) => s.healthScore));
  if (healthTrend && healthTrend.slope < 0) {
    apply('health-decay', 'Health score trending down', 5, 'watch',
      `Health score is dropping ${round(Math.abs(healthTrend.slope) * 30, 2)} points per month.`, 'Health trend');
  }

  const totalPenalty = Math.min(PENALTY_LIMIT, penalties.reduce((sum, p) => sum + p.points, 0));
  let score = clamp(100 - totalPenalty, 0, 100);
  if (device?.smartPassed === false) score = Math.min(score, 15);
  score = round(score, 0);

  const { grade, verdict } = gradeFor(score);
  risks.sort((a, b) => RISK_ORDER[b.severity] - RISK_ORDER[a.severity]);
  return { score, grade, verdict, penalties, risks };
}

function popcount(value) {
  let count = 0;
  let n = value;
  while (n > 0) {
    count += n & 1;
    n >>= 1;
  }
  return count;
}
/** Days covered by a history series. */
export function historySpanDays(history) {
  if (!Array.isArray(history) || history.length < 2) return 0;
  const first = history[0].t;
  const last = history[history.length - 1].t;
  return Math.max(0, (last - first) / 86400000);
}

/**
 * Endurance-based projection: how long until 100% of the rated write
 * endurance is consumed, using the measured (or lifetime average) wear rate.
 */
function wearProjection(device, history) {
  const m = device.metrics || {};
  if (!isNum(m.wearPercent)) return null;
  const remaining = Math.max(0, 100 - m.wearPercent);
  if (remaining === 0) {
    return { id: 'wear', label: 'Endurance consumption', days: 0, method: 'firmware wear gauge',
      detail: 'The reported write endurance is already fully consumed.', measured: true };
  }

  const trend = linearTrend(dayPoints(history, (s) => s.wearPercent));
  const span = historySpanDays(history);
  let ratePerDay = null;
  let method = '';
  let measured = false;

  if (trend && trend.slope > 0 && span >= 1) {
    ratePerDay = trend.slope;
    method = `measured trend over ${round(span, 1)} d`;
    measured = true;
  } else {
    const activeDays = isNum(m.powerOnHours) && m.powerOnHours > 0
      ? Math.max(m.powerOnHours / 24, 1)
      : (span > 0 ? span : null);
    if (activeDays && m.wearPercent > 0) {
      ratePerDay = m.wearPercent / activeDays;
      method = 'average wear rate since manufacture';
    }
  }
  if (!ratePerDay || ratePerDay <= 0) return null;

  return {
    id: 'wear',
    label: 'Endurance consumption',
    days: remaining / ratePerDay,
    method,
    detail: `${round(m.wearPercent, 1)}% consumed, ${round(remaining, 1)}% left at ${round(ratePerDay * 30, 3)}%/month.`,
    measured,
    ratePerDay,
    rateSource: measured ? 'measured' : 'lifetime-average',
  };
}

/**
 * Endurance projection in terabytes written: the implied rated TBW comes from
 * the wear gauge, then the measured or average write rate sets the timeline.
 */
function enduranceProjection(device, history) {
  const m = device.metrics || {};
  if (!isNum(m.writtenBytes) || m.writtenBytes <= 0) return null;
  if (!isNum(m.wearPercent) || m.wearPercent < 0.5) return null;

  const impliedTotalBytes = m.writtenBytes / (m.wearPercent / 100);
  const remainingBytes = Math.max(0, impliedTotalBytes - m.writtenBytes);

  const trend = linearTrend(dayPoints(history, (s) => s.writtenBytes));
  const span = historySpanDays(history);
  let bytesPerDay = null;
  let method = '';
  if (trend && trend.slope > 0 && span >= 1) {
    bytesPerDay = trend.slope;
    method = `measured write rate over ${round(span, 1)} d`;
  } else if (isNum(m.powerOnHours) && m.powerOnHours > 0) {
    bytesPerDay = m.writtenBytes / Math.max(m.powerOnHours / 24, 1);
    method = 'average write rate since manufacture';
  }
  if (!bytesPerDay || bytesPerDay <= 0) return null;

  return {
    id: 'endurance',
    label: 'Write endurance budget',
    days: remainingBytes / bytesPerDay,
    method,
    detail: `${round(remainingBytes / 1e12, 2)} TB of the implied ${round(impliedTotalBytes / 1e12, 2)} TB rating left at ${round(bytesPerDay / 1e9, 1)} GB/day.`,
    impliedTotalBytes,
    remainingBytes,
    bytesPerDay,
  };
}
/**
 * Design-life projection: how long the remaining powered-on-hour budget lasts
 * at the duty cycle observed in the history.
 *
 * The budget is scaled by the health score, because a drive with a clean
 * SMART record reliably outlives the nominal 5-year envelope while a degraded
 * one usually does not. Drives already past the scaled budget get a grace
 * period proportional to their remaining health instead of a hard zero.
 */
function designLifeProjection(device, history, opts, healthScore) {
  const m = device.metrics || {};
  const designHours = isNum(opts?.designLifeHours) ? opts.designLifeHours : DEFAULT_DESIGN_LIFE_HOURS;
  if (!isNum(m.powerOnHours)) return null;

  const score = isNum(healthScore) ? healthScore : 100;
  const healthMultiplier = 0.6 + (score / 100) * 0.8; // 0.6x .. 1.4x the nominal design life
  const budgetHours = designHours * healthMultiplier;
  const remainingHours = budgetHours - m.powerOnHours;

  // Duty cycle = powered-on hours per calendar day; defaults to always-on.
  const span = historySpanDays(history);
  let duty = 1;
  if (Array.isArray(history) && history.length >= 2 && span > 0) {
    const first = history[0];
    const last = history[history.length - 1];
    if (isNum(first.powerOnHours) && isNum(last.powerOnHours)) {
      const hoursPerDay = Math.max(0, (last.powerOnHours - first.powerOnHours) / span);
      if (hoursPerDay > 0.05) duty = clamp(hoursPerDay / 24, 0.05, 1);
    }
  }

  if (remainingHours <= 0) {
    const graceDays = (365 * (score / 100)) / duty;
    return {
      id: 'design-life',
      label: 'Design life',
      days: graceDays,
      method: `past the scaled design budget at ${round(duty * 100, 0)}% duty cycle`,
      detail: `${round(m.powerOnHours)} h on the clock exceeds the ${round(budgetHours)} h budget for a drive scoring ${round(score)}/100; only the health-based grace period is left.`,
    };
  }

  return {
    id: 'design-life',
    label: 'Design life',
    days: (remainingHours / 24) / duty,
    method: `remaining hours at ${round(duty * 100, 0)}% duty cycle`,
    detail: `${round(remainingHours)} of ${round(budgetHours)} h budget remain (${round(healthMultiplier, 2)}x nominal, health adjusted).`,
  };
}

/** Extrapolate media defects (reallocated / pending sectors) to a failure point. */
function errorTrendProjections(device, history) {
  const m = device.metrics || {};
  const projections = [];

  const reallocTrend = linearTrend(dayPoints(history, (s) => s.reallocated));
  if (reallocTrend && reallocTrend.slope > 0) {
    const current = isNum(m.reallocated)
      ? m.reallocated
      : reallocTrend.intercept + reallocTrend.slope * (Date.now() / 86400000);
    projections.push({
      id: 'reallocated-trend',
      label: 'Reallocated sector growth',
      days: Math.max(0, (100 - current) / reallocTrend.slope),
      method: 'linear extrapolation of reallocated sectors',
      detail: `Growing ${round(reallocTrend.slope * 30, 2)} sectors/month; 100 sectors is the practical red line.`,
    });
  }

  const pendingTrend = linearTrend(dayPoints(history, (s) => s.pendingSectors));
  if (pendingTrend && pendingTrend.slope > 0) {
    const current = isNum(m.pendingSectors) ? m.pendingSectors : 0;
    projections.push({
      id: 'pending-trend',
      label: 'Pending sector growth',
      days: Math.max(0, (10 - current) / pendingTrend.slope),
      method: 'linear extrapolation of pending sectors',
      detail: `Growing ${round(pendingTrend.slope * 30, 2)} sectors/month; 10 pending sectors means imminent data loss.`,
    });
  }
  return projections;
}

/** Project health-score decay down to the replacement threshold (40). */
function healthDecayProjection(device, history) {
  const trend = linearTrend(dayPoints(history, (s) => s.healthScore));
  if (!trend || trend.slope >= 0) return null;
  const current = isNum(device?.health?.score) ? device.health.score : trend.intercept;
  if (current <= 40) {
    return { id: 'health-decay', label: 'Health score decay', days: 0, method: 'health trend',
      detail: 'Health score is already below the acceptable threshold of 40.' };
  }
  return {
    id: 'health-decay',
    label: 'Health score decay',
    days: (current - 40) / Math.abs(trend.slope),
    method: 'health score extrapolation',
    detail: `Falling ${round(Math.abs(trend.slope) * 30, 2)} points/month; 40 is the replacement threshold.`,
  };
}
/** Replacement recommendation derived from the RUL and open risks. */
function buildRecommendation(health, rulDays, risks) {
  const critical = risks.filter((r) => r.severity === 'critical');
  if (critical.length) {
    return {
      level: 'critical',
      headline: 'Replace this drive now',
      detail: `${critical[0].label}: ${critical[0].detail} Copy the data off before anything else.`,
      action: 'Make an immediate backup, then swap the drive.',
    };
  }
  if (!isNum(rulDays)) {
    return {
      level: 'unknown',
      headline: 'Not enough data to forecast',
      detail: 'The drive does not report an endurance gauge and no history has been captured yet, so only the current SMART values are available.',
      action: 'Capture a few snapshots over the coming days to enable trend forecasting.',
    };
  }
  if (rulDays <= 30) {
    return { level: 'critical', headline: 'End of life is imminent', detail: `The model gives this drive about ${Math.max(1, Math.round(rulDays))} more days of service.`, action: 'Order a replacement and migrate the data now.' };
  }
  if (rulDays <= 90) {
    return { level: 'warning', headline: 'Plan a replacement this quarter', detail: `The model gives this drive about ${Math.round(rulDays)} more days of service.`, action: 'Schedule a replacement within three months.' };
  }
  if (rulDays <= 365) {
    return { level: 'watch', headline: 'Replace within a year', detail: `The model gives this drive about ${Math.round(rulDays)} more days of service.`, action: 'Add the drive to the next hardware refresh cycle.' };
  }
  if (health.score < 75) {
    return { level: 'watch', headline: 'Monitor closely', detail: `Health score ${health.score}/100 while the endurance forecast still shows ${Math.round(rulDays)} days left.`, action: 'Keep an eye on the trend and keep backups current.' };
  }
  return { level: 'ok', headline: 'Healthy drive', detail: `Health score ${health.score}/100 with roughly ${Math.round(rulDays)} days of service left.`, action: 'No action needed - keep monitoring.' };
}

function confidenceLabel(confidence) {
  if (confidence >= 0.7) return 'high';
  if (confidence >= 0.45) return 'medium';
  return 'low';
}

/**
 * Minimal forecast for a device whose SMART data could not be read (usually a
 * permission problem). Nothing is invented - the GUI shows why.
 */
function noDataForecast(device, history, now, opts) {
  const reasons = (device?.messages || [])
    .map((message) => message?.string)
    .filter(Boolean);
  const detail = device?.permissionDenied
    ? 'smartctl could not open the device: permission denied. Start the server with sudo (or install the sudoers rule) to read real SMART data.'
    : (reasons[0] || 'The drive did not report any SMART parameters.');
  return {
    dataAvailable: false,
    health: { score: null, grade: '?', verdict: 'No data', penalties: [], risks: [] },
    risks: [],
    wear: { percentUsed: null, percentRemaining: null, source: null, ratePerDay: null, ratePerMonth: null, ratePerYear: null },
    endurance: { writtenBytes: null, readBytes: null, impliedTotalBytes: null, remainingBytes: null, writeBytesPerDay: null, driveWritesPerDay: null },
    usage: {
      powerOnHours: device?.metrics?.powerOnHours ?? null,
      powerCycles: device?.metrics?.powerCycles ?? null,
      ageYears: null,
      temperature: device?.metrics?.temperature ?? null,
      loadUnloadCycles: null,
      temperatureSensors: [],
    },
    rul: {
      days: null,
      date: null,
      label: null,
      method: null,
      detail,
      confidence: 0,
      confidenceLabel: 'none',
      drivers: [],
      caps: [],
      beyondHorizon: false,
      horizonDays: 7300,
    },
    projections: [],
    history: {
      points: Array.isArray(history) ? history.length : 0,
      spanDays: round(historySpanDays(history), 2),
      firstAt: history?.[0]?.t ?? null,
      lastAt: history?.[history.length - 1]?.t ?? null,
    },
    recommendation: {
      level: 'unknown',
      headline: device?.permissionDenied ? 'SMART data unavailable (permission denied)' : 'SMART data unavailable',
      detail,
      action: device?.permissionDenied
        ? 'Restart the analyzer as root: sudo npm start  (or run bin/setup-sudoers.sh once).'
        : 'Re-run the SMART scan; if the problem persists the drive may not expose SMART data.',
    },
    generatedAt: now,
    designLifeHours: isNum(opts?.designLifeHours) ? opts.designLifeHours : DEFAULT_DESIGN_LIFE_HOURS,
  };
}

/**
 * Run the full analysis: health score, per-method projections, the combined
 * remaining-life forecast, confidence and a recommendation.
 *
 * @param {object} device normalised device (from normalizeSmartctlJson)
 * @param {Array} history snapshots collected over time, oldest first
 * @param {{designLifeHours?:number, now?:number}} opts
 */
export function forecast(device, history = [], opts = {}) {
  const now = isNum(opts.now) ? opts.now : Date.now();
  const hasData = device?.smartAvailable !== false && (device?.parameterCount ?? 0) > 0;
  if (!hasData) return noDataForecast(device, history, now, opts);

  const health = assessHealth(device, history);
  const scored = { ...device, health };
  const m = device?.metrics || {};

  const projections = [];
  for (const projection of [wearProjection(device, history), enduranceProjection(device, history)]) {
    if (projection) projections.push(projection);
  }
  projections.push(...errorTrendProjections(device, history));
  const decay = healthDecayProjection(scored, history);
  if (decay) projections.push(decay);
  const design = designLifeProjection(device, history, opts, health.score);
  if (design) projections.push({ ...design, informational: true });

  const usable = projections.filter((p) => isNum(p.days) && p.days >= 0);
  const authoritative = usable.filter((p) => !p.informational);
  const pool = authoritative.length ? authoritative : usable;
  return finishForecast({ now, device, history, health, usable, pool, opts, metrics: m });
}

/** Assemble the final forecast object from the individual projections. */
function finishForecast({ now, device, history, health, usable, pool, opts, metrics: m }) {
  const HORIZON_DAYS = 7300; // never claim more than 20 years
  const chosen = pool.length
    ? pool.reduce((min, p) => (p.days < min.days ? p : min), pool[0])
    : null;

  let days = chosen ? chosen.days : null;

  // Hard caps: an already-failing drive cannot be trusted for long, and a
  // degraded drive cannot sensibly be given a decade of remaining life just
  // because a linear trend happens to be gentle.
  const caps = [];
  if (device.smartPassed === false) caps.push({ reason: 'SMART self-assessment is failing', limitDays: 30 });
  if (isNum(m.pendingSectors) && m.pendingSectors > 0) caps.push({ reason: 'pending (unstable) sectors present', limitDays: 60 });
  if (health.risks.some((r) => r.severity === 'critical')) caps.push({ reason: 'critical risk factors present', limitDays: 180 });
  const HEALTH_CEILINGS = [
    { belowScore: 45, limitDays: 180, reason: 'health score below 45' },
    { belowScore: 60, limitDays: 365, reason: 'health score below 60' },
    { belowScore: 70, limitDays: 730, reason: 'health score below 70' },
    { belowScore: 85, limitDays: 1095, reason: 'health score below 85' },
  ];
  if (isNum(health.score)) {
    const ceiling = HEALTH_CEILINGS.find((entry) => health.score < entry.belowScore);
    if (ceiling) caps.push({ reason: ceiling.reason, limitDays: ceiling.limitDays });
  }
  const appliedCaps = [];
  if (isNum(days)) {
    for (const cap of caps) {
      if (days > cap.limitDays) {
        days = cap.limitDays;
        appliedCaps.push(cap);
      }
    }
  }

  let beyondHorizon = false;
  if (isNum(days) && days > HORIZON_DAYS) {
    days = HORIZON_DAYS;
    beyondHorizon = true;
  }

  // ---- confidence ---------------------------------------------------------
  const span = historySpanDays(history);
  let confidence = 0.2;
  if (isNum(m.wearPercent)) confidence += 0.3;
  if (history.length >= 3 && span >= 7) confidence += 0.25;
  else if (history.length >= 2 && span >= 1) confidence += 0.12;
  if (span >= 30) confidence += 0.12;
  if (!pool.some((p) => p.id === 'wear' || p.id === 'endurance')) confidence -= 0.1;
  confidence -= Math.min(0.3, health.risks.filter((r) => r.severity === 'critical').length * 0.1);
  if (pool.length >= 2) {
    const values = pool.map((p) => p.days).filter((d) => d > 1);
    if (values.length >= 2 && Math.max(...values) / Math.min(...values) <= 2) confidence += 0.08;
  }
  confidence = clamp(confidence, 0.05, 0.95);

  // ---- wear / endurance blocks -------------------------------------------
  const wearProjectionResult = usable.find((p) => p.id === 'wear') || null;
  const wearRatePerDay = wearProjectionResult?.ratePerDay ?? null;
  const wear = {
    percentUsed: isNum(m.wearPercent) ? round(m.wearPercent, 1) : null,
    percentRemaining: isNum(m.wearPercent) ? round(Math.max(0, 100 - m.wearPercent), 1) : null,
    source: m.wearSource || null,
    ratePerDay: isNum(wearRatePerDay) ? round(wearRatePerDay, 5) : null,
    ratePerMonth: isNum(wearRatePerDay) ? round(wearRatePerDay * 30.44, 3) : null,
    ratePerYear: isNum(wearRatePerDay) ? round(wearRatePerDay * 365.25, 2) : null,
    rateSource: wearProjectionResult?.rateSource ?? null,
  };

  const enduranceProjectionResult = usable.find((p) => p.id === 'endurance') || null;
  const writeRatePerDay = enduranceProjectionResult?.bytesPerDay
    ?? (isNum(m.writtenBytes) && isNum(m.powerOnHours) && m.powerOnHours > 0 ? m.writtenBytes / (m.powerOnHours / 24) : null);
  const endurance = {
    writtenBytes: m.writtenBytes ?? null,
    readBytes: m.readBytes ?? null,
    impliedTotalBytes: enduranceProjectionResult?.impliedTotalBytes ?? null,
    remainingBytes: enduranceProjectionResult?.remainingBytes ?? null,
    writeBytesPerDay: isNum(writeRatePerDay) ? Math.round(writeRatePerDay) : null,
    driveWritesPerDay: isNum(writeRatePerDay) && isNum(m.capacityBytes) && m.capacityBytes > 0
      ? round(writeRatePerDay / m.capacityBytes, 3)
      : null,
  };

  const usage = {
    powerOnHours: m.powerOnHours ?? null,
    powerCycles: m.powerCycles ?? null,
    ageYears: isNum(m.powerOnHours) ? round(m.powerOnHours / 8760, 2) : null,
    temperature: m.temperature ?? null,
    loadUnloadCycles: m.loadUnloadCycles ?? null,
    temperatureSensors: m.temperatureSensors || [],
  };

  const rulDays = isNum(days) ? Math.max(0, round(days, 1)) : null;

  return {
    health,
    risks: health.risks,
    wear,
    endurance,
    usage,
    rul: {
      days: rulDays,
      date: isNum(rulDays) ? Math.round(now + rulDays * 86400000) : null,
      label: chosen ? chosen.label : null,
      method: chosen ? chosen.method : null,
      detail: chosen ? chosen.detail : null,
      confidence: round(confidence, 2),
      confidenceLabel: confidenceLabel(confidence),
      drivers: usable.map((p) => ({
        id: p.id,
        label: p.label,
        days: round(p.days, 1),
        method: p.method,
        detail: p.detail,
        informational: Boolean(p.informational),
      })),
      caps: appliedCaps,
      beyondHorizon,
      horizonDays: HORIZON_DAYS,
    },
    projections: usable,
    history: {
      points: Array.isArray(history) ? history.length : 0,
      spanDays: round(span, 2),
      firstAt: history?.[0]?.t ?? null,
      lastAt: history?.[history.length - 1]?.t ?? null,
    },
    recommendation: buildRecommendation(health, rulDays, health.risks),
    generatedAt: now,
    designLifeHours: isNum(opts?.designLifeHours) ? opts.designLifeHours : DEFAULT_DESIGN_LIFE_HOURS,
  };
}

/**
 * Convenience helper: attach `health` and `forecast` to a normalised device
 * and return a clone ready for the API response or the GUI.
 */
export function enrichDevice(device, history = [], opts = {}) {
  const result = forecast(device, history, opts);
  return { ...device, health: result.health, forecast: result };
}






