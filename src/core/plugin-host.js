'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const MAX_ROWS = 8;
const FETCH_TIMEOUT_MS = 20000;
const MIN_REFRESH_MS = 10000;

/**
 * Runs widget plugins.
 *
 * A plugin is a folder with `plugin.json` plus an entry module exporting
 * `fetch(ctx)`. It runs in the main process (so it can do network I/O) but it
 * can only return structured rows — never markup. The widget draws those rows
 * itself, so a plugin can neither break the layout nor reach the renderer.
 */
class PluginHost extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.dirs = opts.dirs || [];
    this.getSettings = opts.getSettings || (() => ({}));
    // Electron's net.fetch follows the OS proxy (and PAC) settings; plain fetch
    // does not, which would break every plugin on a proxied machine.
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.plugins = new Map(); // id -> entry
    this.timers = new Set(); // every live timer, so stop() can never miss one
  }

  discover() {
    const found = [];
    for (const dir of this.dirs) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        found.push(this._readManifest(path.join(dir, e.name)));
      }
    }
    return found.filter(Boolean);
  }

  /** Returns { manifest, dir, error } — a broken folder stays visible with its error. */
  _readManifest(dir) {
    const folder = path.basename(dir);
    const file = path.join(dir, 'plugin.json');
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return null; // not a plugin folder at all
    }

    try {
      const m = JSON.parse(raw);
      if (!m.id || typeof m.id !== 'string') throw new Error('manifest needs an "id"');
      if (typeof m.entry === 'string' && (path.isAbsolute(m.entry) || m.entry.includes('..'))) {
        throw new Error('"entry" must stay inside the plugin folder');
      }
      return {
        dir,
        error: null,
        manifest: {
          id: m.id,
          name: typeof m.name === 'string' ? m.name : m.id,
          icon: typeof m.icon === 'string' ? m.icon.slice(0, 4) : '',
          description: typeof m.description === 'string' ? m.description : '',
          refreshMs: Math.max(MIN_REFRESH_MS, Number(m.refreshMs) || 900000),
          entry: typeof m.entry === 'string' ? m.entry : 'index.js',
          config: m.config && typeof m.config === 'object' ? m.config : {},
          enabledByDefault: m.enabledByDefault !== false,
        },
      };
    } catch (err) {
      return {
        dir,
        error: `bad plugin.json: ${err.message}`,
        manifest: {
          id: `broken:${folder}`,
          name: folder,
          icon: '⚠',
          description: '',
          refreshMs: MIN_REFRESH_MS,
          entry: 'index.js',
          config: {},
          enabledByDefault: false,
        },
      };
    }
  }

  settingsFor(manifest) {
    const saved = this.getSettings()[manifest.id] || {};
    return {
      enabled: saved.enabled ?? manifest.enabledByDefault,
      config: { ...manifest.config, ...(saved.config || {}) },
    };
  }

  /** Drop the plugin's whole module subtree from the cache, so a reload picks up helper files too. */
  _purgeRequireCache(dir) {
    const root = path.resolve(dir);
    for (const key of Object.keys(require.cache)) {
      const rel = path.relative(root, key);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) delete require.cache[key];
    }
  }

  /** (Re)load every plugin from disk and restart their refresh loops. */
  load() {
    this.stop();
    this.plugins.clear();

    for (const { manifest, dir, error } of this.discover()) {
      if (this.plugins.has(manifest.id)) {
        this.emit('plugin-error', { dir, message: `duplicate plugin id "${manifest.id}" — folder ignored` });
        continue;
      }

      let mod = null;
      let loadError = error;
      if (!loadError) {
        try {
          this._purgeRequireCache(dir);
          mod = require(path.join(dir, manifest.entry));
          if (typeof mod?.fetch !== 'function') throw new Error('entry must export a fetch(ctx) function');
        } catch (err) {
          loadError = err.message;
        }
      }

      const state = this.settingsFor(manifest);
      const entry = {
        manifest,
        dir,
        mod,
        timer: null,
        seq: 0, // guards against a slow run overwriting a newer result
        running: false,
        panel: {
          id: manifest.id,
          name: manifest.name,
          icon: manifest.icon,
          rows: [],
          error: loadError,
          updatedAt: null,
          loading: !loadError && state.enabled,
        },
      };
      this.plugins.set(manifest.id, entry);

      if (state.enabled && !loadError) this._schedule(entry);
    }

    this.emit('panels', this.panels());
    return this.list();
  }

  _schedule(entry) {
    this._clearTimer(entry);
    entry.panel = { ...entry.panel, error: null, loading: true };
    this.run(entry.manifest.id).catch(() => {});
    entry.timer = setInterval(() => {
      this.run(entry.manifest.id).catch(() => {});
    }, entry.manifest.refreshMs);
    this.timers.add(entry.timer);
  }

  _clearTimer(entry) {
    if (!entry.timer) return;
    clearInterval(entry.timer);
    this.timers.delete(entry.timer);
    entry.timer = null;
  }

  async run(id) {
    const entry = this.plugins.get(id);
    if (!entry || !entry.mod || entry.running) return; // never overlap runs of one plugin
    entry.running = true;

    const seq = ++entry.seq;
    const { config } = this.settingsFor(entry.manifest);
    const ctx = {
      config,
      log: (...args) => this.emit('plugin-log', { id, args }),
      fetchJson: (url, opts) => httpJson(this.fetchImpl, url, opts),
      fetchText: (url, opts) => httpText(this.fetchImpl, url, opts),
    };

    try {
      const result = await withTimeout(entry.mod.fetch(ctx), FETCH_TIMEOUT_MS, `${id}: fetch timed out`);
      if (seq !== entry.seq) return; // a newer run already answered
      entry.panel = {
        ...entry.panel,
        ...normalizePanel(result, entry.manifest),
        error: null,
        loading: false,
        updatedAt: Date.now(),
      };
    } catch (err) {
      if (seq !== entry.seq) return;
      entry.panel = { ...entry.panel, error: err.message, loading: false, updatedAt: Date.now() };
    } finally {
      entry.running = false;
    }
    this.emit('panels', this.panels());
  }

  /** Panels for the enabled plugins, in manifest order. */
  panels() {
    const out = [];
    for (const entry of this.plugins.values()) {
      if (!this.settingsFor(entry.manifest).enabled) continue;
      out.push(entry.panel);
    }
    return out;
  }

  /** Everything discovered, enabled or not — this is what the settings window lists. */
  list() {
    return [...this.plugins.values()].map((e) => ({
      ...e.manifest,
      dir: e.dir,
      ...this.settingsFor(e.manifest),
      error: e.panel.error,
    }));
  }

  /** Apply a settings change (enable/disable or config edit) for one plugin. */
  apply(id) {
    const entry = this.plugins.get(id);
    if (!entry) return;
    const { enabled } = this.settingsFor(entry.manifest);
    this._clearTimer(entry);
    entry.seq++; // discard whatever the previous configuration is still fetching

    if (enabled && entry.mod) this._schedule(entry);
    this.emit('panels', this.panels());
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    for (const entry of this.plugins.values()) entry.timer = null;
  }
}

const TONES = new Set(['ok', 'warn', 'crit', 'muted', 'default']);

function str(v, max = 64) {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Plugins are untrusted input: keep the shape, drop everything else. */
function normalizePanel(result, manifest) {
  const raw = Array.isArray(result) ? { rows: result } : result || {};
  const rows = Array.isArray(raw.rows) ? raw.rows.slice(0, MAX_ROWS) : [];
  return {
    id: manifest.id,
    name: str(raw.title, 32) || manifest.name,
    icon: str(raw.icon, 4) || manifest.icon,
    subtitle: str(raw.subtitle, 48),
    rows: rows.map((r) => ({
      label: str(r?.label, 40),
      value: str(r?.value, 24),
      sub: str(r?.sub, 64),
      tone: TONES.has(r?.tone) ? r.tone : 'default',
      progress:
        r?.progress == null || !Number.isFinite(Number(r.progress))
          ? null
          : Math.max(0, Math.min(100, Number(r.progress))),
    })),
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

async function httpText(fetchImpl, url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 15000);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'codex-usage-widget', ...(opts.headers || {}) },
      method: opts.method || 'GET',
      body: opts.body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function httpJson(fetchImpl, url, opts) {
  return JSON.parse(await httpText(fetchImpl, url, opts));
}

module.exports = { PluginHost, normalizePanel };
