/**
 * Normalises the JSON that `smartctl -a -j` emits into one device model that
 * the GUI, the forecast engine and the tests all understand. Works for ATA,
 * NVMe and SCSI/SAS devices, and tolerates missing fields everywhere.
 */

import {
  NVME_FIELDS,
  parseRawNumber,
  rateAtaAttribute,
  rateNvmeField,
  rateScsiField,
  worstSeverity,
} from './attributes.js';
import { slugify } from './format.js';

const DEFAULT_LBA_BYTES = 512;

/** Build a stable identifier for a device (survives reboots / device rename). */
export function deviceKey(json, fallback = 'disk') {
  const serial = json?.serial_number || json?.nvme_serial_number || '';
  const model = json?.model_name || json?.device?.info_name || fallback;
  const base = slugify(`${model}-${serial}`).replace(/^-+|-+$/g, '');
  return base || slugify(fallback);
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** smartctl exit status bit flags (see man smartctl). */
export function decodeExitStatus(exitStatus) {
  const bits = [];
  if (!Number.isFinite(exitStatus)) return bits;
  if (exitStatus & 1) bits.push('command line did not parse');
  if (exitStatus & 2) bits.push('device open failed or SMART not available');
  if (exitStatus & 4) bits.push('a SMART command failed or a prefail attribute is below its threshold');
  if (exitStatus & 8) bits.push('SMART status check reports DISK FAILING');
  return bits;
}

/** Pull the ATA attribute table into the unified attribute shape. */
function ataAttributes(json) {
  const table = json?.ata_smart_attributes?.table;
  if (!Array.isArray(table)) return [];
  return table.map((row) => {
    const rating = rateAtaAttribute({
      id: row.id,
      name: row.name,
      value: row.value,
      worst: row.worst,
      threshold: row.thresh,
      raw: num(row.raw?.value),
      rawString: row.raw?.string,
      whenFailed: row.when_failed,
    });
    const rawValue = num(row.raw?.value) ?? parseRawNumber(row.raw?.string);
    return {
      key: `ata:${row.id}`,
      source: 'ATA',
      id: row.id,
      name: rating.info.name || row.name || `Attribute ${row.id}`,
      reportedName: row.name || '',
      value: num(row.value),
      worst: num(row.worst),
      threshold: num(row.thresh),
      raw: rawValue,
      rawString: row.raw?.string ?? (rawValue === null ? '' : String(rawValue)),
      unit: '',
      category: rating.info.category || 'vendor',
      status: rating.status,
      note: rating.note,
      description: rating.info.description || '',
      whenFailed: row.when_failed || '',
    };
  });
}

/** Pull the NVMe health information log into the unified attribute shape. */
function nvmeAttributes(json) {
  const log = json?.nvme_smart_health_information_log;
  if (!log || typeof log !== 'object') return [];
  const rows = [];
  for (const [field, value] of Object.entries(log)) {
    if (!Number.isFinite(value)) continue;
    if (!NVME_FIELDS[field] && field.endsWith('_sensors')) continue;
    const rating = rateNvmeField(field, value, log);
    rows.push({
      key: `nvme:${field}`,
      source: 'NVMe',
      id: field,
      name: rating.info.name,
      value,
      worst: null,
      threshold: field === 'available_spare' ? num(log.available_spare_threshold) : null,
      raw: value,
      rawString: String(value),
      unit: rating.info.unit || '',
      category: rating.info.category || 'vendor',
      status: rating.status,
      note: rating.note,
      description: rating.info.description || '',
    });
  }
  return rows;
}

/** Flatten the SCSI error counters and environmental data. */
function scsiAttributes(json) {
  const rows = [];
  const hasScsiData = json?.device?.protocol === 'SCSI'
    || json?.device?.type === 'scsi'
    || Object.keys(json || {}).some((key) => key.startsWith('scsi_'))
    || Boolean(json?.scsi_error_counter_log);
  if (!hasScsiData) return rows;

  const push = (key, value, label) => {
    if (!Number.isFinite(value)) return;
    const rating = rateScsiField(key, value);
    rows.push({
      key: `scsi:${key}`,
      source: 'SCSI',
      id: key,
      name: label || rating.info.name,
      value,
      worst: null,
      threshold: null,
      raw: value,
      rawString: String(value),
      unit: '',
      category: rating.info.category || 'vendor',
      status: rating.status,
      note: rating.note,
      description: rating.info.description || '',
    });
  };

  push('scsi_grown_defect_list', num(json?.scsi_grown_defect_list));
  const errors = json?.scsi_error_counter_log;
  if (errors && typeof errors === 'object') {
    for (const op of ['read', 'write', 'verify']) {
      push(`${op}_uncorrected`, num(errors[op]?.total_uncorrected_errors), `${op[0].toUpperCase()}${op.slice(1)} Uncorrected Errors`);
    }
    push('non_medium_errors', num(errors.read?.non_medium_errors) ?? num(errors.write?.non_medium_errors));
  }
  push('scsi_start_stop_cycle_counter', num(json?.scsi_start_stop_cycle_counter?.accumulated_start_stop_cycles));
  push('scsi_temperature', num(json?.scsi_temperature?.current));
  return rows;
}
/**
 * Derive the headline numbers the forecast engine needs from the attribute
 * list. Every value is null when the drive does not report it.
 */
export function deriveMetrics(json, attributes, options = {}) {
  const lbaBytes = num(json?.logical_block_size) || DEFAULT_LBA_BYTES;
  const ata = (id) => attributes.find((a) => a.source === 'ATA' && a.id === id) || null;
  const nvmeLog = json?.nvme_smart_health_information_log || null;
  const ataRaw = (id) => num(ata(id)?.raw);

  const metrics = {
    wearPercent: null,
    wearSource: null,
    writtenBytes: null,
    readBytes: null,
    reallocated: ataRaw(5),
    pendingSectors: ataRaw(197),
    offlineUncorrectable: ataRaw(198),
    reportedUncorrectable: ataRaw(187),
    crcErrors: ataRaw(199),
    loadUnloadCycles: ataRaw(193),
    spinRetryCount: ataRaw(10),
    heliumLevel: ataRaw(22),
    mediaErrors: num(nvmeLog?.media_errors),
    spareAvailable: num(nvmeLog?.available_spare),
    spareThreshold: num(nvmeLog?.available_spare_threshold),
    criticalWarning: num(nvmeLog?.critical_warning),
    grownDefects: num(json?.scsi_grown_defect_list),
    mediaErrorsTotal: null,
    errorLogCount: num(json?.ata_smart_error_log?.summary?.count) ?? num(nvmeLog?.num_err_log_entries),
    selfTestFailures: 0,
    selfTestCount: 0,
    temperatureSensors: Array.isArray(nvmeLog?.temperature_sensors) ? nvmeLog.temperature_sensors : [],
  };

  // ---- endurance consumed -------------------------------------------------
  if (num(nvmeLog?.percentage_used) !== null) {
    metrics.wearPercent = num(nvmeLog.percentage_used);
    metrics.wearSource = 'NVMe health log: Percentage Used';
  } else if (num(ata(202)?.raw) !== null) {
    metrics.wearPercent = Math.max(0, 100 - num(ata(202).raw));
    metrics.wearSource = 'ATA 202 Percent_Lifetime_Remain';
  } else if (num(ata(231)?.value) !== null) {
    metrics.wearPercent = Math.max(0, 100 - num(ata(231).value));
    metrics.wearSource = 'ATA 231 SSD_Life_Left (normalised)';
  } else if (num(ata(233)?.value) !== null) {
    metrics.wearPercent = Math.max(0, 100 - num(ata(233).value));
    metrics.wearSource = 'ATA 233 Media_Wearout_Indicator (normalised)';
  } else if (num(ata(177)?.value) !== null) {
    metrics.wearPercent = Math.max(0, 100 - num(ata(177).value));
    metrics.wearSource = 'ATA 177 Wear_Leveling_Count (normalised)';
  } else if (num(json?.scsi_percentage_used_endurance_indicator?.value) !== null) {
    metrics.wearPercent = num(json.scsi_percentage_used_endurance_indicator.value);
    metrics.wearSource = 'SCSI percentage used endurance indicator';
  }
  if (metrics.wearPercent !== null) {
    metrics.wearPercent = Math.min(1000, Math.max(0, metrics.wearPercent));
  }

  // ---- cumulative bytes written / read -----------------------------------
  if (num(nvmeLog?.data_units_written) !== null) {
    metrics.writtenBytes = num(nvmeLog.data_units_written) * 512000;
  } else if (ataRaw(241) !== null) {
    metrics.writtenBytes = ataRaw(241) * lbaBytes;
  } else if (ataRaw(246) !== null) {
    metrics.writtenBytes = ataRaw(246) * lbaBytes;
  } else if (ataRaw(248) !== null) {
    metrics.writtenBytes = ataRaw(248) > 1e12 ? ataRaw(248) : ataRaw(248) * lbaBytes;
  }
  if (num(nvmeLog?.data_units_read) !== null) {
    metrics.readBytes = num(nvmeLog.data_units_read) * 512000;
  } else if (ataRaw(242) !== null) {
    metrics.readBytes = ataRaw(242) * lbaBytes;
  } else if (ataRaw(247) !== null) {
    metrics.readBytes = ataRaw(247) * lbaBytes;
  }

  // ---- self test history --------------------------------------------------
  const testTable = json?.ata_smart_self_test_log?.standard?.table;
  if (Array.isArray(testTable)) {
    metrics.selfTestCount = testTable.length;
    metrics.selfTestFailures = testTable.filter((entry) => entry?.status?.passed === false
      || /fail/i.test(entry?.status?.string || '')).length;
  }

  metrics.mediaErrorsTotal = Math.max(
    metrics.mediaErrors || 0,
    metrics.offlineUncorrectable || 0,
    metrics.reportedUncorrectable || 0,
    metrics.grownDefects || 0,
  );

  metrics.powerOnHours = num(json?.power_on_time?.hours) ?? num(nvmeLog?.power_on_hours) ?? ataRaw(9);
  metrics.powerCycles = num(json?.power_cycle_count) ?? num(nvmeLog?.power_cycles) ?? ataRaw(12);
  metrics.temperature = num(json?.temperature?.current)
    ?? num(nvmeLog?.temperature)
    ?? num(json?.scsi_temperature?.current)
    ?? (num(ata(194)?.raw) && num(ata(194).raw) > 0 ? num(ata(194).raw) : null);
  metrics.capacityBytes = num(json?.user_capacity?.bytes)
    ?? num(json?.nvme_total_capacity)
    ?? (num(json?.user_capacity?.blocks) ? num(json.user_capacity.blocks) * lbaBytes : null);
  metrics.options = options;
  return metrics;
}
/** Classify the drive so the forecast can pick the right model. */
export function classifyDrive(json) {
  if (json?.nvme_smart_health_information_log || /nvme/i.test(json?.device?.protocol || '') || json?.device?.type === 'nvme') {
    return { kind: 'ssd', form: 'NVMe SSD' };
  }
  const rotation = num(json?.rotation_rate);
  if (rotation === 0) return { kind: 'ssd', form: 'SATA SSD' };
  if (rotation !== null && rotation > 0) return { kind: 'hdd', form: 'HDD' };
  const table = json?.ata_smart_attributes?.table;
  if (Array.isArray(table)) {
    const hasSsdWearGauge = table.some((row) => ['202', '231', '233', '177'].includes(String(row.id)));
    return hasSsdWearGauge ? { kind: 'ssd', form: 'ATA SSD' } : { kind: 'hdd', form: 'ATA drive' };
  }
  if (json?.scsi_error_counter_log) return { kind: 'unknown', form: 'SCSI device' };
  return { kind: 'unknown', form: 'Unknown' };
}

/**
 * Main entry point: smartctl JSON -> unified device model.
 * @param {object} json parsed `smartctl -a -j` output
 * @param {{device?:string,key?:string,collectedAt?:number,mode?:string}} meta
 */
export function normalizeSmartctlJson(json, meta = {}) {
  if (!json || typeof json !== 'object') {
    throw new Error('normalizeSmartctlJson expects a smartctl JSON object');
  }
  const messages = Array.isArray(json.smartctl?.messages) ? json.smartctl.messages : [];
  const exitStatus = num(json.smartctl?.exit_status);
  const permissionDenied = messages.some((m) => /permission denied|operation not permitted/i.test(m?.string || ''));
  const attributes = [...ataAttributes(json), ...nvmeAttributes(json), ...scsiAttributes(json)];
  const metrics = deriveMetrics(json, attributes);
  const { kind, form } = classifyDrive(json);

  let overallStatus = 'ok';
  for (const attribute of attributes) overallStatus = worstSeverity(overallStatus, attribute.status);
  if (json.smart_status?.passed === false) overallStatus = 'critical';

  const deviceName = meta.device || json.device?.name || json.device?.info_name || 'unknown';
  const smartAvailable = !permissionDenied && (attributes.length > 0 || json.smart_status?.passed !== undefined);

  return {
    key: meta.key || deviceKey(json, deviceName),
    device: deviceName,
    infoName: json.device?.info_name || deviceName,
    type: json.device?.type || 'unknown',
    protocol: json.device?.protocol || 'unknown',
    kind,
    form,
    model: json.model_name || json.scsi_model_name || meta.model || json.device?.info_name || 'Unknown model',
    modelFamily: json.model_family || '',
    serial: json.serial_number || json.nvme_serial_number || '',
    firmware: json.firmware_version || json.nvme_firmware_revision || '',
    rotationRate: num(json.rotation_rate),
    capacityBytes: metrics.capacityBytes,
    logicalBlockSize: num(json.logical_block_size) || DEFAULT_LBA_BYTES,
    smartAvailable,
    smartPassed: json.smart_status?.passed ?? (exitStatus !== null && (exitStatus & 8) ? false : null),
    permissionDenied,
    messages,
    exitStatus,
    exitStatusNotes: decodeExitStatus(exitStatus),
    metrics,
    attributes,
    parameterCount: attributes.length,
    overallStatus,
    collectedAt: meta.collectedAt ?? Date.now(),
    mode: meta.mode || 'live',
    raw: json,
  };
}

/** Normalise one or many smartctl JSON blobs (used by the import feature). */
export function normalizeMany(input, meta = {}) {
  const list = Array.isArray(input) ? input : [input];
  return list
    .filter((json) => json && typeof json === 'object')
    .map((json, index) => normalizeSmartctlJson(json, {
      ...meta,
      device: meta.device || json.device?.name,
      key: Array.isArray(input) ? `${meta.key ? `${meta.key}-` : ''}${index}` : meta.key,
      mode: meta.mode,
    }));
}


