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

  /** Keep the history file bounded; it only exists for trend views. */
  trimHistory(maxRows = 5000) {
    try {
      const { size } = fs.statSync(this.historyPath);
      if (size < 1_000_000) return;
      const kept = this.readHistory(maxRows);
      fs.writeFileSync(this.historyPath, kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } catch {
      /* nothing to trim */
    }
  }

  appendHistory(snapshot) {
    const row = {
      t: snapshot.fetchedAt,
      plan: snapshot.plan,
      buckets: snapshot.buckets.map((b) => ({
        id: b.id,
        p: b.primary ? { u: b.primary.usedPercent, r: b.primary.resetsAt } : null,
        s: b.secondary ? { u: b.secondary.usedPercent, r: b.secondary.resetsAt } : null,
      })),
    };
    fs.appendFileSync(this.historyPath, JSON.stringify(row) + '\n');
    this.trimHistory();
  }

  readHistory(limit = 500) {
    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500;
    try {
      const lines = fs.readFileSync(this.historyPath, 'utf8').split('\n').filter(Boolean);
      return lines
        .slice(-n)
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

module.exports = { Store };
