'use strict';

const PRIMARY_LABEL_MINS = 300; // 5h window
const SECONDARY_LABEL_MINS = 10080; // weekly window

function windowLabel(mins) {
  if (mins == null) return '';
  if (mins === PRIMARY_LABEL_MINS) return '5h';
  if (mins === SECONDARY_LABEL_MINS) return 'Weekly';
  if (mins % 10080 === 0) return `${mins / 10080}w`;
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function normalizeWindow(win, nowMs) {
  if (!win) return null;
  const used = typeof win.usedPercent === 'number' ? win.usedPercent : 0;
  const resetsAtMs = win.resetsAt != null ? win.resetsAt * 1000 : null;
  return {
    usedPercent: used,
    remainingPercent: Math.max(0, 100 - used),
    windowMinutes: win.windowDurationMins ?? null,
    windowLabel: windowLabel(win.windowDurationMins),
    resetsAt: resetsAtMs,
    resetsInSec: resetsAtMs != null ? Math.max(0, Math.round((resetsAtMs - nowMs) / 1000)) : null,
  };
}

function bucketName(id, limitName) {
  if (limitName) return limitName;
  if (id === 'codex') return 'Codex';
  return id;
}

function normalizeBucket(id, snap, nowMs) {
  return {
    id,
    name: bucketName(id, snap.limitName),
    isPrimaryBucket: id === 'codex',
    planType: snap.planType ?? null,
    rateLimitReachedType: snap.rateLimitReachedType ?? null,
    credits: snap.credits ?? null,
    individualLimit: snap.individualLimit ?? null,
    primary: normalizeWindow(snap.primary, nowMs),
    secondary: normalizeWindow(snap.secondary, nowMs),
  };
}

/**
 * Turn a raw `account/rateLimits/read` result into the widget's view model.
 * `primary` is the 5-hour window and `secondary` the weekly window, matching
 * the official Codex limit semantics.
 */
function normalizeSnapshot(raw, account, nowMs = Date.now()) {
  const byId = raw.rateLimitsByLimitId && Object.keys(raw.rateLimitsByLimitId).length
    ? raw.rateLimitsByLimitId
    : { [raw.rateLimits?.limitId || 'codex']: raw.rateLimits || {} };

  const buckets = Object.entries(byId).map(([id, snap]) => normalizeBucket(id, snap, nowMs));
  buckets.sort((a, b) => Number(b.isPrimaryBucket) - Number(a.isPrimaryBucket) || a.id.localeCompare(b.id));

  const main = buckets.find((b) => b.isPrimaryBucket) || buckets[0] || null;

  return {
    fetchedAt: nowMs,
    source: 'codex app-server: account/rateLimits/read',
    account: account ? { email: account.email ?? null, planType: account.planType ?? null } : null,
    plan: main?.planType ?? account?.planType ?? null,
    primary: main?.primary ?? null,
    secondary: main?.secondary ?? null,
    credits: main?.credits ?? null,
    rateLimitReachedType: main?.rateLimitReachedType ?? null,
    resetCredits: raw.rateLimitResetCredits ?? null,
    buckets,
  };
}

/**
 * Identity of a snapshot's numbers, used to skip no-op history writes.
 *
 * `resetsAt` is deliberately excluded: an idle window's reset time slides
 * forward on every read, which would make every poll look like a change.
 */
function snapshotFingerprint(s) {
  return JSON.stringify(
    s.buckets.map((b) => [
      b.id,
      b.primary?.usedPercent ?? null,
      b.secondary?.usedPercent ?? null,
      b.credits?.balance ?? null,
      b.rateLimitReachedType ?? null,
    ])
  );
}

function formatDuration(sec) {
  if (sec == null) return '--';
  if (sec <= 0) return 'now';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

module.exports = { normalizeSnapshot, normalizeWindow, snapshotFingerprint, formatDuration, windowLabel };
