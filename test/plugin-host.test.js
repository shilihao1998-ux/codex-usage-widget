'use strict';
// Run: node test/plugin-host.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PluginHost, normalizePanel } = require('../src/core/plugin-host');
const { mergeTheme, BackgroundImage } = require('../src/core/theme');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuw-test-'));
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`  ok  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

function writePlugin(dir, manifest, code) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'index.js'), code);
}

const settings = {};
const host = new PluginHost({ dirs: [path.join(tmp, 'a'), path.join(tmp, 'b')], getSettings: () => settings });

(async () => {
  // Two folders, same id: the second must be ignored, not silently overwrite the first.
  writePlugin(path.join(tmp, 'a', 'dup'), { id: 'dup', name: 'A' }, 'exports.fetch = async () => ({ rows: [] });');
  writePlugin(path.join(tmp, 'b', 'dup'), { id: 'dup', name: 'B' }, 'exports.fetch = async () => ({ rows: [] });');
  settings.dup = { enabled: true, config: {} };

  await check('duplicate ids do not leak timers', async () => {
    host.load();
    assert.strictEqual(host.plugins.size, 1, 'only one plugin kept');
    assert.strictEqual(host.timers.size, 1, 'exactly one timer scheduled');
    host.load(); // reload must not accumulate timers
    assert.strictEqual(host.timers.size, 1, 'still one timer after reload');
    host.stop();
    assert.strictEqual(host.timers.size, 0, 'stop() clears every timer');
  });

  await check('broken plugin.json stays visible with its error', async () => {
    fs.mkdirSync(path.join(tmp, 'a', 'broken'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'a', 'broken', 'plugin.json'), '{ not json');
    host.load();
    const broken = host.list().find((p) => p.name === 'broken');
    assert.ok(broken, 'broken plugin listed');
    assert.match(broken.error, /bad plugin.json/);
    host.stop();
  });

  await check('a slow run cannot overwrite a newer result', async () => {
    writePlugin(
      path.join(tmp, 'a', 'slow'),
      { id: 'slow', name: 'Slow', refreshMs: 10000 },
      `let n = 0;
       exports.fetch = async () => {
         const mine = ++n;
         await new Promise((r) => setTimeout(r, mine === 1 ? 400 : 10));
         if (mine === 1) throw new Error('stale failure');
         return { rows: [{ label: 'fresh', value: String(mine) }] };
       };`
    );
    settings.slow = { enabled: true, config: {} };
    host.load();

    const entry = host.plugins.get('slow');
    const first = host.run('slow'); // starts run #1 (slow, will fail)
    await new Promise((r) => setTimeout(r, 50));
    entry.seq++; // simulate a config change superseding the in-flight run
    entry.running = false;
    await host.run('slow'); // run #2 succeeds
    await first;

    assert.strictEqual(entry.panel.error, null, 'stale error must not land');
    assert.strictEqual(entry.panel.rows[0].value, '2', 'newest result kept');
    host.stop();
  });

  await check('overlapping runs are skipped, not queued', async () => {
    const entry = host.plugins.get('slow');
    entry.running = true;
    await host.run('slow'); // must return immediately without touching the panel
    entry.running = false;
    assert.ok(true);
  });

  await check('plugin output is normalized, never trusted', () => {
    const panel = normalizePanel(
      {
        title: 'x'.repeat(100),
        rows: Array.from({ length: 30 }, () => ({
          label: '<img src=x onerror=alert(1)>',
          value: 'v',
          tone: 'evil',
          progress: 9999,
        })),
      },
      { id: 'p', name: 'P', icon: '' }
    );
    assert.strictEqual(panel.rows.length, 8, 'row count capped');
    assert.strictEqual(panel.name.length, 32, 'title length capped');
    assert.strictEqual(panel.rows[0].tone, 'default', 'unknown tone rejected');
    assert.strictEqual(panel.rows[0].progress, 100, 'progress clamped');
    // The label is kept verbatim but only ever written with textContent — no markup path.
    assert.strictEqual(panel.rows[0].label, '<img src=x onerror=alert(1)>');
  });

  await check('theme merge clamps and drops unknown keys', () => {
    const t = mergeTheme({
      width: 99999,
      scale: -5,
      text: 'javascript:alert(1)',
      background: { color: '#fff', opacity: 12, fit: 'evil', imagePath: 42, dataUrl: 'data:whatever' },
      bogus: 'x',
    });
    assert.strictEqual(t.width, 600, 'width clamped');
    assert.strictEqual(t.scale, 0.7, 'scale clamped');
    assert.strictEqual(t.text, '#f2f3f5', 'invalid colour falls back');
    assert.strictEqual(t.background.color, '#121317', 'short hex rejected');
    assert.strictEqual(t.background.opacity, 1, 'opacity clamped');
    assert.strictEqual(t.background.fit, 'cover', 'invalid fit falls back');
    assert.strictEqual(t.background.imagePath, null, 'non-string path rejected');
    assert.ok(!('dataUrl' in t.background), 'resolved fields never persist');
    assert.ok(!('bogus' in t), 'unknown keys dropped');
  });

  await check('background image loads once and reports errors', () => {
    const bg = new BackgroundImage();
    const img = path.join(__dirname, '..', 'assets', 'backgrounds', 'aurora.png');
    const state = bg.set(img);
    assert.ok(state.dataUrl.startsWith('data:image/png;base64,'), 'data url built');
    assert.ok(bg.descriptor().key, 'descriptor exposes a key');
    assert.ok(!('dataUrl' in bg.descriptor()), 'descriptor never carries the bytes');

    const missing = bg.set(path.join(tmp, 'nope.png'));
    assert.match(missing.error, /image not found/);
    assert.strictEqual(missing.dataUrl, null);
  });

  host.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(results.join('\n'));
  console.log(process.exitCode ? '\nFAILED' : '\nall passed');
})();
