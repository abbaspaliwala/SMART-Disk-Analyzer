/**
 * Small formatting helpers shared by the Node backend and the browser GUI.
 * Pure functions only - no Node or DOM APIs - so this file runs in both places.
 */

const KIB = 1024;
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];

/** Clamp a number into [min, max]. */
export function clamp(value, min, max) {
  if (Number.isNaN(value) || value === null || value === undefined) return min;
  return Math.min(max, Math.max(min, value));
}

/** Round to a fixed number of decimals without producing -0. */
export function round(value, decimals = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** True when the value is a usable finite number. */
export function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Human readable byte size (1000-based style suffix, 1024-based math). */
export function formatBytes(bytes, decimals = 1) {
  if (!isNum(bytes) || bytes < 0) return '—';
  if (bytes < KIB) return `${Math.round(bytes)} B`;
  let index = 0;
  let value = bytes;
  while (value >= KIB && index < UNITS.length - 1) {
    value /= KIB;
    index += 1;
  }
  const digits = value >= 100 ? 0 : decimals;
  return `${round(value, digits)} ${UNITS[index]}`;
}

/** Thousand separated integer. */
export function formatNumber(value) {
  if (!isNum(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

/** Human readable power-on time, e.g. "3y 42d" or "812 h". */
export function formatHours(hours) {
  if (!isNum(hours) || hours < 0) return '—';
  if (hours < 48) return `${round(hours, 1)} h`;
  const days = hours / 24;
  if (days < 60) return `${round(days, 1)} d`;
  const years = Math.floor(days / 365);
  const remDays = Math.round(days - years * 365);
  return remDays > 0 ? `${years}y ${remDays}d` : `${years}y`;
}

/** "1,234 days" style duration from a day count. */
export function formatDays(days) {
  if (!isNum(days)) return '—';
  if (days <= 0) return '0 d';
  if (days < 1) return '< 1 d';
  if (days < 60) return `${round(days, 1)} d`;
  const years = days / 365;
  if (years < 1) return `${round(days / 30.44, 1)} mo`;
  return `${round(years, 1)} yr`;
}

/** ISO date (YYYY-MM-DD) from epoch milliseconds. */
export function formatDate(ms) {
  if (!isNum(ms)) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

/** Date + time stamp for table cells. */
export function formatDateTime(ms) {
  if (!isNum(ms)) return '—';
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** Relative day offset from today, e.g. "in 2.3 yr". */
export function formatFutureDays(days) {
  if (!isNum(days)) return '—';
  if (days <= 0) return 'now';
  return `in ${formatDays(days)}`;
}

/** Signed percentage, e.g. "+2.4%/mo". */
export function formatRate(value, unitSuffix = '%', decimals = 2) {
  if (!isNum(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${round(value, decimals)}${unitSuffix}`;
}

/** Percentage of a 0-100 scale. */
export function formatPercent(value, decimals = 1) {
  if (!isNum(value)) return '—';
  return `${round(value, decimals)}%`;
}

/** Escape a string for safe insertion into HTML templates. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** Simple slug used for DOM ids and object keys. */
export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'unknown';
}

/** Median of a numeric list (used by trend math). */
export function median(values) {
  const nums = values.filter(isNum).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}
