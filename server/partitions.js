/**
 * Volume / partition discovery built on `lsblk`.
 *
 * smartctl only describes the drive itself, so this module supplies the other
 * half of the picture: how the drive is carved into partitions, which of them
 * are mounted, and how much space each one holds. It also owns the small
 * amount of policy needed to hand a mount point to the desktop's file manager,
 * which a browser cannot do on its own.
 *
 * Nothing here ever goes through a shell: every command is executed with an
 * argument array, and a path is only opened after it matched a mount point that
 * lsblk reported for a real block device.
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Device types that are never a user visible volume. */
const IGNORED_TYPES = new Set(['loop', 'ram', 'zram', 'rom']);

/** Read-only image filesystems that are not real user volumes. */
const SNAP_FILESYSTEMS = new Set(['squashfs', 'iso9660', 'udf']);

/**
 * `lsblk` columns, most detailed first. MOUNTPOINTS/FSAVAIL/FSUSE% need
 * util-linux >= 2.33, so older systems fall back to the plain column set.
 */
export const LSBLK_COLUMN_SETS = [
  'NAME,KNAME,TYPE,SIZE,FSTYPE,LABEL,MOUNTPOINTS,PARTN,FSAVAIL,FSUSE%,MODEL',
  'NAME,KNAME,TYPE,SIZE,FSTYPE,LABEL,MOUNTPOINT,PARTN,MODEL',
];

function num(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Mount points of an lsblk node (new array field, legacy single field). */
function mountsOf(node) {
  if (Array.isArray(node?.mountpoints)) {
    return node.mountpoints.filter((entry) => typeof entry === 'string' && entry);
  }
  if (typeof node?.mountpoint === 'string' && node.mountpoint) return [node.mountpoint];
  return [];
}

/** "47%" -> 47 */
function percent(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = String(value ?? '').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

/** Flatten one lsblk node into the volume shape the GUI understands. */
function toVolume(node) {
  const mountpoints = mountsOf(node);
  return {
    name: node.name || null,
    path: node.name ? `/dev/${node.name}` : null,
    type: node.type || 'part',
    number: num(node.partn),
    sizeBytes: num(node.size) ?? 0,
    fstype: node.fstype || null,
    label: node.label || null,
    mountpoint: mountpoints[0] || null,
    mountpoints,
    mounted: mountpoints.length > 0,
    fsAvailableBytes: num(node.fsavail),
    fsUsePercent: percent(node['fsuse%']),
  };
}


/**
 * Turn `lsblk -J` output into one entry per physical disk with its volumes.
 *
 * Container nodes (LVM, LUKS, RAID) are flattened: only their leaf volumes are
 * listed, so the segment widths still add up to the size of the drive.
 */
export function parseLsblk(json) {
  const blockdevices = Array.isArray(json?.blockdevices) ? json.blockdevices : [];
  const disks = [];
  const mounts = new Set();

  const walk = (node, collected) => {
    for (const child of Array.isArray(node?.children) ? node.children : []) {
      if (IGNORED_TYPES.has(child.type)) continue;
      for (const mountpoint of mountsOf(child)) mounts.add(mountpoint);
      const nested = Array.isArray(child.children) && child.children.length > 0;
      if (nested) walk(child, collected);
      else collected.push(toVolume(child));
    }
  };

  for (const node of blockdevices) {
    if (IGNORED_TYPES.has(node.type)) continue;
    const volumes = [];
    walk(node, volumes);
    const diskMounts = mountsOf(node);
    for (const mountpoint of diskMounts) mounts.add(mountpoint);
    // A drive that carries a filesystem directly, without a partition table.
    if (!volumes.length && (node.fstype || diskMounts.length)) volumes.push(toVolume(node));
    const sizeBytes = num(node.size) ?? 0;
    const allocatedBytes = volumes.reduce((total, volume) => total + volume.sizeBytes, 0);
    disks.push({
      name: node.name,
      path: `/dev/${node.name}`,
      type: node.type || 'disk',
      model: (node.model || '').trim() || null,
      sizeBytes,
      volumes,
      allocatedBytes,
      freeBytes: Math.max(0, sizeBytes - allocatedBytes),
      mounts: diskMounts,
    });
  }
  return { disks, mounts };
}
/**
 * Derive the parent disk name from a partition device node.
 * sda1 -> sda, nvme0n1p2 -> nvme0n1, mmcblk0p1 -> mmcblk0.
 * A whole-disk node is its own disk (returned unchanged); device mapper and
 * network sources have no disk and return null.
 */
export function diskNameForPartition(source) {
  const name = String(source || '').replace(/^\/dev\//, '').replace(/\[.*\]$/, '').trim();
  if (!name || name.includes('/')) return null;
  const nvme = name.match(/^(nvme\d+n\d+)p\d+$/);
  if (nvme) return nvme[1];
  const mmc = name.match(/^(mmcblk\d+)p\d+$/);
  if (mmc) return mmc[1];
  // Whole-disk names: a filesystem can sit directly on one of these.
  if (/^(nvme\d+n\d+|mmcblk\d+|sd[a-z]+|vd[a-z]+|hd[a-z]+|xvd[a-z]+|md\d+|dm-\d+)$/.test(name)) return name;
  if (/^[a-z]+\d+$/.test(name)) return name.replace(/\d+$/, '');
  return null;
}

/** Partition number of a device node, or null when it is the whole disk. */
export function partitionNumber(source) {
  const name = String(source || '').replace(/^\/dev\//, '').replace(/\[.*\]$/, '').trim();
  const parent = diskNameForPartition(name);
  if (!parent || parent === name) return null;
  const match = name.match(/(?:p)?(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Fallback discovery through `findmnt`, for machines without lsblk (containers)
 * or where lsblk is unavailable. Only mounted filesystems are visible this way,
 * so the map shows the volumes that exist rather than the free space between them.
 */
export function parseFindmnt(json) {
  const byDisk = new Map();
  const mounts = new Set();
  const isRealVolume = (source, node) => !/^\/dev\/(loop|ram|zram|sr|fd)\d+/.test(source)
    && !SNAP_FILESYSTEMS.has(String(node.fstype || ''))
    && !String(node.target || '').startsWith('/snap/');

  const walk = (nodes) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const source = typeof node?.source === 'string' ? node.source : '';
      if (source.startsWith('/dev/') && node.target && isRealVolume(source, node)) {
        mounts.add(node.target);
        const clean = source.replace(/\[.*\]$/, '');
        const diskName = diskNameForPartition(clean);
        if (diskName) {
          if (!byDisk.has(diskName)) byDisk.set(diskName, new Map());
          const volumes = byDisk.get(diskName);
          const existing = volumes.get(clean);
          if (existing) {
            if (!existing.mountpoints.includes(node.target)) existing.mountpoints.push(node.target);
          } else {
            const sizeBytes = num(node.size) ?? 0;
            const fsAvailableBytes = num(node.avail);
            volumes.set(clean, {
              name: clean.replace(/^\/dev\//, ''),
              path: clean,
              type: 'part',
              number: partitionNumber(clean),
              sizeBytes,
              fstype: node.fstype || null,
              label: node.label || null,
              mountpoint: node.target,
              mountpoints: [node.target],
              mounted: true,
              fsAvailableBytes,
              fsUsePercent: sizeBytes > 0 && fsAvailableBytes !== null
                ? Math.max(0, Math.round(((sizeBytes - fsAvailableBytes) / sizeBytes) * 100))
                : null,
            });
          }
        }
      }
      if (node?.children) walk(node.children);
    }
  };
  walk(json?.filesystems);

  const disks = [...byDisk.entries()].map(([name, volumeMap]) => {
    const volumes = [...volumeMap.values()].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    const allocatedBytes = volumes.reduce((total, volume) => total + volume.sizeBytes, 0);
    return {
      name,
      path: `/dev/${name}`,
      type: 'disk',
      model: null,
      sizeBytes: allocatedBytes,
      volumes,
      allocatedBytes,
      freeBytes: 0,
      mounts: volumes.flatMap((volume) => volume.mountpoints),
    };
  });

  return { disks, mounts };
}

/* ==========================================================================
   Windows: physical disks, partitions and volumes through PowerShell
   ========================================================================== */

/**
 * Collect the same picture lsblk gives on Linux, using the Storage module.
 *
 * One PowerShell process, one JSON document: disks (number, model, size),
 * partitions (disk number, partition number, size, drive letter) and volumes
 * (label, filesystem, free space). Only built-in cmdlets are used and every
 * section fails independently, so a locked-down machine still yields what it can.
 */
export const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$result = [ordered]@{ source = "windows"; disks = @(); partitions = @(); volumes = @(); error = $null }',
  'try {',
  '  $list = @()',
  '  foreach ($d in @(Get-Disk)) {',
  '    $list += [pscustomobject]@{ number = [int]$d.Number; model = [string]$d.FriendlyName;',
  '      serial = [string]$d.SerialNumber; size = [double]$d.Size; bus = [string]$d.BusType;',
  '      style = [string]$d.PartitionStyle }',
  '  }',
  '  $result.disks = $list',
  '} catch { $result.error = "Get-Disk: " + $_.Exception.Message }',
  'try {',
  '  $list = @()',
  '  foreach ($p in @(Get-Partition)) {',
  '    $letter = ""',
  '    if ( ([string]$p.DriveLetter) -match "^[A-Za-z]$" ) { $letter = ([string]$p.DriveLetter).ToUpper() }',
  '    $list += [pscustomobject]@{ disk = [int]$p.DiskNumber; number = [int]$p.PartitionNumber;',
  '      offset = [double]$p.Offset; size = [double]$p.Size; letter = $letter; type = [string]$p.Type }',
  '  }',
  '  $result.partitions = $list',
  '} catch { if (-not $result.error) { $result.error = "Get-Partition: " + $_.Exception.Message } }',
  'try {',
  '  $list = @()',
  '  foreach ($v in @(Get-Volume)) {',
  '    $letter = ""',
  '    if ( ([string]$v.DriveLetter) -match "^[A-Za-z]$" ) { $letter = ([string]$v.DriveLetter).ToUpper() }',
  '    $list += [pscustomobject]@{ letter = $letter; label = [string]$v.FileSystemLabel;',
  '      fstype = [string]$v.FileSystem; size = [double]$v.Size; free = [double]$v.SizeRemaining;',
  '      driveType = [string]$v.DriveType }',
  '  }',
  '  $result.volumes = $list',
  '} catch { if (-not $result.error) { $result.error = "Get-Volume: " + $_.Exception.Message } }',
  // Write UTF-8 bytes straight to the pipe: no BOM, no OEM code page, so labels
  // with accents survive and JSON.parse never sees a byte-order mark.
  '$json = ConvertTo-Json -InputObject $result -Depth 6 -Compress',
  '$bytes = [Text.Encoding]::UTF8.GetBytes($json)',
  '$stdout = [Console]::OpenStandardOutput()',
  '$stdout.Write($bytes, 0, $bytes.Length)',
  '$stdout.Flush()',
].join('\n');

/** The system PowerShell, found without relying on PATH. */
export function powershellPath(env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  const candidate = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(candidate) ? candidate : 'powershell.exe';
}

/** "C:\\" mount point for a drive letter, or null. */
function driveLetterMount(letter) {
  const value = String(letter || '').trim().toUpperCase();
  return /^[A-Z]$/.test(value) ? `${value}:\\` : null;
}

/** One Windows partition in the volume shape the GUI understands. */
function toWindowsVolume(partition, volume) {
  const mountpoint = driveLetterMount(partition?.letter);
  const sizeBytes = num(partition?.size) ?? 0;
  const free = num(volume?.free);
  const drive = mountpoint ? mountpoint.slice(0, 2) : null;
  const partitionType = String(partition?.type || '').trim();
  // A lettered volume shows its label (or "C: Local Disk"); a bare partition
  // shows its type, which is how Windows names EFI/Recovery partitions.
  const label = String(volume?.label || '').trim()
    || (drive ? `${drive} Local Disk` : (partitionType || null));
  const name = drive || `disk${partition?.disk}p${partition?.number}`;
  return {
    name,
    path: mountpoint || name,
    type: 'part',
    number: num(partition?.number),
    sizeBytes,
    fstype: String(volume?.fstype || '').trim() || null,
    label,
    mountpoint,
    mountpoints: mountpoint ? [mountpoint] : [],
    mounted: Boolean(mountpoint),
    fsAvailableBytes: free,
    fsUsePercent: sizeBytes > 0 && free !== null
      ? Math.max(0, Math.round(((sizeBytes - free) / sizeBytes) * 100))
      : null,
  };
}

/**
 * Turn the PowerShell JSON into one entry per physical disk with its volumes.
 * Disk numbering matches PhysicalDriveN, which is what smartctl's `/dev/sdX`
 * addresses on Windows.
 */
export function parseWindowsPartitions(raw) {
  const disks = Array.isArray(raw?.disks) ? raw.disks : [];
  const partitions = Array.isArray(raw?.partitions) ? raw.partitions : [];
  const volumes = Array.isArray(raw?.volumes) ? raw.volumes : [];

  const volumeByLetter = new Map();
  for (const volume of volumes) {
    const letter = String(volume?.letter || '').trim().toUpperCase();
    if (letter) volumeByLetter.set(letter, volume);
  }

  const mounts = new Set();

  // Get-Disk can be denied while Get-Partition still works, and partitions carry
  // their own disk number - so the disk list is the union of both sources.
  const byNumber = new Map();
  for (const disk of disks) {
    const number = num(disk?.number);
    if (number !== null) byNumber.set(number, disk);
  }
  for (const partition of partitions) {
    const number = num(partition?.disk);
    if (number !== null && !byNumber.has(number)) byNumber.set(number, { number, model: null, size: null });
  }

  const entries = [...byNumber.values()]
    .sort((a, b) => (num(a?.number) ?? 0) - (num(b?.number) ?? 0))
    .map((disk) => {
      const number = num(disk?.number) ?? 0;
      const own = partitions
        .filter((partition) => num(partition?.disk) === number)
        .sort((a, b) => (num(a?.number) ?? 0) - (num(b?.number) ?? 0));
      const volumeEntries = own.map((partition) => {
        const letter = String(partition?.letter || '').trim().toUpperCase();
        return toWindowsVolume(partition, volumeByLetter.get(letter));
      });
      for (const volume of volumeEntries) {
        for (const mountpoint of volume.mountpoints) mounts.add(mountpoint);
      }
      const sizeBytes = num(disk?.size) ?? 0;
      const allocatedBytes = volumeEntries.reduce((total, volume) => total + volume.sizeBytes, 0);
      return {
        name: `disk${number}`,
        path: `disk${number}`,
        type: 'disk',
        model: String(disk?.model || '').trim() || null,
        sizeBytes,
        volumes: volumeEntries,
        allocatedBytes,
        freeBytes: Math.max(0, sizeBytes - allocatedBytes),
        mounts: volumeEntries.flatMap((volume) => volume.mountpoints),
    };
  });

  return { disks: entries, mounts };
}

/**
 * smartctl addresses Windows drives as `/dev/sda`, `/dev/sdb`, ... which map to
 * PhysicalDrive0, 1, ... - the same numbering `Get-Disk` reports.
 */
export function windowsDiskName(devicePath) {
  const value = String(devicePath || '').trim();
  const sd = value.match(/^\/dev\/sd([a-z])$/i);
  if (sd) return `disk${sd[1].toLowerCase().charCodeAt(0) - 97}`;
  const physical = value.match(/PhysicalDrive(\d+)$/i);
  if (physical) return `disk${Number(physical[1])}`;
  return null;
}

/**
 * Base64 of the script as UTF-16LE, which is what `powershell -EncodedCommand`
 * expects.
 *
 * The script must not be passed through `-Command`: it contains quotes and
 * newlines, and the Windows command line mangles them (`The string is missing
 * the terminator`). A base64 token has neither, so it survives any argv.
 */
export function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/** Run the PowerShell volume probe and normalise its JSON. */
async function readWindows({ binary, timeoutMs }) {
  try {
    const { stdout } = await execFileAsync(binary, [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodeCommand(WINDOWS_SCRIPT),
    ], {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    const raw = JSON.parse(String(stdout).trim());
    const parsed = parseWindowsPartitions(raw);
    const reported = String(raw?.error || '').trim();
    // An empty answer would leave the volume bar silently blank, so explain it.
    const error = reported || (parsed.disks.length
      ? null
      : 'PowerShell returned no disks and no partitions - are the Storage cmdlets available?');
    return { ...parsed, error, columns: null };
  } catch (error) {
    return { disks: [], mounts: new Set(), columns: null, error: error.message };
  }
}

/**
 * Candidate lsblk names for a smartctl device path. smartctl addresses NVMe
 * controllers (`/dev/nvme0`) while lsblk names namespaces (`nvme0n1`).
 */
export function deviceCandidates(devicePath) {
  const raw = String(devicePath || '').replace(/\s*\(demo\)\s*$/i, '').trim();
  const base = raw.replace(/^\/dev\//, '');
  if (!base) return [];
  const candidates = new Set([base]);
  const controller = base.match(/^(nvme\d+)$/);
  if (controller) candidates.add(`${controller[1]}n1`);
  const namespace = base.match(/^(nvme\d+)n\d+$/);
  if (namespace) candidates.add(namespace[1]);
  if (base.includes('/')) candidates.add(base.split('/').pop());
  return [...candidates];
}

function normalizeModel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Find the lsblk entry that belongs to a smartctl device. Falls back to a
 * unique model match so USB bridges that rename the device still line up.
 */
export function matchDisk(parsed, devicePath, model = null) {
  const disks = parsed?.disks || [];
  if (!disks.length) return null;
  for (const candidate of deviceCandidates(devicePath)) {
    const hit = disks.find((disk) => disk.name === candidate);
    if (hit) return hit;
  }
  // Windows: /dev/sda is PhysicalDrive0, which the map calls disk0.
  const windowsName = windowsDiskName(devicePath);
  if (windowsName) {
    const hit = disks.find((disk) => disk.name === windowsName);
    if (hit) return hit;
  }
  const wanted = normalizeModel(model);
  if (wanted) {
    const byModel = disks.filter((disk) => {
      const known = normalizeModel(disk.model);
      return known && (known.includes(wanted) || wanted.includes(known));
    });
    if (byModel.length === 1) return byModel[0];
  }
  return null;
}

/** Run lsblk and parse it, degrading gracefully when it is not available. */
/** Read the partition table through lsblk (the only source of free space). */
async function readLsblk({ binary, timeoutMs }) {
  let lastError = null;
  for (const columns of LSBLK_COLUMN_SETS) {
    try {
      const { stdout } = await execFileAsync(binary, ['-J', '-b', '-o', columns], {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
      const parsed = parseLsblk(JSON.parse(stdout));
      if (parsed.disks.length) return { ...parsed, columns, error: null };
      lastError = new Error('lsblk reported no block devices');
    } catch (error) {
      lastError = error;
      if (error.code === 'ENOENT' || error.code === 'EACCES') break;
    }
  }
  return { disks: [], mounts: new Set(), columns: null, error: lastError ? lastError.message : 'lsblk is unavailable' };
}

/** Read the mounted filesystems through findmnt (fallback). */
async function readFindmnt({ binary, timeoutMs }) {
  try {
    const { stdout } = await execFileAsync(binary, ['-J', '-b', '-o', 'SOURCE,TARGET,FSTYPE,LABEL,SIZE,AVAIL'], {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { ...parseFindmnt(JSON.parse(stdout)), error: null };
  } catch (error) {
    return { disks: [], mounts: new Set(), error: error.message };
  }
}

/**
 * Discover partitions and volumes for every drive.
 *
 * Windows has no lsblk, so the Storage cmdlets are queried through PowerShell.
 * Everywhere else lsblk is preferred because it also reports unmounted
 * partitions and the unallocated tail of each disk; findmnt is used when lsblk
 * is missing or blocked, which is common inside containers.
 */
export async function readPartitions({
  binary = 'lsblk',
  findmntBinary = 'findmnt',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  platform = process.platform,
  powershell = null,
} = {}) {
  if (platform === 'win32') {
    // PowerShell start-up plus the Storage module import regularly takes more
    // than the 5 s the unix probes get.
    const windowsTimeout = Math.max(timeoutMs, 20000);
    const info = await readWindows({ binary: powershell || powershellPath(), timeoutMs: windowsTimeout });
    return { ...info, source: info.disks.length ? 'windows' : null };
  }

  const primary = await readLsblk({ binary, timeoutMs });
  if (primary.disks.length) return { ...primary, source: 'lsblk' };

  const fallback = await readFindmnt({ binary: findmntBinary, timeoutMs });
  if (fallback.disks.length) {
    return { ...fallback, columns: null, source: 'findmnt' };
  }

  return {
    disks: [],
    mounts: new Set(),
    columns: null,
    source: null,
    error: primary.error || fallback.error || 'no partition data available',
  };
}

/** Shape one matched disk for the browser. */
export function partitionPayload(entry) {
  if (!entry) return null;
  return {
    device: entry.path,
    totalBytes: entry.sizeBytes,
    allocatedBytes: entry.allocatedBytes,
    freeBytes: entry.freeBytes,
    volumes: entry.volumes.map((volume) => ({
      path: volume.path,
      number: volume.number,
      label: volume.label,
      fstype: volume.fstype,
      sizeBytes: volume.sizeBytes,
      mountpoint: volume.mountpoint,
      mounted: volume.mounted,
      fsUsePercent: volume.fsUsePercent,
      fsAvailableBytes: volume.fsAvailableBytes,
    })),
  };
}


/* ==========================================================================
   Opening a mounted volume in the desktop's file manager
   ========================================================================== */

/** File manager launchers per platform, best first. */
export const OPENER_CANDIDATES = {
  linux: [
    ['xdg-open', []],
    ['gio', ['open']],
    ['nautilus', []],
    ['dolphin', []],
    ['thunar', []],
    ['nemo', []],
    ['pcmanfm', []],
    ['caja', []],
  ],
  darwin: [['open', []]],
  win32: [['explorer', []]],
};

/** Resolve a command through PATH (no shell, no child process). */
export function which(command, env = process.env) {
  const directories = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)) return candidate;
      } catch {
        /* not here - keep looking */
      }
    }
  }
  return null;
}

/**
 * Pick the launcher for this desktop.
 * @returns {{command:string,name:string,args:string[]}|null}
 */
export function resolveOpener({ platform = process.platform, env = process.env, find } = {}) {
  const lookup = find || ((command) => which(command, env));
  for (const [name, args] of OPENER_CANDIDATES[platform] || []) {
    const command = lookup(name);
    if (command) return { command, name, args };
  }
  return null;
}

/**
 * Only mount points that lsblk reported may be opened - a request for any
 * other path (including `..` escapes) is refused.
 * @returns {{ok:true,path:string}|{ok:false,error:string}}
 */
export function validateOpenTarget(requested, mounts) {
  if (typeof requested !== 'string' || !requested.trim()) {
    return { ok: false, error: 'a "path" is required' };
  }
  const trimmed = requested.trim();
  if (trimmed.includes('\0')) return { ok: false, error: 'the path contains a null byte' };
  if (!path.isAbsolute(trimmed)) return { ok: false, error: 'only absolute mount points can be opened' };
  const resolved = path.resolve(trimmed);
  const allowed = mounts instanceof Set ? mounts : new Set(mounts || []);
  for (const mountpoint of allowed) {
    if (!mountpoint) continue;
    const normalized = path.resolve(mountpoint);
    if (resolved === normalized || resolved === `${normalized}${path.sep}`) {
      return { ok: true, path: normalized };
    }
  }
  return { ok: false, error: `${trimmed} is not a mounted volume of a detected disk` };
}

/** Look up a local account so a root-run server can open the file manager as the desktop user. */
export function lookupUser(username, { passwdFile = '/etc/passwd' } = {}) {
  if (!username) return null;
  try {
    for (const line of fs.readFileSync(passwdFile, 'utf8').split('\n')) {
      const fields = line.split(':');
      if (fields.length >= 7 && fields[0] === username) {
        const uid = Number(fields[2]);
        const gid = Number(fields[3]);
        if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
        return { username, uid, gid, home: fields[5], shell: fields[6] };
      }
    }
  } catch {
    /* unreadable passwd - fall through */
  }
  return null;
}


/**
 * Build (but do not run) the file manager invocation. Kept separate from
 * `openInFileManager` so the argument/env handling can be tested.
 */
export function buildOpenSpawn(targetPath, { opener, platform = process.platform, env = process.env, runAs = null } = {}) {
  if (!opener?.command) throw new Error('no file manager launcher is available');
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
    throw new Error('only absolute mount points can be opened');
  }
  const options = { detached: true, stdio: 'ignore' };
  if (runAs && platform !== 'win32') {
    const runtimeDir = `/run/user/${runAs.uid}`;
    options.uid = runAs.uid;
    options.gid = runAs.gid;
    options.env = {
      ...env,
      HOME: runAs.home || env.HOME,
      USER: runAs.username,
      LOGNAME: runAs.username,
      // A desktop session socket lives in the runtime dir of its own user.
      XDG_RUNTIME_DIR: fs.existsSync(runtimeDir) ? runtimeDir : env.XDG_RUNTIME_DIR,
    };
  }
  return { command: opener.command, args: [...(opener.args || []), targetPath], options };
}

/**
 * Launch the desktop file manager on a mount point.
 *
 * `xdg-open` reports a non-zero exit status when it cannot find a handler, so
 * the first couple of seconds are waited out to turn that into a real error
 * instead of a silent no-op. A launcher that is still running (dolphin,
 * nautilus) is treated as success and detached.
 */
export function openInFileManager(targetPath, {
  opener,
  platform = process.platform,
  env = process.env,
  runAs = null,
  settleMs = 2500,
} = {}) {
  return new Promise((resolve, reject) => {
    let plan;
    try {
      plan = buildOpenSpawn(targetPath, { opener, platform, env, runAs });
    } catch (error) {
      reject(error);
      return;
    }

    let child;
    try {
      child = spawn(plan.command, plan.args, plan.options);
    } catch (error) {
      reject(new Error(`could not start ${opener.name}: ${error.message}`));
      return;
    }

    let settled = false;
    let timer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        child.unref();
      } catch {
        /* already gone */
      }
      if (error) reject(error);
      else resolve({ path: targetPath, command: opener.name });
    };

    timer = setTimeout(() => finish(null), settleMs);
    child.once('error', (error) => finish(new Error(`could not launch ${opener.name}: ${error.message}`)));
    child.once('exit', (code) => {
      if (code === 0 || code === null || platform === 'win32') finish(null);
      else finish(new Error(`${opener.name} exited with code ${code} - is a desktop session available?`));
    });
  });
}

