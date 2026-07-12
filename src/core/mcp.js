'use strict';

/**
 * MCP server over stdio: lets an agent (Codex itself, Claude Code, …) ask how much
 * quota is left before it starts something expensive.
 *
 * Two rules shape this file:
 *   1. stdout is the protocol. Nothing else may ever be written there — a stray
 *      console.log corrupts the session.
 *   2. The tool returns facts and their age (`fetched_at`, `age_seconds`,
 *      `stale`, `source`) and NEVER a prediction. A burn-rate guess handed to a
 *      model comes back out of it restated as fact.
 */

const TOOLS = [
  {
    name: 'codex_quota',
    description:
      'Read the remaining OpenAI Codex quota (5-hour and weekly windows) from the local Codex app-server. ' +
      'Returns official measured values, never estimates. Use before starting long or expensive work.',
    inputSchema: {
      type: 'object',
      properties: {
        fresh: {
          type: 'boolean',
          description: 'Re-read from the app-server instead of using the cached snapshot (slower, ~2s).',
        },
      },
    },
  },
];

function quotaText(snap, ageSeconds) {
  const win = (w, label) =>
    w
      ? `${label}: ${w.remainingPercent}% left (${w.usedPercent}% used), resets at ${new Date(w.resetsAt).toISOString()}`
      : `${label}: unavailable`;

  return [
    win(snap.primary, '5-hour window'),
    win(snap.secondary, 'weekly window'),
    `plan: ${snap.plan ?? 'unknown'}`,
    `source: ${snap.source}`,
    `fetched: ${new Date(snap.fetchedAt).toISOString()} (${ageSeconds}s ago)${ageSeconds > 600 ? ' — STALE' : ''}`,
    'These are measured values reported by Codex, not estimates.',
  ].join('\n');
}

function quotaPayload(snap) {
  const ageSeconds = Math.round((Date.now() - snap.fetchedAt) / 1000);
  const window = (w) =>
    w
      ? {
          used_percent: w.usedPercent,
          remaining_percent: w.remainingPercent,
          window_minutes: w.windowMinutes,
          resets_at: w.resetsAt ? new Date(w.resetsAt).toISOString() : null,
          resets_in_seconds: w.resetsAt ? Math.max(0, Math.round((w.resetsAt - Date.now()) / 1000)) : null,
        }
      : null;

  return {
    ageSeconds,
    structured: {
      primary_5h: window(snap.primary),
      secondary_weekly: window(snap.secondary),
      plan: snap.plan ?? null,
      fetched_at: new Date(snap.fetchedAt).toISOString(),
      age_seconds: ageSeconds,
      stale: ageSeconds > 600,
      source: snap.source,
      is_estimate: false,
    },
  };
}

/** @param {import('./usage-service').UsageService} service */
function startMcpServer(service, { stdin = process.stdin, stdout = process.stdout } = {}) {
  const send = (msg) => stdout.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  let buffer = '';
  stdin.on('data', async (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // never write diagnostics to stdout
      }
      await handle(msg);
    }
  });

  async function handle(msg) {
    const { id, method, params } = msg;

    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'codex-usage', version: '1.2.0' },
      });
    }
    if (method === 'tools/list') return reply(id, { tools: TOOLS });

    if (method === 'tools/call') {
      if (params?.name !== 'codex_quota') return fail(id, -32602, `unknown tool: ${params?.name}`);
      try {
        const snap = params?.arguments?.fresh ? await service.refresh() : service.snapshot ?? (await service.refresh());
        const { structured } = quotaPayload(snap);
        return reply(id, {
          content: [{ type: 'text', text: quotaText(snap, structured.age_seconds) }],
          structuredContent: structured,
        });
      } catch (err) {
        return reply(id, {
          content: [{ type: 'text', text: `Could not read Codex quota: ${err.message}` }],
          isError: true,
        });
      }
    }

    if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
  }
}

module.exports = { startMcpServer, TOOLS, quotaPayload };
