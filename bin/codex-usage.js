#!/usr/bin/env node
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { UsageService } = require('../src/core/usage-service');
const { formatDuration } = require('../src/core/model');

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('-')) || 'once';
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

function bar(pct, width = 20) {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, width - filled));
}

function render(snap) {
  const lines = [];
  const acct = snap.account?.email ? ` ${snap.account.email}` : '';
  lines.push(`Codex usage — plan: ${snap.plan ?? 'unknown'}${acct}`);
  for (const b of snap.buckets) {
    lines.push(`\n[${b.name}]`);
    for (const key of ['primary', 'secondary']) {
      const w = b[key];
      if (!w) continue;
      const label = key === 'primary' ? `${w.windowLabel} window` : `${w.windowLabel} window`;
      lines.push(
        `  ${label.padEnd(14)} ${bar(w.usedPercent)} ${String(w.usedPercent).padStart(3)}% used · ` +
          `${String(w.remainingPercent).padStart(3)}% left · resets in ${formatDuration(w.resetsInSec)}`
      );
    }
    if (b.credits && (b.credits.hasCredits || b.credits.unlimited)) {
      lines.push(`  credits        ${b.credits.unlimited ? 'unlimited' : b.credits.balance}`);
    }
  }
  if (snap.rateLimitReachedType) lines.push(`\n!! rate limit reached: ${snap.rateLimitReachedType}`);
  lines.push(`\nfetched ${new Date(snap.fetchedAt).toLocaleTimeString()} · ${snap.source}`);
  return lines.join('\n');
}

/** Cross-check the live snapshot against the rate limits Codex itself recorded on disk. */
function latestRolloutRateLimits() {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(root);
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const f of files.slice(0, 20)) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('rate_limits')) continue;
      try {
        const obj = JSON.parse(lines[i]);
        const rl = obj?.payload?.info?.rate_limits || obj?.payload?.rate_limits;
        if (rl) return { file: f, mtime: fs.statSync(f).mtimeMs, rateLimits: rl };
      } catch {
        /* ignore malformed line */
      }
    }
  }
  return null;
}

const SCHEMA = 'codex-usage.v1';

// Exit codes, so a shell hook can gate work on remaining quota:
//   0 = fine · 20 = below --warn · 21 = below --crit · 30 = could not read
const EXIT_OK = 0;
const EXIT_WARN = 20;
const EXIT_CRIT = 21;
const EXIT_UNAVAILABLE = 30;

/**
 * One line for a shell prompt or status bar.
 *
 * Reads the cached snapshot instead of spawning `codex app-server` (that takes
 * seconds — a prompt would hang), and recomputes the countdown from the absolute
 * reset timestamp so a cached file never shows a frozen "resets in 2h".
 */
function statusline(store) {
  const snap = store.readState();
  if (!snap) return { text: 'codex: no data', code: EXIT_UNAVAILABLE };

  const ageSec = Math.round((Date.now() - snap.fetchedAt) / 1000);
  const left = (win) => (win ? `${win.remainingPercent}%` : '--');
  const until = (win) =>
    win?.resetsAt != null ? formatDuration(Math.max(0, Math.round((win.resetsAt - Date.now()) / 1000))) : '--';

  const worst = Math.min(snap.primary?.remainingPercent ?? 100, snap.secondary?.remainingPercent ?? 100);
  const warn = Number(flag('warn', 20));
  const crit = Number(flag('crit', 10));
  const stale = ageSec > 600 ? ' (stale)' : '';

  return {
    text: `codex ${left(snap.primary)} 5h (${until(snap.primary)}) · ${left(snap.secondary)} wk${stale}`,
    code: worst <= crit ? EXIT_CRIT : worst <= warn ? EXIT_WARN : EXIT_OK,
  };
}

async function main() {
  const svc = new UsageService({ pollMs: Number(flag('interval', 60)) * 1000 });

  if (cmd === 'statusline') {
    const { text, code } = statusline(svc.store);
    svc.stop();
    console.log(text);
    process.exit(code);
  }

  if (cmd === 'once' || cmd === 'verify') {
    const snap = await svc.refresh();
    svc.stop();

    if (cmd === 'verify') {
      const disk = latestRolloutRateLimits();
      console.log(render(snap));
      console.log('\n--- cross-check vs Codex\'s own session log ---');
      if (!disk) {
        console.log('no rollout with rate_limits found (run a Codex turn first)');
      } else {
        const p = disk.rateLimits.primary || {};
        const s = disk.rateLimits.secondary || {};
        console.log(`source: ${path.basename(disk.file)} (written ${new Date(disk.mtime).toLocaleString()})`);
        const epoch = (win) => (win?.resetsAt != null ? win.resetsAt / 1000 : '--');
        const pct = (win) => (win?.usedPercent != null ? win.usedPercent : '--');
        console.log(`  logged 5h:     ${p.used_percent}% used, resets_at ${p.resets_at}`);
        console.log(`  logged weekly: ${s.used_percent}% used, resets_at ${s.resets_at}`);
        console.log(`  live   5h:     ${pct(snap.primary)}% used, resets_at ${epoch(snap.primary)}`);
        console.log(`  live   weekly: ${pct(snap.secondary)}% used, resets_at ${epoch(snap.secondary)}`);
        console.log(
          '\nNote: the log is a snapshot from the last Codex turn; the live read is current. ' +
            'They agree when no quota was consumed in between.'
        );
      }
      return;
    }

    console.log(has('json') ? JSON.stringify({ schema: SCHEMA, ...snap }, null, 2) : render(snap));

    // Same contract as `statusline`, so `once` can gate a script too.
    const worst = Math.min(snap.primary?.remainingPercent ?? 100, snap.secondary?.remainingPercent ?? 100);
    const warn = Number(flag('warn', 20));
    const crit = Number(flag('crit', 10));
    if (worst <= crit) process.exitCode = EXIT_CRIT;
    else if (worst <= warn) process.exitCode = EXIT_WARN;
    return;
  }

  if (cmd === 'watch') {
    svc.on('snapshot', (snap) => {
      console.clear();
      console.log(render(snap));
    });
    await svc.start();
    return;
  }

  if (cmd === 'serve') {
    const port = Number(flag('port', 7893));
    const clients = new Set();
    svc.on('snapshot', (snap) => {
      const payload = `data: ${JSON.stringify(snap)}\n\n`;
      for (const res of clients) res.write(payload);
    });

    // Binding to 127.0.0.1 alone does not stop a web page from reaching this
    // server by rebinding a hostname to the loopback address, so require a
    // loopback Host and reject anything a browser marks with an Origin.
    const hostAllowed = (req) => {
      const host = (req.headers.host || '').toLowerCase();
      const ok = host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
      return ok && !req.headers.origin;
    };

    const server = http.createServer((req, res) => {
      if (!hostAllowed(req)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/usage') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ schema: SCHEMA, ...svc.getState() }));
        return;
      }
      if (url.pathname === '/api/history') {
        const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit')) || 500), 5000);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(svc.store.readHistory(limit)));
        return;
      }
      if (url.pathname === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        clients.add(res);
        if (svc.snapshot) res.write(`data: ${JSON.stringify(svc.snapshot)}\n\n`);
        req.on('close', () => clients.delete(res));
        return;
      }
      res.writeHead(404).end('not found');
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`codex-usage serving on http://127.0.0.1:${port} (poll ${svc.pollMs / 1000}s)`);
    });
    await svc.start();
    return;
  }

  console.log(
    [
      'usage: codex-usage <command> [options]',
      '',
      'commands:',
      '  once         print the current quota      [--json] [--warn 20] [--crit 10]',
      '  statusline   one line for a prompt/status bar (reads the cached snapshot)',
      '  watch        keep printing on change      [--interval 60]',
      '  verify       live read vs the snapshot Codex logged itself',
      '  serve        loopback HTTP + SSE          [--port 7893]',
      '',
      'exit codes (once / statusline): 0 ok · 20 below --warn · 21 below --crit · 30 no data',
    ].join('\n')
  );
  process.exit(1);
}

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});
