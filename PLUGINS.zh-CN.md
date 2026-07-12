# 写一个插件

[English](PLUGINS.md) | 简体中文

插件在小组件里多渲染一块面板——天气、磁盘、股价、服务器状态，随你。

**契约：插件只取数、返回结构化的行；渲染由小组件自己做。** 插件不返回 HTML、碰不到渲染进程，所以既坏不了布局也偷不走页面，而且样式天然跟着用户的主题。

> ⚠️ 插件跑在**主进程，有完整 Node 权限**：能读文件、能起进程、能发网络请求。只装你信得过的插件——标准跟装 npm 包一样。
> 你丢进自己插件目录的插件**默认是关的**——拷进去不足以让它运行，必须你在设置 → Plugins 里手动启用。

## 放哪

| 目录 | 用途 |
| --- | --- |
| `plugins/` | 仓库自带的示例（如 `weather`） |
| `~/.codex-usage-widget/plugins/` | 你自己的插件（设置 → Plugins → **Open plugins folder** 直达） |

一个插件 = 一个文件夹，两个文件：`plugin.json` + `index.js`。

## `plugin.json`

```jsonc
{
  "id": "weather",              // 必填，全局唯一
  "name": "Weather",            // 面板标题
  "icon": "🌤",                 // 可选，1-2 个字符
  "description": "…",           // 设置窗口里显示
  "refreshMs": 900000,          // 刷新间隔；小于 10000 会被抬到 10000
  "enabledByDefault": false,    // 只对随应用打包的内置插件生效；
                                // 放在用户插件目录里的，一律默认关闭，必须手动启用
  "config": {                   // 默认配置，用户可在设置窗口里改
    "city": "Shanghai"
  }
}
```

两个文件夹声明同一个 `id` 时，先发现的生效，另一个报错——id 必须唯一。

## `index.js`

导出 `fetch(ctx)`，返回面板数据：

```js
exports.fetch = async (ctx) => {
  const data = await ctx.fetchJson(`https://api.example.com/x?q=${ctx.config.city}`);

  return {
    title: '面板标题',           // 可选，默认用 manifest 的 name
    icon: '🌧',                 // 可选，覆盖 manifest
    subtitle: '右上角小字',      // 可选
    rows: [
      {
        label: '左边的标签',
        value: '29°C',          // 右边的大字
        sub: '第二行小字',       // 可选
        tone: 'warn',           // ok | warn | crit | muted | default
        progress: 72,           // 0-100，画一条进度条（可选）
      },
    ],
  };
};
```

`ctx` 提供：

| 字段 | 说明 |
| --- | --- |
| `ctx.config` | manifest 默认值 + 用户在设置窗口里改过的值 |
| `ctx.fetchJson(url, opts)` | HTTP GET → JSON。用 Electron `net.fetch`，**跟随系统代理** |
| `ctx.fetchText(url, opts)` | 同上，返回文本 |
| `ctx.log(...args)` | 打到应用 stdout，带插件 id 前缀 |

约束（超出的会被截断/丢弃，插件永远搞不崩组件）：

- 最多 8 行；`label` ≤ 40 字符、`value` ≤ 24、`sub` ≤ 64、`title` ≤ 32
- `fetch` 超过 20 秒被中止，面板显示超时
- 抛异常 = 这块面板显示该错误，其他面板不受影响
- 每个插件同时只跑一次：上一次还没结束时，这一拍直接跳过而不是排队

## 调试

设置 → **Plugins**：开关、改配置 JSON、**Reload plugins** 热加载（整个插件目录重新 require，子模块也一起刷新）。错误直接显示在插件卡片和面板上。

## 例子：本机磁盘占用

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

放进去，点 **Reload plugins**，勾上就出现在组件里。
