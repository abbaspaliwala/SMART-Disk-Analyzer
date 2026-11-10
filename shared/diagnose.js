/**
 * Plain-language diagnostics for a dashboard that found no disks.
 *
 * The server already reports what it tried: whether smartctl exists at all, the
 * error each `--scan` attempt produced and how many devices came back. This
 * module turns that into text for the banner and the terminal, so a machine
 * without smartmontools explains itself instead of showing an empty page.
 *
 * Pure data - no HTML, no Node or DOM APIs - so the GUI and the server use the
 * same wording and it can be unit tested.
 */

/** Operating system family the advice is specialised for. */
export function platformKind(platform = '') {
  const value = String(platform).trim().toLowerCase();
  if (!value) return 'other';
  if (value.startsWith('win') || value.includes('windows')) return 'windows';
  if (value.startsWith('darwin') || value.includes('macos') || value.includes('mac os')) return 'macos';
  if (value.startsWith('linux') || value.includes('linux')) return 'linux';
  return 'other';
}

/** Collapse a possibly multi-line error string into one short sentence. */
function shortError(value, limit = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

/** What to look at while the live disks are unreadable. */
const ALTERNATIVES = 'Meanwhile you can explore the five bundled demo drives (npm run demo) '
  + 'or import a "smartctl -a -j" JSON file with the Import button.';

/** How to install smartmontools, per platform. */
function installSteps(platform) {
  switch (platform) {
    case 'windows':
      return {
        commands: ['winget install smartmontools'],
        notes: [
          'Alternatively install the Windows package from smartmontools.org.',
          'The analyzer also probes "C:\\Program Files\\smartmontools\\bin" directly, so a standard install is found without changing PATH.',
          'Restart the server from an elevated terminal ("Run as administrator"): Windows only lets administrators read raw disk data.',
          'For a custom install location, start the server with --smartctl "D:\\path\\to\\smartctl.exe".',
        ],
      };
    case 'macos':
      return {
        commands: ['brew install smartmontools'],
        notes: ['Then restart the server with sudo npm start - macOS needs root for raw disk access.'],
      };
    case 'linux':
      return {
        commands: ['sudo apt install smartmontools', 'sudo dnf install smartmontools'],
        notes: [
          'Then restart with sudo npm start, or install the sudoers rule once (./bin/setup-sudoers.sh) and use npm run elevated.',
        ],
      };
    default:
      return {
        commands: [],
        notes: ['Install smartmontools, make sure smartctl is on PATH and restart the server.'],
      };
  }
}

/**
 * Explain why no disk could be listed.
 *
 * Returns `null` when there is nothing to explain (demo mode, no status yet, or
 * disks were in fact discovered), otherwise a plain-data notice:
 * `{ tone, title, message, commands, notes, footnote }`.
 */
export function buildScanNotice({ status, diskCount = 0 } = {}) {
  if (!status || status.mode !== 'live' || diskCount > 0) return null;
  const smartctl = status.smartctl || {};
  const platform = platformKind(status.host?.platform);
  return smartctl.available === false
    ? missingSmartctlNotice(smartctl, platform)
    : emptyScanNotice(smartctl, platform, status.scan);
}

/** smartmontools is not installed (or not executable). */
function missingSmartctlNotice(smartctl, platform) {
  const error = shortError(smartctl.error);
  const steps = installSteps(platform);
  return {
    tone: 'critical',
    title: 'smartctl was not found - no disks can be listed',
    message: `The dashboard learns which disks exist by running "smartctl --scan", `
      + `but smartmontools is not installed${error ? ` (${error})` : ''}.`,
    commands: steps.commands,
    notes: steps.notes,
    footnote: ALTERNATIVES,
  };
}

/** smartctl runs, but the device scan came back empty. */
function emptyScanNotice(smartctl, platform, scan) {
  const version = smartctl.version ? `smartctl ${smartctl.version}` : 'smartctl';
  const failures = (scan?.attempts || [])
    .filter((attempt) => attempt.error)
    .map((attempt) => `${attempt.flag}: ${shortError(attempt.error, 120)}`);
  const detail = failures.length ? ` The scan failed (${failures.join('; ')}).` : '';

  const notes = [];
  if (platform === 'windows') {
    notes.push('Run that in an elevated terminal too: without administrator rights smartctl cannot enumerate the physical drives.');
    notes.push('If a drive sits behind a RAID controller or a USB bridge, name its device type explicitly (for example -d sat).');
  } else if (platform === 'linux') {
    notes.push('If the scan is empty as root too, the kernel is hiding the drive (RAID controller, USB bridge or a virtual machine).');
  } else if (platform === 'macos') {
    notes.push('If the scan is still empty, the drives are hidden behind a controller macOS does not expose to smartctl.');
  } else {
    notes.push('Install smartmontools, make sure smartctl is on PATH and restart the server.');
  }

  return {
    tone: 'watch',
    title: 'smartctl reported no disks',
    message: `${version} answered "smartctl --scan", but the scan returned no devices.${detail}`,
    commands: [platform === 'windows' ? 'smartctl --scan' : 'sudo smartctl --scan'],
    notes,
    footnote: ALTERNATIVES,
  };
}

/**
 * Disks were detected but their SMART data could not be read - the permission
 * case, which needs different advice on Windows, macOS and Linux.
 */
export function buildPrivilegeNotice({ status, diskCount = 0 } = {}) {
  if (!status || status.mode !== 'live') return null;
  if (status.privileges?.canReadSmart !== false) return null;
  if (diskCount <= 0) return null;

  const platform = platformKind(status.host?.platform);
  const devices = `${diskCount} device${diskCount === 1 ? '' : 's'}`;

  if (platform === 'windows') {
    return {
      tone: 'critical',
      title: 'SMART data needs administrator rights',
      message: `The ${devices} could be detected but not opened (Permission denied). `
        + 'Windows only lets administrators read raw disk data.',
      commands: ['npm start'],
      notes: ['Stop the running server, open an elevated terminal ("Run as administrator") and start it again from there.'],
      footnote: ALTERNATIVES,
    };
  }

  if (platform === 'macos') {
    return {
      tone: 'critical',
      title: 'SMART data needs root privileges',
      message: `The ${devices} could be detected but not opened (Permission denied). `
        + 'macOS only lets root read raw disk data.',
      commands: ['sudo npm start'],
      notes: ['Restart the server with sudo.'],
      footnote: ALTERNATIVES,
    };
  }

  return {
    tone: 'critical',
    title: 'SMART data needs root privileges',
    message: `The ${devices} could be detected but not opened (Permission denied).`,
    commands: ['sudo npm start'],
    notes: ['Or install the sudoers rule once (./bin/setup-sudoers.sh) and start with npm run elevated.'],
    footnote: ALTERNATIVES,
  };
}
