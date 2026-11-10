import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPrivilegeNotice,
  buildScanNotice,
  platformKind,
} from '../shared/diagnose.js';

/** A status payload shaped like the one /api/status returns. */
function status({ platform = 'Linux 6.8.0', smartctl = {}, privileges = {}, scan = null, mode = 'live' } = {}) {
  return {
    mode,
    smartctl,
    privileges: { isRoot: null, useSudo: false, canReadSmart: false, ...privileges },
    host: { hostname: 'host', platform, arch: 'x64', uptimeSeconds: 1, cpus: 4 },
    scan,
  };
}

test('platformKind maps the strings os.type() produces', () => {
  assert.equal(platformKind('Windows_NT 10.0.19045'), 'windows');
  assert.equal(platformKind('Linux 6.8.0-45-generic'), 'linux');
  assert.equal(platformKind('Darwin 23.4.0'), 'macos');
  assert.equal(platformKind('FreeBSD 14.0'), 'other');
  assert.equal(platformKind(''), 'other');
  assert.equal(platformKind(undefined), 'other');
});

test('buildScanNotice stays quiet when there is nothing to explain', () => {
  const missing = { available: false, version: null, error: 'spawn smartctl ENOENT' };
  assert.equal(buildScanNotice(), null);
  assert.equal(buildScanNotice({ status: null }), null);
  // demo mode has its own banner
  assert.equal(buildScanNotice({ status: status({ mode: 'demo' }), diskCount: 0 }), null);
  // disks were found, so the scan clearly worked
  assert.equal(buildScanNotice({ status: status({ smartctl: missing }), diskCount: 2 }), null);
});

test('a missing smartctl is a critical notice with the install command', () => {
  const linux = buildScanNotice({
    status: status({ smartctl: { available: false, version: null, error: 'spawn smartctl ENOENT' } }),
    diskCount: 0,
  });
  assert.equal(linux.tone, 'critical');
  assert.match(linux.title, /smartctl was not found/);
  assert.match(linux.message, /spawn smartctl ENOENT/);
  assert.deepEqual(linux.commands, ['sudo apt install smartmontools', 'sudo dnf install smartmontools']);
  assert.match(linux.notes.join(' '), /sudo npm start/);
  assert.match(linux.footnote, /npm run demo/);

  const windows = buildScanNotice({
    status: status({
      platform: 'Windows_NT 10.0.19045',
      smartctl: { available: false, version: null, error: 'spawn smartctl ENOENT' },
    }),
    diskCount: 0,
  });
  assert.deepEqual(windows.commands, ['winget install smartmontools']);
  const notes = windows.notes.join(' ');
  assert.match(notes, /elevated terminal/);
  assert.match(notes, /smartctl\.exe/);
  assert.doesNotMatch(notes, /sudo/);

  const macos = buildScanNotice({
    status: status({ platform: 'Darwin 23.4.0', smartctl: { available: false, error: 'ENOENT' } }),
    diskCount: 0,
  });
  assert.deepEqual(macos.commands, ['brew install smartmontools']);
  assert.match(macos.notes.join(' '), /sudo npm start/);
});

test('an empty scan reports what smartctl actually said', () => {
  const notice = buildScanNotice({
    status: status({
      smartctl: { available: true, version: '7.4', error: null },
      scan: {
        flag: null,
        deviceCount: 0,
        attempts: [
          { flag: '--scan-open', error: 'Permission denied' },
          { flag: '--scan', error: '' },
        ],
      },
    }),
    diskCount: 0,
  });
  assert.equal(notice.tone, 'watch');
  assert.match(notice.message, /smartctl 7\.4/);
  assert.match(notice.message, /--scan-open: Permission denied/);
  // the empty attempt contributes no noise
  assert.doesNotMatch(notice.message, /--scan:/);
  assert.deepEqual(notice.commands, ['sudo smartctl --scan']);
  assert.match(notice.notes.join(' '), /kernel is hiding the drive/);

  const windows = buildScanNotice({
    status: status({
      platform: 'Windows_NT 10.0.19045',
      smartctl: { available: true, version: '7.4' },
      scan: { flag: '--scan', deviceCount: 0, attempts: [{ flag: '--scan', error: 'spawn EPERM' }] },
    }),
    diskCount: 0,
  });
  assert.deepEqual(windows.commands, ['smartctl --scan']);
  assert.match(windows.notes.join(' '), /administrator rights/i);
});

test('an unreadable disk explains the elevation story per platform', () => {
  const base = {
    smartctl: { available: true, version: '7.4' },
    privileges: { canReadSmart: false },
    scan: { flag: '--scan', deviceCount: 1, attempts: [] },
  };
  assert.equal(
    buildPrivilegeNotice({ status: status({ ...base, privileges: { canReadSmart: true } }), diskCount: 1 }),
    null,
  );
  assert.equal(buildPrivilegeNotice({ status: status(base), diskCount: 0 }), null);
  assert.equal(buildPrivilegeNotice({ status: status({ ...base, mode: 'demo' }), diskCount: 1 }), null);

  const linux = buildPrivilegeNotice({ status: status(base), diskCount: 3 });
  assert.equal(linux.tone, 'critical');
  assert.match(linux.message, /3 devices/);
  assert.deepEqual(linux.commands, ['sudo npm start']);
  assert.match(linux.notes.join(' '), /setup-sudoers\.sh/);

  const windows = buildPrivilegeNotice({ status: status({ ...base, platform: 'Windows_NT 10.0.19045' }), diskCount: 1 });
  assert.match(windows.message, /1 device could/);
  assert.deepEqual(windows.commands, ['npm start']);
  assert.match(windows.notes.join(' '), /Run as administrator/);
  assert.doesNotMatch(windows.notes.join(' '), /sudo/);

  const macos = buildPrivilegeNotice({ status: status({ ...base, platform: 'Darwin 23.4.0' }), diskCount: 2 });
  assert.deepEqual(macos.commands, ['sudo npm start']);
});
