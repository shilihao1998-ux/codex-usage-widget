'use strict';

const USAGE_READ = 'account/usage/read';

/**
 * Official token usage: daily buckets, streaks and lifetime totals, straight from
 * `account/usage/read` on the app-server. This is measured data, not an estimate.
 *
 * Older Codex builds do not implement the method (it arrived after 0.130), so a
 * missing method is a normal state, not an error: we report `supported: false`
 * and the UI simply says so instead of showing a blank chart.
 */
class TokenUsage {
  constructor(client) {
    this.client = client;
    this.supported = null; // null = not asked yet
    this.data = null;
    this.error = null;
    this.fetchedAt = null;
  }

  async refresh() {
    try {
      const raw = await this.client.request(USAGE_READ);
      this.supported = true;
      this.error = null;
      this.fetchedAt = Date.now();
      this.data = normalize(raw);
      return this.data;
    } catch (err) {
      // "unknown variant `account/usage/read`" — the build predates the method.
      if (/unknown variant|method not found|-32600|-32601/i.test(err.message)) {
        this.supported = false;
        this.error = 'This Codex build does not expose token usage (needs a newer Codex).';
      } else {
        this.error = err.message;
      }
      return null;
    }
  }

  state() {
    return {
      supported: this.supported,
      error: this.error,
      fetchedAt: this.fetchedAt,
      ...(this.data || {}),
    };
  }
}

function normalize(raw) {
  const summary = raw?.summary || {};
  const days = (raw?.dailyUsageBuckets || [])
    .filter((b) => b && typeof b.tokens === 'number' && b.startDate)
    .map((b) => ({ date: b.startDate, tokens: b.tokens }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const last7 = days.slice(-7);
  return {
    days,
    today: days.length ? days[days.length - 1] : null,
    last7Total: last7.reduce((sum, d) => sum + d.tokens, 0),
    peakDaily: summary.peakDailyTokens ?? null,
    lifetime: summary.lifetimeTokens ?? null,
    streakDays: summary.currentStreakDays ?? null,
    longestStreakDays: summary.longestStreakDays ?? null,
    longestTurnSec: summary.longestRunningTurnSec ?? null,
  };
}

/** 1_714_916_652 → "1.71B" — a tray tooltip has no room for grouped digits. */
function formatTokens(n) {
  if (n == null) return '--';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

module.exports = { TokenUsage, formatTokens, USAGE_READ };
