'use strict';
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Minimal RGBA PNG encoder so the tray icon can be drawn at runtime, with no asset files. */
function makePng(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 5x7 pixel digits — a tray icon is far too small for real text rendering.
const DIGITS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

/** A full circle rather than a misleading "99" when nothing has been used yet. */
const FULL = ['00000', '01110', '10001', '10001', '10001', '01110', '00000'];

function drawNumber(value, size) {
  const glyphs = value >= 100 ? [FULL] : String(Math.max(0, Math.round(value))).padStart(2, ' ').trim().split('').map((d) => DIGITS[d]);
  const scale = 2;
  const glyphW = 5 * scale;
  const gap = scale;
  const totalW = glyphs.length * glyphW + (glyphs.length - 1) * gap;
  const totalH = 7 * scale;
  const originX = Math.round((size - totalW) / 2);
  const originY = Math.round((size - totalH) / 2);

  return (x, y) => {
    const gx = x - originX;
    const gy = y - originY;
    if (gx < 0 || gy < 0 || gy >= totalH) return false;
    const index = Math.floor(gx / (glyphW + gap));
    if (index >= glyphs.length) return false;
    const inGlyph = gx - index * (glyphW + gap);
    if (inGlyph >= glyphW) return false;
    const row = glyphs[index][Math.floor(gy / scale)];
    return row && row[Math.floor(inGlyph / scale)] === '1';
  };
}

/**
 * Tray icon.
 *
 * `mode`: 'ring' (arc = remaining), 'number' (the percentage, legible at 16px),
 * or 'both' (arc plus the number inside it).
 */
function trayIcon(remainingPercent, rgb, mode = 'ring') {
  const size = 32;
  const cx = 15.5;
  const cy = 15.5;
  const frac = Math.max(0, Math.min(100, remainingPercent)) / 100;
  const [r, g, b] = rgb;
  const thin = mode === 'both';
  const rOuter = 14;
  const rInner = thin ? 11.5 : 9.5;
  const hasRing = mode !== 'number';
  const hasNumber = mode !== 'ring';
  const numberHit = hasNumber ? drawNumber(remainingPercent, size) : null;

  return makePng(size, (x, y) => {
    if (numberHit && numberHit(x, y)) return [r, g, b, 255];
    if (!hasRing) return [0, 0, 0, 0];

    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > rOuter || dist < rInner) return [0, 0, 0, 0];
    // angle: 0 at 12 o'clock, growing clockwise
    let ang = Math.atan2(dx, -dy);
    if (ang < 0) ang += Math.PI * 2;
    const on = ang / (Math.PI * 2) <= frac;
    const edge = Math.min(dist - rInner, rOuter - dist);
    const alpha = Math.max(0, Math.min(1, edge)) * (on ? 1 : 0.22);
    return [r, g, b, Math.round(alpha * 255)];
  });
}

module.exports = { makePng, trayIcon };
