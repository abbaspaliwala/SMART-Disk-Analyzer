/**
 * <sa-forecast-panel> - the numbers behind the remaining-life estimate:
 * endurance, usage, and every projection that fed the final answer.
 */

import { BaseElement, define, escapeHtml } from '../base.js';
import { formatBytes, formatDate, formatDays, formatHours, formatNumber, formatPercent, formatRate } from '/shared/format.js';

export class SaForecastPanel extends BaseElement {
  setData({ disk = null } = {}) {
    this.setState({ disk });
  }

  render() {
    const disk = this.state.disk;
    if (!disk) {
      this.html('<div class="empty">Select a disk to see its forecast.</div>');
      return;
    }
    const forecast = disk.forecast || {};
    const wear = forecast.wear || {};
    const endurance = forecast.endurance || {};
    const usage = forecast.usage || {};
    const rul = forecast.rul || {};

    const stat = (label, value, hint = '') => `
      <div class="stat">
        <div class="stat__label">${escapeHtml(label)}</div>
        <div class="stat__value num">${value}</div>
        ${hint ? `<div class="stat__hint">${escapeHtml(hint)}</div>` : ''}
      </div>`;

    const driverRows = (rul.drivers || []).map((driver) => `
      <tr${driver.informational ? ' style="opacity:.68"' : ''}>
        <td>${escapeHtml(driver.label)}${driver.informational ? ' <span class="pill pill--muted">informational</span>' : ''}</td>
        <td class="numeric">${formatDays(driver.days)}</td>
        <td class="mono">${formatDate(Date.now() + driver.days * 86400000)}</td>
        <td class="wrap hint">${escapeHtml(driver.method || '')}</td>
      </tr>`).join('');

    const caps = (rul.caps || []).map((cap) => `
      <li><strong>${escapeHtml(cap.reason)}</strong> caps the estimate at ${formatDays(cap.limitDays)}.</li>`).join('');

    this.html(`
      <div class="card">
        <div class="card__head">
          <h3>Endurance &amp; usage</h3>
          <span class="spacer"></span>
          ${wear.source ? `<span class="pill pill--muted" title="${escapeHtml(wear.source)}">${escapeHtml(wear.source)}</span>` : ''}
        </div>
        <div class="card__body">
          <div class="stat-grid">
            ${stat('Endurance used', wear.percentUsed === null || wear.percentUsed === undefined ? '—' : formatPercent(wear.percentUsed),
              wear.percentRemaining === null || wear.percentRemaining === undefined ? 'not reported' : `${formatPercent(wear.percentRemaining)} remaining`)}
            ${stat('Wear rate', wear.ratePerMonth === null || wear.ratePerMonth === undefined ? '—' : formatRate(wear.ratePerMonth, '%/mo'),
              wear.rateSource === 'measured' ? 'measured from snapshots' : wear.rateSource === 'lifetime-average' ? 'lifetime average' : 'needs history')}
            ${stat('Data written', endurance.writtenBytes === null || endurance.writtenBytes === undefined ? '—' : formatBytes(endurance.writtenBytes),
              endurance.writeBytesPerDay ? `${formatBytes(endurance.writeBytesPerDay)}/day` : 'lifetime total')}
            ${stat('Implied endurance', endurance.impliedTotalBytes === null || endurance.impliedTotalBytes === undefined ? '—' : formatBytes(endurance.impliedTotalBytes),
              endurance.remainingBytes ? `${formatBytes(endurance.remainingBytes)} left` : 'derived from wear')}
            ${stat('Power-on time', formatHours(usage.powerOnHours), usage.powerCycles ? `${formatNumber(usage.powerCycles)} power cycles` : '')}
            ${stat('Temperature', usage.temperature === null || usage.temperature === undefined ? '—' : `${usage.temperature} °C`,
              Array.isArray(usage.temperatureSensors) && usage.temperatureSensors.length > 1 ? `sensors ${usage.temperatureSensors.join(' / ')} °C` : '')}
            ${stat('Forecast confidence', rul.confidenceLabel ? escapeHtml(rul.confidenceLabel) : '—',
              typeof rul.confidence === 'number' ? `${Math.round(rul.confidence * 100)}% · ${(forecast.history?.points || 0)} snapshots` : 'no history')}
            ${stat('Model horizon', rul.days === null || rul.days === undefined ? '—' : formatDays(rul.days),
              rul.beyondHorizon ? `capped at ${formatDays(rul.horizonDays)}` : (rul.label || ''))}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card__head">
          <h3>How the estimate was derived</h3>
          <span class="spacer"></span>
          <span class="pill pill--info">${(rul.drivers || []).length} model${(rul.drivers || []).length === 1 ? '' : 's'}</span>
        </div>
        <div class="card__body" style="padding:0">
          ${driverRows ? `
          <div class="table-wrap" style="border:0;border-radius:0;max-height:none">
            <table class="data">
              <thead><tr><th>Projection</th><th style="text-align:right">Remaining</th><th>Projected end of life</th><th>Method</th></tr></thead>
              <tbody>${driverRows}</tbody>
            </table>
          </div>` : '<div class="empty"><strong>No projection possible yet</strong>Capture a snapshot or two so the trend models can run.</div>'}
          ${caps ? `<div class="card__body" style="border-top:1px solid var(--border-soft)">
            <div class="stat__label" style="margin-bottom:6px">Applied safety caps</div>
            <ul class="hint" style="margin:0;padding-left:18px">${caps}</ul>
          </div>` : ''}
        </div>
      </div>
    `);
  }
}

define('sa-forecast-panel', SaForecastPanel);
