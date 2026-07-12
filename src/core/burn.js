'use strict';

/**
 * Burn rate and depletion estimate.
 *
 * This is the only place in the product that produces a number Codex did not
 * give us, so it is deliberately conservative: it refuses to answer unless the
 * samples justify one, it never fits across a window reset (usage drops back to
 * zero there), and everything it returns is labelled an estimate by the callers.
 */

const MIN_SAMPLES = 3;
const MIN_SPAN_MS = 10 * 60 * 1000; // 10 minutes
const MIN_DELTA_PERCENT = 2;

/**
 * Pull one window's samples out of history.jsonl rows.
 * `key` is 'p' (primary / 5h) or 's' (secondary / weekly).
 */
function samplesFor(history, bucketId, key) {
  const out = [];
  for (const row of history) {
    const bucket = (row.buckets || []).find((b) => b.id === bucketId);
    const win = bucket && bucket[key];
    if (!win || typeof win.u !== 'number') continue;
    out.push({ t: row.t, used: win.u, resetsAt: win.r ?? null });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Keep only the samples belonging to the window instance that is running now.
 *
 * A reset shows up as usage falling; fitting across that point would average a
 * fresh window together with a spent one and report a burn rate nobody has.
 */
function currentWindow(samples) {
  let start = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].used < samples[i - 1].used) start = i;
  }
  return samples.slice(start);
}

/**
 * @returns {null | {
 *   percentPerHour: number, samples: number, spanMs: number,
 *   exhaustAt: number|null, exhaustsBeforeReset: boolean|null, resetsAt: number|null
 * }}
 * null means "not enough evidence" — the caller must show that, not a zero.
 */
function burnRate(history, { bucketId = 'codex', key = 'p', now = Date.now() } = {}) {
  const samples = currentWindow(samplesFor(history, bucketId, key));
  if (samples.length < MIN_SAMPLES) return null;

  const first = samples[0];
  const last = samples[samples.length - 1];
  const spanMs = last.t - first.t;
  const deltaPercent = last.used - first.used;

  if (spanMs < MIN_SPAN_MS) return null;
  if (deltaPercent < MIN_DELTA_PERCENT) return null;

  const percentPerHour = (deltaPercent / spanMs) * 3600000;
  const remaining = Math.max(0, 100 - last.used);
  const hoursLeft = percentPerHour > 0 ? remaining / percentPerHour : null;
  const exhaustAt = hoursLeft == null ? null : Math.round(now + hoursLeft * 3600000);
  const resetsAt = last.resetsAt ?? null;

  return {
    percentPerHour,
    samples: samples.length,
    spanMs,
    exhaustAt,
    resetsAt,
    exhaustsBeforeReset: exhaustAt != null && resetsAt != null ? exhaustAt < resetsAt : null,
  };
}

/** Thresholds are exported so the UI can say *why* it has no estimate yet. */
burnRate.MIN_SAMPLES = MIN_SAMPLES;
burnRate.MIN_SPAN_MS = MIN_SPAN_MS;
burnRate.MIN_DELTA_PERCENT = MIN_DELTA_PERCENT;

module.exports = { burnRate, samplesFor, currentWindow };
