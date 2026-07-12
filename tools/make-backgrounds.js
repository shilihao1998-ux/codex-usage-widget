#!/usr/bin/env node
'use strict';
// Generates the sample backgrounds in assets/backgrounds/. Run: node tools/make-backgrounds.js
const fs = require('fs');
const path = require('path');
const { makePng } = require('../src/ui/png');

const OUT = path.join(__dirname, '..', 'assets', 'backgrounds');
const SIZE = 720;

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const lerp = (a, b, t) => a + (b - a) * t;

function radial(u, v, cx, cy, falloff) {
  return Math.max(0, 1 - Math.hypot(u - cx, v - cy) * falloff);
}

const WALLPAPERS = {
  // Deep indigo with a soft aurora bloom in the top-right.
  'aurora.png': (u, v) => {
    const bloom = radial(u, v, 0.78, 0.2, 1.7) ** 1.6;
    const wash = radial(u, v, 0.15, 0.9, 1.4) ** 2;
    return [
      clamp(lerp(18, 34, v) + 150 * bloom + 30 * wash),
      clamp(lerp(20, 28, u) + 90 * bloom + 70 * wash),
      clamp(lerp(38, 62, 1 - v) + 120 * bloom + 90 * wash),
    ];
  },
  // Warm charcoal with an ember glow bottom-left.
  'ember.png': (u, v) => {
    const glow = radial(u, v, 0.18, 0.86, 1.5) ** 1.8;
    return [clamp(24 + 12 * u + 180 * glow), clamp(21 + 8 * v + 70 * glow), clamp(20 + 10 * v + 40 * glow)];
  },
  // Near-black slate with a faint grid — stays legible behind any text.
  'slate-grid.png': (u, v) => {
    const x = u * SIZE;
    const y = v * SIZE;
    const line = x % 48 < 1 || y % 48 < 1 ? 14 : 0;
    const vignette = 1 - radial(u, v, 0.5, 0.5, 0.9) * 0.5;
    return [clamp((22 + line) * vignette), clamp((23 + line) * vignette), clamp((28 + line) * vignette)];
  },
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, shade] of Object.entries(WALLPAPERS)) {
  const buf = makePng(SIZE, (x, y) => [...shade(x / SIZE, y / SIZE), 255]);
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`wrote ${path.join('assets', 'backgrounds', name)} (${buf.length} bytes)`);
}
