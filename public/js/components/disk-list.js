/**
 * <sa-disk-list> - the left rail: every disk with a compact health gauge,
 * identity line and its remaining-life estimate. Clicking selects a disk.
 */

import { BaseElement, define, escapeHtml, healthStatus } from '../base.js';
import { formatBytes, formatDays, formatPercent } from '/shared/format.js';
import { subscribe, selectDisk, selectedDisk } from '../state.js';
import './gauge.js';

const RISK_ORDER = { critical: 0, warning: 1, watch: 2, ok: 3, unknown: 4 };

export class SaDiskList extends BaseElement {
  onConnect() {
    this._unsubs.push(subscribe((state) => this.setState({ state })));
    this.on(this, 'click', (event) => {
      const button = event.target.closest('.disk');
      if (button?.dataset.key) selectDisk(button.dataset.key);
    });
    this.on(this, 'keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const buttons = this.qa('.disk');
      const index = buttons.indexOf(document.activeElement);
      if (index === -1) return;
      event.preventDefault();
      const next = buttons[index + (event.key === 'ArrowDown' ? 1 : -1)];
      next?.focus();
      if (next?.dataset.key) selectDisk(next.dataset.key);
    });
  }

  render() {
    const state = this.state.state;
    if (!state || state.loading) {
      this.html(`<div class="disk-list">
        <div class="disk-list__head"><h2>Disks</h2></div>
        ${Array.from({ length: 4 }, () => '<div class="skeleton skeleton--row"></div>').join('')}
      </div>`);
      return;
    }

    const disks = [...(state.disks || [])].sort((a, b) => {
      const riskA = RISK_ORDER[healthStatus(a.health?.score)] ?? 4;
      const riskB = RISK_ORDER[healthStatus(b.health?.score)] ?? 4;
      if (riskA !== riskB) return riskA - riskB;
      const daysA = a.forecast?.rul?.days ?? Number.POSITIVE_INFINITY;
      const daysB = b.forecast?.rul?.days ?? Number.POSITIVE_INFINITY;
      return daysA - daysB;
    });

    const active = selectedDisk();

    this.html(`
      <div class="disk-list">
        <div class="disk-list__head">
          <h2>Disks</h2>
          <span class="pill pill--muted disk-list__count">${disks.length}</span>
        </div>
        ${disks.length ? disks.map((disk) => this.diskMarkup(disk, active?.key === disk.key)).join('') : this.emptyMarkup()}
      </div>
    `);

    // Feed each gauge after the markup exists.
    const items = this.qa('.disk');
    items.forEach((item, index) => {
      const disk = disks[index];
      const gauge = item.querySelector('sa-gauge');
      if (gauge && disk) {
        gauge.setData({
          value: disk.health?.score ?? null,
          status: healthStatus(disk.health?.score),
          compact: true,
          label: `${disk.health?.verdict || 'Unknown'} (${disk.health?.score ?? '—'}/100)`,
        });
      }
    });
  }

  emptyMarkup() {
    return `<div class="empty"><strong>No disks found</strong>
      smartctl did not report any devices. Try rescanning, or import a smartctl JSON file.</div>`;
  }

  diskMarkup(disk, isActive) {
    const score = disk.health?.score;
    const status = healthStatus(score);
    const rul = disk.forecast?.rul;
    const wear = disk.forecast?.wear?.percentUsed;
    const rulText = rul?.days === null || rul?.days === undefined
      ? 'no forecast'
      : `${formatDays(rul.days)}${rul.beyondHorizon ? '+' : ''} left`;

    return `
      <button class="disk${isActive ? ' is-active' : ''}" data-key="${escapeHtml(disk.key)}" type="button"
              aria-pressed="${isActive ? 'true' : 'false'}">
        <sa-gauge class="disk__gauge"></sa-gauge>
        <span class="disk__body" style="min-width:0">
          <span class="disk__name" title="${escapeHtml(disk.model)}">${escapeHtml(disk.model)}</span>
          <span class="disk__meta">
            <span>${escapeHtml(disk.device)}</span>
            <span>${escapeHtml(disk.form || '')}</span>
            <span>${formatBytes(disk.capacityBytes, 0)}</span>
          </span>
          <span class="disk__rul">
            <span class="dot ${status === 'unknown' ? 'sev-unknown' : `sev-${status}`}"></span>
            <span>${escapeHtml(rulText)}</span>
            ${typeof wear === 'number' ? `<span class="pill pill--muted">${formatPercent(wear, 0)} worn</span>` : ''}
            ${disk.smartAvailable === false ? '<span class="pill pill--muted">no data</span>' : ''}
          </span>
        </span>
      </button>
    `;
  }
}

define('sa-disk-list', SaDiskList);
