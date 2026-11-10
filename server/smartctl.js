/**
 * Thin, dependency free wrapper around the `smartmontools` smartctl binary.
 *
 * Everything goes through execFile with an argument array (never a shell) so a
 * device name can never be interpreted as shell syntax.
 */

import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_CONCURRENCY = 4;

/** The name the analyzer looks for when no --smartctl was given. */
const DEFAULT_BINARY = 'smartctl';

/**
 * Well-known install locations, tried when the default name is not on PATH.
 * The Windows installer does not always add its bin directory to PATH, so an
 * installed smartmontools would otherwise look like a missing one.
 */
const BINARY_FALLBACKS = {
  win32: [
    'C:\\Program Files\\smartmontools\\bin\\smartctl.exe',
    'C:\\Program Files (x86)\\smartmontools\\bin\\smartctl.exe',
  ],
  posix: [
    '/usr/sbin/smartctl',
    '/usr/local/sbin/smartctl',
    '/usr/local/bin/smartctl',
    '/opt/homebrew/bin/smartctl',
    '/opt/local/bin/smartctl',
  ],
};

/** Fallback binaries for a platform (node's process.platform names). */
export function fallbackBinaries(platform = process.platform) {
  return platform === 'win32' ? [...BINARY_FALLBACKS.win32] : [...BINARY_FALLBACKS.posix];
}

/** Device types where smartctl auto-detection is reliable; no -d needed. */
const AUTO_TYPES = new Set(['', 'ata', 'scsi', 'sat', 'nvme', 'auto']);

export class SmartctlError extends Error {
  constructor(message, { code = null, stdout = '', stderr = '' } = {}) {
    super(message);
    this.name = 'SmartctlError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function run(binary, args, { timeoutMs = DEFAULT_TIMEOUT_MS, useSudo = false } = {}) {
  const command = useSudo ? 'sudo' : binary;
  const commandArgs = useSudo ? ['-n', binary, ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(command, commandArgs, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.killed) {
        reject(new SmartctlError(`smartctl timed out after ${timeoutMs} ms`, { stdout, stderr }));
        return;
      }
      // The binary itself could not be executed (missing, not executable...).
      if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) {
        reject(new SmartctlError(`cannot execute "${command}": ${error.message}`, { code: error.code, stdout, stderr }));
        return;
      }
      // smartctl uses the exit status as a bit field of warnings, so a non-zero
      // code is not necessarily a failure - callers inspect the JSON instead.
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

/** Run "<binary> --version" once; never throws. */
async function probeBinary(binary, { useSudo = false, timeoutMs = 5000 } = {}) {
  try {
    const { stdout, stderr } = await run(binary, ['--version'], { timeoutMs, useSudo });
    const firstLine = (stdout.split('\n')[0] || '').trim();
    const match = firstLine.match(/smartctl\s+([0-9]+\.[0-9]+[^\s]*)/i);
    if (!match) {
      return {
        available: false,
        version: null,
        error: (stderr || '').trim() || `"${binary} --version" did not report a smartctl version`,
        useSudo,
        binary,
      };
    }
    return { available: true, version: match[1], firstLine, useSudo, binary };
  } catch (error) {
    return { available: false, version: null, error: error.message, useSudo, binary };
  }
}

/**
 * Detect smartctl and its version.
 *
 * When the configured name is the default "smartctl" (so it came from PATH) and
 * it cannot be executed, the well-known install locations are probed too. An
 * explicit --smartctl path is never second-guessed. Returns the error of the
 * original attempt when nothing is found, so the message still names what the
 * user asked for.
 */
export async function detectSmartctl({
  binary = DEFAULT_BINARY,
  useSudo = false,
  timeoutMs = 5000,
  platform = process.platform,
  probe = probeBinary,
} = {}) {
  const direct = await probe(binary, { useSudo, timeoutMs });
  if (direct.available || binary !== DEFAULT_BINARY) return direct;
  // "sudo -n <absolute path>" needs its own sudoers entry, so only fall back
  // when the privileges come from running as root.
  if (useSudo) return direct;
  for (const candidate of fallbackBinaries(platform)) {
    const attempt = await probe(candidate, { useSudo, timeoutMs });
    if (attempt.available) return { ...attempt, fallback: true };
  }
  return direct;
}

/**
 * Parse `smartctl --scan[-open]` text output.
 * Example lines:
 *   /dev/sda -d scsi # /dev/sda, SCSI device
 *   # /dev/sda -d scsi # /dev/sda, SCSI device open failed: Permission denied
 */
export function parseScanOutput(stdout) {
  const devices = [];
  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const openFailed = line.startsWith('#');
    const body = openFailed ? line.replace(/^#+\s*/, '') : line;
    const match = body.match(/^(\S+)(?:\s+-d\s+([^\s#]+))?(?:\s+#\s*(.*))?$/);
    if (!match) continue;
    const [, name, type, comment] = match;
    if (!name || name.startsWith('-')) continue;
    devices.push({
      device: name,
      type: type || '',
      comment: (comment || '').trim(),
      openFailed,
    });
  }
  return devices;
}

/** Discover the disks attached to this machine. */
export async function scanDevices({ binary = 'smartctl', useSudo = false, timeoutMs = 15000 } = {}) {
  const attempts = [];
  for (const flag of ['--scan-open', '--scan']) {
    try {
      const { stdout } = await run(binary, [flag], { timeoutMs, useSudo });
      const devices = dedupeScanDevices(
        parseScanOutput(stdout).filter((entry) => entry.device && !entry.device.startsWith('#')),
      );
      attempts.push({ flag, count: devices.length });
      if (devices.length) return { devices, flag, attempts };
    } catch (error) {
      attempts.push({ flag, error: error.message });
    }
  }
  return { devices: [], flag: null, attempts };
}

/**
 * Keep one entry per device path.
 *
 * smartctl can list the same drive more than once - on Windows the same
 * physical drive shows up under two `-d` types, and a drive that is both a
 * physical disk and a RAID member is reported twice. Reading it twice would
 * put the same disk in the list twice, so the first listing wins.
 */
export function dedupeScanDevices(devices) {
  const seen = new Set();
  const unique = [];
  for (const device of devices) {
    const name = String(device?.device || '').trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    unique.push(device);
  }
  return unique;
}

/** Build the argument list for a full SMART read of one device. */
export function buildReadArgs(device) {
  const args = ['-a', '-j'];
  const type = (device.type || '').trim();
  // Megaraid/areca/USB bridges must be addressed explicitly; ATA/SCSI/NVMe are
  // auto-detected, and forcing "-d scsi" there would hide ATA attributes.
  if (type && !AUTO_TYPES.has(type.toLowerCase())) args.push('-d', type);
  args.push(device.device);
  return args;
}

/** Read the full SMART JSON for a single device. */
export async function readDevice(device, { binary = 'smartctl', useSudo = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const args = buildReadArgs(device);
  try {
    const { code, stdout, stderr } = await run(binary, args, { timeoutMs, useSudo });
    let json = null;
    let parseError = null;
    const trimmed = stdout.trim();
    if (trimmed.startsWith('{')) {
      try {
        json = JSON.parse(trimmed);
      } catch (error) {
        parseError = error.message;
      }
    }
    return {
      device: device.device,
      type: device.type || '',
      comment: device.comment || '',
      args,
      exitCode: code,
      json,
      stderr: (stderr || '').trim(),
      error: parseError
        ? `Could not parse smartctl JSON: ${parseError}`
        : (json ? null : (stderr || stdout || 'smartctl returned no JSON').trim().slice(0, 500)),
    };
  } catch (error) {
    return {
      device: device.device,
      type: device.type || '',
      comment: device.comment || '',
      args,
      exitCode: null,
      json: null,
      stderr: '',
      error: error.message,
    };
  }
}

/** Read several devices with bounded parallelism, preserving input order. */
export async function readDevices(devices, options = {}) {
  const results = new Array(devices.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, devices.length) }, async () => {
    while (cursor < devices.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await readDevice(devices[index], options);
    }
  });
  await Promise.all(workers);
  return results;
}
