'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveCodexBin } = require('./codex-bin');
const { AppServerClient } = require('./app-server-client');
const { dataDir } = require('./paths');
const { USAGE_READ } = require('./token-usage');

/**
 * Turns every line of the troubleshooting section into a check a machine runs in
 * two seconds — and produces a report that is safe to paste into an issue.
 *
 * Redaction is a WHITELIST: only the fields listed here ever leave the machine.
 * Nothing from plugin config (which may hold third-party keys) is included, and
 * the account email is reduced to its domain.
 */
async function runDoctor() {
  const checks = [];
  // `optional` checks report their state but never make the whole run fail:
  // token stats simply do not exist in older Codex builds.
  const add = (name, ok, detail, optional = false) => checks.push({ name, ok, detail, optional });

  add('node', true, process.version);
  add('platform', true, `${os.platform()} ${os.release()}`);

  let bin = null;
  try {
    bin = resolveCodexBin();
    add('codex executable', true, redactPath(bin));
  } catch (err) {
    add('codex executable', false, err.message);
    return report(checks, null);
  }

  const client = new AppServerClient({ bin });
  const stderr = [];
  client.on('stderr', (chunk) => stderr.push(chunk.trim()));

  let account = null;
  try {
    // request() performs the initialize handshake on first use.
    account = await client.request('account/read', { refreshToken: false }).then((r) => r?.account ?? null);
    add('signed in', !!account?.email, account?.email ? `plan ${account.planType}, ${maskEmail(account.email)}` : 'no account — run `codex login`');
  } catch (err) {
    add('app-server handshake', false, err.message);
    client.stop();
    return report(checks, stderr);
  }

  try {
    const limits = await client.request('account/rateLimits/read');
    const p = limits?.rateLimits?.primary;
    const s = limits?.rateLimits?.secondary;
    add(
      'account/rateLimits/read',
      !!p || !!s,
      p ? `5h ${100 - p.usedPercent}% left · weekly ${100 - (s?.usedPercent ?? 0)}% left` : 'no windows returned'
    );
    const buckets = Object.keys(limits?.rateLimitsByLimitId || {});
    if (buckets.length) add('limit buckets', true, buckets.join(', '));
  } catch (err) {
    add('account/rateLimits/read', false, err.message);
  }

  try {
    await client.request(USAGE_READ);
    add('account/usage/read (token stats)', true, 'supported', true);
  } catch (err) {
    const old = /unknown variant|method not found/i.test(err.message);
    add(
      'account/usage/read (token stats)',
      false,
      old ? 'not in this Codex build — token panel stays hidden' : err.message,
      true
    );
  }

  client.stop();

  const dir = dataDir();
  for (const [name, file] of [
    ['prefs.json', path.join(dir, 'prefs.json')],
    ['state.json', path.join(dir, 'state.json')],
    ['history.jsonl', path.join(dir, 'history.jsonl')],
  ]) {
    try {
      const stat = fs.statSync(file);
      add(`data/${name}`, true, `${stat.size} bytes, modified ${new Date(stat.mtimeMs).toISOString()}`);
    } catch {
      add(`data/${name}`, true, 'not created yet');
    }
  }

  return report(checks, stderr);
}

/** Codex prints failure reasons on stderr; without this they are simply lost. */
function report(checks, stderr) {
  return {
    checks,
    stderr: (stderr || []).filter(Boolean).slice(-10).map(redactPath),
    ok: checks.every((c) => c.ok || c.optional),
  };
}

const maskEmail = (email) => `***@${String(email).split('@')[1] ?? '?'}`;
const redactPath = (text) => String(text).split(os.homedir()).join('~');

function renderDoctor({ checks, stderr, ok }) {
  const lines = checks.map(
    (c) => `  ${c.ok ? '✓' : c.optional ? '–' : '✗'} ${c.name.padEnd(32)} ${c.detail}`
  );
  if (stderr.length) {
    lines.push('', '  codex app-server stderr (last lines):');
    for (const line of stderr) lines.push(`    ${line}`);
  }
  lines.push('', ok ? '  all checks passed' : '  something is wrong — see the ✗ lines above');
  lines.push('  (paths redacted to ~, email masked — safe to paste into an issue)');
  return lines.join('\n');
}

module.exports = { runDoctor, renderDoctor };
