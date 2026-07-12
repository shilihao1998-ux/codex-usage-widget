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

/** Tray icon: a ring whose filled arc is the remaining quota. */
function trayIcon(remainingPercent, rgb) {
  const size = 32;
  const cx = 15.5;
  const cy = 15.5;
  const rOuter = 14;
  const rInner = 9.5;
  const frac = Math.max(0, Math.min(100, remainingPercent)) / 100;
  const [r, g, b] = rgb;

  return makePng(size, (x, y) => {
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
