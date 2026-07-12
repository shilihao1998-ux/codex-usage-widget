'use strict';

/**
 * A shareable HTML report of quota over time.
 *
 * The point of this file is to be screenshotted and pasted, so it carries **no
 * account identity** — no email, no account id. Gaps in the data are drawn as
 * gaps: the widget is not always running, and joining across an absence would
 * draw a line through hours nobody measured.
 */

const GAP_MS = 30 * 60 * 1000;

function buildSeries(rows, bucketId, key) {
  return rows
    .map((row) => {
      const bucket = (row.buckets || []).find((b) => b.id === bucketId);
      const win = bucket && bucket[key];
      return win && typeof win.u === 'number' ? { t: row.t, remaining: 100 - win.u } : null;
    })
    .filter(Boolean);
}

/** Split into segments at resets and at gaps where the widget was not running. */
function segments(series) {
  const out = [];
  let current = [];
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const prev = series[i - 1];
    if (prev && (s.t - prev.t > GAP_MS || s.remaining > prev.remaining + 1)) {
      if (current.length > 1) out.push(current);
      current = [];
    }
    current.push(s);
  }
  if (current.length > 1) out.push(current);
  return out;
}

function polyline(series, W, H, t0, span) {
  return segments(series)
    .map((seg) => {
      const points = seg
        .map((s) => {
          const x = ((s.t - t0) / span) * W;
          const y = H - (Math.max(0, Math.min(100, s.remaining)) / 100) * H;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
      return `<polyline points="${points}" />`;
    })
    .join('\n      ');
}

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function buildReport({ rows, tokens = null, plan = null, bucketId = 'codex' }) {
  const W = 900;
  const H = 220;
  const primary = buildSeries(rows, bucketId, 'p');
  const secondary = buildSeries(rows, bucketId, 's');
  const all = [...primary, ...secondary];

  const t0 = all.length ? Math.min(...all.map((s) => s.t)) : Date.now();
  const t1 = all.length ? Math.max(...all.map((s) => s.t)) : Date.now() + 1;
  const span = Math.max(1, t1 - t0);
  const fmt = (t) => new Date(t).toLocaleString();

  const dailyBars = (tokens?.days || [])
    .slice(-30)
    .map((d) => {
      const peak = Math.max(...tokens.days.map((x) => x.tokens), 1);
      const height = Math.max(1, Math.round((d.tokens / peak) * 100));
      return `<div class="bar" title="${escape(d.date)}: ${escape(formatTokens(d.tokens))}"><i style="height:${height}%"></i><span>${escape(d.date.slice(5))}</span></div>`;
    })
    .join('\n        ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Codex usage report</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px; background: #121317; color: #f2f3f5;
         font: 14px/1.6 "Segoe UI", system-ui, -apple-system, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: rgba(242,243,245,.5); margin-bottom: 28px; }
  section { margin-bottom: 36px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .1em;
       color: rgba(242,243,245,.4); margin: 0 0 12px; }
  svg { width: 100%; height: 220px; background: rgba(255,255,255,.03); border-radius: 10px; }
  polyline { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
  .p polyline { stroke: #56c88c; }
  .s polyline { stroke: #6aa9f0; }
  .legend { display: flex; gap: 18px; margin-top: 10px; color: rgba(242,243,245,.6); font-size: 12px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .bars { display: flex; align-items: flex-end; gap: 4px; height: 160px; }
  .bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; }
  .bar i { display: block; width: 100%; background: #56c88c; border-radius: 3px 3px 0 0; }
  .bar span { font-size: 9px; color: rgba(242,243,245,.35); margin-top: 4px; }
  .stats { display: flex; gap: 32px; flex-wrap: wrap; }
  .stat b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
  .stat span { color: rgba(242,243,245,.5); font-size: 12px; }
  footer { color: rgba(242,243,245,.35); font-size: 12px; border-top: 1px solid rgba(255,255,255,.08); padding-top: 16px; }
</style>
</head>
<body>
  <h1>Codex usage report</h1>
  <div class="sub">${escape(plan ? `plan ${plan} · ` : '')}${escape(fmt(t0))} → ${escape(fmt(t1))} · ${rows.length} recorded changes</div>

  <section>
    <h2>Remaining quota over time</h2>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <g class="p">
      ${polyline(primary, W, H, t0, span)}
      </g>
      <g class="s">
      ${polyline(secondary, W, H, t0, span)}
      </g>
    </svg>
    <div class="legend">
      <span><i class="dot" style="background:#56c88c"></i>5-hour window</span>
      <span><i class="dot" style="background:#6aa9f0"></i>weekly window</span>
      <span>gaps = the widget was not running; a rise = the window reset</span>
    </div>
  </section>
${
  tokens?.days?.length
    ? `
  <section>
    <h2>Tokens per day (official)</h2>
    <div class="bars">
        ${dailyBars}
    </div>
  </section>

  <section>
    <h2>Totals (official)</h2>
    <div class="stats">
      <div class="stat"><b>${escape(formatTokens(tokens.lifetime))}</b><span>lifetime tokens</span></div>
      <div class="stat"><b>${escape(formatTokens(tokens.peakDaily))}</b><span>peak day</span></div>
      <div class="stat"><b>${escape(tokens.streakDays ?? '--')}</b><span>day streak</span></div>
      <div class="stat"><b>${escape(formatTokens(tokens.last7Total))}</b><span>last 7 days</span></div>
    </div>
  </section>`
    : ''
}
  <footer>
    Quota figures come from <code>account/rateLimits/read</code> on the local Codex app-server — the same
    call the official Codex app makes. No estimates appear in this report, and it contains no account identity.
  </footer>
</body>
</html>
`;
}

function formatTokens(n) {
  if (n == null) return '--';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

module.exports = { buildReport, segments, buildSeries };
