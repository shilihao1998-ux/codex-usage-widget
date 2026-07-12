'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Locate the `codex` executable. The desktop app installs a launcher plus one
 * versioned binary per release; the launcher is the stable path, so prefer it
 * and only fall back to scanning the versioned directories.
 */
function candidatePaths() {
  const home = os.homedir();
  const out = [];
  if (process.env.CODEX_BIN) out.push(process.env.CODEX_BIN);

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    out.push(path.join(local, 'OpenAI', 'Codex', 'bin', 'codex.exe'));
    out.push(path.join(home, '.codex', 'bin', 'codex.exe'));
  } else {
    out.push(path.join(local(home), 'OpenAI', 'Codex', 'bin', 'codex'));
    out.push(path.join(home, '.codex', 'bin', 'codex'));
    out.push(path.join(home, '.local', 'bin', 'codex'));
    out.push('/usr/local/bin/codex');
    out.push('/opt/homebrew/bin/codex');
  }
  return out;
}

function local(home) {
  return process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support')
    : path.join(home, '.local', 'share');
}

/**
 * Ask the OS where `codex` lives.
 *
 * Two Windows traps: `where.exe` searches the current directory before PATH (so
 * a stray codex.exe in a downloaded folder would win), and an npm install puts
 * an extensionless shim first, which `spawn` cannot execute. Run the lookup from
 * the home directory, drop anything under the CWD, and prefer a real .exe.
 */
function fromPath() {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  let out;
  try {
    out = execFileSync(finder, ['codex'], { encoding: 'utf8', cwd: os.homedir() });
  } catch {
    return null;
  }

  const cwd = path.resolve(process.cwd());
  const hits = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((p) => path.resolve(path.dirname(p)) !== cwd);

  if (process.platform !== 'win32') return hits[0] || null;
  const byExt = (ext) => hits.find((p) => p.toLowerCase().endsWith(ext));
  return byExt('.exe') || byExt('.cmd') || byExt('.bat') || null;
}

/**
 * The desktop app keeps one versioned build per release in `bin/<hash>/`, and a
 * launcher in `bin/` that can lag behind it. The newest build is the one the app
 * itself runs, and older launchers lack newer app-server methods (token usage,
 * for one), so prefer the freshest versioned binary and keep the launcher as the
 * fallback.
 */
function newestVersionedBin(launcher) {
  const dir = path.dirname(launcher);
  const exe = path.basename(launcher);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return null;
  }

  const builds = entries
    .map((e) => path.join(dir, e.name, exe))
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ path: p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  return builds[0]?.path ?? null;
}

function resolveCodexBin() {
  if (process.env.CODEX_BIN) {
    if (fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
    throw new Error(`CODEX_BIN does not exist: ${process.env.CODEX_BIN}`);
  }

  for (const p of candidatePaths()) {
    if (!p || !fs.existsSync(p)) continue;
    return newestVersionedBin(p) || p;
  }
  const onPath = fromPath();
  if (onPath && fs.existsSync(onPath)) return newestVersionedBin(onPath) || onPath;

  throw new Error(
    'codex executable not found. Set CODEX_BIN to its full path (e.g. ' +
      '%LOCALAPPDATA%\\OpenAI\\Codex\\bin\\codex.exe).'
  );
}

module.exports = { resolveCodexBin };
