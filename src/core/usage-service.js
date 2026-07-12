'use strict';
const { EventEmitter } = require('events');
const { AppServerClient } = require('./app-server-client');
const { normalizeSnapshot, snapshotFingerprint } = require('./model');
const { TokenUsage } = require('./token-usage');
const { Store } = require('./store');

const RATE_LIMITS_READ = 'account/rateLimits/read';
const RATE_LIMITS_UPDATED = 'account/rateLimits/updated';
const ACCOUNT_READ = 'account/read';

function safeFingerprint(snapshot) {
  if (!snapshot?.buckets) return null;
  try {
    return snapshotFingerprint(snapshot);
  } catch {
    return null;
  }
}

/**
 * Keeps a live view of the account's Codex rate limits.
 *
 * Values come straight from `account/rateLimits/read`, the same app-server call
 * the official desktop app makes, so the widget cannot drift from it. Refreshes
 * happen on a timer and whenever the server pushes `account/rateLimits/updated`
 * (which it does as turns consume quota).
 */
class UsageService extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.pollMs = opts.pollMs ?? 60000;
    this.client = new AppServerClient({ bin: opts.bin });
    this.store = opts.store || new Store(opts.dataDir);
    // Seed from the last persisted snapshot so short-lived processes (`once`)
    // do not re-append an unchanged row to the history file.
    this.snapshot = this.store.readState();
    this.account = null;
    this.lastFingerprint = safeFingerprint(this.snapshot);
    this.timer = null;
    this.pushDebounce = null;
    this.refreshing = null;
    this.dirty = false;
    this.lastError = null;

    this.recordHistory = opts.recordHistory ?? true;
    // Token usage is a separate, slower-moving official feed (daily buckets).
    this.tokens = new TokenUsage(this.client);
    this.tokensTimer = null;

    this.client.on('notification', (method) => {
      if (method === RATE_LIMITS_UPDATED) this._onPush();
    });
    this.client.on('disconnected', (info) => {
      // The account is cached for the life of the connection; if Codex restarted
      // because the user signed in as someone else, re-read it rather than pin
      // the old email onto the new numbers.
      this.account = null;
      this.emit('status', { state: 'disconnected', ...info });
    });
    this.client.on('connected', () => this.emit('status', { state: 'connected' }));
    this.client.on('error', (err) => {
      this.lastError = err.message;
      this.emit('service-error', err);
    });
  }

  async start() {
    if (this.snapshot) {
      this.snapshot.cached = true; // not yet re-read from app-server in this process
      this.emit('snapshot', this.snapshot);
    }
    // A failed first read (Codex logged out, app-server slow to boot) must not
    // stop the poll loop from starting — the next tick can recover.
    await this.refresh().catch(() => {});
    this.timer = setInterval(() => {
      this.refresh().catch(() => {});
    }, this.pollMs);
    return this.snapshot;
  }

  _onPush() {
    // Pushes are sparse rolling updates; refetch the authoritative snapshot.
    if (this.pushDebounce) return;
    this.pushDebounce = setTimeout(() => {
      this.pushDebounce = null;
      this.refresh().catch(() => {});
    }, 800);
  }

  /**
   * Coalesces concurrent callers onto one in-flight read, but a request that
   * arrives mid-flight (notably a push saying quota just changed) would be
   * answered with data fetched before it — so mark the result dirty and re-read.
   */
  async refresh() {
    if (this.refreshing) {
      this.dirty = true;
      return this.refreshing;
    }
    this.refreshing = this._refresh().finally(() => {
      this.refreshing = null;
      if (this.dirty) {
        this.dirty = false;
        this.refresh().catch(() => {});
      }
    });
    return this.refreshing;
  }

  async _refresh() {
    let snap;
    try {
      if (!this.account) {
        this.account = await this.client
          .request(ACCOUNT_READ, { refreshToken: false })
          .then((r) => r?.account ?? null)
          .catch(() => null);
      }
      const raw = await this.client.request(RATE_LIMITS_READ);
      snap = normalizeSnapshot(raw, this.account, Date.now());
      if (process.env.CODEX_USAGE_KEEP_RAW) snap.raw = raw;
      this.lastError = null;
      this.snapshot = snap;
    } catch (err) {
      this.lastError = err.message;
      this.emit('service-error', err);
      throw err;
    }

    // Persistence is a cache, never a gate: a failed disk write must not discard
    // a snapshot we successfully read.
    try {
      const fp = snapshotFingerprint(snap);
      this.store.writeState(snap);
      if (fp !== this.lastFingerprint) {
        this.lastFingerprint = fp;
        if (this.recordHistory) this.store.appendHistory(snap);
      }
    } catch (err) {
      this.emit('service-error', err);
    }

    this.emit('snapshot', snap);
    return snap;
  }

  getState() {
    return {
      snapshot: this.snapshot,
      lastError: this.lastError,
      pollMs: this.pollMs,
    };
  }

  /**
   * Start following token usage. It only changes once a turn finishes, so a
   * 10-minute cadence is plenty — and it is only started when someone asks.
   */
  async startTokenUsage(everyMs = 600000) {
    if (this.tokensTimer) return this.tokens.state();
    const tick = () => this.tokens.refresh().then(() => this.emit('tokens', this.tokens.state())).catch(() => {});
    await tick();
    // A build without the method will never grow one: stop asking.
    if (this.tokens.supported === false) return this.tokens.state();
    this.tokensTimer = setInterval(tick, everyMs);
    return this.tokens.state();
  }

  stopTokenUsage() {
    if (this.tokensTimer) clearInterval(this.tokensTimer);
    this.tokensTimer = null;
  }

  /** Change the poll cadence without restarting the app-server connection. */
  setPollMs(pollMs) {
    const ms = Math.max(15000, Math.min(3600000, Number(pollMs) || 60000));
    if (ms === this.pollMs) return this.pollMs;
    this.pollMs = ms;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => {
        this.refresh().catch(() => {});
      }, ms);
    }
    return ms;
  }

  /** Wiping history must also clear the fingerprint, or the next poll records nothing. */
  clearHistory() {
    this.store.clearHistory();
    this.lastFingerprint = null;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.pushDebounce) clearTimeout(this.pushDebounce);
    this.timer = null;
    this.stopTokenUsage();
    this.client.stop();
  }
}

module.exports = { UsageService, RATE_LIMITS_READ };
