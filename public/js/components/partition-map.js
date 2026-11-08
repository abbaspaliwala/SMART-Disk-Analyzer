/**
 * <sa-partition-map> - the volumes of the selected drive as one proportional
 * bar, in the spirit of GNOME Disks / Windows "Volumes" view.
 *
 * A mounted volume is a real link to `file:///mount/point`, but a browser is
 * not allowed to open a file manager by itself, so the click is handed to the
 * local backend (POST /api/open) which validates the mount point and launches
 * the desktop's file manager.
 */

import { BaseElement, define, escapeHtml } from '../base.js';
import { formatBytes } from '/shared/format.js';
import { api } from '../api.js';

/** Below these widths (as a % of the bar) the label shrinks, then disappears. */
const NARROW_PERCENT = 9;
const TINY_PERCENT = 3;
/** Cool hues only: green/amber/red are reserved for health severities. */
const HUES = [199, 217, 236, 262, 288, 320];

export class SaPartitionMap extends BaseElement {
  constructor() {
    super();
    this.state = { partitions: null, device: null, busy: null };
  }

  /** @param {{partitions?:object|null, device?:object|null}} data */
  setData({ partitions = null, device = null } = {}) {
    this.setState({ partitions, device });
  }

  onConnect() {
    this.on(this, 'click', (event) => this.handleClick(event));
    // A segment without an href is not focusable-activatable by default.
    this.on(this, 'keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const segment = event.target.closest?.('[data-volume]');
      if (!segment) return;
      event.preventDefault();
      segment.click();
    });
  }

  volumes() {
    return this.state.partitions?.volumes || [];
  }

  handleClick(event) {
    const segment = event.target.closest('[data-volume]');
    if (!segment) return;
    event.preventDefault();
    if (this.state.busy) return;
    const volume = this.volumes().find((entry) => entry.path === segment.dataset.volume);
    if (!volume) return;

    if (volume.demo) {
      this.emit('notify', { type: 'info', message: 'Demo volume - fixture drives are not present on this machine.' });
      return;
    }
    if (!volume.mounted || !volume.mountpoint) {
      const name = volume.label ? `"${volume.label}"` : volume.path;
      this.emit('notify', {
        type: 'info',
        message: `${name} is not mounted - mount it and it becomes clickable.`,
      });
      return;
    }

    this.setState({ busy: volume.path });
    api.openPath(volume.mountpoint)
      .then((result) => this.emit('notify', {
        type: 'ok',
        message: `Opening ${result.path} in ${result.command}`,
      }))
      .catch((error) => this.emit('notify', { type: 'error', message: error.message }))
      .finally(() => this.setState({ busy: null }));
  }

  render() {
    const partitions = this.state.partitions;
    const volumes = this.volumes();
    if (!partitions || !volumes.length) {
      this.html('');
      return;
    }

    const total = partitions.totalBytes || volumes.reduce((sum, volume) => sum + (volume.sizeBytes || 0), 0);
    const ordered = [...volumes].sort((a, b) => (a.number ?? 99) - (b.number ?? 99));
    const segments = ordered.map((volume, index) => this.segmentMarkup(volume, index, total));
    if (partitions.freeBytes > 0 && total > 0) {
      segments.push(this.freeMarkup(partitions.freeBytes, total));
    }

    const mounted = ordered.filter((volume) => volume.mounted).length;
    const deviceName = this.state.device?.device || partitions.device || 'this drive';
    const summary = [
      `${ordered.length} volume${ordered.length === 1 ? '' : 's'}`,
      `${formatBytes(partitions.allocatedBytes ?? total)} allocated`,
      partitions.freeBytes > 0 ? `${formatBytes(partitions.freeBytes)} free` : null,
    ].filter(Boolean).join(' · ');
    const hint = partitions.demo
      ? 'demo layout'
      : mounted
        ? 'click a mounted volume to open it'
        : 'no mounted volumes';

    this.html(`
      <section class="volumes" aria-label="Volumes on ${escapeHtml(deviceName)}">
        <div class="volumes__head">
          <h3>Volumes</h3>
          <span class="volumes__summary">${escapeHtml(summary)}</span>
          <span class="volumes__hint">${escapeHtml(hint)}</span>
        </div>
        <div class="volumes__bar">${segments.join('')}</div>
      </section>
    `);
  }

  /** One volume segment. */
  segmentMarkup(volume, index, total) {
    const size = volume.sizeBytes || 0;
    const share = total > 0 ? (size / total) * 100 : 0;
    const label = volume.label
      || (volume.number ? `Volume ${volume.number}` : (volume.fstype ? volume.fstype.toUpperCase() : 'Volume'));
    const partLine = volume.number ? `Partition ${volume.number}` : 'Whole disk';
    const sizeLine = [formatBytes(size), volume.fstype ? volume.fstype.toUpperCase() : null].filter(Boolean).join(' · ');
    const mount = volume.mounted && volume.mountpoint ? volume.mountpoint : null;
    const tone = volume.demo ? 'demo' : (mount ? 'mounted' : 'unmounted');

    const tooltip = [
      label,
      partLine,
      sizeLine,
      mount ? `mounted at ${mount}` : 'not mounted',
      Number.isFinite(volume.fsUsePercent) ? `${volume.fsUsePercent}% used` : null,
    ].filter(Boolean).join(' · ');

    const classes = ['volumes__seg', `volumes__seg--${tone}`];
    if (share < NARROW_PERCENT) classes.push('volumes__seg--narrow');
    if (share < TINY_PERCENT) classes.push('volumes__seg--tiny');
    if (this.state.busy === volume.path) classes.push('is-busy');

    const href = mount ? `file://${encodeURI(mount)}` : null;
    return `<a class="${classes.join(' ')}"${href ? ` href="${escapeHtml(href)}"` : ' role="button"'}
        data-volume="${escapeHtml(volume.path || '')}"
        style="--hue:${HUES[index % HUES.length]};flex-basis:${Math.max(share, 0.4).toFixed(3)}%"
        tabindex="0"
        title="${escapeHtml(tooltip)}"
        aria-label="${escapeHtml(`${label}, ${sizeLine}, ${mount ? `mounted at ${mount}` : 'not mounted'}`)}">
      <span class="volumes__name">${escapeHtml(label)}</span>
      <span class="volumes__part">${escapeHtml(partLine)}${mount ? '' : ' · <span class="volumes__off">off</span>'}</span>
      <span class="volumes__size">${escapeHtml(sizeLine)}</span>
    </a>`;
  }

  /** The unallocated tail of the drive. */
  freeMarkup(bytes, total) {
    const share = total > 0 ? (bytes / total) * 100 : 0;
    const classes = ['volumes__seg', 'volumes__seg--free'];
    if (share < NARROW_PERCENT) classes.push('volumes__seg--narrow');
    if (share < TINY_PERCENT) classes.push('volumes__seg--tiny');
    return `<div class="${classes.join(' ')}" style="flex-basis:${share.toFixed(3)}%"
        title="Unallocated space on the drive">
      <span class="volumes__name">Free Space</span>
      <span class="volumes__part">unallocated</span>
      <span class="volumes__size">${formatBytes(bytes)}</span>
    </div>`;
  }
}

define('sa-partition-map', SaPartitionMap);
