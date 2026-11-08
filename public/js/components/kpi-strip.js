/**
 * <sa-kpi-strip> - top level numbers: disks, capacity, health spread and the
 * drive that is closest to its end of life.
 */

import { BaseElement, define, escapeHtml } from '../base.js';
import { formatBytes, formatDate, formatDays } from '/shared/format.js';
import { subscribe } from '../state.js';

export class SaKpiStrip extends BaseElement {
  onConnect() {
    this._unsubs.push(subscribe((state) => this.setState({ state })));
  }

  render() {
    const state = this.state.state;
    if (!state || state.loading) {
      this.html(`
        <div class="kpis">
          ${Array.from({ length: 6 }, () => '<div class="kpi skeleton" style="height:86px"></div>').join('')}
        </div>`);
      return;
    }

    const summary = state.summary || {};
    const disks = state.disks || [];
    const total = summary.total ?? disks.length;
    const accessible = summary.accessible ?? disks.filter((disk) => disk.smartAvailable).length;
    const averageHealth = summary.averageHealth;
    const nearest = summary.nearestEndOfLife;
    const atRisk = (summary.warning || 0) + (summary.critical || 0);

    this.html(`
      <div class="kpis">
        <div class="kpi">
          <div class="kpi__label">Disks detected</div>
          <div class="kpi__value num">${total}</div>
          <div class="kpi__sub">${accessible} readable SMART ${accessible === total ? '' : '· ' + (total - accessible) + ' locked'}</div>
          <div class="kpi__bar"><span style="width:${total ? Math.round((accessible / total) * 100) : 0}%"></span></div>
        </div>

        <div class="kpi">
          <div class="kpi__label">Total capacity</div>
          <div class="kpi__value num">${formatBytes(summary.totalCapacityBytes, 1)}</div>
          <div class="kpi__sub">across ${accessible} drive${accessible === 1 ? '' : 's'}</div>
        </div>

        <div class="kpi">
          <div class="kpi__label">Mean health</div>
          <div class="kpi__value num">${typeof averageHealth === 'number' ? averageHealth.toFixed(1) : '—'}</div>
          <div class="kpi__sub">0–100 weighted SMART score</div>
          <div class="kpi__bar"><span style="width:${typeof averageHealth === 'number' ? averageHealth : 0}%"></span></div>
        </div>

        <div class="kpi ${atRisk ? 'kpi--warning' : 'kpi--ok'}">
          <div class="kpi__label">Needs attention</div>
          <div class="kpi__value num">${atRisk}</div>
          <div class="kpi__sub">${summary.critical || 0} critical · ${summary.warning || 0} degraded</div>
        </div>

        <div class="kpi ${nearest && nearest.days < 120 ? 'kpi--critical' : nearest && nearest.days < 400 ? 'kpi--warning' : 'kpi--ok'}">
          <div class="kpi__label">Earliest end of life</div>
          <div class="kpi__value num">${nearest ? formatDays(nearest.days) : '—'}</div>
          <div class="kpi__sub">${nearest ? `${escapeHtml(nearest.model)} · ${formatDate(nearest.date)}` : 'no forecast yet'}</div>
        </div>

        <div class="kpi">
          <div class="kpi__label">Healthy drives</div>
          <div class="kpi__value num">${(summary.excellent || 0) + (summary.good || 0) + (summary.fair || 0)}</div>
          <div class="kpi__sub">${summary.excellent || 0} excellent · ${summary.fair || 0} fair</div>
        </div>
      </div>
    `);
  }
}

define('sa-kpi-strip', SaKpiStrip);
