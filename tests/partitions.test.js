import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildOpenSpawn,
  deviceCandidates,
  diskNameForPartition,
  encodeCommand,
  matchDisk,
  openInFileManager,
  parseFindmnt,
  parseLsblk,
  parseWindowsPartitions,
  partitionNumber,
  partitionPayload,
  resolveOpener,
  validateOpenTarget,
  which,
  WINDOWS_SCRIPT,
  windowsDiskName,
} from '../server/partitions.js';
import { buildDemoPartitions, loadDemoDevices } from '../server/demo.js';
import { openBrowser, resolveBrowser } from '../server/browser.js';
import { parseConfig, startServer } from '../server/index.js';

/** The Windows disk of a typical dual boot machine. */
const LSBLK_WINDOWS_DISK = {
  blockdevices: [
    { name: 'loop0', type: 'loop', size: 4096, fstype: 'squashfs' },
    {
      name: 'sdb',
      kname: 'sdb',
      type: 'disk',
      size: 240057409536,
      fstype: null,
      label: null,
      mountpoints: [],
      partn: null,
      model: 'WDC WD2500BEVT-00A23T0',
      children: [
        {
          name: 'sdb1',
          type: 'part',
          size: 367001600,
          fstype: 'ntfs',
          label: 'System Reserved',
          mountpoints: [],
          partn: 1,
          fsavail: null,
          'fsuse%': null,
        },
        {
          name: 'sdb2',
          type: 'part',
          size: 238780636160,
          fstype: 'ntfs',
          label: 'Win8',
          mountpoints: [],
          partn: 2,
          fsavail: null,
          'fsuse%': null,
        },
        {
          name: 'sdb3',
          type: 'part',
          size: 904921088,
          fstype: 'ntfs',
          label: null,
          mountpoints: [],
          partn: 3,
          fsavail: null,
          'fsuse%': null,
        },
      ],
    },
    {
      name: 'sda',
      type: 'disk',
      size: 480103981056,
      model: 'KINGSTON SA400S37480G',
      children: [
        {
          name: 'sda1',
          type: 'part',
          size: 314572800,
          fstype: 'vfat',
          label: null,
          mountpoints: ['/boot/efi'],
          partn: 1,
          fsavail: 305463296,
          'fsuse%': '3%',
        },
        {
          name: 'sda2',
          type: 'part',
          size: 479787277312,
          fstype: 'ext4',
          label: 'kubuntu_2604',
          mountpoints: ['/'],
          partn: 2,
          fsavail: 239146074112,
          'fsuse%': '44%',
        },
      ],
    },
  ],
};

test('parseLsblk keeps partitions, free space and mount points', () => {
  const parsed = parseLsblk(LSBLK_WINDOWS_DISK);
  assert.equal(parsed.disks.length, 2, 'loop devices are ignored');

  const windows = parsed.disks.find((disk) => disk.name === 'sdb');
  assert.equal(windows.path, '/dev/sdb');
  assert.equal(windows.sizeBytes, 240057409536);
  assert.equal(windows.volumes.length, 3);
  assert.deepEqual(windows.volumes.map((volume) => volume.number), [1, 2, 3]);
  assert.equal(windows.volumes[0].label, 'System Reserved');
  assert.equal(windows.volumes[0].mounted, false);
  assert.equal(windows.volumes[0].mountpoint, null);
  assert.equal(windows.freeBytes, 240057409536 - (367001600 + 238780636160 + 904921088));

  const linux = parsed.disks.find((disk) => disk.name === 'sda');
  assert.equal(linux.volumes[1].mounted, true);
  assert.equal(linux.volumes[1].mountpoint, '/');
  assert.equal(linux.volumes[1].fsUsePercent, 44);
  assert.equal(linux.freeBytes, 480103981056 - 314572800 - 479787277312, 'alignment tail counts as free');

  assert.deepEqual([...parsed.mounts].sort(), ['/', '/boot/efi']);
});

test('parseLsblk flattens LVM/LUKS containers and legacy mountpoint fields', () => {
  const parsed = parseLsblk({
    blockdevices: [{
      name: 'sdc',
      type: 'disk',
      size: 1000,
      children: [{
        name: 'sdc1',
        type: 'part',
        size: 1000,
        fstype: 'LVM2_member',
        mountpoint: null,
        children: [
          { name: 'vg-root', type: 'lvm', size: 400, fstype: 'ext4', mountpoint: '/', partn: null },
          { name: 'vg-home', type: 'lvm', size: 600, fstype: 'xfs', mountpoints: ['/home'], partn: null },
        ],
      }],
    }],
  });
  const disk = parsed.disks[0];
  assert.deepEqual(disk.volumes.map((volume) => volume.name), ['vg-root', 'vg-home']);
  assert.equal(disk.allocatedBytes, 1000);
  assert.equal(disk.freeBytes, 0, 'the container itself is not counted twice');
  assert.deepEqual([...parsed.mounts].sort(), ['/', '/home']);
});

test('parseLsblk treats an unpartitioned filesystem as a single volume', () => {
  const parsed = parseLsblk({
    blockdevices: [{ name: 'sdd', type: 'disk', size: 8000, fstype: 'exfat', label: 'STICK', mountpoints: ['/media/stick'] }],
  });
  assert.equal(parsed.disks[0].volumes.length, 1);
  assert.equal(parsed.disks[0].volumes[0].label, 'STICK');
  assert.equal(parsed.disks[0].freeBytes, 0);
  assert.deepEqual([...parsed.mounts], ['/media/stick']);
});

test('parseFindmnt groups mounted volumes and skips snap/loop images', () => {
  const parsed = parseFindmnt({
    filesystems: [
      {
        source: '/dev/sda2',
        target: '/',
        fstype: 'ext4',
        label: 'kubuntu_2604',
        size: 471107227648,
        avail: 239141883904,
        children: [
          { source: 'sysfs', target: '/sys', fstype: 'sysfs' },
          { source: '/dev/loop5', target: '/snap/code/278', fstype: 'squashfs' },
          { source: '/dev/sda1', target: '/boot/efi', fstype: 'vfat', size: 314572800, avail: 305463296 },
        ],
      },
      { source: '/dev/nvme0n1p3', target: '/run/media/me/Local Disk', fstype: 'ntfs', label: 'Local Disk', size: 1000, avail: 250 },
      { source: 'tmpfs', target: '/run', fstype: 'tmpfs', size: 1000 },
    ],
  });

  assert.deepEqual(parsed.disks.map((disk) => disk.name).sort(), ['nvme0n1', 'sda']);
  const nvme = parsed.disks.find((disk) => disk.name === 'nvme0n1');
  assert.equal(nvme.volumes[0].number, 3);
  assert.equal(nvme.volumes[0].fsUsePercent, 75);
  assert.equal(nvme.volumes[0].mountpoint, '/run/media/me/Local Disk');
  assert.deepEqual([...parsed.mounts].sort(), ['/', '/boot/efi', '/run/media/me/Local Disk']);
});

test('deviceCandidates and matchDisk bridge nvme controllers and namespaces', () => {
  assert.deepEqual(deviceCandidates('/dev/sda'), ['sda']);
  assert.deepEqual(deviceCandidates('/dev/nvme0'), ['nvme0', 'nvme0n1']);
  assert.deepEqual(deviceCandidates('/dev/nvme0n1'), ['nvme0n1', 'nvme0']);
  assert.deepEqual(deviceCandidates('/dev/sda (demo)'), ['sda']);

  const parsed = parseLsblk(LSBLK_WINDOWS_DISK);
  assert.equal(matchDisk(parsed, '/dev/sdb').name, 'sdb');
  assert.equal(matchDisk(parsed, '/dev/sr0'), null);

  const nvme = parseLsblk({ blockdevices: [{ name: 'nvme0n1', type: 'disk', size: 10, children: [] }] });
  assert.equal(matchDisk(nvme, '/dev/nvme0').name, 'nvme0n1');

  // Unique model fallback for USB bridges that rename the device.
  assert.equal(matchDisk(parsed, '/dev/sdz', 'WDC WD2500BEVT').name, 'sdb');
});

test('partition names and numbers are derived for every device flavour', () => {
  assert.equal(diskNameForPartition('/dev/sda2'), 'sda');
  assert.equal(diskNameForPartition('/dev/nvme0n1p3'), 'nvme0n1');
  assert.equal(diskNameForPartition('/dev/mmcblk0p1'), 'mmcblk0');
  assert.equal(diskNameForPartition('/dev/mapper/vg-root'), null);
  // a filesystem directly on a whole disk keeps the disk as its own volume
  assert.equal(diskNameForPartition('/dev/nvme0n1'), 'nvme0n1');
  assert.equal(diskNameForPartition('/dev/mmcblk0'), 'mmcblk0');
  assert.equal(diskNameForPartition('/dev/sdb'), 'sdb');
  assert.equal(partitionNumber('/dev/sda2'), 2);
  assert.equal(partitionNumber('/dev/nvme0n1p12'), 12);
  assert.equal(partitionNumber('/dev/nvme0n1'), null);
  assert.equal(partitionNumber('/dev/mmcblk0'), null);
  assert.equal(partitionNumber('/dev/sdd'), null);

  const whole = parseFindmnt({
    filesystems: [{ source: '/dev/nvme0n1', target: '/data', fstype: 'xfs', size: 1000, avail: 600 }],
  });
  assert.equal(whole.disks[0].name, 'nvme0n1');
  assert.equal(whole.disks[0].volumes[0].number, null);
  assert.equal(whole.disks[0].volumes[0].fsUsePercent, 40);
});


test('partitionPayload is what the GUI consumes', () => {
  const parsed = parseLsblk(LSBLK_WINDOWS_DISK);
  const payload = partitionPayload(matchDisk(parsed, '/dev/sdb'));
  assert.equal(payload.device, '/dev/sdb');
  assert.equal(payload.volumes.length, 3);
  assert.deepEqual(Object.keys(payload.volumes[0]).sort(), [
    'fsAvailableBytes', 'fsUsePercent', 'fstype', 'label', 'mounted', 'mountpoint', 'number', 'path', 'sizeBytes',
  ]);
  assert.equal(payload.volumes[1].path, '/dev/sdb2');
  assert.equal(partitionPayload(null), null);
});

test('validateOpenTarget only accepts mount points lsblk reported', () => {
  const mounts = new Set(['/', '/boot/efi', '/run/media/me/My Disk']);
  assert.deepEqual(validateOpenTarget('/boot/efi', mounts), { ok: true, path: '/boot/efi' });
  assert.deepEqual(validateOpenTarget('/boot/efi/', mounts), { ok: true, path: '/boot/efi' });
  assert.deepEqual(validateOpenTarget('/run/media/me/My Disk', mounts), { ok: true, path: '/run/media/me/My Disk' });

  assert.equal(validateOpenTarget('/etc', mounts).ok, false);
  assert.equal(validateOpenTarget('/boot/efi/../../etc', mounts).ok, false);
  assert.equal(validateOpenTarget('boot/efi', mounts).ok, false);
  assert.equal(validateOpenTarget('', mounts).ok, false);
  assert.equal(validateOpenTarget(null, mounts).ok, false);
  assert.equal(validateOpenTarget('/boot/efi\u0000', mounts).ok, false);
  assert.equal(validateOpenTarget('/boot/efi', []).ok, false);
});

test('which and resolveOpener pick the first available launcher', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smart-open-'));
  const fake = path.join(dir, 'my-open');
  await fs.writeFile(fake, '#!/bin/sh\nexit 0\n');
  await fs.chmod(fake, 0o755);
  await fs.writeFile(path.join(dir, 'not-executable'), 'nope');

  assert.equal(which('my-open', { PATH: dir }), fake);
  assert.equal(which('not-executable', { PATH: dir }), null);
  assert.equal(which('definitely-missing', { PATH: dir }), null);

  const opener = resolveOpener({ platform: 'linux', env: { PATH: '' }, find: (command) => (command === 'gio' ? '/usr/bin/gio' : null) });
  assert.deepEqual(opener, { command: '/usr/bin/gio', name: 'gio', args: ['open'] });
  assert.equal(resolveOpener({ platform: 'linux', env: { PATH: '' }, find: () => null }), null);

  await fs.rm(dir, { recursive: true, force: true });
});

test('buildOpenSpawn passes the mount point as a single argument and drops privileges', () => {
  const opener = { command: '/usr/bin/xdg-open', name: 'xdg-open', args: [] };
  const plan = buildOpenSpawn('/run/media/me/My Disk', { opener, env: { PATH: '/usr/bin' } });
  assert.equal(plan.command, '/usr/bin/xdg-open');
  assert.deepEqual(plan.args, ['/run/media/me/My Disk'], 'spaces are never word-split');
  assert.equal(plan.options.detached, true);
  assert.equal(plan.options.uid, undefined);

  const asUser = buildOpenSpawn('/', {
    opener: { command: '/usr/bin/gio', name: 'gio', args: ['open'] },
    env: { PATH: '/usr/bin', HOME: '/root' },
    runAs: { username: 'me', uid: 1000, gid: 1000, home: '/home/me' },
  });
  assert.deepEqual(asUser.args, ['open', '/']);
  assert.equal(asUser.options.uid, 1000);
  assert.equal(asUser.options.gid, 1000);
  assert.equal(asUser.options.env.HOME, '/home/me');

  assert.throws(() => buildOpenSpawn('relative/path', { opener }), /absolute/);
  assert.throws(() => buildOpenSpawn('/', { opener: null }), /no file manager launcher/);
});

test('openInFileManager reports a launcher that fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smart-launch-'));
  const ok = path.join(dir, 'ok-opener');
  const bad = path.join(dir, 'bad-opener');
  await fs.writeFile(ok, '#!/bin/sh\nexit 0\n');
  await fs.writeFile(bad, '#!/bin/sh\nexit 3\n');
  await fs.chmod(ok, 0o755);
  await fs.chmod(bad, 0o755);

  const success = await openInFileManager('/', { opener: { command: ok, name: 'ok-opener', args: [] }, settleMs: 1500 });
  assert.equal(success.path, '/');
  assert.equal(success.command, 'ok-opener');

  await assert.rejects(
    openInFileManager('/', { opener: { command: bad, name: 'bad-opener', args: [] }, settleMs: 1500 }),
    /bad-opener exited with code 3/,
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test('demo drives come with a fabricated volume layout', () => {
  const { devices } = loadDemoDevices();
  for (const device of devices) {
    assert.ok(device.partitions, `${device.model} has a partition map`);
    assert.ok(device.partitions.volumes.length >= 2);
    assert.equal(device.partitions.demo, true);
    assert.ok(device.partitions.volumes.every((volume) => volume.demo === true && volume.mounted === false));
    const allocated = device.partitions.volumes.reduce((sum, volume) => sum + volume.sizeBytes, 0);
    assert.equal(device.partitions.allocatedBytes, allocated);
    assert.ok(device.partitions.freeBytes >= 0);
  }
  const nvme = devices.find((disk) => disk.device.startsWith('/dev/nvme0'));
  assert.equal(nvme.partitions.volumes[1].path, '/dev/nvme0n1p2');
  assert.equal(buildDemoPartitions({ capacityBytes: 0, device: '/dev/sda' }, [{ partn: 1 }]), null);
});


test('the volume API opens mount points and refuses everything else', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smart-vol-'));
  const lsblkJson = path.join(dir, 'lsblk.json');
  const lsblkBin = path.join(dir, 'lsblk');
  const openerBin = path.join(dir, 'xdg-open');
  const openedLog = path.join(dir, 'opened.log');

  await fs.writeFile(lsblkJson, JSON.stringify({
    blockdevices: [{
      name: 'sda',
      type: 'disk',
      size: 1000000000000,
      model: 'Test Disk',
      children: [
        { name: 'sda1', type: 'part', size: 100000000000, partn: 1, fstype: 'vfat', mountpoints: ['/boot/efi'] },
        { name: 'sda2', type: 'part', size: 600000000000, partn: 2, fstype: 'ext4', label: 'root', mountpoints: ['/'] },
      ],
    }],
  }));
  await fs.writeFile(lsblkBin, `#!/bin/sh\nexec cat "${lsblkJson}"\n`);
  await fs.writeFile(openerBin, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${openedLog}"\n`);
  await fs.chmod(lsblkBin, 0o755);
  await fs.chmod(openerBin, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  const { server, state, baseUrl } = await startServer({
    ...parseConfig([], {}),
    port: 0,
    mode: 'live',
    lsblk: lsblkBin,
    historyFile: path.join(dir, 'history.json'),
    refreshSeconds: 0,
    openBrowser: false,
  });
  t.after(async () => {
    process.env.PATH = originalPath;
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  assert.equal(state.opener?.name, 'xdg-open', 'the fake launcher is picked up from PATH');

  const map = await (await fetch(`${baseUrl}/api/partitions`)).json();
  assert.equal(map.source, 'lsblk');
  assert.equal(map.disks.length, 1);
  assert.equal(map.disks[0].volumes.length, 2);
  assert.equal(map.disks[0].freeBytes, 1000000000000 - 700000000000);
  assert.deepEqual(map.mounts.sort(), ['/', '/boot/efi']);
  assert.equal(map.open.enabled, true);

  const opened = await fetch(`${baseUrl}/api/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/boot/efi' }),
  });
  assert.equal(opened.status, 200);
  const openedBody = await opened.json();
  assert.equal(openedBody.opened, true);
  assert.equal(openedBody.path, '/boot/efi');
  assert.equal((await fs.readFile(openedLog, 'utf8')).trim(), '/boot/efi');

  // anything that is not a reported mount point is refused before spawning
  const refused = await fetch(`${baseUrl}/api/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/etc' }),
  });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /not a mounted volume/);

  assert.equal((await fetch(`${baseUrl}/api/open`, { method: 'POST' })).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/open`)).status, 405);

  // a cross-site form/fetch cannot drive the endpoint (no CORS headers)
  const crossOrigin = await fetch(`${baseUrl}/api/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ path: '/boot/efi' }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await fs.readFile(openedLog, 'utf8')).trim(), '/boot/efi', 'nothing else was launched');
});

test('demo mode reports its layouts and never opens a volume', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smart-vol-demo-'));
  const { server, baseUrl } = await startServer({
    ...parseConfig([], {}),
    port: 0,
    mode: 'demo',
    historyFile: path.join(dir, 'history.json'),
    refreshSeconds: 0,
    openBrowser: false,
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  const map = await (await fetch(`${baseUrl}/api/partitions`)).json();
  assert.equal(map.source, 'demo');
  assert.equal(map.disks.length, 5);
  assert.ok(map.disks.every((disk) => disk.volumes.length >= 2));

  const payload = await (await fetch(`${baseUrl}/api/disks`)).json();
  assert.ok(payload.disks.every((disk) => disk.partitions?.volumes.length >= 2));
  assert.equal(payload.status.partitions.source, null, 'demo never probes the host');

  const response = await fetch(`${baseUrl}/api/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/dev/sda1' }),
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /fixtures/);
});

test('the server opens the dashboard in a browser on startup', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smart-browser-'));
  const fakeBrowser = path.join(dir, 'xdg-open');
  const log = path.join(dir, 'opened.log');
  await fs.writeFile(fakeBrowser, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${log}"\n`);
  await fs.chmod(fakeBrowser, 0o755);

  // candidate order and platform support
  assert.deepEqual(
    resolveBrowser({ platform: 'linux', env: { PATH: dir } }),
    { command: fakeBrowser, name: 'xdg-open', args: [] },
  );
  assert.deepEqual(
    resolveBrowser({ platform: 'linux', find: (command) => (command === 'gio' ? '/usr/bin/gio' : null) }),
    { command: '/usr/bin/gio', name: 'gio', args: ['open'] },
  );
  assert.equal(resolveBrowser({ platform: 'linux', find: () => null }), null);
  assert.equal(resolveBrowser({ platform: 'plan9', find: () => '/bin/true' }), null);

  // only http(s) URLs are ever handed to the launcher
  await assert.rejects(openBrowser('file:///etc/passwd', { opener: { command: fakeBrowser, name: 'xdg-open' } }), /refusing/);
  await assert.rejects(openBrowser('http://127.0.0.1:7373/', { opener: null }), /no browser launcher/);

  const result = await openBrowser('http://127.0.0.1:7373/?x=1', {
    opener: { command: fakeBrowser, name: 'xdg-open', args: [] },
  });
  assert.equal(result.command, 'xdg-open');
  assert.equal(result.url, 'http://127.0.0.1:7373/?x=1');

  // the launcher receives the URL as a single argument, untouched
  let recorded = '';
  for (let attempt = 0; attempt < 40 && !recorded; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    recorded = (await fs.readFile(log, 'utf8').catch(() => '')).trim();
  }
  assert.equal(recorded, 'http://127.0.0.1:7373/?x=1');

  await fs.rm(dir, { recursive: true, force: true });
});

/* --------------------------------------------------------------------------
   Windows volume map (PowerShell JSON -> disk entries -> GUI payload)
   -------------------------------------------------------------------------- */

/** Two disks: a GPT system drive and an MBR data drive. */
const WINDOWS_MAP = {
  source: 'windows',
  error: null,
  disks: [
    { number: 0, model: 'Samsung SSD 970 EVO Plus 1TB', serial: 'S1', size: 1000204886016, bus: 'NVMe', style: 'GPT' },
    { number: 1, model: 'WDC WD20EZAZ-00GGJB0', serial: 'S2', size: 2000398934016, bus: 'SATA', style: 'MBR' },
  ],
  partitions: [
    { disk: 0, number: 1, offset: 1048576, size: 104857600, letter: '', type: 'System' },
    { disk: 0, number: 2, offset: 105906176, size: 999653638144, letter: 'C', type: 'Basic' },
    { disk: 1, number: 1, offset: 1048576, size: 500000000000, letter: 'D', type: 'Basic' },
    { disk: 1, number: 2, offset: 500001048576, size: 1000000000, letter: '', type: 'Recovery' },
  ],
  volumes: [
    { letter: 'C', label: 'System', fstype: 'NTFS', size: 999653638144, free: 400000000000, driveType: 'Fixed' },
    { letter: 'D', label: '', fstype: 'NTFS', size: 500000000000, free: 100000000000, driveType: 'Fixed' },
  ],
};

test('parseWindowsPartitions groups partitions under their physical disk', () => {
  const parsed = parseWindowsPartitions(WINDOWS_MAP);

  assert.equal(parsed.disks.length, 2);
  assert.deepEqual([...parsed.mounts].sort(), ['C:\\', 'D:\\']);

  const [system, data] = parsed.disks;
  assert.equal(system.name, 'disk0');
  assert.equal(system.model, 'Samsung SSD 970 EVO Plus 1TB');
  assert.equal(system.sizeBytes, 1000204886016);
  assert.equal(system.volumes.length, 2);

  const efi = system.volumes[0];
  assert.equal(efi.mounted, false);
  assert.equal(efi.mountpoint, null);
  assert.equal(efi.label, 'System', 'a bare partition is named after its type');
  assert.equal(efi.path, 'disk0p1');

  const c = system.volumes[1];
  assert.equal(c.mountpoint, 'C:\\');
  assert.equal(c.path, 'C:\\');
  assert.equal(c.mounted, true);
  assert.equal(c.fstype, 'NTFS');
  assert.equal(c.label, 'System');
  assert.equal(c.fsAvailableBytes, 400000000000);
  assert.equal(c.fsUsePercent, 60, '(999.6 GB - 400 GB) / 999.6 GB');

  // unallocated tail, exactly like the lsblk map reports
  assert.equal(system.allocatedBytes, 999758495744);
  assert.equal(system.freeBytes, 1000204886016 - 999758495744);

  assert.equal(data.volumes[0].path, 'D:\\');
  assert.equal(data.volumes[0].label, 'D: Local Disk', 'an unlabelled drive falls back to the letter');
  assert.equal(data.volumes[0].fsUsePercent, 80);
  assert.equal(data.volumes[1].label, 'Recovery');
});

test('the Windows map is matched by smartctl device name', () => {
  const parsed = parseWindowsPartitions(WINDOWS_MAP);

  assert.equal(windowsDiskName('/dev/sda'), 'disk0');
  assert.equal(windowsDiskName('/dev/sdd'), 'disk3');
  assert.equal(windowsDiskName('\\\\.\\PhysicalDrive2'), 'disk2');
  assert.equal(windowsDiskName('/dev/nvme0'), null);

  assert.equal(matchDisk(parsed, '/dev/sda').name, 'disk0');
  assert.equal(matchDisk(parsed, '/dev/sdb').name, 'disk1');
  assert.equal(matchDisk(parsed, '/dev/sdc'), null, 'a drive without a partition map is not invented');

  const payload = partitionPayload(matchDisk(parsed, '/dev/sdb'));
  assert.equal(payload.device, 'disk1');
  assert.equal(payload.volumes.length, 2);
  assert.equal(payload.volumes[0].mountpoint, 'D:\\');
  assert.equal(payload.volumes[0].mounted, true);
  assert.deepEqual(Object.keys(payload.volumes[0]).sort(), [
    'fsAvailableBytes', 'fsUsePercent', 'fstype', 'label', 'mounted', 'mountpoint', 'number', 'path', 'sizeBytes',
  ]);
});

test('a broken PowerShell probe degrades to an empty map', () => {
  assert.deepEqual(parseWindowsPartitions({ error: 'Get-Disk: Access is denied' }), { disks: [], mounts: new Set() });
  assert.deepEqual(parseWindowsPartitions(null), { disks: [], mounts: new Set() });
});

test('the PowerShell script is passed as base64, never as -Command', () => {
  // "-Command <multi-line string>" loses its quotes in the Windows command line;
  // -EncodedCommand takes a token with no quotes and no newlines.
  const encoded = encodeCommand(WINDOWS_SCRIPT);
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), WINDOWS_SCRIPT,
    'powershell decodes -EncodedCommand as UTF-16LE');
  assert.match(WINDOWS_SCRIPT, /Get-Disk/);
  assert.match(WINDOWS_SCRIPT, /Get-Partition/);
  assert.match(WINDOWS_SCRIPT, /Get-Volume/);
});

test('partitions alone still produce a disk entry', () => {
  // Get-Disk can be denied while Get-Partition keeps working.
  const parsed = parseWindowsPartitions({
    disks: [],
    partitions: [{ disk: 2, number: 1, size: 1000, letter: 'E', type: 'Basic' }],
    volumes: [{ letter: 'E', label: 'Data', fstype: 'NTFS', size: 1000, free: 250 }],
  });

  assert.equal(parsed.disks.length, 1);
  const [disk] = parsed.disks;
  assert.equal(disk.name, 'disk2');
  assert.equal(disk.model, null);
  assert.equal(disk.sizeBytes, 0, 'unknown until Get-Disk answers');
  assert.equal(disk.volumes.length, 1);
  assert.equal(disk.volumes[0].mountpoint, 'E:\\');
  assert.equal(disk.volumes[0].fsUsePercent, 75);
  assert.deepEqual([...parsed.mounts], ['E:\\']);
});


