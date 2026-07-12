'use strict';

// Statuspage's public summary endpoint — no key, no account.
const SUMMARY = 'https://status.openai.com/api/v2/summary.json';

const TONE = {
  none: 'ok',
  minor: 'warn',
  major: 'crit',
  critical: 'crit',
  maintenance: 'muted',
};

exports.fetch = async (ctx) => {
  const data = await ctx.fetchJson(SUMMARY);
  const indicator = data?.status?.indicator ?? 'none';
  const incidents = (data?.incidents || []).filter((i) => i.status !== 'resolved');

  // Silence is the useful default: a permanent green "all systems operational"
  // row is noise, and it would also imply we are monitoring more than we are.
  if (indicator === 'none' && !incidents.length && !ctx.config.showWhenHealthy) {
    return { rows: [] };
  }

  if (!incidents.length) {
    return {
      rows: [{ label: data?.status?.description ?? 'Operational', value: '✓', tone: TONE[indicator] || 'default' }],
    };
  }

  return {
    subtitle: data?.status?.description ?? '',
    rows: incidents.slice(0, 3).map((incident) => ({
      label: incident.name,
      value: incident.status,
      sub: (incident.incident_updates?.[0]?.body || '').slice(0, 64),
      tone: TONE[incident.impact] || 'warn',
    })),
  };
};
