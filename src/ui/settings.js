'use strict';

const $ = (id) => document.getElementById(id);
let state = null;

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const p of document.querySelectorAll('.page')) {
      p.classList.toggle('active', p.id === `page-${tab.dataset.tab}`);
    }
  });
}

const THEME_CONTROLS = [
  { id: 'blur', path: ['blur'], type: 'number', out: 'blurOut', suffix: 'px' },
  { id: 'radius', path: ['radius'], type: 'number', out: 'radiusOut', suffix: 'px' },
  { id: 'width', path: ['width'], type: 'number', out: 'widthOut', suffix: 'px' },
  { id: 'scale', path: ['scale'], type: 'number', out: 'scaleOut', suffix: '×' },
  { id: 'text', path: ['text'], type: 'color' },
  { id: 'accent', path: ['accent'], type: 'color' },
  { id: 'warn', path: ['warn'], type: 'color' },
  { id: 'crit', path: ['crit'], type: 'color' },
  { id: 'bgColor', path: ['background', 'color'], type: 'color' },
  { id: 'bgOpacity', path: ['background', 'opacity'], type: 'number', out: 'bgOpacityOut' },
  { id: 'fit', path: ['background', 'fit'], type: 'text' },
  { id: 'overlayColor', path: ['overlay', 'color'], type: 'color' },
  { id: 'overlayStrength', path: ['overlay', 'strength'], type: 'number', out: 'overlayStrengthOut' },
];

function themePatch(control, value) {
  const [top, leaf] = control.path;
  if (!leaf) return { [top]: value };
  return { [top]: { ...state.theme[top], [leaf]: value } };
}

function wireThemeControls() {
  for (const control of THEME_CONTROLS) {
    const el = $(control.id);
    const event = control.type === 'text' ? 'change' : 'input';
    el.addEventListener(event, async () => {
      const value = control.type === 'number' ? Number(el.value) : el.value;
      if (control.out) $(control.out).textContent = format(control, value);
      state = await window.codexSettings.setTheme(themePatch(control, value));
    });
  }
}

function format(control, value) {
  if (control.suffix) return `${value}${control.suffix}`;
  return `${Math.round(value * 100)}%`;
}

function renderTheme() {
  const t = state.theme;
  for (const control of THEME_CONTROLS) {
    const [top, leaf] = control.path;
    const value = leaf ? t[top][leaf] : t[top];
    $(control.id).value = value;
    if (control.out) $(control.out).textContent = format(control, value);
  }
  $('imagePath').textContent = t.background.imagePath || 'no image — solid colour';
  $('imageError').hidden = !t.background.error;
  $('imageError').textContent = t.background.error || '';
}

const CHECKBOXES = [
  'compact',
  'showAllBuckets',
  'showCredits',
  'showBurnRate',
  'alwaysOnTop',
  'notify',
  'notifyRefill',
  'notifyAllBuckets',
  'recordHistory',
  'updateCheck',
];

const SELECTS = ['trayMode', 'trayFollow', 'pollSeconds'];

function renderBehavior() {
  const p = state.prefs;
  for (const id of CHECKBOXES) $(id).checked = !!p[id];
  for (const id of SELECTS) $(id).value = String(p[id]);
  $('thresholds').value = (p.notifyThresholds || []).join(', ');
  $('winOpacity').value = p.opacity ?? 1;
  $('winOpacityOut').textContent = `${Math.round((p.opacity ?? 1) * 100)}%`;
}

function renderData() {
  const rows = state.historyRows ?? 0;
  $('dataStats').textContent = state.prefs.recordHistory
    ? `${rows} change${rows === 1 ? '' : 's'} recorded so far.`
    : `Recording is off. ${rows} row${rows === 1 ? '' : 's'} already on disk.`;
  $('dataDir').textContent = state.dataDir || '';
  $('versionInfo').textContent = state.update
    ? `You are on v${state.version} — v${state.update.latest} is available.`
    : `You are on v${state.version} — up to date as of the last check.`;
}

/** The wallpapers we ship, as a clickable strip — otherwise they are unreachable. */
function renderWallpapers() {
  const strip = $('wallpapers');
  strip.innerHTML = '';
  for (const wp of state.builtinBackgrounds || []) {
    const button = document.createElement('button');
    button.className = 'wallpaper';
    button.textContent = wp.name;
    button.title = wp.path;
    button.classList.toggle('active', state.theme.background.imagePath === wp.path);
    button.addEventListener('click', async () => {
      state = await window.codexSettings.setTheme({
        background: { ...state.theme.background, imagePath: wp.path },
      });
      renderTheme();
    });
    strip.appendChild(button);
  }
}

/** True while a config editor holds focus or unsaved text — re-rendering would discard it. */
function editingPluginConfig() {
  const active = document.activeElement;
  if (active && active.classList.contains('plugin-config-json')) return true;
  return [...document.querySelectorAll('.plugin-config-json')].some((el) => el.dataset.dirty === '1');
}

function renderPlugins() {
  if (editingPluginConfig()) return;
  const list = $('pluginList');
  list.innerHTML = '';
  if (!state.plugins.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No plugins found.';
    list.appendChild(empty);
    return;
  }

  const tpl = $('plugin-tpl');
  for (const plugin of state.plugins) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.plugin-icon').textContent = plugin.icon || '🔌';
    node.querySelector('.plugin-name').textContent = plugin.name;
    node.querySelector('.plugin-desc').textContent = plugin.description || '';

    const err = node.querySelector('.plugin-error');
    err.hidden = !plugin.error;
    err.textContent = plugin.error || '';

    const toggle = node.querySelector('.plugin-enabled');
    toggle.checked = plugin.enabled;
    toggle.addEventListener('change', async () => {
      state = await window.codexSettings.setPlugin({ id: plugin.id, enabled: toggle.checked });
      render();
    });

    const editor = node.querySelector('.plugin-config-json');
    editor.value = JSON.stringify(plugin.config ?? {}, null, 2);
    editor.addEventListener('input', () => {
      editor.dataset.dirty = '1';
    });

    const status = node.querySelector('.plugin-status');
    node.querySelector('.plugin-save').addEventListener('click', async () => {
      let config;
      try {
        config = JSON.parse(editor.value);
      } catch (e) {
        status.textContent = `invalid JSON: ${e.message}`;
        status.classList.add('error');
        return;
      }
      status.classList.remove('error');
      status.textContent = 'saved — refreshing…';
      editor.dataset.dirty = '0';
      state = await window.codexSettings.setPlugin({ id: plugin.id, config });
      setTimeout(() => (status.textContent = ''), 2000);
    });

    list.appendChild(node);
  }
}

/** Don't yank a control out from under the user: a push mid-drag would snap the slider back. */
function isEditing(pageId) {
  const active = document.activeElement;
  return !!active && active.closest(`#${pageId}`) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
}

function render() {
  if (!isEditing('page-appearance')) {
    renderTheme();
    renderWallpapers();
  }
  if (!isEditing('page-behavior')) renderBehavior();
  if (!isEditing('page-data')) renderData();
  renderPlugins();
}

$('pickImage').addEventListener('click', async () => {
  state = await window.codexSettings.pickImage();
  renderTheme();
});

$('clearImage').addEventListener('click', async () => {
  state = await window.codexSettings.setTheme({ background: { ...state.theme.background, imagePath: null } });
  renderTheme();
});

$('resetTheme').addEventListener('click', async () => {
  state = await window.codexSettings.resetTheme();
  renderTheme();
});

$('reloadPlugins').addEventListener('click', async () => {
  state = await window.codexSettings.reloadPlugins();
  renderPlugins();
});

$('openPluginDir').addEventListener('click', () => window.codexSettings.openPluginDir());

for (const id of CHECKBOXES) {
  $(id).addEventListener('change', async () => {
    state = await window.codexSettings.setPrefs({ [id]: $(id).checked });
    if (id === 'recordHistory') renderData();
  });
}

for (const id of SELECTS) {
  $(id).addEventListener('change', async () => {
    const value = id === 'pollSeconds' ? Number($(id).value) : $(id).value;
    state = await window.codexSettings.setPrefs({ [id]: value });
  });
}

$('openDataDir').addEventListener('click', () => window.codexSettings.openDataDir());

$('clearHistory').addEventListener('click', async () => {
  state = await window.codexSettings.clearHistory();
  $('dataStatus').textContent = 'History cleared.';
  renderData();
  setTimeout(() => ($('dataStatus').textContent = ''), 2500);
});

for (const [id, format] of [
  ['exportJson', 'json'],
  ['exportCsv', 'csv'],
]) {
  $(id).addEventListener('click', async () => {
    const res = await window.codexSettings.exportHistory(format);
    $('dataStatus').textContent = res.saved
      ? `Exported ${res.rows} row${res.rows === 1 ? '' : 's'} to ${res.path}`
      : res.error
        ? `Export failed: ${res.error}`
        : '';
    setTimeout(() => ($('dataStatus').textContent = ''), 4000);
  });
}

$('checkUpdate').addEventListener('click', async () => {
  $('versionInfo').textContent = 'checking…';
  const res = await window.codexSettings.checkUpdate();
  state = await window.codexSettings.get();
  $('versionInfo').textContent = res.update
    ? `You are on v${res.version} — v${res.update.latest} is available.`
    : `You are on v${res.version} — no newer release found.`;
});

$('winOpacity').addEventListener('input', async () => {
  const value = Number($('winOpacity').value);
  $('winOpacityOut').textContent = `${Math.round(value * 100)}%`;
  state = await window.codexSettings.setPrefs({ opacity: value });
});

$('thresholds').addEventListener('change', async () => {
  const values = $('thresholds')
    .value.split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0 && v <= 100)
    .sort((a, b) => b - a);
  state = await window.codexSettings.setPrefs({ notifyThresholds: values });
  $('thresholds').value = values.join(', ');
});

window.codexSettings.onUpdate((payload) => {
  state = payload;
  render(); // prefs can change from the tray menu too, not just from this window
});

(async () => {
  state = await window.codexSettings.get();
  wireThemeControls();
  render();
})();
