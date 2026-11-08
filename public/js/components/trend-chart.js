/**
 * <sa-trend-chart> - canvas line chart used for the SMART history trends.
 *
 * setData({ series: [{ label, color, points: [{x: epochMs, y}], zeroBased }],
 *           format: (value) => string, height })
 */

import { BaseElement, define, escapeHtml } from '../base.js';
import { formatDateTime } from '/shared/format.js';

const PAD = { top: 14, right: 14, bottom: 24, left: 54 };

export class SaTrendChart extends BaseElement {
  onConnect() {
    this.on(window, 'resize', () => this.draw());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._observer?.disconnect();
  }

  setData(data = {}) {
    this.setState({
      series: (data.series || []).filter((series) => series.points?.length),
      height: data.height || 280,
      format: data.format || ((value) => String(Math.round(value * 100) / 100)),
      emptyText: data.emptyText || 'No snapshots captured yet',
    });
  }

  render() {
    const { height, emptyText, series } = this.state;
    if (!series?.length) {
      this.html(`<div class="empty"><strong>Nothing to plot</strong>${escapeHtml(emptyText)}</div>`);
      return;
    }
    this.html(`
      <div class="chart-shell">
        <div class="chart-legend">
          ${series.map((entry) => `<span><i style="background:${escapeHtml(entry.color)}"></i>${escapeHtml(entry.label)}</span>`).join('')}
        </div>
        <canvas class="chart-canvas" style="height:${height}px"></canvas>
        <div class="chart-tooltip"></div>
      </div>
    `);
    this._canvas = this.q('canvas');
    this._tooltip = this.q('.chart-tooltip');
    this.on(this._canvas, 'mousemove', (event) => this.handleMove(event));
    this.on(this._canvas, 'mouseleave', () => {
      this._hoverX = null;
      this._tooltip?.classList.remove('is-visible');
      this.draw();
    });
    this._observer?.disconnect();
    if (typeof ResizeObserver === 'function') {
      this._observer = new ResizeObserver(() => this.draw());
      this._observer.observe(this._canvas);
    }
    this.draw();
  }

  /** Nearest data point for the pointer position, plus the shared timestamp. */
  handleMove(event) {
    if (!this._geometry) return;
    const rect = this._canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    let nearest = null;
    for (const series of this.state.series) {
      for (const point of series.points) {
        const px = this._geometry.x(point.x);
        const distance = Math.abs(px - mouseX);
        if (!nearest || distance < nearest.distance) nearest = { distance, point, px };
      }
    }
    if (!nearest || nearest.distance > 40) {
      this._hoverX = null;
      this._tooltip?.classList.remove('is-visible');
      this.draw();
      return;
    }
    this._hoverX = nearest.point.x;
    this.draw();
    if (this._tooltip) {
      const rows = this.state.series
        .map((series) => {
          const match = series.points.find((point) => point.x === nearest.point.x);
          return match ? `${escapeHtml(series.label)}: ${escapeHtml(this.state.format(match.y))}` : null;
        })
        .filter(Boolean);
      this._tooltip.innerHTML = `<div>${escapeHtml(formatDateTime(nearest.point.x))}</div>${rows.map((row) => `<div>${row}</div>`).join('')}`;
      this._tooltip.style.left = `${nearest.px}px`;
      this._tooltip.style.top = `${PAD.top + 12}px`;
      this._tooltip.classList.add('is-visible');
    }
  }

  draw() {
    const canvas = this._canvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const css = getComputedStyle(document.documentElement);
    const colorOf = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
    const gridColor = colorOf('--border-soft', '#1a263c');
    const textColor = colorOf('--text-faint', '#6d7f9e');

    const { series, format } = this.state;
    const all = series.flatMap((entry) => entry.points);
    if (!all.length) return;

    const xs = all.map((point) => point.x);
    const ys = all.map((point) => point.y);
    let xMin = Math.min(...xs);
    let xMax = Math.max(...xs);
    if (xMin === xMax) {
      xMin -= 86400000;
      xMax += 86400000;
    }
    let yMin = Math.min(...ys);
    let yMax = Math.max(...ys);
    if (series.every((entry) => entry.zeroBased !== false) && yMin >= 0) yMin = 0;
    if (yMin === yMax) {
      yMin -= 1;
      yMax += 1;
    }
    const span = yMax - yMin;
    yMin -= span * 0.08;
    yMax += span * 0.12;

    const plotW = rect.width - PAD.left - PAD.right;
    const plotH = rect.height - PAD.top - PAD.bottom;
    const x = (value) => PAD.left + ((value - xMin) / (xMax - xMin)) * plotW;
    const y = (value) => PAD.top + plotH - ((value - yMin) / (yMax - yMin)) * plotH;
    this._geometry = { x, y };

    // horizontal grid + y labels
    ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
    ctx.fillStyle = textColor;
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    const ticks = 4;
    for (let i = 0; i <= ticks; i += 1) {
      const value = yMin + ((yMax - yMin) * i) / ticks;
      const py = Math.round(y(value)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.left, py);
      ctx.lineTo(PAD.left + plotW, py);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(format(value), PAD.left - 8, py);
    }

    // x labels: first / middle / last
    ctx.textBaseline = 'top';
    [xMin, (xMin + xMax) / 2, xMax].forEach((value, index) => {
      const label = new Date(value).toISOString().slice(5, 10);
      const px = x(value);
      ctx.textAlign = index === 0 ? 'left' : index === 2 ? 'right' : 'center';
      ctx.fillText(label, index === 0 ? PAD.left : index === 2 ? PAD.left + plotW : px, rect.height - PAD.bottom + 7);
    });

    // series lines, areas and dots
    for (const entry of series) {
      const stroke = entry.color;
      const points = entry.points;
      ctx.lineWidth = 2;
      ctx.strokeStyle = stroke;
      ctx.beginPath();
      points.forEach((point, index) => {
        const px = x(point.x);
        const py = y(point.y);
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      if (entry.area !== false) {
        const gradient = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + plotH);
        gradient.addColorStop(0, `${stroke}38`);
        gradient.addColorStop(1, `${stroke}00`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(x(points[0].x), y(yMin));
        points.forEach((point) => ctx.lineTo(x(point.x), y(point.y)));
        ctx.lineTo(x(points[points.length - 1].x), y(yMin));
        ctx.closePath();
        ctx.fill();
      }

      if (points.length <= 30) {
        ctx.fillStyle = stroke;
        points.forEach((point) => {
          ctx.beginPath();
          ctx.arc(x(point.x), y(point.y), 2.6, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }

    // hover crosshair
    if (this._hoverX !== null && this._hoverX !== undefined) {
      const px = x(this._hoverX);
      ctx.save();
      ctx.strokeStyle = colorOf('--accent', '#38bdf8');
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px, PAD.top);
      ctx.lineTo(px, PAD.top + plotH);
      ctx.stroke();
      ctx.restore();
      for (const entry of series) {
        const point = entry.points.find((candidate) => candidate.x === this._hoverX);
        if (!point) continue;
        ctx.fillStyle = entry.color;
        ctx.beginPath();
        ctx.arc(x(point.x), y(point.y), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = colorOf('--panel', '#111a2b');
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }
}

define('sa-trend-chart', SaTrendChart);

