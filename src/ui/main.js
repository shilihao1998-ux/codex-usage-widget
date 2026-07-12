'use strict';
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  screen,
  shell,
  dialog,
  net,
  Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { UsageService } = require('../core/usage-service');
const { formatDuration } = require('../core/model');
const { burnRate } = require('../core/burn');
const { BackgroundImage, mergeTheme, DEFAULT_THEME } = require('../core/theme');
const { PluginHost } = require('../core/plugin-host');
const { trayIcon } = require('./png');

const { ensureDataDir } = require('../core/paths');

const DATA_DIR = ensureDataDir();
const PREFS_PATH = path.join(DATA_DIR, 'prefs.json');
const USER_PLUGIN_DIR = path.join(DATA_DIR, 'plugins');
// Bundled plugins may ship enabled; anything the user drops in starts disabled.
const PLUGIN_DIRS = [
  { path: path.join(__dirname, '..', '..', 'plugins'), trusted: true },
  { path: USER_PLUGIN_DIR, trusted: false },
];
const BUILTIN_BACKGROUNDS = app.isPackaged
  ? path.join(process.resourcesPath, 'backgrounds')
  : path.join(__dirname, '..', '..', 'assets', 'backgrounds');

const RELEASES_API = 'https://api.github.com/repos/shilihao1998-ux/codex-usage-widget/releases/latest';
const RELEASES_PAGE = 'https://github.com/shilihao1998-ux/codex-usage-widget/releases/latest';

const DEFAULT_PREFS = {
  x: null,
  y: null,
  compact: false,
  showAllBuckets: false,
  opacity: 1,
  alwaysOnTop: true,
  pollSeconds: 60,
  notify: true,
  notifyThresholds: [20, 10],
  notifyAllBuckets: false, // extra buckets (e.g. Spark) stay quiet unless asked
  notifyRefill: true, // only ever fires for a window we already warned about
  showBurnRate: false, // the only estimated number in the product — off by default
  showCredits: true, // renders nothing at all unless the account has credits
  trayMode: 'ring', // ring | both | number
  trayFollow: 'worst', // worst | primary | secondary
  recordHistory: true,
  updateCheck: true, // one unauthenticated GET to api.github.com per day
  height: 176, // last height the renderer asked for; content decides it
  theme: { ...DEFAULT_THEME },
  plugins: {}, // id -> { enabled, config }
};

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 900;

let win = null;
let settingsWin = null;
let tray = null;
let service = null;
let plugins = null;
let trayTicker = null;
let updateTimer = null;
let updateInfo = null; // { latest, url } once a newer release is seen
let prefs = { ...DEFAULT_PREFS };
const background = new BackgroundImage();

function loadPrefs() {
  try {
    const saved = JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8'));
    prefs = { ...DEFAULT_PREFS, ...saved, theme: mergeTheme(saved.theme), plugins: saved.plugins || {} };
  } catch {
    prefs = { ...DEFAULT_PREFS, theme: mergeTheme(null) };
  }
  background.set(prefs.theme.background.imagePath);
}

/**
 * Single funnel for pref writes. Both windows are refreshed, so a change made in
 * the tray menu is reflected in an open settings window and vice versa.
 */
const PREF_KEYS = [
  'compact',
  'showAllBuckets',
  'opacity',
  'alwaysOnTop',
  'notify',
  'notifyThresholds',
  'notifyAllBuckets',
  'notifyRefill',
  'showBurnRate',
  'showCredits',
  'trayMode',
  'trayFollow',
  'recordHistory',
  'updateCheck',
  'pollSeconds',
];

function applyPrefs(patch) {
  for (const key of PREF_KEYS) {
    if (key in patch) prefs[key] = patch[key];
  }
  // Clamp what the service actually runs on, not just what the settings UI offers.
  if ('pollSeconds' in patch) {
    prefs.pollSeconds = Math.round((service?.setPollMs(prefs.pollSeconds * 1000) ?? 60000) / 1000);
  }
  if ('recordHistory' in patch && service) service.recordHistory = !!prefs.recordHistory;

  savePrefs();
  win?.setOpacity(prefs.opacity);
  win?.setAlwaysOnTop(prefs.alwaysOnTop, 'screen-saver');
  applySize();
  pushToRenderer();
  pushToSettings();
  updateTray();
}

/** Single funnel for theme writes, so the image is (re)read exactly when the path changes. */
function setTheme(theme) {
  prefs.theme = mergeTheme(theme);
  background.set(prefs.theme.background.imagePath);
  savePrefs();
  applySize();
  pushToRenderer();
  pushToSettings();
}

function savePrefs() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2));
  } catch {
    /* prefs are best-effort */
  }
}

function statusColor(remaining) {
  if (remaining <= 10) return [244, 96, 84];
  if (remaining <= 25) return [240, 173, 78];
  return [86, 200, 140];
}

function windowSize() {
  const width = Math.max(200, Math.min(600, Math.round(prefs.theme.width || DEFAULT_THEME.width)));
  const height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(prefs.height || 176)));
  return { width, height };
}

/**
 * When run unpackaged, `process.execPath` is electron.exe, which needs the app
 * directory passed as an argument or it would start an empty Electron shell.
 */
function loginItemArgs() {
  return app.isPackaged ? [] : [path.resolve(app.getAppPath())];
}

function loginItemSettings() {
  return app.getLoginItemSettings({ path: process.execPath, args: loginItemArgs() });
}

function setOpenAtLogin(openAtLogin) {
  app.setLoginItemSettings({
    openAtLogin,
    path: process.execPath,
    args: loginItemArgs(),
  });
}

function defaultPosition(width, height) {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - width - 24, y: area.y + 24 };
}

/**
 * A frameless, taskbar-less window placed off-screen (monitor unplugged since
 * last run) is unreachable — the tray "show" just re-shows it where it isn't.
 * So a restored position is only honoured if it still overlaps a real display.
 */
function visiblePosition(width, height) {
  if (prefs.x == null || prefs.y == null) return defaultPosition(width, height);
  const MIN_VISIBLE = 40;
  const fits = screen.getAllDisplays().some(({ workArea: a }) => {
    const overlapX = Math.min(prefs.x + width, a.x + a.width) - Math.max(prefs.x, a.x);
    const overlapY = Math.min(prefs.y + height, a.y + a.height) - Math.max(prefs.y, a.y);
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
  });
  return fits ? { x: prefs.x, y: prefs.y } : defaultPosition(width, height);
}

function resetPosition() {
  if (!win) return;
  const { width, height } = windowSize();
  const { x, y } = defaultPosition(width, height);
  prefs.x = x;
  prefs.y = y;
  savePrefs();
  win.setPosition(x, y, false);
  win.show();
}

function createWindow() {
  const { width, height } = windowSize();
  const { x, y } = visiblePosition(width, height);

  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: prefs.alwaysOnTop,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(prefs.alwaysOnTop, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setOpacity(prefs.opacity);
  win.loadFile(path.join(__dirname, 'index.html'));

  win.on('moved', () => {
    const [nx, ny] = win.getPosition();
    prefs.x = nx;
    prefs.y = ny;
    savePrefs();
  });
  win.on('closed', () => {
    win = null;
  });
}

/** Width is a user setting; height follows the rendered content (see `ui:resize`). */
function applySize() {
  if (!win) return;
  const { width, height } = windowSize();
  win.setSize(width, height, false);
}

function applyHeight(height) {
  if (!win) return;
  const h = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)));
  if (h === prefs.height && win.getSize()[1] === h) return;
  prefs.height = h;
  savePrefs();
  win.setSize(windowSize().width, h, false);
}

/**
 * Countdowns must come from the absolute `resetsAt`, never from the `resetsInSec`
 * captured at fetch time — that value is persisted to disk and would be wrong by
 * however long the widget was closed.
 */
function resetsIn(win) {
  if (!win) return '--';
  if (win.resetsAt == null) return 'unknown';
  return formatDuration(Math.max(0, Math.round((win.resetsAt - Date.now()) / 1000)));
}

function windowLine(label, win) {
  if (!win) return `${label}: --`;
  return `${label}: ${win.remainingPercent}% left · resets in ${resetsIn(win)}`;
}

function buildTrayMenu() {
  const snap = service?.snapshot;
  const stale = snap?.cached || !!service?.lastError;
  return Menu.buildFromTemplate([
    { label: windowLine('5h', snap?.primary), enabled: false },
    { label: windowLine('Weekly', snap?.secondary), enabled: false },
    ...(stale
      ? [{ label: service?.lastError ? `⚠ stale: ${service.lastError}` : '⚠ cached data', enabled: false }]
      : []),
    ...(updateInfo
      ? [
          { type: 'separator' },
          {
            label: `⬆ Update available: v${updateInfo.latest}`,
            click: () => shell.openExternal(updateInfo.url),
          },
        ]
      : []),
    { type: 'separator' },
    { label: 'Settings…', click: () => openSettings() },
    { label: 'Refresh now', click: () => service?.refresh().catch(() => {}) },
    {
      label: 'Compact mode',
      type: 'checkbox',
      checked: prefs.compact,
      click: (item) => applyPrefs({ compact: item.checked }),
    },
    {
      label: 'Show all limit buckets',
      type: 'checkbox',
      checked: prefs.showAllBuckets,
      click: (item) => applyPrefs({ showAllBuckets: item.checked }),
    },
    {
      label: `Low-quota alerts (${prefs.notifyThresholds.join('% / ')}%)`,
      type: 'checkbox',
      checked: prefs.notify,
      click: (item) => applyPrefs({ notify: item.checked }),
    },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: prefs.alwaysOnTop,
      click: (item) => applyPrefs({ alwaysOnTop: item.checked }),
    },
    {
      label: 'Opacity',
      submenu: [1, 0.9, 0.75, 0.6].map((o) => ({
        label: `${Math.round(o * 100)}%`,
        type: 'radio',
        checked: Math.abs(prefs.opacity - o) < 0.01,
        click: () => {
          applyPrefs({ opacity: o });
        },
      })),
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: loginItemSettings().openAtLogin,
      click: (item) => setOpenAtLogin(item.checked),
    },
    { type: 'separator' },
    { label: 'Open usage page', click: () => shell.openExternal('https://chatgpt.com/codex/settings/usage') },
    { label: 'Show / hide widget', click: () => (win?.isVisible() ? win.hide() : win?.show()) },
    { label: 'Reset position', click: () => resetPosition() },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

/** Which window the tray icon speaks for. */
function trayWindow(snap) {
  if (!snap) return null;
  if (prefs.trayFollow === 'primary') return snap.primary ?? null;
  if (prefs.trayFollow === 'secondary') return snap.secondary ?? null;
  const p = snap.primary?.remainingPercent ?? 100;
  const s = snap.secondary?.remainingPercent ?? 100;
  return (p <= s ? snap.primary : snap.secondary) ?? null;
}

function updateTray() {
  if (!tray) return;
  const snap = service?.snapshot;
  const shown = trayWindow(snap)?.remainingPercent ?? 100;
  const icon = nativeImage.createFromBuffer(trayIcon(shown, statusColor(shown), prefs.trayMode));
  tray.setImage(icon);
  tray.setToolTip(
    snap
      ? `Codex — ${windowLine('5h', snap.primary)}\n${windowLine('Weekly', snap.secondary)}` +
          (service?.lastError ? `\n⚠ stale: ${service.lastError}` : '')
      : 'Codex usage — loading…'
  );
  tray.setContextMenu(buildTrayMenu());
}

/**
 * Burn rate for the main bucket's two windows — an ESTIMATE, computed from our
 * own history, and only when the user has asked for it.
 */
function burnEstimates() {
  if (!prefs.showBurnRate || !service?.snapshot) return null;
  const history = service.store.readHistory(500);
  const main = service.snapshot.buckets.find((b) => b.isPrimaryBucket) || service.snapshot.buckets[0];
  if (!main) return null;
  return {
    primary: burnRate(history, { bucketId: main.id, key: 'p' }),
    secondary: burnRate(history, { bucketId: main.id, key: 's' }),
  };
}

/**
 * The background image is deliberately absent here: it is fetched once over
 * `theme:image` when its key changes, instead of riding along on every push.
 */
function widgetState() {
  return {
    snapshot: service?.snapshot ?? null,
    error: service?.lastError ?? null,
    prefs,
    theme: { ...prefs.theme, background: { ...prefs.theme.background, ...background.descriptor() } },
    panels: plugins?.panels() ?? [],
    burn: burnEstimates(),
    update: updateInfo,
  };
}

function pushToRenderer() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('usage:update', widgetState());
}

function pushToSettings() {
  if (!settingsWin || settingsWin.isDestroyed()) return;
  settingsWin.webContents.send('settings:update', settingsState());
}

/** The wallpapers we ship — otherwise they are unreachable without a file dialog. */
function builtinBackgrounds() {
  try {
    return fs
      .readdirSync(BUILTIN_BACKGROUNDS)
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .map((f) => ({ name: path.parse(f).name, path: path.join(BUILTIN_BACKGROUNDS, f) }));
  } catch {
    return [];
  }
}

function settingsState() {
  return {
    prefs,
    version: app.getVersion(),
    update: updateInfo,
    theme: { ...prefs.theme, background: { ...prefs.theme.background, ...background.descriptor() } },
    plugins: plugins?.list() ?? [],
    pluginDirs: PLUGIN_DIRS.map((d) => d.path),
    builtinBackgrounds: builtinBackgrounds(),
    dataDir: DATA_DIR,
    historyRows: service?.store.readHistory(100000).length ?? 0,
  };
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 520,
    height: 640,
    title: 'Codex Usage Widget — Settings',
    autoHideMenuBar: true,
    backgroundColor: '#16171b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

const alerted = new Set(); // "<bucket>:<window>:<threshold>:<resetsAt>" already warned about
const warnedWindows = new Set(); // "<bucket>:<window>" currently in a warned state

/** Every window of every bucket the user has asked to watch — not just the main one. */
function watchedWindows(snap) {
  const out = [];
  for (const bucket of snap.buckets || []) {
    if (!bucket.isPrimaryBucket && !prefs.notifyAllBuckets) continue;
    const prefix = bucket.isPrimaryBucket ? '' : `${bucket.name} `;
    if (bucket.primary) out.push({ key: `${bucket.id}:p`, label: `${prefix}5h`, win: bucket.primary });
    if (bucket.secondary) out.push({ key: `${bucket.id}:s`, label: `${prefix}Weekly`, win: bucket.secondary });
  }
  return out;
}

/**
 * Warn once per threshold per window instance, and say so when the quota comes
 * back. Keying on `resetsAt` means a fresh window can warn again, but a re-poll
 * of the same one cannot.
 */
function checkThresholds(snap) {
  if (!prefs.notify || !Notification.isSupported() || !snap || snap.cached) return;

  for (const { key, label, win } of watchedWindows(snap)) {
    const crossed = prefs.notifyThresholds.filter((t) => win.remainingPercent <= t).sort((a, b) => a - b);

    if (!crossed.length) {
      // Recovered: only worth saying if we were the ones who raised the alarm.
      if (warnedWindows.has(key)) {
        warnedWindows.delete(key);
        if (prefs.notifyRefill) {
          new Notification({
            title: `Codex ${label} quota is back`,
            body: `${win.remainingPercent}% available again`,
          }).show();
        }
      }
      continue;
    }

    if (alerted.size > 200) alerted.clear(); // keys accumulate as windows roll over
    const keys = crossed.map((t) => `${key}:${t}:${win.resetsAt}`);
    const isNew = keys.some((k) => !alerted.has(k));
    keys.forEach((k) => alerted.add(k));
    warnedWindows.add(key);
    if (!isNew) continue;

    new Notification({
      title: `Codex ${label} quota low`,
      body: `${win.remainingPercent}% left · resets in ${resetsIn(win)}`,
    }).show();
  }
}

/** Debug hook: CODEX_USAGE_SCREENSHOT=<path> dumps the rendered widget once data lands. */
let shotTaken = false;
async function screenshotIfRequested() {
  const out = process.env.CODEX_USAGE_SCREENSHOT;
  if (!out || !win || shotTaken) return;
  shotTaken = true;
  await new Promise((r) => setTimeout(r, Number(process.env.CODEX_USAGE_SCREENSHOT_DELAY) || 700));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());

  const settingsOut = process.env.CODEX_USAGE_SCREENSHOT_SETTINGS;
  if (settingsOut) {
    openSettings();
    await new Promise((r) => setTimeout(r, 1500));
    const shot = await settingsWin.webContents.capturePage();
    fs.writeFileSync(settingsOut, shot.toPNG());
  }
  if (process.env.CODEX_USAGE_SCREENSHOT_EXIT) app.quit();
}

function startService() {
  service = new UsageService({
    pollMs: (prefs.pollSeconds || 60) * 1000,
    dataDir: DATA_DIR,
    recordHistory: prefs.recordHistory,
  });
  service.on('snapshot', (snap) => {
    pushToRenderer();
    updateTray();
    checkThresholds(snap);
    screenshotIfRequested().catch(() => {});
  });
  service.on('service-error', () => {
    pushToRenderer();
    updateTray();
  });
  service.start().catch(() => pushToRenderer());
}

/** Compare "1.2.0" style versions; returns true when `a` is newer than `b`. */
function isNewer(a, b) {
  const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y, z] = parse(a);
  const [p, q, r] = parse(b);
  return x !== p ? x > p : y !== q ? y > q : z > r;
}

/**
 * We read an undocumented Codex API; when OpenAI changes it, a frozen install
 * would quietly show wrong numbers. So the app checks once a day whether a newer
 * release exists — an unauthenticated GET to GitHub, no identifiers, no download.
 * It never installs anything, and it can be switched off.
 */
async function checkForUpdate() {
  if (!prefs.updateCheck) return;
  try {
    const res = await net.fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json' } });
    if (!res.ok) return;
    const { tag_name: tag } = await res.json();
    if (tag && isNewer(tag, app.getVersion())) {
      updateInfo = { latest: String(tag).replace(/^v/, ''), url: RELEASES_PAGE };
      updateTray();
      pushToRenderer();
      pushToSettings();
    }
  } catch {
    /* offline or rate-limited: silently skip, this is never load-bearing */
  }
}

/**
 * A widget parked on a monitor that is now unplugged is invisible, and the tray's
 * "show" would only re-show it where it isn't — so re-place it whenever the
 * display layout changes.
 */
function watchDisplays() {
  let pending = null;
  const reposition = () => {
    clearTimeout(pending); // docking fires a burst of events
    pending = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [width, height] = win.getSize();
      const [x, y] = win.getPosition();
      prefs.x = x;
      prefs.y = y;
      const safe = visiblePosition(width, height);
      if (safe.x !== x || safe.y !== y) {
        prefs.x = safe.x;
        prefs.y = safe.y;
        savePrefs();
        win.setPosition(safe.x, safe.y, false);
      }
    }, 500);
  };
  screen.on('display-removed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-metrics-changed', reposition);
}

function startPlugins() {
  plugins = new PluginHost({
    dirs: PLUGIN_DIRS,
    getSettings: () => prefs.plugins,
    fetchImpl: (url, opts) => net.fetch(url, opts), // follows the system proxy
  });
  plugins.on('panels', () => {
    pushToRenderer();
    pushToSettings();
  });
  plugins.on('plugin-error', ({ dir, message }) => console.error(`[plugin] ${dir}: ${message}`));
  plugins.on('plugin-log', ({ id, args }) => console.log(`[plugin:${id}]`, ...args));
  fs.mkdirSync(path.join(DATA_DIR, 'plugins'), { recursive: true });
  plugins.load();
}

// Exit before any window, tray or app-server child exists; app.quit() alone
// would still let whenReady() run and boot a second full instance.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

app.on('second-instance', () => {
  if (!win) return;
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  loadPrefs();
  createWindow();

  tray = new Tray(nativeImage.createFromBuffer(trayIcon(100, statusColor(100), prefs.trayMode)));
  tray.on('click', () => (win?.isVisible() ? win.focus() : win?.show()));
  updateTray();

  // The tooltip and menu show live countdowns, so they need re-rendering between polls.
  trayTicker = setInterval(updateTray, 30000);

  startService();
  startPlugins();
  watchDisplays();

  checkForUpdate();
  updateTimer = setInterval(checkForUpdate, 24 * 60 * 60 * 1000);

  ipcMain.handle('usage:get', () => widgetState());
  ipcMain.handle('usage:refresh', async () => {
    try {
      await service.refresh();
    } catch {
      /* surfaced through service-error */
    }
    return widgetState();
  });
  ipcMain.on('ui:menu', () => tray?.popUpContextMenu(buildTrayMenu()));
  ipcMain.on('ui:hide', () => win?.hide());
  ipcMain.on('ui:settings', () => openSettings());
  ipcMain.on('ui:resize', (_e, height) => applyHeight(height));

  ipcMain.handle('settings:get', () => settingsState());

  ipcMain.handle('theme:image', () => background.dataUrl());

  ipcMain.handle('settings:set-theme', (_e, patch) => {
    setTheme({ ...prefs.theme, ...patch });
    return settingsState();
  });

  ipcMain.handle('settings:set-prefs', (_e, patch) => {
    applyPrefs(patch);
    return settingsState();
  });

  ipcMain.handle('settings:pick-image', async () => {
    const res = await dialog.showOpenDialog(settingsWin ?? win, {
      title: 'Choose a background image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'] }],
    });
    if (res.canceled || !res.filePaths[0]) return settingsState();
    setTheme({ ...prefs.theme, background: { ...prefs.theme.background, imagePath: res.filePaths[0] } });
    return settingsState();
  });

  ipcMain.handle('settings:reset-theme', () => {
    setTheme(null);
    return settingsState();
  });

  ipcMain.handle('plugins:set', (_e, { id, enabled, config }) => {
    const current = prefs.plugins[id] || {};
    prefs.plugins[id] = {
      enabled: enabled ?? current.enabled,
      config: config ?? current.config ?? {},
    };
    savePrefs();
    plugins?.apply(id);
    pushToRenderer();
    return settingsState();
  });

  ipcMain.handle('plugins:reload', () => {
    plugins?.load();
    return settingsState();
  });

  ipcMain.handle('plugins:open-dir', () => {
    fs.mkdirSync(USER_PLUGIN_DIR, { recursive: true });
    shell.openPath(USER_PLUGIN_DIR);
    return settingsState();
  });

  ipcMain.handle('data:open-dir', () => {
    shell.openPath(DATA_DIR);
    return settingsState();
  });

  ipcMain.handle('data:clear-history', () => {
    service?.clearHistory();
    pushToRenderer();
    return settingsState();
  });

  ipcMain.handle('data:export', async (_e, format) => {
    const rows = service?.store.readHistory(100000) ?? [];
    const isCsv = format === 'csv';
    const res = await dialog.showSaveDialog(settingsWin ?? win, {
      title: 'Export usage history',
      defaultPath: `codex-usage-history.${isCsv ? 'csv' : 'json'}`,
      filters: [{ name: isCsv ? 'CSV' : 'JSON', extensions: [isCsv ? 'csv' : 'json'] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };

    const body = isCsv ? toCsv(rows) : JSON.stringify(rows, null, 2);
    try {
      fs.writeFileSync(res.filePath, body);
      return { saved: true, path: res.filePath, rows: rows.length };
    } catch (err) {
      return { saved: false, error: err.message };
    }
  });

  ipcMain.handle('check-update', async () => {
    await checkForUpdate();
    return { version: app.getVersion(), update: updateInfo };
  });
});

/** One row per window per sample — the shape a spreadsheet or pandas actually wants. */
function toCsv(rows) {
  const lines = ['timestamp,iso,plan,bucket,window,used_percent,remaining_percent,resets_at'];
  for (const row of rows) {
    for (const bucket of row.buckets || []) {
      for (const [key, label] of [
        ['p', '5h'],
        ['s', 'weekly'],
      ]) {
        const win = bucket[key];
        if (!win) continue;
        lines.push(
          [
            row.t,
            new Date(row.t).toISOString(),
            row.plan ?? '',
            bucket.id,
            label,
            win.u,
            100 - win.u,
            win.r ?? '',
          ].join(',')
        );
      }
    }
  }
  return lines.join('\n') + '\n';
}

// Subscribing keeps the app alive in the tray when the widget window is closed.
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  if (trayTicker) clearInterval(trayTicker);
  if (updateTimer) clearInterval(updateTimer);
  service?.stop();
  plugins?.stop();
});
