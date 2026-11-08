/**
 * Application state container: a plain object plus a subscriber list.
 * Components subscribe instead of being wired together individually.
 */

const listeners = new Set();

export const state = {
  payload: null,
  disks: [],
  status: null,
  summary: null,
  selectedKey: null,
  loading: true,
  refreshing: false,
  error: null,
  tab: 'overview',
  autoRefresh: false,
  theme: 'dark',
  imported: [],
};

/** Notify every subscriber about a state change. */
export function setState(patch) {
  Object.assign(state, patch);
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (error) {
      console.error('[state] subscriber failed', error);
    }
  }
}

/** Subscribe to state changes; returns an unsubscribe function. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The currently selected disk object (or the first disk as a fallback). */
export function selectedDisk() {
  if (!state.disks.length) return null;
  return state.disks.find((disk) => disk.key === state.selectedKey) || state.disks[0];
}

/** Select a disk by key and put the detail view back on the overview tab. */
export function selectDisk(key) {
  setState({ selectedKey: key, tab: 'overview' });
}

/** Read the persisted theme preference. */
export function loadTheme() {
  try {
    const saved = localStorage.getItem('smart-analyzer-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* localStorage can be unavailable - fall through to the default */
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Persist and apply the theme. */
export function applyTheme(theme) {
  const root = document.documentElement;
  // Suppress transitions for one frame so switching themes is instant instead
  // of fading every colour-animated control.
  root.classList.add('theme-switching');
  root.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('smart-analyzer-theme', theme);
  } catch {
    /* ignore storage failures */
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => root.classList.remove('theme-switching'));
  });
  setState({ theme });
}
