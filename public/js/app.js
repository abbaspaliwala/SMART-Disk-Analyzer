/**
 * Application bootstrap: loads the payload, wires the toolbar buttons and
 * keeps the page chrome (status chips, banner, footer) in sync with state.
 */

import { api } from './api.js';
import { state, setState, subscribe, loadTheme, applyTheme, selectedDisk } from './state.js';
import { formatDateTime } from '/shared/format.js';
import './components/kpi-strip.js';
import './components/disk-list.js';
import './components/detail-view.js';
import './components/toasts.js';
import './components/import-dialog.js';

const dom = {
  hostLine: document.getElementById('host-line'),
  chips: document.getElementById('status-chips'),
  banner: document.getElementById('banner'),
  toasts: document.getElementById('toasts'),
  dialog: document.getElementById('import-dialog'),
  fileInput: document.getElementById('file-import'),
  footerMeta: document.getElementById('footer-meta'),
  refresh: document.getElementById('btn-refresh'),
  capture: document.getElementById('btn-capture'),
  theme: document.getElementById('btn-theme'),
};

/** Show a toast notification. */
function notify(type, message) {
  dom.toasts?.push({ type, message });
}

/** Live disks plus anything imported in this session. */
function composeDisks(payloadDisks) {
  return [...(payloadDisks || []), ...(state.imported || [])];
}

/** Fetch the dashboard payload. */
async function load({ force = false, quiet = false } = {}) {
  setState({ loading: !state.payload, refreshing: true });
  try {
    const payload = await api.getDisks(force);
    const disks = composeDisks(payload.disks);
    const stillThere = disks.some((disk) => disk.key === state.selectedKey);
    setState({
      payload,
      disks,
      status: payload.status,
      summary: payload.summary,
      loading: false,
      refreshing: false,
      error: null,
      selectedKey: stillThere ? state.selectedKey : (disks[0]?.key ?? null),
    });
    renderChrome();
    if (!quiet) {
      const readable = disks.filter((disk) => disk.smartAvailable).length;
      notify('ok', `Scanned ${disks.length} device${disks.length === 1 ? '' : 's'} · ${readable} with SMART data`);
    }
  } catch (error) {
    setState({ loading: false, refreshing: false, error: error.message });
    renderChrome();
    notify('error', error.message);
  }
}

/** Store a snapshot for every readable disk. */
async function capture() {
  dom.capture.disabled = true;
  try {
    const result = await api.capture();
    setState({
      disks: composeDisks(result.disks),
      summary: result.summary,
      payload: state.payload ? { ...state.payload, disks: result.disks, summary: result.summary } : state.payload,
      refreshing: false,
    });
    renderChrome();
    const captured = (result.captured || []).length;
    notify(captured ? 'ok' : 'info', captured
      ? `Captured ${captured} snapshot${captured === 1 ? '' : 's'} · ${result.history?.points ?? 0} total points stored`
      : 'Nothing captured - no disk reported SMART data (root required).');
  } catch (error) {
    notify('error', error.message);
  } finally {
    dom.capture.disabled = false;
  }
}

/** Add imported drives to the session and select the first one. */
function handleImported(disks) {
  const stamped = disks.map((disk, index) => ({ ...disk, key: `import-${Date.now()}-${index}` }));
  setState({ imported: [...(state.imported || []), ...stamped], selectedKey: stamped[0]?.key ?? state.selectedKey });
  setState({ disks: composeDisks(state.payload?.disks) });
  notify('ok', `Analysed ${stamped.length} imported drive${stamped.length === 1 ? '' : 's'} locally`);
}
/** Status chips, warning banner and footer text. */
function renderChrome() {
  const { status, disks, payload, error, loading, refreshing } = state;

  if (dom.hostLine) {
    dom.hostLine.textContent = status?.host
      ? `${status.host.hostname} · ${status.host.platform} · smartctl ${status.smartctl?.version || 'n/a'}`
      : (loading ? 'connecting…' : (error ? 'backend unreachable' : 'ready'));
  }

  if (dom.chips) {
    const items = [];
    if (status) {
      items.push(`<span class="pill pill--${status.mode === 'demo' ? 'info' : 'ok'}">${status.mode === 'demo' ? 'demo mode' : 'live'}</span>`);
      items.push(`<span class="pill ${status.smartctl?.available ? 'pill--ok' : 'pill--critical'}">smartctl ${status.smartctl?.available ? status.smartctl.version : 'missing'}</span>`);
      const canRead = status.privileges?.canReadSmart;
      items.push(`<span class="pill ${canRead ? 'pill--ok' : 'pill--watch'}">${status.privileges?.isRoot ? 'root' : canRead ? 'unprivileged' : 'no device access'}</span>`);
      if (status.history) items.push(`<span class="pill pill--muted">${status.history.points} snapshots</span>`);
    }
    if (refreshing) items.push('<span class="pill pill--info">scanning…</span>');
    if (payload?.generatedAt) items.push(`<span class="pill pill--muted">updated ${formatDateTime(payload.generatedAt)}</span>`);
    dom.chips.innerHTML = items.join('');
  }

  if (dom.banner) {
    let banner = null;
    if (error) {
      banner = `<strong>Backend error</strong>${error}`;
    } else if (status?.mode === 'live' && status.privileges && !status.privileges.canReadSmart && disks.length) {
      banner = `<strong>SMART data needs root privileges</strong>
        The ${disks.length} detected device${disks.length === 1 ? ' is' : 's are'} locked (<code>Permission denied</code>).
        Restart with <code>sudo npm start</code>, or install the sudoers rule once with
        <code>./bin/setup-sudoers.sh</code> and use <code>npm run elevated</code>.
        Meanwhile you can explore the bundled demo drives with <code>npm run demo</code>, or import a
        <code>smartctl -a -j</code> file with the Import button.`;
    } else if (status?.mode === 'demo') {
      banner = `<strong>Demo mode</strong>Five fixture drives with synthetic 12 week histories, so the dashboard and
        forecast can be explored without root access.`;
    }
    if (banner) {
      dom.banner.innerHTML = `<span>${banner}</span><button class="banner__close" aria-label="Dismiss">✕</button>`;
      dom.banner.hidden = false;
      dom.banner.querySelector('.banner__close')?.addEventListener('click', () => { dom.banner.hidden = true; });
    } else {
      dom.banner.hidden = true;
    }
  }

  if (dom.footerMeta) {
    const parts = [];
    if (status?.nodeVersion) parts.push(`Node ${status.nodeVersion}`);
    if (status?.history) parts.push(`${status.history.devices} tracked drives`);
    if (selectedDisk()) parts.push(selectedDisk().device);
    dom.footerMeta.textContent = parts.join(' · ');
  }

  const current = selectedDisk();
  document.title = current ? `${current.model} · SMART Disk Analyzer` : 'SMART Disk Analyzer';
}
/** Wire the toolbar, shortcuts, drag & drop and start the first scan. */
function wireUi() {
  applyTheme(loadTheme());
  subscribe(() => renderChrome());

  dom.refresh?.addEventListener('click', () => load({ force: true }));
  dom.capture?.addEventListener('click', () => capture());
  dom.theme?.addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));
  dom.fileInput?.addEventListener('change', (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length) dom.dialog.openWithFiles?.(files);
    event.target.value = '';
  });

  // Custom events bubble up from the components.
  document.addEventListener('notify', (event) => notify(event.detail?.type || 'info', event.detail?.message || ''));
  document.addEventListener('refresh', (event) => load({ force: event.detail?.force ?? true }));
  document.addEventListener('imported', (event) => handleImported(event.detail?.disks || []));

  // Drag & drop a smartctl JSON file anywhere on the page.
  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    document.body.classList.add('drop-active');
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('drop-active');
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('drop-active');
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) dom.dialog.openWithFiles?.(files);
  });

  // Keyboard shortcuts (ignored while typing in an input).
  window.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
    if (typing || event.metaKey || event.ctrlKey) return;
    if (event.key === 'r' || event.key === 'R') { load({ force: true }); }
    else if (event.key === 'c' || event.key === 'C') { capture(); }
    else if (event.key === 'i' || event.key === 'I') { dom.dialog.open(); }
    else if (event.key === '?') { notify('info', 'Shortcuts: R rescan · C capture snapshot · I import JSON'); }
  });

  // Optional auto refresh (off by default to keep disks sleeping).
  const autoButton = document.createElement('button');
  autoButton.className = 'btn btn--icon';
  autoButton.title = 'Toggle auto refresh every 60 seconds';
  autoButton.textContent = '⟳60';
  autoButton.addEventListener('click', () => {
    setState({ autoRefresh: !state.autoRefresh });
    autoButton.classList.toggle('btn--primary', state.autoRefresh);
    notify('info', state.autoRefresh ? 'Auto refresh on (60 s)' : 'Auto refresh off');
  });
  dom.theme?.before(autoButton);

  window.setInterval(() => {
    if (state.autoRefresh && !document.hidden) load({ quiet: true });
  }, 60000);
}

wireUi();
load({ quiet: true });


