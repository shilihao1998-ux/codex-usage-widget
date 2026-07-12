# Let the agent check its own quota

`codex-usage mcp` is an MCP server on stdio. Point Codex (or Claude Code, or anything that speaks MCP) at it and the agent can ask how much quota is left **before** it starts a long refactor.

It exposes one tool:

| Tool | Returns |
| --- | --- |
| `codex_quota` | remaining % and reset time for the 5-hour and weekly windows, plus `fetched_at`, `age_seconds`, `stale`, `source`, `is_estimate: false`. Pass `{"fresh": true}` to force a live read (~2 s) instead of the cached snapshot. |

**It never returns a prediction.** A burn-rate guess handed to a model comes back out of the model restated as fact, so the tool reports only measured values and how old they are.

## Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.codex_usage]
command = "node"
args = ["C:/path/to/codex-usage-widget/bin/codex-usage.js", "mcp"]
```

## Claude Code

```bash
claude mcp add codex-usage -- node /path/to/codex-usage-widget/bin/codex-usage.js mcp
```

## What the agent sees

```
5-hour window: 88% left (12% used), resets at 2026-07-12T11:08:38.000Z
weekly window: 77% left (23% used), resets at 2026-07-18T06:02:00.000Z
plan: pro
source: codex app-server: account/rateLimits/read
fetched: 2026-07-12T07:05:56.523Z (4s ago)
These are measured values reported by Codex, not estimates.
```

A useful instruction to pair with it, in `AGENTS.md` or your system prompt:

> Before starting work you expect to take more than ~20 turns, call `codex_quota`. If the 5-hour window is below 20 %, say so and propose a smaller scope instead of starting.
