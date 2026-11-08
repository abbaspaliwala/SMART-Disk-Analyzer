/**
 * Tiny base class for the GUI web components.
 *
 * Components live in the light DOM (so the single stylesheet applies) and
 * re-render on demand. Event listeners registered through `on()` are removed
 * automatically when the element leaves the document.
 */

import { escapeHtml } from '/shared/format.js';

export class BaseElement extends HTMLElement {
  constructor() {
    super();
    this.state = {};
    this._unsubs = [];
    this._bound = [];
    this._isRendered = false;
  }

  connectedCallback() {
    this._isRendered = true;
    if (typeof this.onConnect === 'function') this.onConnect();
    this.render();
  }

  disconnectedCallback() {
    this._unsubs.forEach((unsubscribe) => unsubscribe());
    this._unsubs = [];
    this._bound.forEach(([element, type, handler]) => element.removeEventListener(type, handler));
    this._bound = [];
    this._isRendered = false;
  }

  /** Merge state and re-render. */
  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.update();
  }

  /** Re-render only if the element is attached. */
  update() {
    if (this._isRendered) this.render();
  }

  /** Replace the component markup. */
  html(markup) {
    this.innerHTML = markup;
  }

  /** Register a listener that is cleaned up automatically. */
  on(element, type, handler, options) {
    if (!element) return;
    element.addEventListener(type, handler, options);
    this._bound.push([element, type, handler]);
  }

  /** Shorthand for querySelector / querySelectorAll. */
  q(selector) {
    return this.querySelector(selector);
  }

  qa(selector) {
    return Array.from(this.querySelectorAll(selector));
  }

  /** Emit a bubbling custom event. */
  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  render() {}
}

/** Define a custom element once. */
export function define(name, elementClass) {
  if (!customElements.get(name)) customElements.define(name, elementClass);
}

export { escapeHtml };

/** CSS class for a severity token. */
export function severityClass(severity) {
  return `sev-${severity || 'unknown'}`;
}

/** Badge pill markup for a severity token. */
export function severityPill(severity, label) {
  const text = label || { ok: 'OK', info: 'Info', watch: 'Watch', warning: 'Warning', critical: 'Critical' }[severity] || 'Unknown';
  return `<span class="pill pill--${severity || 'muted'}"><i class="dot"></i>${escapeHtml(text)}</span>`;
}

/** Colour token for a 0-100 health score. */
export function healthStatus(score) {
  if (typeof score !== 'number') return 'unknown';
  if (score >= 85) return 'ok';
  if (score >= 70) return 'watch';
  if (score >= 45) return 'warning';
  return 'critical';
}
