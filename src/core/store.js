'use strict';
const fs = require('fs');
const path = require('path');
const { ensureDataDir } = require('./paths');

class Store {
  constructor(dir = ensureDataDir()) {
    this.dir = dir;
    this.statePath = path.join(dir, 'state.json');
    this.historyPath = path.join(dir, 'history.jsonl');
    fs.mkdirSync(dir, { recursive: true });
  }

  writeState(snapshot) {
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, this.statePath);
  }

  readState() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Keep the history file bounded.
   *
   * Retention DROPS rows, it never merges them: averaging two samples would
   * invent a percentage the server never reported. Rows within `keepFullDays`
   * are kept as-is; older ones are thinned to at most one per hour, and every
   * window boundary (a drop in usage) and local peak is always kept, because
   * those are exactly the points a trend line must not smooth away.
   */
  trimHistory({ maxRows = 20000, keepFullDays = 7 } = {}) {
    let rows;
    try {
      const { size } = fs.statSync(this.historyPath);
      if (size < 1_000_000) return;
      rows = this.readHistory(Infinity);
    } catch {
      return;
    }

    const cutoff = Date.now() - keepFullDays * 86400000;
    const recent = rows.filter((r) => r.t >= cutoff);
    const kept = [...thin(rows.filter((r) => r.t < cutoff)), ...recent].slice(-maxRows);

    try {
      fs.writeFileSync(this.historyPath, kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } catch {
      /* best effort */
    }
  }

  appendHistory(snapshot) {
    const row = {
      t: snapshot.fetchedAt,
      plan: snapshot.plan,
      // `credits` is part of the change fingerprint, so it has to be recorded too
      // or a credits-only change writes a row that looks identical to the last one.
      credits: snapshot.credits?.balance ?? null,
      buckets: snapshot.buckets.map((b) => ({
        id: b.id,
        p: b.primary ? { u: b.primary.usedPercent, r: b.primary.resetsAt } : null,
        s: b.secondary ? { u: b.secondary.usedPercent, r: b.secondary.resetsAt } : null,
      })),
    };
    fs.appendFileSync(this.historyPath, JSON.stringify(row) + '\n');
    this.trimHistory();
  }

  clearHistory() {
    try {
      fs.rmSync(this.historyPath, { force: true });
    } catch {
      /* nothing to clear */
    }
  }

  readHistory(limit = 500) {
    const all = limit === Infinity;
    const n = all ? 0 : Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500;
    try {
      const lines = fs.readFileSync(this.historyPath, 'utf8').split('\n').filter(Boolean);
      return (all ? lines : lines.slice(-n))
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

/** Used percent of the main bucket's 5h window — the series retention reasons about. */
function primaryUsed(row) {
  const bucket = (row.buckets || []).find((b) => b.id === 'codex') || (row.buckets || [])[0];
  return bucket?.p?.u ?? null;
}

/** One row per hour, plus every reset boundary and local peak. Never synthesises a row. */
function thin(rows) {
  const kept = [];
  let lastKeptHour = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const hour = Math.floor(row.t / 3600000);
    const used = primaryUsed(row);
    const prev = i > 0 ? primaryUsed(rows[i - 1]) : null;
    const next = i < rows.length - 1 ? primaryUsed(rows[i + 1]) : null;

    const isReset = prev != null && used != null && used < prev; // window rolled over
    const isPeak = prev != null && next != null && used != null && used > prev && used >= next;

    if (isReset || isPeak || hour !== lastKeptHour) {
      kept.push(row);
      lastKeptHour = hour;
    }
  }
  return kept;
}

module.exports = { Store, thin };
