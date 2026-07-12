'use strict';

/**
 * UI strings.
 *
 * Only chrome is translated. Anything the server said — `plan`, `limitName`,
 * `rateLimitReachedType`, plugin output — is printed verbatim, and so are the
 * machine-facing surfaces (CLI, /api, history.jsonl), which stay English so a
 * script never has to care about the user's locale.
 *
 * The four trust words (official / cached / stale / est.) are translated with
 * care: they are the accuracy guarantee, and a vague translation quietly
 * dissolves it.
 */
const STRINGS = {
  en: {
    'window.5h': '5h',
    'window.weekly': 'Weekly',
    'card.used': '{n}% used',
    'card.resetsIn': 'resets in {d} · {t}',
    'card.noReset': 'no reset info',
    'card.official': 'official app-server data · updated {t}',
    'card.connecting': 'connecting to codex app-server…',
    'card.error': 'error: {msg}',
    'card.staleError': 'stale — {msg}',
    'card.limitReached': 'limit reached: {type}',
    'card.cached': 'cached',
    'card.stale': 'stale {d}',
    'card.credits': 'Credits',
    'card.unlimited': 'unlimited',
    'card.fromPlugins': 'From plugins · not Codex data',
    'card.measuring': 'measuring…',
    'card.est': 'est.',
    'card.runsOut': 'runs out ~{t}',
    'card.lastsPastReset': 'lasts past reset',
    'card.refreshing': 'refreshing…',
    'usage.title': 'Tokens',
    'usage.today': 'today',
    'usage.last7': '7-day',
    'usage.streak': '{n}-day streak',
    'usage.unsupported': 'needs a newer Codex build',
    'trend.title': 'Quota trend',
    'trend.empty': 'not enough history yet',
    'tray.left': '{label}: {n}% left · resets in {d}',
    'tray.unknown': '{label}: --',
    'tray.loading': 'Codex usage — loading…',
    'tray.cachedData': '⚠ cached data',
    'tray.staleData': '⚠ stale: {msg}',
    'tray.update': '⬆ Update available: v{v}',
    'menu.settings': 'Settings…',
    'menu.refresh': 'Refresh now',
    'menu.compact': 'Compact mode',
    'menu.allBuckets': 'Show all limit buckets',
    'menu.alerts': 'Low-quota alerts ({t}%)',
    'menu.onTop': 'Always on top',
    'menu.opacity': 'Opacity',
    'menu.lockPosition': 'Lock position',
    'menu.clickThrough': 'Click-through (ignore mouse)',
    'menu.startWithWindows': 'Start with Windows',
    'menu.usagePage': 'Open usage page',
    'menu.showHide': 'Show / hide widget',
    'menu.resetPosition': 'Reset position',
    'menu.quit': 'Quit',
    'notify.low.title': 'Codex {label} quota low',
    'notify.low.body': '{n}% left · resets in {d}',
    'notify.back.title': 'Codex {label} quota is back',
    'notify.back.body': '{n}% available again',
  },
  'zh-CN': {
    'window.5h': '5 小时',
    'window.weekly': '本周',
    'card.used': '已用 {n}%',
    'card.resetsIn': '{d} 后重置 · {t}',
    'card.noReset': '无重置信息',
    'card.official': '官方 app-server 数据 · {t} 更新',
    'card.connecting': '正在连接 codex app-server…',
    'card.error': '错误：{msg}',
    'card.staleError': '数据已过期 — {msg}',
    'card.limitReached': '已触顶：{type}',
    'card.cached': '缓存数据',
    'card.stale': '已过期 {d}',
    'card.credits': 'Credits',
    'card.unlimited': '不限量',
    'card.fromPlugins': '来自插件 · 非 Codex 数据',
    'card.measuring': '测量中…',
    'card.est': '估算',
    'card.runsOut': '约 {t} 用尽',
    'card.lastsPastReset': '够用到重置',
    'card.refreshing': '刷新中…',
    'usage.title': 'Token 用量',
    'usage.today': '今日',
    'usage.last7': '近 7 天',
    'usage.streak': '连续 {n} 天',
    'usage.unsupported': '需要更新版本的 Codex',
    'trend.title': '额度趋势',
    'trend.empty': '历史数据还不够',
    'tray.left': '{label}：剩 {n}% · {d} 后重置',
    'tray.unknown': '{label}：--',
    'tray.loading': 'Codex 额度 — 加载中…',
    'tray.cachedData': '⚠ 缓存数据',
    'tray.staleData': '⚠ 已过期：{msg}',
    'tray.update': '⬆ 有新版本：v{v}',
    'menu.settings': '设置…',
    'menu.refresh': '立即刷新',
    'menu.compact': '紧凑模式',
    'menu.allBuckets': '显示全部计量桶',
    'menu.alerts': '低额度提醒（{t}%）',
    'menu.onTop': '窗口置顶',
    'menu.opacity': '不透明度',
    'menu.lockPosition': '锁定位置',
    'menu.clickThrough': '点击穿透（忽略鼠标）',
    'menu.startWithWindows': '开机自启',
    'menu.usagePage': '打开官方用量页',
    'menu.showHide': '显示 / 隐藏组件',
    'menu.resetPosition': '重置位置',
    'menu.quit': '退出',
    'notify.low.title': 'Codex {label} 额度不足',
    'notify.low.body': '剩余 {n}% · {d} 后重置',
    'notify.back.title': 'Codex {label} 额度已恢复',
    'notify.back.body': '重新可用 {n}%',
  },
};

const LANGUAGES = [
  { id: 'en', name: 'English' },
  { id: 'zh-CN', name: '简体中文' },
];

function translator(lang) {
  const table = STRINGS[lang] || STRINGS.en;
  return (key, vars = {}) => {
    const template = table[key] ?? STRINGS.en[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_, name) => (vars[name] != null ? String(vars[name]) : ''));
  };
}

module.exports = { STRINGS, LANGUAGES, translator };
