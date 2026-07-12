#!/usr/bin/env node
'use strict';
// Generates build/icon.ico (and icon.png) — the app/installer icon.
// Run: node tools/make-icon.js
const fs = require('fs');
const path = require('path');
const { makePng } = require('../src/ui/png');

const OUT = path.join(__dirname, '..', 'build');
const SIZE = 256;

/**
 * The same ring the tray icon draws: a gauge with a healthy-green arc on a dark
 * rounded tile, so the app icon and the tray icon read as one thing.
 */
function shade(x, y) {
  const cx = (SIZE - 1) / 2;
  const cy = (SIZE - 1) / 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.hypot(dx, dy);

  // rounded-square tile
  const r = 52;
  const half = SIZE / 2 - 6;
  const qx = Math.abs(dx) - (half - r);
  const qy = Math.abs(dy) - (half - r);
  const tile = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r + Math.min(Math.max(qx, qy), 0);
  if (tile > 0.5) return [0, 0, 0, 0];
  const tileAlpha = Math.min(1, Math.max(0, 0.5 - tile));

  // background gradient of the tile
  const u = x / SIZE;
  const v = y / SIZE;
  const bg = [
    Math.round(24 + 26 * u + 18 * v),
    Math.round(25 + 18 * u + 14 * v),
    Math.round(34 + 40 * (1 - u) + 22 * v),
  ];

  const rOuter = 88;
  const rInner = 60;
  if (dist > rOuter || dist < rInner) return [...bg, Math.round(tileAlpha * 255)];

  // 78 % remaining, drawn clockwise from 12 o'clock
  let ang = Math.atan2(dx, -dy);
  if (ang < 0) ang += Math.PI * 2;
  const on = ang / (Math.PI * 2) <= 0.78;
  const edge = Math.min(dist - rInner, rOuter - dist);
  const aa = Math.min(1, Math.max(0, edge));

  const ring = on ? [86, 200, 140] : [70, 72, 82];
  const mix = ring.map((c, i) => Math.round(bg[i] + (c - bg[i]) * aa));
  return [...mix, Math.round(tileAlpha * 255)];
}

/** ICO container holding a single PNG image (supported since Windows Vista). */
function pngToIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // 0 means 256
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, png]);
}

fs.mkdirSync(OUT, { recursive: true });
const png = makePng(SIZE, shade);
fs.writeFileSync(path.join(OUT, 'icon.png'), png);
fs.writeFileSync(path.join(OUT, 'icon.ico'), pngToIco(png, SIZE));
console.log(`wrote build/icon.png and build/icon.ico (${SIZE}x${SIZE})`);
