// Emit Anthropic tool-use schemas for endpoints that cleared preflight.
// Params are lifted from the Orbit task brief's STEPS section where available,
// falling back to the query string of the catalogued example URL.
import { FLAGS } from './score.mjs';

const SECRET = /key|token|secret|password|appid|auth|routing|credential|signature/i;

const slug = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);

function paramsFromBrief(brief) {
  const steps = brief?.match(/STEPS\s*\n([\s\S]*?)(?:\nGOTCHAS|$)/i)?.[1] ?? '';
  const out = {};
  for (const m of steps.matchAll(/^\s{4,}([a-z_][a-z0-9_]*):\s*(.+)$/gim)) {
    const [, name, desc] = m;
    if (['params', 'returns', 'threading'].includes(name.toLowerCase())) continue;
    if (SECRET.test(name)) continue; // injected server-side, never model-selectable
    out[name] = {
      type: /number|integer|float|latitude|longitude/i.test(desc) ? 'number' : 'string',
      description: desc.trim().slice(0, 200),
    };
  }
  return out;
}

function paramsFromUrl(url) {
  const out = {};
  try {
    const u = new URL(url.replace(/\{\{[^}]+\}\}/g, 'tpl'));
    for (const [k] of u.searchParams) {
      if (SECRET.test(k)) continue; // injected server-side, never by the model
      out[k] = { type: 'string', description: `Query parameter \`${k}\`.` };
    }
  } catch { /* unparseable */ }
  return out;
}

export function toolsFor(rows) {
  return rows
    .filter((r) => r.endpoint && !r.flags.some((f) => FLAGS[f].blocking))
    .map((r) => {
      const props = { ...paramsFromUrl(r.endpoint.url), ...paramsFromBrief(r.brief) };
      const summary = (r.endpoint.evaluateGuide ?? r.endpoint.description ?? '').split('\n')[0];
      return {
        name: slug(`${r.endpoint.provider}_${r.endpoint.name}`) || slug(r.capability),
        description: `${summary}\n\nCapability: ${r.capability}\nCall: ${r.endpoint.method} ${r.endpoint.url.split('?')[0]}`.slice(0, 1000),
        input_schema: { type: 'object', properties: props, required: [] },
        _preflight: { auth_tier: r.tier, advisory_flags: r.flags },
      };
    });
}
