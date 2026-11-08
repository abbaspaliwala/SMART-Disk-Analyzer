/**
 * SMART attribute knowledge base.
 *
 * Turns the raw numbers smartctl reports into human meaning plus a severity
 * rating. Everything here is pure data and pure functions so the browser can
 * run it too (used by the drag & drop JSON import).
 *
 * Severity scale (ordered): ok < watch < warning < critical. "info" ranks
 * with "ok" and is used for parameters that are interesting but never an
 * indicator of failure.
 */

export const SEVERITY_RANK = Object.freeze({
  ok: 0,
  info: 0,
  watch: 1,
  warning: 2,
  critical: 3,
});

/** Worst (highest) severity of two values; ties keep the first argument. */
export function worstSeverity(a, b) {
  return (SEVERITY_RANK[a] ?? 0) >= (SEVERITY_RANK[b] ?? 0) ? a : b;
}

/**
 * ATA / SATA attribute table. Attribute IDs are stable across vendors while
 * the names are not, so the id is the primary key and the reported name is
 * kept for display.
 */
export const ATA_ATTRIBUTES = {
  1: { name: 'Read Error Rate', category: 'integrity', description: 'Vendor specific raw read error counter. A rising value can hint at media or head problems; the normalised value matters more than the raw one.' },
  2: { name: 'Throughput Performance', category: 'performance', description: 'Overall drive throughput relative to the vendor design.' },
  3: { name: 'Spin-Up Time', category: 'performance', description: 'Average time for the platters to reach full rotation speed.' },
  4: { name: 'Start/Stop Count', category: 'usage', description: 'Number of spindle start/stop cycles. Mechanical wear indicator for HDDs.' },
  5: { name: 'Reallocated Sector Count', category: 'integrity', description: 'Sectors remapped to the spare area after a read/write failure. Any non-zero value means the media has already failed somewhere.', critical: true },
  7: { name: 'Seek Error Rate', category: 'integrity', description: 'Vendor specific head positioning error counter.' },
  8: { name: 'Seek Time Performance', category: 'performance', description: 'Average seek performance relative to the vendor design.' },
  9: { name: 'Power-On Hours', category: 'usage', description: 'Total hours the drive has been powered on since manufacture.', usage: true },
  10: { name: 'Spin Retry Count', category: 'integrity', description: 'Retries needed to reach full spin speed - a mechanical warning sign on HDDs.', critical: true },
  11: { name: 'Recalibration Retries', category: 'integrity', description: 'Number of times the drive had to recalibrate its heads.' },
  12: { name: 'Power Cycle Count', category: 'usage', description: 'Number of full power on/off cycles.', usage: true },
  13: { name: 'Soft Read Error Rate', category: 'integrity', description: 'Read errors corrected by ECC without a visible failure.' },
  22: { name: 'Helium Level', category: 'integrity', description: 'Helium fill level of sealed high-capacity HDDs. A drop means the seal has failed.' },
  170: { name: 'Available Reserved Space', category: 'integrity', description: 'Spare blocks still available for reallocation on SSDs.' },
  171: { name: 'SSD Program Fail Count', category: 'integrity', description: 'Flash program failures repaired by the controller.', critical: true },
  172: { name: 'SSD Erase Fail Count', category: 'integrity', description: 'Flash erase failures repaired by the controller.', critical: true },
  173: { name: 'SSD Wear Leveling Count', category: 'wear', description: 'Average erase count of the flash blocks - a direct measure of NAND wear.', wear: true },
  174: { name: 'Unexpected Power Loss', category: 'integrity', description: 'Unexpected power loss events seen by the controller.' },
  175: { name: 'Power Loss Protection Failure', category: 'integrity', description: 'Power loss protection capacitor failures.' },
  177: { name: 'Wear Leveling Count', category: 'wear', description: 'Wear levelling indicator. The normalised value falls from 100 as the flash wears out.', wear: true, usesNormalized: true },
  179: { name: 'Used Reserved Block Count', category: 'integrity', description: 'Spare blocks already consumed by the controller.', critical: true },
  180: { name: 'Unused Reserved Block Count', category: 'wear', description: 'Spare blocks still available for future reallocation.', wear: true, usesNormalized: true },
  181: { name: 'Program Fail Count', category: 'integrity', description: 'Total flash program failures.', critical: true },
  182: { name: 'Erase Fail Count', category: 'integrity', description: 'Total flash erase failures.', critical: true },
  183: { name: 'Runtime Bad Block', category: 'integrity', description: 'Blocks marked bad at runtime.', critical: true },
  184: { name: 'End-to-End Error', category: 'integrity', description: 'Data path (controller/cache) integrity errors - data reached the host corrupted.', critical: true },
  187: { name: 'Reported Uncorrectable Errors', category: 'integrity', description: 'Errors that could not be corrected by ECC and were reported to the host. Each one is a lost read.', critical: true },
  188: { name: 'Command Timeout', category: 'performance', description: 'Commands aborted because they exceeded the internal timeout. Small counts are normal on some drives.' },
  189: { name: 'High Fly Writes', category: 'integrity', description: 'Writes performed with the head flying too high.' },
  190: { name: 'Airflow Temperature', category: 'temperature', description: 'Drive temperature reported by the airflow sensor.' },
  191: { name: 'G-Sense Error Rate', category: 'integrity', description: 'Shock / vibration events detected by the accelerometer.' },
  192: { name: 'Power-Off Retract Count', category: 'usage', description: 'Head parking events caused by power removal.' },
  193: { name: 'Load/Unload Cycle Count', category: 'usage', description: 'Head load/unload cycles - mechanical wear for laptops and green drives.' },
  194: { name: 'Temperature', category: 'temperature', description: 'Current drive temperature in degrees Celsius.', temperature: true },
  195: { name: 'Hardware ECC Recovered', category: 'integrity', description: 'ECC corrections performed in hardware. A rising raw value on an HDD is a soft warning.' },
  196: { name: 'Reallocation Event Count', category: 'integrity', description: 'Number of attempts to move data away from suspect sectors.', critical: true },
  197: { name: 'Current Pending Sector Count', category: 'integrity', description: 'Sectors waiting to be reallocated - unstable sectors the drive could not read reliably.', critical: true },
  198: { name: 'Offline Uncorrectable', category: 'integrity', description: 'Uncorrectable errors found during offline surface scans.', critical: true },
  199: { name: 'UDMA CRC Error Count', category: 'connection', description: 'Interface (SATA cable / controller) CRC errors. Usually a cable or backplane problem rather than the media.' },
  200: { name: 'Multi-Zone Error Rate', category: 'integrity', description: 'Vendor specific write/seek errors across zones.' },
  201: { name: 'Soft Read Error Rate', category: 'integrity', description: 'Read errors recovered by ECC.' },
  202: { name: 'Percent Lifetime Remain', category: 'wear', description: 'Vendor endurance gauge: raw value is the percentage of rated drive lifetime still unused.', wear: true, rawIsRemainingPercent: true },
  203: { name: 'Run Out Of Spare Blocks', category: 'integrity', description: 'Counts how often the controller ran out of spare blocks.', critical: true },
  204: { name: 'Soft ECC Correction', category: 'integrity', description: 'Soft ECC corrections performed by the firmware.' },
  205: { name: 'Thermal Asperity Rate', category: 'integrity', description: 'Read errors caused by thermal asperities on the platter.' },
  210: { name: 'Vibration During Write', category: 'integrity', description: 'Write operations impacted by vibration.' },
  211: { name: 'Vibration During Read', category: 'integrity', description: 'Read operations impacted by vibration.' },
  212: { name: 'Shock During Write', category: 'integrity', description: 'Write operations impacted by shock events.' },
  220: { name: 'Disk Shift', category: 'integrity', description: 'Platter displacement relative to the spindle.' },
  222: { name: 'Loaded Hours', category: 'usage', description: 'Hours with the heads loaded over the platters.' },
  223: { name: 'Load/Unload Retry Count', category: 'integrity', description: 'Failed head load attempts.' },
  224: { name: 'Load Friction', category: 'integrity', description: 'Friction measured during head loading.' },
  225: { name: 'Load/Unload Cycle Count', category: 'usage', description: 'Total head load/unload cycles.' },
  226: { name: 'Load In Time', category: 'performance', description: 'Time needed to load the heads.' },
  227: { name: 'Torque Amplification Count', category: 'integrity', description: 'Spindle torque amplification events.' },
  228: { name: 'Power-Off Retract Count', category: 'usage', description: 'Emergency head retract events.' },
  230: { name: 'Head Amplitude', category: 'performance', description: 'Head signal amplitude - a drop indicates head wear.' },
  231: { name: 'SSD Life Left', category: 'wear', description: 'Percentage of rated write endurance still remaining (normalised value).', wear: true, usesNormalized: true },
  232: { name: 'Available Reserved Space', category: 'wear', description: 'Normalised amount of spare flash blocks available.', wear: true, usesNormalized: true },
  233: { name: 'Media Wearout Indicator', category: 'wear', description: 'Intel/Samsung style wear gauge: the normalised value counts down from 100 as NAND is consumed.', wear: true, usesNormalized: true },
  234: { name: 'Thermal Throttle', category: 'performance', description: 'Count of thermal throttling events.' },
  235: { name: 'Power-On Hours', category: 'usage', description: 'Power-on hours as reported in the vendor specific block.', usage: true },
  240: { name: 'Head Flying Hours', category: 'usage', description: 'Hours the heads spent flying over the platters.' },
  241: { name: 'Total LBAs Written', category: 'wear', description: 'Total logical blocks written. Multiply by the logical block size to get bytes written - the basis of the endurance forecast.', wear: true, lbaWritten: true },
  242: { name: 'Total LBAs Read', category: 'wear', description: 'Total logical blocks read.', wear: true, lbaRead: true },
  246: { name: 'Total Host Writes', category: 'wear', description: 'Host sectors written (some vendors use 32 MiB units).', wear: true, lbaWritten: true },
  247: { name: 'Total Host Reads', category: 'wear', description: 'Host sectors read.', wear: true, lbaRead: true },
  248: { name: 'Total Host Writes', category: 'wear', description: 'Host bytes written expressed directly by the firmware.', wear: true },
  249: { name: 'Total NAND Writes', category: 'wear', description: 'Raw NAND bytes written, including write amplification.', wear: true },
  250: { name: 'Read Error Retry Rate', category: 'integrity', description: 'Retries needed to read data correctly.' },
  251: { name: 'Minimum Spares Remaining', category: 'wear', description: 'Lowest spare block reserve seen.', wear: true },
  252: { name: 'Newly Added Bad Flash Block', category: 'integrity', description: 'Flash blocks newly marked bad.', critical: true },
  254: { name: 'Free Fall Protection', category: 'integrity', description: 'Free fall events detected.' },
};

/** Look up ATA attribute metadata, falling back to the vendor reported name. */
export function ataInfo(id, reportedName) {
  const info = ATA_ATTRIBUTES[id];
  if (info) return { ...info, id, name: reportedName || info.name };
  return {
    id,
    name: reportedName || `Attribute ${id}`,
    category: 'vendor',
    description: `Vendor specific attribute ${id}. Watch the trend: a normalised value falling towards the threshold is the classic warning pattern.`,
  };
}

/** Parse the integer part of a raw value string such as "12345 (0 0 0)". */
export function parseRawNumber(rawString) {
  if (typeof rawString !== 'string') return null;
  const match = rawString.trim().match(/^(-?\d+)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** Pick the first severity tier whose `min` the raw value reaches. */
function statusForRawTiers(raw, tiers) {
  if (!Number.isFinite(raw)) return 'info';
  for (const tier of tiers) {
    if (raw >= tier.min) return tier.status;
  }
  return 'ok';
}
/**
 * Rate one ATA attribute row.
 * @param {{id:number,name?:string,value?:number,worst?:number,threshold?:number,raw?:number|null,rawString?:string,whenFailed?:string}} row
 * @returns {{status:string,note:string,info:object}}
 */
export function rateAtaAttribute(row) {
  const info = ataInfo(row.id, row.name);
  const raw = Number.isFinite(row.raw) ? row.raw : parseRawNumber(row.rawString);
  const value = Number.isFinite(row.value) ? row.value : null;
  const threshold = Number.isFinite(row.threshold) ? row.threshold : null;

  if (row.whenFailed) {
    return { status: 'critical', note: `Firmware flagged this attribute as failing (${row.whenFailed}).`, info };
  }

  switch (row.id) {
    case 5:
    case 196:
      return {
        status: statusForRawTiers(raw, [{ min: 100, status: 'critical' }, { min: 10, status: 'warning' }, { min: 1, status: 'watch' }]),
        note: raw ? `${raw} sector(s) moved to the spare area.` : 'No sectors reallocated.',
        info,
      };
    case 197:
      return {
        status: statusForRawTiers(raw, [{ min: 9, status: 'critical' }, { min: 1, status: 'warning' }]),
        note: raw ? `${raw} unstable sector(s) pending reallocation - data loss risk.` : 'No pending sectors.',
        info,
      };
    case 198:
      return { status: statusForRawTiers(raw, [{ min: 1, status: 'critical' }]), note: raw ? `${raw} uncorrectable error(s) during offline scans.` : 'No offline uncorrectable errors.', info };
    case 187:
      return { status: statusForRawTiers(raw, [{ min: 1, status: 'critical' }]), note: raw ? `${raw} uncorrectable read error(s) reported to the host.` : 'No reported uncorrectable errors.', info };
    case 10:
    case 11:
      return {
        status: statusForRawTiers(raw, [{ min: 10, status: 'critical' }, { min: 1, status: 'warning' }]),
        note: raw ? `${raw} spin retr${raw === 1 ? 'y' : 'ies'} - mechanical wear.` : 'No spin retries.',
        info,
      };
    case 199:
      return {
        status: statusForRawTiers(raw, [{ min: 1000, status: 'warning' }, { min: 1, status: 'watch' }]),
        note: raw ? `${raw} CRC error(s) - check the SATA cable/backplane, not the media.` : 'No interface CRC errors.',
        info,
      };
    case 22:
      if (!Number.isFinite(raw)) return { status: 'info', note: 'Helium level not numeric.', info };
      return raw < 90
        ? { status: 'critical', note: `Helium level at ${raw}% - the sealed enclosure has failed.`, info }
        : { status: 'ok', note: `Helium level at ${raw}%.`, info };
    case 190:
    case 194: {
      const celsius = Number.isFinite(raw) && raw > 0 && raw < 200 ? raw : null;
      if (celsius === null) return { status: 'info', note: 'Temperature not reported as a plain value.', info };
      if (celsius >= 70) return { status: 'critical', note: `${celsius} °C is far above the safe envelope.`, info };
      if (celsius >= 60) return { status: 'warning', note: `${celsius} °C is hot - improve airflow.`, info };
      if (celsius >= 50) return { status: 'watch', note: `${celsius} °C is warmer than ideal.`, info };
      return { status: 'ok', note: `${celsius} °C is in the safe range.`, info };
    }
    case 202: {
      if (!Number.isFinite(raw)) return { status: 'info', note: 'Endurance gauge not numeric.', info };
      if (raw <= 5) return { status: 'critical', note: `${raw}% of the rated endurance remains.`, info };
      if (raw <= 15) return { status: 'warning', note: `${raw}% of the rated endurance remains.`, info };
      if (raw <= 30) return { status: 'watch', note: `${raw}% of the rated endurance remains.`, info };
      return { status: 'ok', note: `${raw}% of the rated endurance remains.`, info };
    }
    default:
      break;
  }

  // Remaining-life / wear gauges count down from 100 on the normalised value.
  if (info.usesNormalized) {
    const gauge = Number.isFinite(value) ? value : raw;
    if (!Number.isFinite(gauge)) return { status: 'info', note: 'Wear gauge not numeric.', info };
    if (gauge <= 5) return { status: 'critical', note: `Wear gauge at ${gauge}/100 - endurance essentially exhausted.`, info };
    if (gauge <= 20) return { status: 'warning', note: `Wear gauge at ${gauge}/100 - plan a replacement.`, info };
    if (gauge <= 50) return { status: 'watch', note: `Wear gauge at ${gauge}/100 - half the endurance is consumed.`, info };
    return { status: 'ok', note: `Wear gauge at ${gauge}/100.`, info };
  }
  return rateFallback(info, { raw, value, threshold });
}
/**
 * Generic rating for attributes without a dedicated rule.
 * @param {object} info attribute metadata
 * @param {{raw:number|null,value:number|null,threshold:number|null}} nums
 */
function rateFallback(info, { raw, value, threshold }) {
  if (info.usage) return { status: 'info', note: 'Usage counter.', info };
  if (info.wear && (info.lbaWritten || info.lbaRead)) {
    return { status: 'info', note: 'Cumulative transfer counter - feeds the endurance forecast.', info };
  }
  if (Number.isFinite(value) && Number.isFinite(threshold) && threshold > 0) {
    if (value <= threshold) return { status: 'critical', note: `Normalised value ${value} is at/below the vendor threshold ${threshold}.`, info };
    if (value <= threshold + 10) return { status: 'warning', note: `Normalised value ${value} is close to the threshold ${threshold}.`, info };
  }
  if (info.critical && Number.isFinite(raw) && raw > 0) {
    return { status: 'warning', note: 'Vendor reliability attribute reports a non-zero count.', info };
  }
  return { status: 'ok', note: `${(info.description || '').split('.')[0]}.`, info };
}

/**
 * NVMe SMART / health information log fields (NVMe base spec figure 200).
 * `unit` is used purely for display.
 */
export const NVME_FIELDS = {
  critical_warning: { name: 'Critical Warning', category: 'integrity', unit: 'bitmask', description: 'Bit field of composite health warnings: spare space, temperature limits, reliability degradation, read-only mode and volatile-memory backup.' },
  temperature: { name: 'Composite Temperature', category: 'temperature', unit: '°C', description: 'Current composite temperature of the controller and NAND.' },
  available_spare: { name: 'Available Spare', category: 'wear', unit: '%', description: 'Spare NAND blocks still available to replace worn or failed blocks.' },
  available_spare_threshold: { name: 'Spare Threshold', category: 'wear', unit: '%', description: 'The available-spare level below which the controller raises a critical warning.' },
  percentage_used: { name: 'Percentage Used', category: 'wear', unit: '%', description: 'Vendor estimate of the endurance already consumed. This is the primary remaining-life signal for NVMe drives.' },
  data_units_read: { name: 'Data Units Read', category: 'wear', unit: '1000x512B', description: 'Total data read, in units of 1000 x 512 bytes.' },
  data_units_written: { name: 'Data Units Written', category: 'wear', unit: '1000x512B', description: 'Total data written, in units of 1000 x 512 bytes. Used to derive TBW and write rate.' },
  host_reads: { name: 'Host Read Commands', category: 'performance', unit: 'cmds', description: 'Number of completed host read commands.' },
  host_writes: { name: 'Host Write Commands', category: 'performance', unit: 'cmds', description: 'Number of completed host write commands.' },
  controller_busy_time: { name: 'Controller Busy Time', category: 'performance', unit: 'min', description: 'Minutes the controller spent busy servicing commands.' },
  power_cycles: { name: 'Power Cycles', category: 'usage', unit: 'cycles', description: 'Number of power cycles.' },
  power_on_hours: { name: 'Power-On Hours', category: 'usage', unit: 'h', description: 'Total hours powered on.', usage: true },
  unsafe_shutdowns: { name: 'Unsafe Shutdowns', category: 'integrity', unit: 'count', description: 'Power-loss events without a graceful shutdown - risk of metadata damage.' },
  media_errors: { name: 'Media Errors', category: 'integrity', unit: 'count', description: 'Unrecovered data integrity errors detected by the controller.', critical: true },
  num_err_log_entries: { name: 'Error Log Entries', category: 'integrity', unit: 'count', description: 'Entries in the controller error log.' },
  warning_temp_time: { name: 'Warning Temp Time', category: 'temperature', unit: 'min', description: 'Minutes the drive spent above the warning temperature threshold.' },
  critical_comp_time: { name: 'Critical Comp Time', category: 'temperature', unit: 'min', description: 'Minutes the drive spent above the critical temperature threshold.' },
};

const NVME_CRITICAL_WARNING_BITS = [
  'available spare below threshold',
  'temperature outside the safe range',
  'NVM subsystem reliability degraded',
  'media placed in read-only mode',
  'volatile memory backup failed',
  'persistent memory region unreliable',
];

/** Decode the NVMe critical_warning bitmask into readable phrases. */
export function decodeNvmeCriticalWarning(mask) {
  if (!Number.isFinite(mask) || mask === 0) return [];
  return NVME_CRITICAL_WARNING_BITS.filter((_, index) => (mask >> index) & 1);
}

/** Convert NVMe data units (1000 x 512 bytes) to bytes. */
export function nvmeDataUnitsToBytes(units) {
  return Number.isFinite(units) ? units * 1000 * 512 : null;
}
/**
 * Rate a single NVMe health-log field.
 * @param {string} key field name from nvme_smart_health_information_log
 * @param {number} value field value
 * @param {object} log the whole health log (needed for threshold comparisons)
 */
export function rateNvmeField(key, value, log = {}) {
  const info = NVME_FIELDS[key] || { name: key, category: 'vendor', unit: '', description: 'Vendor specific NVMe health field.' };
  const n = Number.isFinite(value) ? value : null;

  switch (key) {
    case 'critical_warning': {
      const bits = decodeNvmeCriticalWarning(n);
      if (!bits.length) return { status: 'ok', note: 'No critical warnings raised by the controller.', info };
      return { status: 'critical', note: `Controller warnings: ${bits.join('; ')}.`, info };
    }
    case 'percentage_used':
      if (n === null) return { status: 'info', note: 'Endurance used not reported.', info };
      if (n >= 100) return { status: 'critical', note: `${n}% of the rated endurance consumed - beyond specification.`, info };
      if (n >= 90) return { status: 'warning', note: `${n}% of the rated endurance consumed - replacement imminent.`, info };
      if (n >= 70) return { status: 'watch', note: `${n}% of the rated endurance consumed.`, info };
      return { status: 'ok', note: `${n}% of the rated endurance consumed.`, info };
    case 'available_spare': {
      const threshold = Number.isFinite(log.available_spare_threshold) ? log.available_spare_threshold : 10;
      if (n === null) return { status: 'info', note: 'Spare blocks not reported.', info };
      if (n < threshold) return { status: 'critical', note: `${n}% spare is below the ${threshold}% threshold.`, info };
      if (n < threshold + 5) return { status: 'warning', note: `${n}% spare is close to the ${threshold}% threshold.`, info };
      return { status: 'ok', note: `${n}% spare blocks available.`, info };
    }
    case 'media_errors':
      if (!n) return { status: 'ok', note: 'No unrecovered media errors.', info };
      return { status: n >= 10 ? 'critical' : 'warning', note: `${n} unrecovered media error(s).`, info };
    case 'num_err_log_entries':
      if (!n) return { status: 'ok', note: 'Error log is empty.', info };
      return { status: n >= 100 ? 'warning' : 'watch', note: `${n} controller error log entr${n === 1 ? 'y' : 'ies'}.`, info };
    case 'unsafe_shutdowns':
      if (!n) return { status: 'ok', note: 'No unsafe shutdowns recorded.', info };
      return { status: n >= 200 ? 'watch' : 'ok', note: `${n} unsafe shutdown(s) - metadata damage risk.`, info };
    case 'temperature': {
      if (n === null) return { status: 'info', note: 'Temperature not reported.', info };
      if (n >= 80) return { status: 'critical', note: `${n} °C - thermal throttling or shutdown imminent.`, info };
      if (n >= 70) return { status: 'warning', note: `${n} °C - add cooling.`, info };
      if (n >= 60) return { status: 'watch', note: `${n} °C is warm for NVMe.`, info };
      return { status: 'ok', note: `${n} °C is in the safe range.`, info };
    }
    case 'warning_temp_time':
    case 'critical_comp_time':
      if (!n) return { status: 'ok', note: 'No time spent above the temperature limits.', info };
      return { status: key === 'critical_comp_time' ? 'warning' : 'watch', note: `${n} min above the ${key === 'critical_comp_time' ? 'critical' : 'warning'} temperature limit.`, info };
    default:
      if (info.usage) return { status: 'info', note: 'Usage counter.', info };
      if (info.critical && n > 0) return { status: 'warning', note: 'Non-zero value reported.', info };
      return { status: 'info', note: `${(info.description || '').split('.')[0]}.`, info };
  }
}
/** SCSI / SAS log pages that smartctl flattens into the JSON output. */
export const SCSI_FIELDS = {
  scsi_grown_defect_list: { name: 'Grown Defect List', category: 'integrity', description: 'Media defects discovered after manufacture. A growing list means the platter surface is degrading.', critical: true },
  read_uncorrected: { name: 'Read Uncorrected Errors', category: 'integrity', description: 'Read operations that failed without correction.', critical: true },
  write_uncorrected: { name: 'Write Uncorrected Errors', category: 'integrity', description: 'Write operations that failed without correction.', critical: true },
  verify_uncorrected: { name: 'Verify Uncorrected Errors', category: 'integrity', description: 'Verify operations that failed without correction.' },
  non_medium_errors: { name: 'Non-Medium Errors', category: 'connection', description: 'Errors not caused by the media - cabling, expander or controller issues.' },
  scsi_percentage_used_endurance_indicator: { name: 'Endurance Indicator', category: 'wear', description: 'SSD endurance consumed as reported by the SCSI endurance indicator.' },
  scsi_start_stop_cycle_counter: { name: 'Start/Stop Cycles', category: 'usage', description: 'Spindle start/stop cycles.', usage: true },
  scsi_temperature: { name: 'Temperature', category: 'temperature', description: 'Drive temperature reported by the SCSI environmental log page.' },
};

/** Rate a SCSI log counter. */
export function rateScsiField(key, value) {
  const info = SCSI_FIELDS[key] || { name: key, category: 'vendor', description: 'Vendor specific SCSI log counter.' };
  const n = Number.isFinite(value) ? value : null;
  if (info.usage) return { status: 'info', note: 'Usage counter.', info };
  if (key === 'scsi_temperature') {
    if (n === null) return { status: 'info', note: 'Temperature not reported.', info };
    if (n >= 65) return { status: 'warning', note: `${n} °C is hot.`, info };
    if (n >= 50) return { status: 'watch', note: `${n} °C is warm.`, info };
    return { status: 'ok', note: `${n} °C is in the safe range.`, info };
  }
  if (key === 'scsi_percentage_used_endurance_indicator') {
    if (n === null) return { status: 'info', note: 'Endurance not reported.', info };
    if (n >= 90) return { status: 'critical', note: `${n}% of the endurance consumed.`, info };
    if (n >= 70) return { status: 'warning', note: `${n}% of the endurance consumed.`, info };
    return { status: 'ok', note: `${n}% of the endurance consumed.`, info };
  }
  if (!n) return { status: 'ok', note: 'No events recorded.', info };
  if (info.critical) return { status: n >= 10 ? 'critical' : 'warning', note: `${n} event(s) recorded.`, info };
  return { status: 'watch', note: `${n} event(s) recorded.`, info };
}






