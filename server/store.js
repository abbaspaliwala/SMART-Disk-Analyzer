/**
 * Snapshot history store: keeps a rolling window of SMART snapshots per disk
 * in a single JSON file so forecasts survive server restarts.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { mergeHistory } from '../shared/forecast.js';

const STORE_VERSION = 1;

export class HistoryStore {
  /**
   * @param {{file:string, maxPointsPerDevice?:number, minIntervalMs?:number}} options
   */
  constructor({ file, maxPointsPerDevice = 2000, minIntervalMs = 0 } = {}) {
    this.file = file;
    this.maxPointsPerDevice = maxPointsPerDevice;
    this.minIntervalMs = minIntervalMs;
    this.data = { version: STORE_VERSION, updatedAt: null, devices: {} };
    this.loaded = false;
    this.writeChain = Promise.resolve();
  }

  /** Read the store from disk (missing or corrupt files start empty). */
  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.devices && typeof parsed.devices === 'object') {
        this.data = { version: STORE_VERSION, updatedAt: parsed.updatedAt || null, devices: parsed.devices };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[history] could not read ${this.file}: ${error.message} - starting with an empty history`);
      }
    }
    this.loaded = true;
    return this;
  }

  /** Persist atomically (tmp file + rename), serialised through a promise chain. */
  async save() {
    const payload = JSON.stringify({ ...this.data, updatedAt: Date.now() }, null, 1);
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, payload, 'utf8');
      await fs.rename(tmp, this.file);
    }).catch((error) => {
      const hint = error.code === 'EACCES'
        ? ' (owned by root from an earlier "sudo npm start"? fix with: sudo chown $USER data/history.json)'
        : '';
      console.error(`[history] write failed: ${error.message}${hint}`);
    });
    return this.writeChain;
  }

  /** Raw history array for a device key. */
  get(key) {
    return this.data.devices[key]?.history ?? [];
  }

  /** Metadata recorded for a device key. */
  meta(key) {
    const entry = this.data.devices[key];
    if (!entry) return null;
    const { history, ...rest } = entry;
    return { ...rest, points: Array.isArray(history) ? history.length : 0 };
  }

  /** All device keys that have at least one snapshot. */
  keys() {
    return Object.keys(this.data.devices);
  }

  /**
   * Append a snapshot for a device.
   * @returns {Promise<{added:boolean, points:number}>}
   */
  async record(key, snapshot, meta = {}) {
    const entry = this.data.devices[key] || { history: [], firstSeen: snapshot.t };
    const previous = Array.isArray(entry.history) ? entry.history : [];
    const history = mergeHistory(previous, snapshot, {
      minIntervalMs: this.minIntervalMs,
      maxPoints: this.maxPointsPerDevice,
    });
    const added = history.length !== previous.length;
    this.data.devices[key] = {
      ...entry,
      ...meta,
      key,
      firstSeen: entry.firstSeen || snapshot.t,
      lastSeen: added ? snapshot.t : (entry.lastSeen || snapshot.t),
      history,
    };
    if (added) await this.save();
    return { added, points: history.length };
  }

  /** Replace the whole history of one device (used by the demo seeder). */
  setHistory(key, snapshots, meta = {}) {
    this.data.devices[key] = {
      ...(this.data.devices[key] || {}),
      ...meta,
      key,
      firstSeen: snapshots[0]?.t ?? null,
      lastSeen: snapshots[snapshots.length - 1]?.t ?? null,
      history: snapshots.slice(-this.maxPointsPerDevice),
    };
  }

  /** Drop the history of one device. */
  async clear(key) {
    if (!this.data.devices[key]) return false;
    delete this.data.devices[key];
    await this.save();
    return true;
  }

  /** Drop everything. */
  async clearAll() {
    this.data.devices = {};
    await this.save();
  }

  /** Compact summary used by the status endpoint. */
  summary() {
    const keys = this.keys();
    const points = keys.reduce((sum, key) => sum + this.get(key).length, 0);
    return { devices: keys.length, points, updatedAt: this.data.updatedAt };
  }
}
