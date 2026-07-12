'use strict';
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { resolveCodexBin } = require('./codex-bin');

const CLIENT_INFO = { name: 'codex-usage-widget', title: 'Codex Usage Widget', version: '1.0.0' };

/**
 * Persistent JSON-RPC (NDJSON over stdio) connection to `codex app-server`.
 *
 * This is the same protocol the Codex desktop app speaks, so every number we
 * read here is the number the official UI shows. Reading rate limits does not
 * start a thread or a turn, so it never consumes quota.
 */
class AppServerClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.bin = opts.bin || null;
    this.requestTimeoutMs = opts.requestTimeoutMs || 30000;
    this.child = null;
    this.ready = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.stopped = false;
    this.restartDelayMs = 1000;
  }

  async start() {
    if (this.stopped) throw new Error('app-server client stopped');
    if (this.ready) return this.ready;
    // A failed handshake must not be cached, or every later request would reuse
    // the rejected promise and the client would never recover.
    this.ready = this._spawn().catch((err) => {
      this.ready = null;
      if (this.child) {
        this.child.kill();
        this.child = null;
      }
      throw err;
    });
    return this.ready;
  }

  async _spawn() {
    const bin = this.bin || resolveCodexBin();
    this.bin = bin;
    // npm-style installs resolve to a .cmd shim, which Windows cannot exec directly.
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const child = spawn(bin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: needsShell,
    });
    this.child = child;
    this.buf = '';

    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString()));
    // 'error' (spawn failure) fires without 'exit', and 'close' always follows a
    // live child — handling both, guarded, is what makes reconnect reliable.
    child.on('exit', (code, signal) => this._onChildGone(child, `exited code=${code} signal=${signal}`));
    child.on('close', (code, signal) => this._onChildGone(child, `closed code=${code} signal=${signal}`));
    child.on('error', (err) => {
      this.emit('error', err);
      this._onChildGone(child, `spawn error: ${err.message}`);
    });

    const init = await this._request('initialize', { clientInfo: CLIENT_INFO });
    this._notify('initialized', {});
    this.restartDelayMs = 1000;
    this.emit('connected', init);
    return init;
  }

  _rejectPending(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  _onChildGone(child, why) {
    if (child.__gone) return; // exit + close both fire for the same child
    child.__gone = true;

    this._rejectPending(new Error(`codex app-server ${why}`));
    if (this.child === child) {
      this.child = null;
      this.ready = null;
    }
    this.emit('disconnected', { why });
    if (this.stopped) return;

    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(delay * 2, 60000);
    setTimeout(() => {
      if (this.stopped || this.child) return;
      this.start().catch((e) => this.emit('error', e));
    }, delay);
  }

  _onData(chunk) {
    this.buf += chunk.toString();
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method) this.emit('notification', msg.method, msg.params);
  }

  _write(obj) {
    if (!this.child || !this.child.stdin.writable) throw new Error('app-server not running');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  _notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  _request(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._write(msg);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async request(method, params) {
    await this.start();
    return this._request(method, params);
  }

  stop() {
    this.stopped = true;
    if (this.child) this.child.kill();
    this.child = null;
    this.ready = null;
    this._rejectPending(new Error('app-server client stopped'));
  }
}

module.exports = { AppServerClient };
