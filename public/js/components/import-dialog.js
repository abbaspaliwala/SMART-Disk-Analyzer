/**
 * <sa-import-dialog> - analyse smartctl JSON from another machine.
 *
 * The parsing, normalisation and forecasting all happen in the browser using
 * the same shared modules the backend uses, so an imported drive gets exactly
 * the same health score and forecast as a locally scanned one.
 */

import { BaseElement, define, escapeHtml } from '../base.js';
import { normalizeMany } from '/shared/normalize.js';
import { enrichDevice } from '/shared/forecast.js';

export class SaImportDialog extends BaseElement {
  constructor() {
    super();
    this.state = { open: false, files: [], text: '' };
  }

  onConnect() {
    this.on(this, 'click', (event) => {
      if (event.target.closest('[data-close]')) this.close();
      if (event.target.closest('[data-analyze]')) this.analyse();
    });
    this.on(this, 'dragover', (event) => {
      if (!this.state.open) return;
      event.preventDefault();
      this.q('#drop-zone')?.classList.add('drop-active');
    });
    this.on(this, 'dragleave', () => this.q('#drop-zone')?.classList.remove('drop-active'));
    this.on(this, 'drop', (event) => {
      if (!this.state.open) return;
      event.preventDefault();
      this.q('#drop-zone')?.classList.remove('drop-active');
      this.readFiles(event.dataTransfer?.files);
    });
    this.on(this, 'change', (event) => {
      if (event.target.id === 'import-files') this.readFiles(event.target.files);
    });
  }

  /** Open with an optional pre-filled payload (used by the drag & drop of the page). */
  open(prefill) {
    this.state.open = true;
    this.state.files = [];
    this.state.text = prefill || '';
    this.render();
    this.show();
  }

  /** Open and immediately load the given File objects. */
  async openWithFiles(fileList) {
    this.state.open = true;
    await this.readFiles(fileList);
  }

  show() {
    const dialog = this.q('dialog');
    if (dialog && !dialog.open) dialog.showModal();
  }

  close() {
    this.state.open = false;
    this.q('dialog')?.close();
  }

  async readFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const texts = await Promise.all(files.map((file) => file.text()));
    this.state.open = true;
    this.state.files = files.map((file) => file.name);
    this.state.text = texts.join('\n');
    this.render();
    this.show();
  }

  /** Parse whatever the user supplied and hand the devices to the app. */
  analyse() {
    const raw = this.state.text.trim();
    if (!raw) {
      this.emit('notify', { type: 'error', message: 'Nothing to import yet - drop a file or paste smartctl JSON first.' });
      return;
    }

    let parsed;
    try {
      const trimmed = raw.startsWith('{') || raw.startsWith('[') ? raw : raw.slice(raw.indexOf('{'));
      parsed = JSON.parse(trimmed);
    } catch (error) {
      this.emit('notify', { type: 'error', message: `That is not valid JSON: ${error.message}` });
      return;
    }

    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.disks) ? parsed.disks : [parsed]);
    let devices;
    try {
      devices = normalizeMany(list, { mode: 'import' });
    } catch (error) {
      this.emit('notify', { type: 'error', message: `Could not read that smartctl data: ${error.message}` });
      return;
    }

    const analysed = devices.map((device) => {
      const enriched = enrichDevice(device, [], {});
      return { ...enriched, history: [], mode: 'import', importedAt: Date.now() };
    }).filter((device) => device.parameterCount > 0 || device.smartAvailable);

    if (!analysed.length) {
      this.emit('notify', { type: 'error', message: 'No SMART parameters found in that file.' });
      return;
    }

    this.emit('imported', { disks: analysed });
    this.close();
  }

  render() {
    if (!this.state.open) {
      this.html('');
      return;
    }
    this.html(`
      <dialog class="modal">
        <div class="modal__head">
          <h3>Import smartctl JSON</h3>
          <span style="flex:1"></span>
          <button class="btn btn--icon" data-close aria-label="Close">✕</button>
        </div>
        <div class="modal__body">
          <p class="hint">
            On any machine run <code>sudo smartctl -a -j /dev/sdX &gt; disk.json</code> (or <code>--scan -j</code> for all
            devices) and drop the file here. Nothing leaves your browser — the same analysis code runs locally.
          </p>
          <label id="drop-zone" class="empty" style="border:1px dashed var(--border);border-radius:12px;cursor:pointer">
            <strong>Drop .json files here</strong>
            or click to choose files
            <input id="import-files" type="file" accept=".json,application/json" multiple hidden />
          </label>
          <textarea class="input" placeholder='{ "json_format_version": [1, 0], "device": { … } }'
                    aria-label="smartctl JSON">${escapeHtml(this.state.text.slice(0, 400000))}</textarea>
          ${this.state.files.length ? `<p class="hint">Loaded: ${this.state.files.map((name) => escapeHtml(name)).join(', ')}</p>` : ''}
        </div>
        <div class="modal__foot">
          <button class="btn" data-close>Cancel</button>
          <button class="btn btn--primary" data-analyze>Analyse</button>
        </div>
      </dialog>
    `);
    this.on(this.q('#drop-zone'), 'click', (event) => {
      if (event.target.id !== 'import-files') this.q('#import-files')?.click();
    });
    this.q('dialog')?.addEventListener('cancel', () => { this.state.open = false; });
  }
}

define('sa-import-dialog', SaImportDialog);
