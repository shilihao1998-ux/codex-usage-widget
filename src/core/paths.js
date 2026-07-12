'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEGACY_DIR = path.join(__dirname, '..', '..', 'data');

/**
 * Where prefs, the cached snapshot, history and user plugins live.
 *
 * Deliberately outside the repository: it holds the signed-in account's email
 * and usage history, and a checkout should never accumulate that. Override with
 * CODEX_USAGE_DATA_DIR.
 */
function dataDir() {
  if (process.env.CODEX_USAGE_DATA_DIR) return process.env.CODEX_USAGE_DATA_DIR;
  return path.join(os.homedir(), '.codex-usage-widget');
}

/** Create the data dir, moving state over from the old in-repo `data/` once. */
function ensureDataDir() {
  const dir = dataDir();
  const fresh = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });

  if (fresh && !process.env.CODEX_USAGE_DATA_DIR && fs.existsSync(LEGACY_DIR)) {
    for (const name of fs.readdirSync(LEGACY_DIR)) {
      const from = path.join(LEGACY_DIR, name);
      const to = path.join(dir, name);
      try {
        fs.cpSync(from, to, { recursive: true });
      } catch {
        /* best effort: a failed migration just means starting fresh */
      }
    }
  }
  return dir;
}

module.exports = { dataDir, ensureDataDir };
