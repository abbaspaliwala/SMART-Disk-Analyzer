/**
 * <sa-toasts> - transient notifications in the bottom right corner.
 * Usage: element.push({ type: 'ok'|'error'|'info', message, timeout })
 */

import { BaseElement, define, escapeHtml } from '../base.js';

export class SaToasts extends BaseElement {
  constructor() {
    super();
    this.state = { items: [] };
    this._seq = 0;
  }

  onConnect() {
    this.on(this, 'click', (event) => {
      const button = event.target.closest('[data-toast]');
      if (button) this.dismiss(Number(button.dataset.toast));
    });
  }

  push({ type = 'info', message = '', timeout = 5200 } = {}) {
    const id = (this._seq += 1);
    this.state.items = [...this.state.items, { id, type, message }];
    this.render();
    if (timeout > 0) window.setTimeout(() => this.dismiss(id), timeout);
    return id;
  }

  dismiss(id) {
    this.state.items = this.state.items.filter((item) => item.id !== id);
    this.render();
  }

  render() {
    const { items } = this.state;
    if (!items.length) {
      this.html('');
      return;
    }
    this.html(`<div class="toasts" role="status" aria-live="polite">
      ${items.map((item) => `
        <div class="toast toast--${escapeHtml(item.type)}">
          <span>${item.type === 'ok' ? '✓' : item.type === 'error' ? '⚠' : 'ℹ'}</span>
          <span>${escapeHtml(item.message)}</span>
          <button class="toast__close" data-toast="${item.id}" aria-label="Dismiss">✕</button>
        </div>`).join('')}
    </div>`);
  }
}

define('sa-toasts', SaToasts);
