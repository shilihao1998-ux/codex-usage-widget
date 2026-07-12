# Writing a plugin

English | [简体中文](PLUGINS.zh-CN.md)

A plugin renders one extra panel in the widget — weather, disk usage, a stock price, a server's health, anything.

**The contract: your plugin fetches data and returns structured rows. The widget draws them.** A plugin never returns markup and never touches the renderer, so it cannot break the layout or reach the page — and it inherits the user's theme automatically.

> ⚠️ Plugins run in the **main process with full Node access**: they can read files, spawn processes and make network calls. Install only plugins you trust, exactly as you would with any npm package.

## Where plugins live

| Directory | Purpose |
| --- | --- |
| `plugins/` | examples that ship with the repo (e.g. `weather`) |
| `~/.codex-usage-widget/plugins/` | your plugins (Settings → Plugins → **Open plugins folder**) |

One plugin is one folder with two files: `plugin.json` and `index.js`.

## `plugin.json`

```jsonc
{
  "id": "weather",              // required, unique across all plugin folders
  "name": "Weather",            // panel title
  "icon": "🌤",                 // optional, 1–2 characters
  "description": "…",           // shown in the settings window
  "refreshMs": 900000,          // refresh interval; values below 10000 are raised to 10000
  "enabledByDefault": false,    // optional; OMITTING IT MEANS true — a new plugin starts enabled
  "config": {                   // default config; the user edits it in the settings window
    "city": "Shanghai"
  }
}
```

If two folders declare the same `id`, the first one wins and the other is reported as an error — ids must be unique.

## `index.js`

Export `fetch(ctx)` and return the panel data:

```js
exports.fetch = async (ctx) => {
  const data = await ctx.fetchJson(`https://api.example.com/x?q=${ctx.config.city}`);

  return {
    title: 'Panel title',       // optional; defaults to the manifest name
    icon: '🌧',                 // optional; overrides the manifest
    subtitle: 'top-right note', // optional
    rows: [
      {
        label: 'Left-hand label',
        value: '29°C',          // the emphasised value on the right
        sub: 'second line',     // optional
        tone: 'warn',           // ok | warn | crit | muted | default
        progress: 72,           // 0–100, draws a bar (optional)
      },
    ],
  };
};
```

`ctx` gives you:

| Field | Meaning |
| --- | --- |
| `ctx.config` | manifest defaults merged with the user's edits |
| `ctx.fetchJson(url, opts)` | HTTP GET → JSON. Uses Electron's `net.fetch`, so it **follows the system proxy** |
| `ctx.fetchText(url, opts)` | same, returns text |
| `ctx.log(...args)` | logs to the app's stdout, prefixed with the plugin id |

Limits (anything beyond them is trimmed or dropped — a plugin can never crash the widget):

- at most 8 rows; `label` ≤ 40 chars, `value` ≤ 24, `sub` ≤ 64, `title` ≤ 32
- `fetch` is aborted after 20 s and the panel shows the timeout
- throwing shows that error on the panel; other panels keep working
- one run at a time per plugin: if a refresh is still in flight, the next tick is skipped rather than queued

## Debugging

Settings → **Plugins**: toggle a plugin, edit its config JSON, hit **Reload plugins** to pick up code changes (the whole plugin folder is re-required, helper modules included). Errors appear on the plugin card and on the panel itself.

## Example: local disk usage

`~/.codex-usage-widget/plugins/disk/plugin.json`

```json
{ "id": "disk", "name": "Disk", "icon": "💾", "refreshMs": 60000, "config": { "drive": "C:" } }
```

`~/.codex-usage-widget/plugins/disk/index.js`

```js
const { execFileSync } = require('child_process');

exports.fetch = async (ctx) => {
  const out = execFileSync('powershell', [
    '-NoProfile', '-Command',
    `(Get-PSDrive ${ctx.config.drive.replace(':', '')} | Select-Object Used,Free | ConvertTo-Json)`,
  ]).toString();
  const { Used, Free } = JSON.parse(out);
  const total = Used + Free;
  const usedPct = Math.round((Used / total) * 100);

  return {
    rows: [
      {
        label: ctx.config.drive,
        value: `${Math.round(Free / 1e9)} GB free`,
        sub: `${usedPct}% used of ${Math.round(total / 1e9)} GB`,
        progress: usedPct,
        tone: usedPct > 90 ? 'crit' : usedPct > 75 ? 'warn' : 'default',
      },
    ],
  };
};
```

Drop the folder in, click **Reload plugins**, enable it — the panel appears in the widget.
