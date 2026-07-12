'use strict';
// Run: node test/burn.test.js
const assert = require('assert');
const { burnRate, currentWindow } = require('../src/core/burn');

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

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = 1_700_000_000_000;

/** history.jsonl rows for one bucket's 5h window. */
const rows = (samples) =>
  samples.map(([minutes, used, resetsAt]) => ({
    t: T0 + minutes * MIN,
    buckets: [{ id: 'codex', p: { u: used, r: resetsAt ?? T0 + 5 * HOUR }, s: null }],
  }));

check('refuses to answer with too few samples', () => {
  const out = burnRate(rows([[0, 0], [30, 10]]), { now: T0 + 30 * MIN });
  assert.strictEqual(out, null, 'two samples is not evidence');
});

check('refuses to answer over too short a span', () => {
  const out = burnRate(rows([[0, 0], [2, 5], [4, 10]]), { now: T0 + 4 * MIN });
  assert.strictEqual(out, null, '4 minutes is not a trend');
});

check('refuses to answer when barely anything moved', () => {
  const out = burnRate(rows([[0, 4], [30, 4], [60, 5]]), { now: T0 + 60 * MIN });
  assert.strictEqual(out, null, '1% over an hour is noise, not a rate');
});

check('computes the rate and the depletion time', () => {
  // 10% per hour: 0 → 20% over two hours, 80% left ⇒ 8 more hours.
  const out = burnRate(rows([[0, 0], [60, 10], [120, 20]]), { now: T0 + 120 * MIN });
  assert.ok(out, 'should produce an estimate');
  assert.strictEqual(Math.round(out.percentPerHour), 10);
  assert.strictEqual(out.samples, 3);
  const hoursToEmpty = (out.exhaustAt - (T0 + 120 * MIN)) / HOUR;
  assert.ok(Math.abs(hoursToEmpty - 8) < 0.01, `expected ~8h to empty, got ${hoursToEmpty}`);
});

check('says whether the window runs out before it resets', () => {
  const now = T0 + 120 * MIN;
  // Burning 30%/h with 40% left ⇒ empty in ~80 min, while the reset is 4h away.
  const fast = burnRate(rows([[0, 0], [60, 30], [120, 60, T0 + 6 * HOUR]]), { now });
  assert.strictEqual(fast.exhaustsBeforeReset, true);

  // Burning 3%/h with 94% left ⇒ over 30h, far beyond the reset.
  const slow = burnRate(rows([[0, 0], [60, 3], [120, 6, T0 + 6 * HOUR]]), { now });
  assert.strictEqual(slow.exhaustsBeforeReset, false);
});

check('never fits across a window reset', () => {
  // Usage climbs to 90%, the window resets, then 4% is used in the new one.
  const history = rows([[0, 50], [60, 70], [120, 90], [180, 1], [240, 3], [300, 4]]);
  const out = burnRate(history, { now: T0 + 300 * MIN });
  assert.ok(out, 'the new window has enough samples of its own');
  // Only the post-reset samples count: 3% over 2h ≈ 1.5%/h, not the pre-reset 20%/h.
  assert.ok(out.percentPerHour < 3, `pre-reset samples leaked in: ${out.percentPerHour}%/h`);
  assert.strictEqual(out.samples, 3);
});

check('currentWindow cuts at the drop', () => {
  const samples = [
    { t: 1, used: 40 },
    { t: 2, used: 80 },
    { t: 3, used: 5 },
    { t: 4, used: 9 },
  ];
  assert.deepStrictEqual(
    currentWindow(samples).map((s) => s.used),
    [5, 9]
  );
});

check('an idle window (no usage) yields no estimate, not a division by zero', () => {
  const out = burnRate(rows([[0, 0], [60, 0], [120, 0]]), { now: T0 + 120 * MIN });
  assert.strictEqual(out, null);
});

console.log(results.join('\n'));
console.log(process.exitCode ? '\nFAILED' : '\nall passed');
