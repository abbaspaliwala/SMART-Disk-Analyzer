/**
 * <sa-attribute-table> - every SMART parameter of the selected drive in one
 * sortable, filterable table, with expandable rows for the full meaning.
 */

import { BaseElement, define, escapeHtml, severityPill } from '../base.js';
import { SEVERITY_RANK } from '/shared/attributes.js';

const COLUMNS = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: 'Parameter' },
  { key: 'value', label: 'Value', numeric: true },
  { key: 'worst', label: 'Worst', numeric: true },
  { key: 'threshold', label: 'Thresh', numeric: true },
  { key: 'raw', label: 'Raw', numeric: true },
  { key: 'status', label: 'Status' },
  { key: 'note', label: 'Interpretation' },
];

export class SaAttributeTable extends BaseElement {
  constructor() {
    super();
    this.state = {
      attributes: [],
      filter: '',
      category: 'all',
      severity: 'all',
      sortKey: 'id',
      sortDir: 'asc',
      expanded: new Set(),
      device: null,
    };
  }

  onConnect() {
    this.on(this, 'click', (event) => this.handleClick(event));
    this.on(this, 'keydown', (event) => {
      if (event.key === 'Enter' && event.target.matches('tr.row-expand')) {
        this.toggleRow(event.target.dataset.key);
      }
    });
    this.on(this, 'input', (event) => {
      if (event.target.id === 'attr-search') {
        this.state.filter = event.target.value;
        this.renderRows();
      }
    });
  }

  /** Fresh attribute list (called by the detail view). */
  setData({ attributes = [], device = null } = {}) {
    this.state.attributes = attributes;
    this.state.device = device;
    this.state.expanded = new Set();
    this.state.filter = '';
    this.state.category = 'all';
    this.state.severity = 'all';
    this.update();
  }

  handleClick(event) {
    const chip = event.target.closest('[data-category]');
    if (chip) {
      this.state.category = chip.dataset.category;
      this.qa('[data-category]').forEach((element) => element.classList.toggle('is-active', element === chip));
      this.renderRows();
      return;
    }
    const sevChip = event.target.closest('[data-severity]');
    if (sevChip) {
      const active = this.state.severity !== sevChip.dataset.severity;
      this.state.severity = active ? sevChip.dataset.severity : 'all';
      this.qa('[data-severity]').forEach((element) => element.classList.toggle('is-active', active && element === sevChip));
      this.renderRows();
      return;
    }
    const header = event.target.closest('th[data-sort]');
    if (header) {
      const key = header.dataset.sort;
      if (this.state.sortKey === key) this.state.sortDir = this.state.sortDir === 'asc' ? 'desc' : 'asc';
      else {
        this.state.sortKey = key;
        this.state.sortDir = 'asc';
      }
      this.update();
      return;
    }
    if (event.target.closest('[data-export]')) {
      this.exportCsv();
      return;
    }
    const row = event.target.closest('tr.row-expand');
    if (row?.dataset.key) this.toggleRow(row.dataset.key);
  }

  toggleRow(key) {
    if (this.state.expanded.has(key)) this.state.expanded.delete(key);
    else this.state.expanded.add(key);
    this.renderRows();
  }

  /** Attributes after search / category / severity filters. */
  filtered() {
    const { attributes, filter, category, severity } = this.state;
    const needle = filter.trim().toLowerCase();
    return attributes.filter((attribute) => {
      if (category !== 'all' && attribute.category !== category) return false;
      if (severity !== 'all' && attribute.status !== severity) return false;
      if (!needle) return true;
      return [attribute.name, attribute.reportedName, attribute.id, attribute.note, attribute.description, attribute.category]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }

  /** Apply the current sort. */
  sorted(list) {
    const { sortKey, sortDir } = this.state;
    const direction = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      if (sortKey === 'status') return ((SEVERITY_RANK[a.status] ?? 0) - (SEVERITY_RANK[b.status] ?? 0)) * direction;
      const left = a[sortKey];
      const right = b[sortKey];
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * direction;
      if (left === right) return 0;
      if (left === null || left === undefined) return 1;
      if (right === null || right === undefined) return -1;
      return String(left).localeCompare(String(right)) * direction;
    });
  }
  render() {
    const { attributes } = this.state;
    const categories = [...new Set(attributes.map((attribute) => attribute.category))].sort();
    const counts = attributes.reduce((acc, attribute) => {
      acc[attribute.status] = (acc[attribute.status] || 0) + 1;
      return acc;
    }, {});

    this.html(`
      <div class="toolbar" style="margin-bottom:12px">
        <input id="attr-search" class="input input--search" type="search" placeholder="Search parameters, notes…"
               value="${escapeHtml(this.state.filter)}" aria-label="Search SMART parameters" />
        <button class="chip-filter is-active" data-category="all">All (${attributes.length})</button>
        ${categories.map((category) => `<button class="chip-filter" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join('')}
        <span style="flex:1"></span>
        ${['critical', 'warning', 'watch'].filter((severity) => counts[severity]).map((severity) => `
          <button class="chip-filter" data-severity="${severity}">${severity} (${counts[severity]})</button>`).join('')}
        <button class="btn btn--sm" data-export="csv">⇩ CSV</button>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              ${COLUMNS.map((column) => `
                <th data-sort="${column.key}" class="${this.state.sortKey === column.key ? 'is-sorted' : ''}"
                    style="${column.numeric ? 'text-align:right' : ''}">
                  ${column.label}${this.state.sortKey === column.key ? (this.state.sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>`).join('')}
            </tr>
          </thead>
          <tbody id="attr-body"></tbody>
        </table>
      </div>
      <p class="hint" style="margin-top:8px">
        Value / worst / threshold are the drive's normalised 0–100 figures, raw is what the firmware reports.
        Click a row for the full explanation.
      </p>
    `);

    this.renderRows();
  }

  /** Repaint just the table body (keeps the search box focused). */
  renderRows() {
    const body = this.q('#attr-body');
    if (!body) return;
    const rows = this.sorted(this.filtered());
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="${COLUMNS.length}"><div class="empty">
        <strong>No matching parameters</strong>Adjust the search or filters.</div></td></tr>`;
      return;
    }
    body.innerHTML = rows.map((attribute) => this.rowMarkup(attribute)).join('');
  }

  rowMarkup(attribute) {
    const isOpen = this.state.expanded.has(attribute.key);
    const rawCell = attribute.source === 'ATA'
      ? (attribute.rawString || '—')
      : (attribute.rawString && attribute.rawString !== String(attribute.value) ? attribute.rawString : '—');
    const numeric = (value) => (typeof value === 'number' ? value : '—');

    return `
      <tr class="row-expand" data-key="${escapeHtml(attribute.key)}" tabindex="0" aria-expanded="${isOpen}">
        <td class="attr-id">${escapeHtml(attribute.source === 'ATA' ? String(attribute.id) : attribute.id)}</td>
        <td>
          <span class="attr-name">${escapeHtml(attribute.name)}</span>
          <div class="hint">${escapeHtml(attribute.category || '')}${attribute.source !== 'ATA' ? ` · ${escapeHtml(attribute.source)}` : ''}</div>
        </td>
        <td class="numeric">${numeric(attribute.value)}</td>
        <td class="numeric">${numeric(attribute.worst)}</td>
        <td class="numeric">${numeric(attribute.threshold)}</td>
        <td class="numeric" title="${escapeHtml(attribute.rawString || '')}">${escapeHtml(rawCell)}</td>
        <td>${severityPill(attribute.status)}</td>
        <td class="wrap">${escapeHtml(attribute.note || '')}</td>
      </tr>
      ${isOpen ? `
      <tr class="row-detail">
        <td colspan="${COLUMNS.length}">
          <dl class="row-detail__grid">
            <div><dt>What it means</dt><dd>${escapeHtml(attribute.description || 'No description available.')}</dd></div>
            <div><dt>Reported name</dt><dd class="mono">${escapeHtml(attribute.reportedName || attribute.name)}</dd></div>
            <div><dt>Raw value</dt><dd class="mono">${escapeHtml(attribute.rawString || '—')}</dd></div>
            <div><dt>Normalised / worst / threshold</dt><dd class="mono">${numeric(attribute.value)} / ${numeric(attribute.worst)} / ${numeric(attribute.threshold)}</dd></div>
            ${attribute.whenFailed ? `<div><dt>Firmware flag</dt><dd>${escapeHtml(attribute.whenFailed)}</dd></div>` : ''}
            <div><dt>Source</dt><dd>${escapeHtml(attribute.source)}</dd></div>
          </dl>
        </td>
      </tr>` : ''}
    `;
  }

  /** Export the current (filtered + sorted) view as CSV. */
  exportCsv() {
    const rows = this.sorted(this.filtered());
    const escapeCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['source', 'id', 'name', 'category', 'value', 'worst', 'threshold', 'raw', 'status', 'note'],
      ...rows.map((attribute) => [
        attribute.source,
        attribute.id,
        attribute.name,
        attribute.category,
        attribute.value,
        attribute.worst,
        attribute.threshold,
        attribute.rawString,
        attribute.status,
        attribute.note,
      ]),
    ].map((line) => line.map(escapeCell).join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `smart-parameters-${(this.state.device?.serial || this.state.device?.key || 'disk')}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    this.emit('notify', { type: 'ok', message: `Exported ${rows.length} parameters to CSV` });
  }
}

define('sa-attribute-table', SaAttributeTable);
