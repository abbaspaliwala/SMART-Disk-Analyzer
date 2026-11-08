/**
 * <sa-risk-list> - the SMART findings that drag the health score down,
 * ordered by severity.
 */

import { BaseElement, define, escapeHtml, severityPill } from '../base.js';

export class SaRiskList extends BaseElement {
  setData({ risks = [], health = null } = {}) {
    this.setState({ risks, health });
  }

  render() {
    const { risks, health } = this.state;
    if (!risks) {
      this.html('<div class="empty">Select a disk.</div>');
      return;
    }
    const header = `
      <div class="card__head">
        <h3>Risk factors</h3>
        <span class="spacer"></span>
        ${health ? `<span class="pill pill--${health.score >= 85 ? 'ok' : health.score >= 70 ? 'watch' : health.score >= 45 ? 'warning' : 'critical'}">
          score ${health.score ?? '—'}/100</span>` : ''}
      </div>`;

    if (!risks.length) {
      this.html(`<div class="card">${header}
        <div class="empty"><strong>No risk factors detected</strong>
        Every reliability parameter is inside its expected range.</div></div>`);
      return;
    }

    this.html(`<div class="card">${header}
      <div class="card__body">
        <div class="risk-list">
          ${risks.map((risk) => `
            <div class="risk risk--${escapeHtml(risk.severity)}">
              <div class="risk__bar"></div>
              <div style="min-width:0">
                <div class="risk__head">
                  <span class="risk__title">${escapeHtml(risk.label)}</span>
                  ${severityPill(risk.severity)}
                  ${risk.attribute ? `<span class="risk__attr">${escapeHtml(risk.attribute)}</span>` : ''}
                </div>
                <div class="risk__detail">${escapeHtml(risk.detail || '')}</div>
              </div>
            </div>`).join('')}
        </div>
      </div>
    </div>`);
  }
}

define('sa-risk-list', SaRiskList);
