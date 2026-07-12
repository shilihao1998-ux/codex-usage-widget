# Codex Usage Widget

English | [简体中文](README.zh-CN.md)

A desktop widget that shows how much **OpenAI Codex** quota you have left — the **5-hour** window and the **weekly** window — with live reset countdowns, a themeable card, and a plugin slot for anything else you want on screen.

The numbers are not estimated and not scraped from logs. They come from `account/rateLimits/read` on your local `codex app-server` — **the same call the official Codex app makes to draw its own usage UI**. Reading them starts no thread and sends no turn, so it costs no quota.

![The widget](docs/widget.png)

> Unofficial project. Not affiliated with, endorsed by, or sponsored by OpenAI. "Codex" and "OpenAI" are trademarks of OpenAI; they are used here only to say what this tool talks to.

---

## Requirements

- **Node.js ≥ 18** (uses the global `fetch`)
- **Codex installed and signed in** — the desktop app or the CLI. Check with `codex login status`.
  The widget drives your local `codex` binary in `app-server` mode; if Codex is not installed or not signed in, the card just says it cannot connect.
- A Codex build whose app-server exposes `account/rateLimits/read` (verified against **codex-cli 0.130 / 0.144**). Older builds without that method will report an error instead of showing numbers.
- **Windows** is the tested platform (tray, autostart and `start-widget.vbs` are Windows-specific). The binary lookup and the core are written for macOS/Linux too, but they are untested there.

## Download (Windows)

**[⬇ Get the latest release](https://github.com/shilihao1998-ux/codex-usage-widget/releases/latest)** — no Node, no terminal, no clone.

| File | What it is |
| --- | --- |
| `Codex-Usage-Widget-Setup-<version>.exe` | installer — adds a Start-menu and desktop shortcut |
| `Codex-Usage-Widget-<version>-portable.exe` | portable — just run it, nothing is installed |

Two things to know:

- The binaries are **not code-signed**, so Windows SmartScreen shows a blue "unknown publisher" warning the first time. Click **More info → Run anyway**. (A signing certificate costs real money; this is a free tool.)
- You still need **Codex installed and signed in** — the widget reads your quota from the local Codex app-server. Without it, the card just says it cannot connect.

## Run from source

```bash
git clone https://github.com/shilihao1998-ux/codex-usage-widget.git
cd codex-usage-widget
npm install    # also downloads the Electron binary (~100 MB, from GitHub release assets)
npm start
```

Behind a firewall or on a slow link, point Electron's binary download at a mirror:

```bash
# example: npmmirror
ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ npm install
```

Silent start (no console window): double-click `start-widget.vbs`.
Start with Windows: tray icon → **Start with Windows**.

## Where the numbers come from

Codex clients talk to a local `codex app-server` over stdio JSON-RPC. This widget speaks that protocol:

| Call | Purpose |
| --- | --- |
| `account/rateLimits/read` | the quota snapshot (no parameters) |
| `account/rateLimits/updated` | server push, fires as turns consume quota |
| `account/read` | account email and plan |

Raw payload:

```jsonc
{
  "rateLimits": {
    "limitId": "codex",
    "primary":   { "usedPercent": 12, "windowDurationMins": 300,   "resetsAt": 1783828956 },
    "secondary": { "usedPercent": 22, "windowDurationMins": 10080, "resetsAt": 1784354520 },
    "credits": { "hasCredits": false, "unlimited": false, "balance": "0" },
    "planType": "pro"
  },
  "rateLimitsByLimitId": { "codex": { ... }, "codex_bengalfox": { ... } }
}
```

- `primary` = 300 minutes = the **5-hour** window
- `secondary` = 10080 minutes = the **weekly** window
- `resetsAt` is an absolute Unix timestamp, so countdowns stay correct between polls (and across restarts)
- `rateLimitsByLimitId` may expose separate metering buckets beyond `codex` (on this account, `codex_bengalfox` = GPT-5.3-Codex-Spark). Enable **Show all limit buckets** to see them.

Refresh policy: poll every 60 s, plus an immediate re-read whenever the server pushes `account/rateLimits/updated`.

This is a private protocol between Codex's own components — OpenAI can change or remove it in any release. If they do, the widget will say so rather than guess. The card also marks its own trust level: `cached` (loaded from disk, not yet re-read this session) and `stale` (no successful refresh for over 5 minutes).

`~/.codex/sessions/**/rollout-*.jsonl` also records `rate_limits`, but that is only a snapshot from the last turn — never a live value. `npm run verify` prints the live read next to that logged snapshot so you can compare them.

## The widget

- Drag to move; the position is remembered (and snaps back if the monitor it was on is gone — tray → **Reset position**)
- Hover for ⟳ refresh, ⚙ settings, ⋯ menu, ✕ hide (the tray icon brings it back)
- Tray icon is a ring coloured by remaining quota (>25 % green, ≤25 % amber, ≤10 % red); its tooltip shows both windows
- **Low-quota alerts**: a system notification once per window when the remaining quota crosses 20 % / 10 % (thresholds editable)

### Appearance

Settings → **Appearance**:

- **Background image** — any local image (png/jpg/gif/webp/bmp/avif, ≤ 12 MB); fit: cover / contain / stretch / tile. Three wallpapers ship with the app: in a release build they sit in the app's `resources/backgrounds/` folder, from source in `assets/backgrounds/` (`npm run backgrounds` regenerates them).
- **Image tint** — colour + strength, laid over the photo so text stays readable
- Card colour, opacity, backdrop blur, corner radius, width, text scale
- Colours: text, healthy (> 25 % left), warning (≤ 25 %), critical (≤ 10 %) — gauges, bars and plugin panels all follow

The image is read by the main process and handed to the renderer as a `data:` URL (the page has no Node access and its CSP allows nothing else), so no local-file access is opened up to the page.

![Settings](docs/settings.png)

### Behavior

Settings → **Behavior**: compact mode, show all limit buckets, always on top, window opacity, low-quota alerts and their thresholds.

## Plugins

Panels below the quota rows — weather, disk, stock prices, server status, whatever you want.

**The contract: a plugin fetches data and returns structured rows (label / value / sub / progress / tone). The widget draws them.** Plugins cannot return HTML and cannot reach the renderer, so a third-party plugin can neither break the layout nor touch the page — and it inherits your theme for free.

- Bundled example: `plugins/weather/` (Open-Meteo, no API key; set a city or exact coordinates; disabled by default)
- Your own plugins live in `~/.codex-usage-widget/plugins/<id>/` — Settings → **Plugins** → *Open plugins folder*
- Settings → **Plugins**: enable/disable, edit config JSON, **Reload plugins**, and see plugin errors inline
- Plugin HTTP goes through Electron's `net.fetch`, so it **follows the system proxy**
- ⚠️ **Plugins run in the main process with full Node access** (they can read files and run code). Install only plugins you trust — the same bar as any npm package.
- How to write one: [PLUGINS.md](PLUGINS.md)

## CLI

```bash
node bin/codex-usage.js once          # print the current quota
node bin/codex-usage.js once --json   # ...as JSON
node bin/codex-usage.js watch         # keep printing on change
node bin/codex-usage.js verify        # live read vs. the snapshot Codex logged itself
node bin/codex-usage.js serve --port 7893
```

`serve` exposes a loopback HTTP API for status bars and scripts:

| Endpoint | Returns |
| --- | --- |
| `GET /api/usage` | `{ snapshot, lastError, pollMs }` — `snapshot` holds `primary`, `secondary`, `buckets`, `plan`, `account` |
| `GET /api/history?limit=500` | array of `{ t, plan, buckets: [{ id, p: {u, r}, s: {u, r} }] }` — only rows where the numbers changed |
| `GET /events` | SSE stream of the snapshot object, pushed on every change |

It binds to 127.0.0.1, requires a loopback `Host` header and rejects any request carrying an `Origin` — otherwise a web page could reach it by rebinding DNS to loopback and read your account and usage.

## Privacy

- No telemetry. Nothing is sent anywhere by the app itself.
- Local state lives in `~/.codex-usage-widget/` (override with `CODEX_USAGE_DATA_DIR`): `prefs.json`, `state.json` (last snapshot — **includes your account email and plan**), `history.jsonl` (quota changes over time), and your plugins. It is never written into the repo.
- Authentication is entirely Codex's: this project never reads `~/.codex/auth.json` and never handles a token. It asks the local app-server, which is already signed in.
- Enabled plugins make whatever network calls they make — the bundled weather plugin calls [Open-Meteo](https://open-meteo.com/) (free, no key, CC-BY 4.0 attribution).

## Layout

```
bin/codex-usage.js            CLI: once / watch / serve / verify
src/core/codex-bin.js         finds the codex executable (CODEX_BIN overrides)
src/core/app-server-client.js persistent JSON-RPC connection (reconnects with backoff)
src/core/usage-service.js     polling + push subscription + snapshot persistence
src/core/model.js             raw payload → view model (remaining %, window labels, countdowns)
src/core/store.js             state.json + history.jsonl
src/core/paths.js             data directory (outside the repo)
src/core/theme.js             theme merge/clamp + background image loading
src/core/plugin-host.js       plugin discovery, refresh loops, output normalization
src/ui/                       Electron widget (frameless, always-on-top, tray) + settings window
plugins/weather/              bundled example plugin
tools/make-backgrounds.js     generates assets/backgrounds/
test/plugin-host.test.js      npm test
```

## Environment variables

| Variable | Effect |
| --- | --- |
| `CODEX_BIN` | path to the codex executable (auto-detected; on Windows `%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe`) |
| `CODEX_USAGE_DATA_DIR` | where prefs/state/plugins live (default `~/.codex-usage-widget`) |
| `CODEX_USAGE_KEEP_RAW` | debug: keep the raw app-server response in the snapshot |
| `CODEX_USAGE_SCREENSHOT` | debug: write a PNG of the rendered widget once data lands |
| `CODEX_USAGE_SCREENSHOT_SETTINGS` | debug: also capture the settings window |
| `CODEX_USAGE_SCREENSHOT_EXIT` | debug: quit after capturing |

## Troubleshooting

- **Card stuck on "connecting to codex app-server…"** — make sure Codex is installed and signed in (`codex login status`), or set `CODEX_BIN` to the executable.
- **`codex executable not found`** — set `CODEX_BIN` to the full path.
- **Numbers differ from the usage page on chatgpt.com** — this widget shows Codex *rate-limit windows* (5 h / weekly), which is not the same metric as the web usage report. Tray → *Open usage page* opens the official page to compare.

## Development

```bash
npm test              # plugin host + theme regression tests (no Electron, no Codex needed)
npm run backgrounds   # regenerate the sample wallpapers
```

## License

MIT — see [LICENSE](LICENSE).
