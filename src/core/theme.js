'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_THEME = {
  width: 268,
  radius: 14,
  scale: 1,
  blur: 18,
  text: '#f2f3f5',
  accent: '#56c88c',
  warn: '#f0ad4e',
  crit: '#f46054',
  background: {
    color: '#121317',
    opacity: 0.82,
    imagePath: null,
    fit: 'cover', // cover | contain | tile | stretch
  },
  overlay: {
    color: '#000000',
    strength: 0.35, // darkening laid over the image so text stays readable
  },
};

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const FITS = new Set(['cover', 'contain', 'tile', 'stretch']);

const num = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const color = (value, fallback) =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : fallback;

/** Clamp everything: the theme is written by the settings window and by hand-edited prefs.json. */
function mergeTheme(theme) {
  const t = theme || {};
  const bg = { ...DEFAULT_THEME.background, ...(t.background || {}) };
  const ov = { ...DEFAULT_THEME.overlay, ...(t.overlay || {}) };
  const d = DEFAULT_THEME;

  return {
    width: num(t.width, d.width, 200, 600),
    radius: num(t.radius, d.radius, 0, 32),
    scale: num(t.scale, d.scale, 0.7, 2),
    blur: num(t.blur, d.blur, 0, 60),
    text: color(t.text, d.text),
    accent: color(t.accent, d.accent),
    warn: color(t.warn, d.warn),
    crit: color(t.crit, d.crit),
    background: {
      color: color(bg.color, d.background.color),
      opacity: num(bg.opacity, d.background.opacity, 0, 1),
      imagePath: typeof bg.imagePath === 'string' && bg.imagePath ? bg.imagePath : null,
      fit: FITS.has(bg.fit) ? bg.fit : d.background.fit,
    },
    overlay: {
      color: color(ov.color, d.overlay.color),
      strength: num(ov.strength, d.overlay.strength, 0, 1),
    },
  };
}

/**
 * Reads the background image once and holds it.
 *
 * The renderer has no Node access and its CSP only allows `data:` images, so
 * main reads the bytes and hands over an inline copy — no file:// access for the
 * page. The data URL is megabytes wide, so it must never ride along on the
 * routine state pushes: callers send `key` and fetch the bytes only when it
 * changes. Disk is touched only when the chosen path changes or `reload()` runs.
 */
class BackgroundImage {
  constructor() {
    this.state = { path: null, key: null, dataUrl: null, error: null };
  }

  /** Load `imagePath` if it differs from what is held (or if forced). */
  set(imagePath, { force = false } = {}) {
    if (!force && imagePath === this.state.path) return this.state;
    this.state = imagePath ? read(imagePath) : { path: null, key: null, dataUrl: null, error: null };
    return this.state;
  }

  reload() {
    return this.set(this.state.path, { force: true });
  }

  /** What the renderer needs to know without shipping the bytes. */
  descriptor() {
    return { key: this.state.key, error: this.state.error };
  }

  dataUrl() {
    return this.state.dataUrl;
  }
}

function read(imagePath) {
  const fail = (error) => ({ path: imagePath, key: null, dataUrl: null, error });

  let stat;
  try {
    stat = fs.statSync(imagePath);
  } catch {
    return fail(`image not found: ${imagePath}`);
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    return fail(`image too large (${Math.round(stat.size / 1e6)} MB, max 12 MB)`);
  }
  const mime = IMAGE_MIME[path.extname(imagePath).toLowerCase()];
  if (!mime) return fail(`unsupported image type: ${path.extname(imagePath) || 'none'}`);

  try {
    const dataUrl = `data:${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;
    return { path: imagePath, key: `${imagePath}:${stat.mtimeMs}:${stat.size}`, dataUrl, error: null };
  } catch (err) {
    return fail(`cannot read image: ${err.message}`);
  }
}

module.exports = { DEFAULT_THEME, mergeTheme, BackgroundImage };
