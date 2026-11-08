/**
 * <sa-gauge> - radial health gauge built from SVG.
 *
 * Usage: element.setData({ value: 0..100|null, grade, verdict, status, size })
 */

import { BaseElement, define, escapeHtml } from '../base.js';

const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export class SaGauge extends BaseElement {
  connectedCallback() {
    this._isRendered = true;
    this.render();
  }

  setData(data = {}) {
    this.setState({
      value: data.value ?? null,
      grade: data.grade ?? '',
      verdict: data.verdict ?? '',
      status: data.status ?? 'unknown',
      label: data.label ?? '',
      compact: Boolean(data.compact),
    });
  }

  render() {
    const { value, grade, verdict, status, label, compact } = this.state;
    const safeValue = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
    const filled = safeValue === null ? 0 : (safeValue / 100) * CIRCUMFERENCE;
    const display = safeValue === null ? '—' : String(Math.round(safeValue));

    this.html(`
      <svg class="gauge gauge--${status || 'unknown'}${compact ? ' gauge--compact' : ''}${filled > 0.5 ? '' : ' gauge--empty'}" viewBox="0 0 100 100" role="img"
           aria-label="Health score ${escapeHtml(display)} out of 100">
        <circle class="gauge__track" cx="50" cy="50" r="${RADIUS}" />
        ${filled > 0.5 ? `<circle class="gauge__fill" cx="50" cy="50" r="${RADIUS}"
                stroke-dasharray="${filled.toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}"
                transform="rotate(-90 50 50)" />` : ''}
        ${compact ? '' : `<text class="gauge__value" x="50" y="46" text-anchor="middle" dominant-baseline="central">${escapeHtml(display)}</text>`}
        ${compact || !grade ? '' : `<text class="gauge__grade" x="50" y="66" text-anchor="middle">${escapeHtml(grade)}</text>`}
        ${label || verdict ? `<title>${escapeHtml(label || verdict)}</title>` : ''}
      </svg>
    `);
  }
}

define('sa-gauge', SaGauge);
