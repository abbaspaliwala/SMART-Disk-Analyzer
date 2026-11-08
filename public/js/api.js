/**
 * REST client for the local analyzer backend.
 * Every method either resolves with parsed JSON or throws an Error whose
 * message is safe to show in a toast.
 */

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      ...options,
    });
  } catch (error) {
    throw new Error(`Cannot reach the analyzer backend (${error.message}). Is "npm start" still running?`);
  }

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 400) };
    }
  }

  if (!response.ok) {
    throw new Error(body?.error || `Request failed with HTTP ${response.status}`);
  }
  return body;
}

export const api = {
  /** Full dashboard payload (all disks with attributes, health and forecast). */
  getDisks(refresh = false) {
    return request(`/api/disks${refresh ? '?refresh=1' : ''}`);
  },

  /** Lightweight status snapshot. */
  getStatus() {
    return request('/api/status');
  },

  /** Store a SMART snapshot for every readable disk. */
  capture() {
    return request('/api/capture', { method: 'POST' });
  },

  /** Snapshot history for one disk. */
  getHistory(key) {
    return request(`/api/history/${encodeURIComponent(key)}`);
  },

  /** Forget the snapshot history of one disk. */
  clearHistory(key) {
    return request(`/api/history/${encodeURIComponent(key)}`, { method: 'DELETE' });
  },

  /** Analyse smartctl JSON produced elsewhere. */
  importJson(payload) {
    return request('/api/import', { method: 'POST', body: JSON.stringify(payload) });
  },

  /** URL that streams the raw smartctl JSON of one disk. */
  downloadUrl(key) {
    return `/api/download/${encodeURIComponent(key)}`;
  },
};
