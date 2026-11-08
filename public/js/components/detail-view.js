/**
 * <sa-detail-view> - the main panel: hero with health gauge and remaining life,
 * then the Overview / Parameters / Trends / Raw tabs.
 */

import { BaseElement, define, escapeHtml, healthStatus } from '../base.js';
import { formatBytes, formatDate, formatDateTime, formatDays, formatHours, formatNumber, formatPercent, formatFutureDays } from '/shared/format.js';
import { subscribe, setState, selectedDisk } from '../state.js';
import { api } from '../api.js';
import './gauge.js';
import './risk-list.js';
import './forecast-panel.js';
import './attribute-table.js';
import './trend-chart.js';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'parameters', label: 'Parameters' },
  { id: 'trends', label: 'Trends' },
  { id: 'raw', label: 'Raw JSON' },
];

const METRICS = [
  { id: 'wearPercent', label: 'Endurance used', color: '#38bdf8', format: (value) => `${value.toFixed(1)}%` },
  { id: 'healthScore', label: 'Health score', color: '#34d399', format: (value) => String(Math.round(value)) },
  { id: 'temperature', label: 'Temperature', color: '#fb923c', format: (value) => `${Math.round(value)} °C` },
  { id: 'reallocated', label: 'Reallocated sectors', color: '#f87171', format: (value) => String(Math.round(value)) },
  { id: 'pendingSectors', label: 'Pending sectors', color: '#fb923c', format: (value) => String(Math.round(value)) },
  { id: 'writtenBytes', label: 'Data written', color: '#818cf8', format: (value) => formatBytes(value) },
  { id: 'powerOnHours', label: 'Power-on hours', color: '#60a5fa', format: (value) => `${formatNumber(value)} h` },
];

export class SaDetailView extends BaseElement {
  constructor() {
    super();
    this.state = { app: null, trendMetric: 'wearPercent' };
  }

  onConnect() {
    this._unsubs.push(subscribe((app) => this.setState({ app })));
    this.on(this, 'click', (event) => this.handleClick(event));
  }

  handleClick(event) {
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      setState({ tab: tab.dataset.tab });
      return;
    }
    const metric = event.target.closest('[data-metric]');
    if (metric) {
      this.state.trendMetric = metric.dataset.metric;
      this.render();
      return;
    }
    if (event.target.closest('[data-action="clear-history"]')) {
      const disk = selectedDisk();
      if (!disk) return;
      api.clearHistory(disk.key)
        .then(() => this.emit('refresh', { force: true }))
        .then(() => this.emit('notify', { type: 'info', message: 'Snapshot history cleared' }))
        .catch((error) => this.emit('notify', { type: 'error', message: error.message }));
      return;
    }
    if (event.target.closest('[data-action="copy-raw"]')) {
      const disk = selectedDisk();
      if (!disk?.raw) return;
      navigator.clipboard?.writeText(JSON.stringify(disk.raw, null, 2))
        .then(() => this.emit('notify', { type: 'ok', message: 'Raw smartctl JSON copied to the clipboard' }))
        .catch(() => this.emit('notify', { type: 'error', message: 'Clipboard access was refused' }));
    }
  }

  render() {
    const app = this.state.app;
    if (!app || app.loading) {
      this.html(`<div class="detail"><div class="card skeleton skeleton--hero"></div></div>`);
      return;
    }
    const disk = selectedDisk();
    if (!disk) {
      this.html(`<div class="card"><div class="empty">
        <strong>No disk selected</strong>Run a rescan, or import a smartctl JSON file to analyse a drive from another machine.
      </div></div>`);
      return;
    }

    const tab = app.tab || 'overview';
    this.html(`
      <div class="detail">
        ${this.heroMarkup(disk)}
        <div class="card">
          <div class="tabs">
            ${TABS.map((entry) => `
              <button class="tab${tab === entry.id ? ' is-active' : ''}" data-tab="${entry.id}" type="button">
                ${entry.label}
                ${entry.id === 'parameters' ? `<span class="tab__count">${disk.parameterCount ?? disk.attributes?.length ?? 0}</span>` : ''}
                ${entry.id === 'trends' ? `<span class="tab__count">${disk.history?.length ?? 0}</span>` : ''}
              </button>`).join('')}
          </div>
          <div class="card__body" id="tab-panel">${this.tabMarkup(disk, tab)}</div>
        </div>
      </div>
    `);

    this.afterRender(disk, tab);
  }
  /** Hero card: gauge, identity, remaining life and the recommendation. */
  heroMarkup(disk) {
    const rul = disk.forecast?.rul || {};
    const recommendation = disk.forecast?.recommendation || {};
    const rulValue = rul.days === null || rul.days === undefined
      ? 'no estimate'
      : `${formatDays(rul.days)}${rul.beyondHorizon ? '+' : ''}`;
    const rulSub = rul.date ? `projected end of life ${formatDate(rul.date)}` : (rul.detail || '');
    const pill = (text, tone = 'muted') => `<span class="pill pill--${tone}">${escapeHtml(text)}</span>`;

    return `
      <div class="card hero">
        <div class="hero__gauge">
          <sa-gauge id="hero-gauge"></sa-gauge>
          <div class="hero__gauge-label">Health score</div>
        </div>
        <div class="hero__main">
          <div class="hero__title">
            <h2>${escapeHtml(disk.model)}</h2>
            <span class="hero__device">${escapeHtml(disk.device)}</span>
          </div>
          <div class="hero__meta">
            ${pill(disk.form || 'unknown')}
            ${pill(formatBytes(disk.capacityBytes, 0))}
            ${disk.protocol && disk.protocol !== 'unknown' ? pill(disk.protocol) : ''}
            ${disk.firmware ? pill(`fw ${disk.firmware}`) : ''}
            ${disk.serial ? pill(disk.serial) : ''}
            ${disk.smartPassed === true ? pill('SMART passed', 'ok') : disk.smartPassed === false ? pill('SMART FAILING', 'critical') : pill('SMART unknown', 'muted')}
            ${disk.mode === 'demo' ? pill('demo data', 'info') : disk.mode === 'import' ? pill('imported', 'info') : ''}
          </div>

          <div class="hero__rul">
            <div>
              <div class="hero__rul-value">${escapeHtml(rulValue)}</div>
              <div class="hero__rul-date">${escapeHtml(rulSub)}</div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
              ${rul.confidenceLabel && rul.confidenceLabel !== 'none'
                ? pill(`${rul.confidenceLabel} confidence (${Math.round((rul.confidence || 0) * 100)}%)`, rul.confidenceLabel === 'high' ? 'ok' : rul.confidenceLabel === 'medium' ? 'watch' : 'muted')
                : ''}
              ${rul.label ? pill(rul.label, 'info') : ''}
              ${disk.metrics?.powerOnHours ? pill(`${formatHours(disk.metrics.powerOnHours)} powered on`) : ''}
            </div>
          </div>

          <div class="hero__rec hero__rec--${escapeHtml(recommendation.level || 'unknown')}">
            <strong>${escapeHtml(recommendation.headline || 'No recommendation')}</strong>
            ${escapeHtml(recommendation.detail || '')}
            ${recommendation.action ? `<div class="hint" style="margin-top:4px">→ ${escapeHtml(recommendation.action)}</div>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  /** Content of the active tab. */
  tabMarkup(disk, tab) {
    if (!disk.smartAvailable) {
      const messages = (disk.messages || []).map((message) => message?.string).filter(Boolean);
      return `<div class="empty">
        <strong>SMART data unavailable for ${escapeHtml(disk.device)}</strong>
        ${escapeHtml(messages[0] || 'smartctl did not return any parameters for this device.')}
        <div class="hint" style="margin-top:10px">
          Raw device access needs root. Start the analyzer with <code>sudo npm start</code>,
          or install the sudoers rule once with <code>./bin/setup-sudoers.sh</code> and then run <code>npm run elevated</code>.
        </div>
      </div>`;
    }

    if (tab === 'parameters') return '<sa-attribute-table id="attr-table"></sa-attribute-table>';
    if (tab === 'trends') return this.trendMarkup(disk);
    if (tab === 'raw') {
      return `
        <div class="toolbar" style="margin-bottom:10px">
          <button class="btn btn--sm" data-action="copy-raw">⧉ Copy JSON</button>
          <a class="btn btn--sm" href="${api.downloadUrl(disk.key)}" download>⇩ Download</a>
          <span class="hint">${escapeHtml(disk.readCommand || `smartctl -a -j ${disk.device}`)}</span>
        </div>
        <pre class="raw">${escapeHtml(JSON.stringify(disk.raw || {}, null, 2))}</pre>`;
    }

    return `
      <div style="display:flex;flex-direction:column;gap:16px">
        <sa-risk-list id="risk-list"></sa-risk-list>
        <sa-forecast-panel id="forecast-panel"></sa-forecast-panel>
      </div>`;
  }
  /** Trends tab: metric picker, chart and the recent snapshot table. */
  trendMarkup(disk) {
    const history = disk.history || [];
    const available = METRICS.filter((metric) => history.some((snapshot) => typeof snapshot[metric.id] === 'number'));
    const active = available.find((metric) => metric.id === this.state.trendMetric) || available[0];

    const buttons = METRICS.map((metric) => {
      const enabled = available.includes(metric);
      return `<button class="chip-filter${enabled && metric.id === active?.id ? ' is-active' : ''}"
              data-metric="${metric.id}" ${enabled ? '' : 'disabled style="opacity:.4;cursor:not-allowed"'}>
              ${escapeHtml(metric.label)}</button>`;
    }).join('');

    const recent = history.slice(-10).reverse().map((snapshot) => `
      <tr>
        <td class="mono">${formatDateTime(snapshot.t)}</td>
        <td class="numeric">${snapshot.wearPercent === null || snapshot.wearPercent === undefined ? '—' : formatPercent(snapshot.wearPercent)}</td>
        <td class="numeric">${snapshot.healthScore ?? '—'}</td>
        <td class="numeric">${snapshot.temperature === null || snapshot.temperature === undefined ? '—' : `${snapshot.temperature} °C`}</td>
        <td class="numeric">${snapshot.reallocated ?? '—'}</td>
        <td class="numeric">${snapshot.pendingSectors ?? '—'}</td>
        <td class="numeric">${snapshot.writtenBytes ? formatBytes(snapshot.writtenBytes) : '—'}</td>
        <td class="numeric">${snapshot.powerOnHours === null || snapshot.powerOnHours === undefined ? '—' : formatNumber(snapshot.powerOnHours)}</td>
      </tr>`).join('');

    return `
      <div class="toolbar" style="margin-bottom:12px">
        ${buttons}
        <span style="flex:1"></span>
        ${history.length ? '<button class="btn btn--sm btn--danger" data-action="clear-history">Clear history</button>' : ''}
      </div>
      <sa-trend-chart id="trend-chart"></sa-trend-chart>
      ${history.length ? `
        <div class="stat__label" style="margin:16px 0 8px">Recent snapshots</div>
        <div class="table-wrap" style="max-height:320px">
          <table class="data">
            <thead><tr>
              <th>Captured</th><th style="text-align:right">Wear</th><th style="text-align:right">Health</th>
              <th style="text-align:right">Temp</th><th style="text-align:right">Realloc</th>
              <th style="text-align:right">Pending</th><th style="text-align:right">Written</th>
              <th style="text-align:right">Hours</th>
            </tr></thead>
            <tbody>${recent}</tbody>
          </table>
        </div>` : `<div class="empty"><strong>No snapshots yet</strong>
          Press <em>Capture</em> to store a SMART snapshot. Two or more snapshots several days apart let the
          model measure the real wear rate instead of falling back to lifetime averages.</div>`}
    `;
  }

  /** Push data into the child components once their markup exists. */
  afterRender(disk, tab) {
    const gauge = this.q('#hero-gauge');
    if (gauge) {
      gauge.setData({
        value: disk.health?.score ?? null,
        grade: disk.health?.grade || '',
        verdict: disk.health?.verdict || 'Unknown',
        status: healthStatus(disk.health?.score),
        label: `Health score ${disk.health?.score ?? '—'} of 100 (${disk.health?.verdict || 'unknown'})`,
      });
      const gaugeLabel = this.q('.hero__gauge-label');
      if (gaugeLabel) gaugeLabel.textContent = disk.health?.verdict || 'Health score';
    }

    if (tab === 'overview') {
      this.q('#risk-list')?.setData({ risks: disk.forecast?.risks || [], health: disk.health });
      this.q('#forecast-panel')?.setData({ disk });
    }
    if (tab === 'parameters') {
      this.q('#attr-table')?.setData({ attributes: disk.attributes || [], device: disk });
    }
    if (tab === 'trends') {
      const chart = this.q('#trend-chart');
      if (chart) {
        const history = disk.history || [];
        const available = METRICS.filter((metric) => history.some((snapshot) => typeof snapshot[metric.id] === 'number'));
        const active = available.find((metric) => metric.id === this.state.trendMetric) || available[0];
        if (active) {
          const series = [{
            label: active.label,
            color: active.color,
            points: history
              .filter((snapshot) => typeof snapshot[active.id] === 'number')
              .map((snapshot) => ({ x: snapshot.t, y: snapshot[active.id] })),
          }];
          // Overlay the health score when a different metric is being shown.
          if (active.id !== 'healthScore' && history.some((snapshot) => typeof snapshot.healthScore === 'number')) {
            series.push({
              label: 'Health score',
              color: '#34d399',
              area: false,
              zeroBased: false,
              points: history
                .filter((snapshot) => typeof snapshot.healthScore === 'number')
                .map((snapshot) => ({ x: snapshot.t, y: snapshot.healthScore })),
            });
          }
          chart.setData({ series, format: active.format });
        } else {
          chart.setData({ series: [] });
        }
      }
    }
  }
}

define('sa-detail-view', SaDetailView);

