'use strict';
// Run: node test/extras.test.js
const assert = require('assert');
const { thin } = require('../src/core/store');
const { buildSeries, segments, buildReport } = require('../src/core/report');
const { quotaPayload } = require('../src/core/mcp');
const { formatTokens } = require('../src/core/token-usage');

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(`  ok  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const rows = (samples) =>
  samples.map(([minutes, used]) => ({
    t: T0 + minutes * MIN,
    plan: 'pro',
    buckets: [{ id: 'codex', p: { u: used, r: T0 + 5 * 3600_000 }, s: { u: 20, r: T0 + 7 * 86400_000 } }],
  }));

check('retention drops rows but never invents one', () => {
  const dense = rows([[0, 10], [5, 12], [10, 14], [15, 40], [20, 30], [70, 35], [130, 40]]);
  const kept = thin(dense);

  assert.ok(kept.length < dense.length, 'thinning must actually drop rows');
  for (const row of kept) {
    assert.ok(
      dense.some((d) => d.t === row.t && d.buckets[0].p.u === row.buckets[0].p.u),
      'every kept row must be one of the originals — no averaging'
    );
  }
  // The reset (40 → 30) is a boundary a trend must not smooth away.
  assert.ok(kept.some((r) => r.buckets[0].p.u === 30), 'reset boundary kept');
  assert.ok(kept.some((r) => r.buckets[0].p.u === 40), 'peak kept');
});

check('the trend breaks at resets and at gaps, never interpolating', () => {
  const series = buildSeries(
    rows([[0, 10], [30, 30], [60, 50], [90, 5], [120, 10]]), // a reset between 50% used and 5% used
    'codex',
    'p'
  );
  const withReset = segments(series);
  assert.strictEqual(withReset.length, 2, 'a reset must split the line');

  const gapped = buildSeries(rows([[0, 10], [30, 20], [600, 30], [630, 40]]), 'codex', 'p');
  assert.strictEqual(segments(gapped).length, 2, 'a long gap (widget not running) must split the line');
});

check('the HTML report carries no account identity', () => {
  const html = buildReport({
    rows: rows([[0, 10], [30, 20], [60, 30]]),
    plan: 'pro',
    tokens: { days: [{ date: '2026-07-01', tokens: 1000 }], lifetime: 5000, peakDaily: 1000, streakDays: 3, last7Total: 4000 },
  });
  assert.ok(!/@/.test(html.replace(/@media|@font-face/g, '')), 'no email anywhere');
  assert.ok(html.includes('no account identity'), 'states its own guarantee');
  assert.ok(html.includes('Tokens per day'), 'includes the official token section');
  assert.ok(html.includes('<polyline'), 'draws the quota line');
});

check('the MCP payload is facts + age, never a prediction', () => {
  const snap = {
    fetchedAt: Date.now() - 5000,
    source: 'codex app-server: account/rateLimits/read',
    plan: 'pro',
    primary: { usedPercent: 12, remainingPercent: 88, windowMinutes: 300, resetsAt: Date.now() + 3600_000 },
    secondary: { usedPercent: 23, remainingPercent: 77, windowMinutes: 10080, resetsAt: Date.now() + 86400_000 },
  };
  const { structured } = quotaPayload(snap);

  assert.strictEqual(structured.is_estimate, false);
  assert.strictEqual(structured.stale, false);
  assert.strictEqual(structured.primary_5h.remaining_percent, 88);
  assert.ok(structured.fetched_at, 'always reports when it was measured');
  assert.ok(!JSON.stringify(structured).includes('exhaust'), 'never carries a depletion prediction');

  const old = quotaPayload({ ...snap, fetchedAt: Date.now() - 20 * 60_000 });
  assert.strictEqual(old.structured.stale, true, 'old data must announce itself as stale');
});

check('token counts are formatted, not rounded to nothing', () => {
  assert.strictEqual(formatTokens(1_714_916_652), '1.71B');
  assert.strictEqual(formatTokens(990_763), '990.8K');
  assert.strictEqual(formatTokens(null), '--');
});

console.log(results.join('\n'));
console.log(process.exitCode ? '\nFAILED' : '\nall passed');
