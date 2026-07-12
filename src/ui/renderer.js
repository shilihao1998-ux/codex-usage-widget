'use strict';

const rowsEl = document.getElementById('rows');
const panelsEl = document.getElementById('panels');
const extrasEl = document.getElementById('extras');
const planEl = document.getElementById('plan');
const sourceEl = document.getElementById('source');
const staleEl = document.getElementById('stale');
const cardEl = document.getElementById('card');
const bgEl = document.getElementById('bg');
const rowTpl = document.getElementById('row-tpl');
const panelTpl = document.getElementById('panel-tpl');
const panelRowTpl = document.getElementById('panel-row-tpl');

let state = { snapshot: null, error: null, prefs: {}, theme: null, panels: [], strings: {} };

/** Chrome is translated; anything the server said is printed verbatim. */
function tr(key, vars = {}) {
  const template = state.strings?.[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => (vars[name] != null ? String(vars[name]) : ''));
}

function color(remaining) {
  if (remaining <= 10) return 'var(--crit)';
  if (remaining <= 25) return 'var(--warn)';
  return 'var(--ok)';
}

function duration(sec) {
  if (sec == null) return '--';
  if (sec <= 0) return 'now';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function clockAt(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
  if (!m) return `rgba(18,19,23,${alpha})`;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

const FIT_TO_CSS = {
  cover: { size: 'cover', repeat: 'no-repeat' },
  contain: { size: 'contain', repeat: 'no-repeat' },
  stretch: { size: '100% 100%', repeat: 'no-repeat' },
  tile: { size: 'auto', repeat: 'repeat' },
};

let imageKey = null;

function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement.style;
  root.setProperty('--card-bg', hexToRgba(theme.background.color, theme.background.opacity));
  // The gauge's inner disc must be opaque, or the conic gradient shows through it.
  root.setProperty('--disc', hexToRgba(theme.background.color, 1));
  root.setProperty('--overlay', hexToRgba(theme.overlay.color, theme.overlay.strength));
  root.setProperty('--blur', `${theme.blur}px`);
  root.setProperty('--radius', `${theme.radius}px`);
  root.setProperty('--scale', String(theme.scale));
  root.setProperty('--fg', theme.text);
  root.setProperty('--ok', theme.accent);
  root.setProperty('--warn', theme.warn);
  root.setProperty('--crit', theme.crit);

  const fit = FIT_TO_CSS[theme.background.fit] || FIT_TO_CSS.cover;
  bgEl.style.backgroundSize = fit.size;
  bgEl.style.backgroundRepeat = fit.repeat;
  document.getElementById('bgOverlay').style.display = theme.background.key ? 'block' : 'none';

  // The image is megabytes wide, so main sends only its key; fetch the bytes
  // once, when that key changes.
  if (theme.background.key === imageKey) return;
  imageKey = theme.background.key;
  if (!imageKey) {
    bgEl.style.backgroundImage = 'none';
    return;
  }
  window.codexUsage.getBackgroundImage().then((dataUrl) => {
    bgEl.style.backgroundImage = dataUrl ? `url("${dataUrl}")` : 'none';
    syncHeight();
  });
}

/**
 * The one estimated line in the product. It is muted, prefixed with `~`, tagged
 * `est.`, and never colours the ring or the tray — a guess must not be able to
 * impersonate a number Codex gave us.
 */
function burnLine(burn) {
  if (!burn) return tr('card.measuring');
  const rate = burn.percentPerHour;
  const rateText = `~${rate < 10 ? rate.toFixed(1) : Math.round(rate)}%/h`;
  const verdict =
    burn.exhaustsBeforeReset === true && burn.exhaustAt
      ? tr('card.runsOut', { t: clockAt(burn.exhaustAt) })
      : tr('card.lastsPastReset');
  return `${rateText} · ${verdict} · ${tr('card.est')}`;
}

/** The two standard windows get translated names; anything else keeps the server's label. */
function windowLabel(win) {
  if (win.windowMinutes === 300) return tr('window.5h');
  if (win.windowMinutes === 10080) return tr('window.weekly');
  return win.windowLabel || '';
}

function windowRow(label, win, burn) {
  const node = rowTpl.content.firstElementChild.cloneNode(true);
  const remaining = win.remainingPercent;
  const c = color(remaining);

  const ring = node.querySelector('.ring');
  ring.style.setProperty('--pct', remaining);
  ring.style.setProperty('--c', c);
  node.querySelector('.ring-val').textContent = `${remaining}%`;

  node.querySelector('.label').textContent = label;
  node.querySelector('.left').textContent = tr('card.used', { n: win.usedPercent });

  const fill = node.querySelector('.fill');
  fill.style.width = `${remaining}%`;
  fill.style.setProperty('--c', c);

  const reset = node.querySelector('.reset');
  reset.dataset.resetsAt = win.resetsAt ?? '';
  reset.textContent = win.resetsAt
    ? tr('card.resetsIn', {
        d: duration(Math.max(0, Math.round((win.resetsAt - Date.now()) / 1000))),
        t: clockAt(win.resetsAt),
      })
    : tr('card.noReset');

  if (state.prefs.showBurnRate) {
    const est = document.createElement('div');
    est.className = 'estimate';
    est.textContent = burnLine(burn);
    node.querySelector('.meta').appendChild(est);
  }
  return node;
}

/** Plugin panels: the plugin supplies data only, this is the only code that draws it. */
function pluginPanel(panel) {
  const node = panelTpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.panel-icon').textContent = panel.icon || '';
  node.querySelector('.panel-name').textContent = panel.name || panel.id;
  node.querySelector('.panel-subtitle').textContent = panel.subtitle || '';

  const body = node.querySelector('.panel-rows');
  if (panel.error) {
    const err = document.createElement('div');
    err.className = 'panel-error';
    err.textContent = panel.error;
    body.appendChild(err);
    return node;
  }
  if (panel.loading && !panel.rows.length) {
    const load = document.createElement('div');
    load.className = 'panel-loading';
    load.textContent = 'loading…';
    body.appendChild(load);
    return node;
  }

  for (const row of panel.rows) {
    const r = panelRowTpl.content.firstElementChild.cloneNode(true);
    r.classList.add(`tone-${row.tone || 'default'}`);
    r.querySelector('.panel-label').textContent = row.label;
    r.querySelector('.panel-value').textContent = row.value;

    const sub = r.querySelector('.panel-sub');
    if (row.sub) sub.textContent = row.sub;
    else sub.remove();

    const track = r.querySelector('.panel-track');
    if (row.progress == null) {
      track.remove();
    } else {
      const fill = r.querySelector('.panel-fill');
      fill.style.width = `${row.progress}%`;
      const tone = { ok: 'var(--ok)', warn: 'var(--warn)', crit: 'var(--crit)' }[row.tone];
      if (tone) fill.style.setProperty('--c', tone);
    }
    body.appendChild(r);
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function formatTokens(n) {
  if (n == null) return '--';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/**
 * Official token usage: daily buckets straight from `account/usage/read`.
 * These are measured numbers, not an estimate, so they may look like the quota
 * rows — but a Codex build without the method says so rather than showing zeros.
 */
function tokensPanel(tokens) {
  const box = document.createElement('div');
  box.className = 'extra';

  const head = document.createElement('div');
  head.className = 'extra-head';
  head.textContent = tr('usage.title');
  box.appendChild(head);

  if (tokens.supported === false) {
    const note = document.createElement('div');
    note.className = 'extra-note';
    note.textContent = tr('usage.unsupported');
    box.appendChild(note);
    return box;
  }
  if (!tokens.days?.length) {
    const note = document.createElement('div');
    note.className = 'extra-note';
    note.textContent = tokens.error || tr('card.measuring');
    box.appendChild(note);
    return box;
  }

  // Daily bars: 14 days, each scaled against the busiest of them.
  const days = tokens.days.slice(-14);
  const peak = Math.max(...days.map((d) => d.tokens), 1);
  const bars = document.createElement('div');
  bars.className = 'bars';
  for (const day of days) {
    const bar = document.createElement('i');
    bar.style.height = `${Math.max(2, Math.round((day.tokens / peak) * 100))}%`;
    bar.title = `${day.date}: ${formatTokens(day.tokens)}`;
    bars.appendChild(bar);
  }
  box.appendChild(bars);

  const line = document.createElement('div');
  line.className = 'extra-line';
  const today = tokens.today ? `${tr('usage.today')} ${formatTokens(tokens.today.tokens)}` : '';
  const week = `${tr('usage.last7')} ${formatTokens(tokens.last7Total)}`;
  const streak = tokens.streakDays ? ` · ${tr('usage.streak', { n: tokens.streakDays })}` : '';
  line.textContent = `${today} · ${week}${streak}`;
  box.appendChild(line);
  return box;
}

/**
 * Sparkline of remaining quota over time, from our own history.
 *
 * Time is the x-axis (history rows are change-triggered, not evenly spaced), the
 * line breaks at every window reset, and a gap while the widget was not running
 * stays a gap — interpolating across it would draw data that never existed.
 */
function trendPanel(trend) {
  const series = trend?.primary || [];
  const box = document.createElement('div');
  box.className = 'extra';

  const head = document.createElement('div');
  head.className = 'extra-head';
  box.appendChild(head);

  if (series.length < 2) {
    head.textContent = tr('trend.title');
    const note = document.createElement('div');
    note.className = 'extra-note';
    note.textContent = tr('trend.empty');
    box.appendChild(note);
    return box;
  }

  const W = 240;
  const H = 34;
  const PAD = 3;
  const t0 = series[0].t;
  const span = Math.max(1, series[series.length - 1].t - t0);
  const GAP_MS = 30 * 60 * 1000; // no sample for half an hour ⇒ the widget was off

  // Scale y to the range actually covered (with a floor of 10 points), or a barely
  // moving quota would draw a flat line glued to the top and read as "no data".
  // The header states the range, so the axis is never silently misleading.
  const values = series.map((s) => s.remaining);
  const lo = Math.max(0, Math.min(...values) - 2);
  const hi = Math.min(100, Math.max(Math.max(...values) + 2, lo + 10));
  head.textContent = `${tr('trend.title')} · ${Math.round(hi)}% → ${Math.round(values[values.length - 1])}%`;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('spark');

  let points = [];
  const flush = () => {
    if (points.length > 1) {
      const line = document.createElementNS(SVG_NS, 'polyline');
      line.setAttribute('points', points.join(' '));
      svg.appendChild(line);
    }
    points = [];
  };

  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const prev = series[i - 1];
    if (prev && (s.t - prev.t > GAP_MS || s.remaining > prev.remaining + 1)) flush(); // gap, or a reset
    const x = ((s.t - t0) / span) * W;
    const norm = (Math.max(lo, Math.min(hi, s.remaining)) - lo) / (hi - lo);
    const y = H - PAD - norm * (H - 2 * PAD);
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  flush();

  box.appendChild(svg);
  return box;
}

/** Rendered only when the account actually has credits — otherwise zero pixels. */
function creditsRow(credits) {
  if (!credits || (!credits.hasCredits && !credits.unlimited)) return null;
  const node = document.getElementById('credits-tpl').content.firstElementChild.cloneNode(true);
  // `balance` is an opaque string with no denominator: print it, never a bar or a %.
  node.querySelector('.credits-value').textContent = credits.unlimited ? 'unlimited' : credits.balance ?? '—';
  return node;
}

function render() {
  const { snapshot, error, prefs, theme, panels, burn, trend, tokens } = state;
  applyTheme(theme);
  document.body.classList.toggle('compact', !!prefs.compact);

  rowsEl.innerHTML = '';
  panelsEl.innerHTML = '';
  extrasEl.innerHTML = '';

  if (snapshot) {
    planEl.textContent = snapshot.plan ?? '—';
    const main = snapshot.buckets.find((b) => b.isPrimaryBucket) || snapshot.buckets[0];
    if (main?.primary) {
      rowsEl.appendChild(windowRow(windowLabel(main.primary), main.primary, burn?.primary));
    }
    if (main?.secondary) {
      rowsEl.appendChild(windowRow(windowLabel(main.secondary), main.secondary, burn?.secondary));
    }

    if (prefs.showCredits) {
      const credits = creditsRow(snapshot.credits);
      if (credits) rowsEl.appendChild(credits);
    }

    if (prefs.showAllBuckets) {
      for (const b of snapshot.buckets) {
        if (b === main) continue;
        const title = document.createElement('div');
        title.className = 'bucket-title';
        title.textContent = b.name;
        rowsEl.appendChild(title);
        if (b.primary) rowsEl.appendChild(windowRow(windowLabel(b.primary), b.primary));
        if (b.secondary) rowsEl.appendChild(windowRow(windowLabel(b.secondary), b.secondary));
      }
    }
  }

  // Official extras (still Codex data, so they stay above the provenance line).
  if (prefs.showTokens && tokens) extrasEl.appendChild(tokensPanel(tokens));
  if (prefs.showTrend) extrasEl.appendChild(trendPanel(trend));

  // Plugin panels sit below the provenance line, under their own label: their rows
  // are data we did not get from Codex, and the card must never blur that.
  if ((panels || []).length) {
    const label = document.createElement('div');
    label.className = 'panels-label';
    label.textContent = tr('card.fromPlugins');
    panelsEl.appendChild(label);
  }
  for (const panel of panels || []) panelsEl.appendChild(pluginPanel(panel));

  if (!snapshot) {
    sourceEl.className = error ? 'error' : '';
    sourceEl.textContent = error ? tr('card.error', { msg: error }) : tr('card.connecting');
  } else if (snapshot.rateLimitReachedType) {
    sourceEl.className = 'error';
    sourceEl.textContent = tr('card.limitReached', { type: snapshot.rateLimitReachedType });
  } else if (error) {
    sourceEl.className = 'error';
    sourceEl.textContent = tr('card.staleError', { msg: error });
  } else {
    sourceEl.className = '';
    sourceEl.textContent = tr('card.official', { t: clockAt(snapshot.fetchedAt) });
  }

  tick();
  syncHeight();
}

/** The window is exactly as tall as the card, however many plugin panels there are. */
let lastHeight = 0;
function syncHeight() {
  const height = Math.ceil(cardEl.getBoundingClientRect().height);
  if (!height || height === lastHeight) return;
  lastHeight = height;
  window.codexUsage.resize(height);
}

/** Countdowns run off the absolute reset timestamps, so they stay right between polls. */
function tick() {
  const snap = state.snapshot;
  if (!snap) return;
  for (const el of document.querySelectorAll('.reset')) {
    const at = Number(el.dataset.resetsAt);
    if (!at) continue;
    const sec = Math.max(0, Math.round((at - Date.now()) / 1000));
    el.textContent = tr('card.resetsIn', { d: duration(sec), t: clockAt(at) });
  }

  const ageSec = Math.round((Date.now() - snap.fetchedAt) / 1000);
  const pollSec = state.prefs.pollSeconds || 60;
  // `cached` means the snapshot came off disk and has not been re-read from
  // app-server yet in this process — it is not live no matter how recent it is.
  const stale = snap.cached || ageSec > Math.max(pollSec * 3, 300);
  cardEl.classList.toggle('stale-data', stale);
  staleEl.textContent = stale
    ? snap.cached
      ? tr('card.cached')
      : tr('card.stale', { d: duration(ageSec) })
    : '';
}

document.getElementById('refresh').addEventListener('click', async () => {
  sourceEl.textContent = tr('card.refreshing');
  state = await window.codexUsage.refresh();
  render();
});

// Lets main fade the card when the pointer is elsewhere (idle opacity).
cardEl.addEventListener('mouseenter', () => window.codexUsage.hover(true));
cardEl.addEventListener('mouseleave', () => window.codexUsage.hover(false));
document.getElementById('settings').addEventListener('click', () => window.codexUsage.openSettings());
document.getElementById('menu').addEventListener('click', () => window.codexUsage.openMenu());
document.getElementById('hide').addEventListener('click', () => window.codexUsage.hide());
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.codexUsage.openMenu();
});

window.codexUsage.onUpdate((payload) => {
  state = payload;
  render();
});

(async () => {
  state = await window.codexUsage.get();
  render();
})();

setInterval(tick, 1000);
new ResizeObserver(syncHeight).observe(cardEl);
