// Preflight scoring engine.
//
// Thesis: in enterprise agent deployments the critical path is almost never
// model work, it is integration auth. Auth burden is knowable on day 1 from
// the endpoint metadata Orbit returns, so we compute it instead of guessing.
//
// PROVENANCE. Everything derived from Orbit (endpoints, AUTH sections, FIT
// verdicts, gotchas, coverage gaps) is observed evidence. The day counts and
// the approved-vendor list are local calibration and live in config.json , 
// they are the only invented numbers in this report.
import { readFileSync } from 'node:fs';
import { INTERNAL } from './paraphrase.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CFG = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'config.json'), 'utf8'));
export const CONFIG = CFG;
const D = CFG.leadTimeDays;

// --- Auth tiers -------------------------------------------------------------
// Lead times are calendar days from engagement start to a working, approved
// integration. Tune ORG_CALIBRATION per customer; these are mid-market defaults.
export const TIERS = {
  NONE:       { rank: 0, days: D.NONE,       label: 'No auth',             note: 'Callable immediately.' },
  API_KEY:    { rank: 1, days: D.API_KEY,    label: 'Self-serve API key',  note: 'Signup + key. Usually same-week.' },
  OAUTH:      { rank: 2, days: D.OAUTH,      label: 'OAuth + scopes',      note: 'App registration and customer admin consent.' },
  ENTERPRISE: { rank: 3, days: D.ENTERPRISE, label: 'Enterprise / partner',note: 'Contract, procurement, or partner approval.' },
  CUSTOM:     { rank: 4, days: D.CUSTOM,     label: 'No public API',       note: 'Internal system. Custom integration work.' },
};

const KNOWN_VENDORS = new Set(CFG.approvedVendors.list);

// Vendors whose APIs are gated behind a contract or partner program.
const ENTERPRISE_VENDORS = /mastercard|visa|adyen|sap|oracle|workday|servicenow|corpay|plaid/i;
const OAUTH_VENDORS = /slack|salesforce|hubspot|zoho|google|microsoft|github|atlassian|shopify|square|zendesk|intercom|dropbox|box|notion|asana|docusign/i;

// --- Risk flags -------------------------------------------------------------
// Each flag carries a severity and whether it blocks a production pilot.
const FLAG_DEFS = {
  NO_COVERAGE:      { sev: 'high', blocking: true,  title: 'No public API found',
    why: 'Orbit returned no candidate endpoints. This is almost certainly an internal system and needs a custom integration.' },
  SANDBOX_URL:      { sev: 'high', blocking: true,  title: 'Sandbox / test host',
    why: 'The catalogued URL points at a test environment. An agent wired to this silently no-ops in production.' },
  MALFORMED_URL:    { sev: 'high', blocking: true,  title: 'Malformed URL in catalog',
    why: 'The published entry has a broken URL. The collection author never cleaned it up; do not trust its other fields either.' },
  LEAKED_CREDENTIAL:{ sev: 'high', blocking: true,  title: 'Credential embedded in example',
    why: 'A literal secret appears in the catalogued URL. It belongs to whoever published the collection. Never reuse it.' },
  UNRESOLVED_HOST:  { sev: 'med',  blocking: false, title: 'Tenant-specific host',
    why: 'The base URL is a template. You need the customer tenant/subdomain before this can be called at all.' },
  VENDOR_UNREVIEWED:{ sev: 'med',  blocking: false, title: 'Vendor not on approved list',
    why: 'This vendor is absent from the approved-vendor list in config.json. That is a statement about your allowlist, not about the vendor, it means someone still has to review data residency and contracting.' },
  WRITE_ACTION:     { sev: 'med',  blocking: false, title: 'Mutating action',
    why: 'This endpoint writes or moves money. It will need human-in-the-loop review before the agent runs it unattended.' },
  WEAK_FIT:         { sev: 'low',  blocking: false, title: 'Weak capability match',
    why: 'Orbit rated this a partial fit for the capability. Confirm with the customer before scoping.' },
  INTERNAL_MISMATCH:{ sev: 'high', blocking: true,  title: 'Internal system matched to a public vendor',
    why: 'The capability names an org-internal system ("our", "internal", "proprietary") but resolved to a third-party public API. A public catalogue cannot contain your internal systems, so this match is almost certainly wrong. Scope it as custom work and confirm with the customer.' },
  CATALOG_GAP:      { sev: 'high', blocking: true,  title: 'Not in the public catalogue',
    why: 'Orbit returned endpoints for this vendor but rejected every one as a non-fit, including after following its own re-search hint. The vendor API very likely exists, it is simply absent from the public catalogue. Budget ordinary integration time and confirm against vendor documentation; do not scope this as a custom build.' },
  AUTH_UNVERIFIED:  { sev: 'med',  blocking: false, title: 'Auth burden unverified',
    why: 'Orbit returned no AUTH section for this endpoint, so the tier below is a conservative assumption, not evidence. Verify against vendor docs before you commit to a date.' },
};
export const FLAGS = FLAG_DEFS;

const PLACEHOLDER = /^(your|enter|xxx|test|demo|example|<|\{)/i;

export function redactUrl(url = '') {
  return url.replace(/([?&][a-z_-]*(?:key|token|secret|password|appid|auth)[a-z_-]*=)([^&\s]+)/gi,
    (_, p, v) => (v.includes('{{') || PLACEHOLDER.test(v) || v.length < 16)
      ? _ : `${p}${v.slice(0, 4)}${'*'.repeat(8)}${v.slice(-2)}`);
}

// A credential is "leaked" if a secret-ish param holds a long literal value
// that is not a template ({{x}}) and not an obvious placeholder.
function findLeakedCredential(url) {
  const m = url.matchAll(/[?&]([a-z_-]*(?:key|token|secret|password|appid|auth)[a-z_-]*)=([^&\s]+)/gi);
  for (const [, name, raw] of m) {
    const val = decodeURIComponent(raw);
    if (val.includes('{{') || val.includes('${') || PLACEHOLDER.test(val)) continue;
    if (val.length >= 16 && /^[A-Za-z0-9_.-]+$/.test(val)) {
      return { param: name, redacted: `${val.slice(0, 4)}${'*'.repeat(8)}${val.slice(-2)}` };
    }
  }
  return null;
}

// Asymmetric on purpose: under-estimating auth burden is the failure mode this
// product exists to prevent, so NONE is only ever returned on explicit evidence
// from Orbit's AUTH section. Absence of evidence floors at API_KEY.
function classifyAuth(endpoint, authText = '') {
  const hay = `${endpoint.url} ${endpoint.description ?? ''} ${authText}`;
  const vendor = endpoint.provider ?? '';

  // Orbit distinguishes two very different statements with similar wording:
  //   "no authentication IS REQUIRED"                      -> genuinely open
  //   "no authentication scheme IS PRESENT in the request" -> undocumented
  // The second means the collection author omitted it, not that the API is
  // open. Reading it as NONE returned "Oracle Cloud, 0 days".
  const UNDOCUMENTED = /scheme is (not )?present|not (specified|documented|defined)|provide any auth|separately|supplied (request|collection)/i;
  const GENUINELY_OPEN = /no auth(entication|orisation)? (is )?(required|needed)|does not require auth|call the endpoint without (credentials|auth)|without credentials|requires no auth/i;
  if (GENUINELY_OPEN.test(authText) && !UNDOCUMENTED.test(authText)) return 'NONE';
  if (ENTERPRISE_VENDORS.test(vendor)) return 'ENTERPRISE';
  if (/oauth|bearer token|\bscope\b|access_token|admin consent|client secret/i.test(hay) || OAUTH_VENDORS.test(vendor)) return 'OAUTH';
  return 'API_KEY';
}

// Orbit states its own verdict in the brief's FIT section. Prefer it over any
// heuristic of ours, it is the model that actually read the endpoint schema.
function orbitFit(brief) {
  const v = brief?.match(/\bFIT\b\s*\n\s*(.+)/i)?.[1]?.trim() ?? '';
  if (/^not at all/i.test(v)) return { pct: 0, verdict: 'Not at all' };
  if (/^partial/i.test(v))    return { pct: 55, verdict: 'Partially' };
  if (/^(yes|fully|complete)/i.test(v)) return { pct: 100, verdict: 'Yes' };
  return null;
}

function flagEndpoint(ep) {
  const flags = [];
  const url = ep.url ?? '';
  let host = '';
  try { host = new URL(url.replace(/\{\{[^}]+\}\}/g, 'tpl')).host; } catch { /* unparseable */ }

  if (!url || url === 'None' || /https?:\/\/https?:\/\//.test(url) || !/^https?:\/\/|^\{\{/.test(url)) {
    flags.push('MALFORMED_URL');
  }
  if (/sandbox|(^|[.-])test[.-]|[.-]dev[.-]|staging|zd-dev/i.test(host)) flags.push('SANDBOX_URL');
  if (/\{\{/.test(url.split('?')[0].replace(/^https?:\/\//, '').split('/')[0] || '')) flags.push('UNRESOLVED_HOST');

  const leak = findLeakedCredential(url);
  if (leak) flags.push('LEAKED_CREDENTIAL');

  const vendorKey = (ep.provider ?? '').toLowerCase().split(/[\s/.]/)[0];
  if (vendorKey && !KNOWN_VENDORS.has(vendorKey)) flags.push('VENDOR_UNREVIEWED');
  if (/^(POST|PUT|PATCH|DELETE)$/i.test(ep.method ?? '')) flags.push('WRITE_ACTION');

  return { flags, leak };
}

// Orbit's evaluateGuide has a "Not supported:" section. If the capability words
// show up there rather than in "Use for:", the match is weaker than it looks.
function fitScore(capability, ep) {
  const guide = (ep.evaluateGuide ?? '').toLowerCase();
  const useFor = guide.split('not supported:')[0];
  const words = capability.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const hits = words.filter((w) => useFor.includes(w)).length;
  return words.length ? hits / words.length : 0;
}

export function rankCandidates(capability, searchResult) {
  return (searchResult?.data ?? [])
    .map((ep) => ({ ep, fit: fitScore(capability, ep), ...flagEndpoint(ep) }))
    .sort((a, b) => {
      const block = (x) => x.flags.filter((f) => FLAG_DEFS[f].blocking).length;
      const soft = (x) => (x.flags.includes('UNRESOLVED_HOST') ? 1 : 0);
      return block(a) - block(b) || soft(a) - soft(b) || b.fit - a.fit;
    });
}

// A scan an FDE cannot defend to a customer is not usable. Every conclusion
// records how it was reached, and whether it rests on Orbit evidence or on
// local calibration. `kind` is the load-bearing field.
const step = (kind, claim, source, detail) => ({ kind, claim, source, detail });

export function scoreCapability(capability, searchResult, chosen) {
  const candidates = searchResult?.data ?? [];

  if (candidates.length === 0) {
    return {
      capability, tier: 'CUSTOM', days: TIERS.CUSTOM.days, endpoint: null,
      candidateCount: 0, flags: ['NO_COVERAGE'], leak: null, fit: 0,
      fitVerdict: 'no candidates', brief: null, alternatives: [], hygiene: [],
      trace: [
        step('evidence', 'Orbit returned zero candidates for every phrasing tried', 'POST /v1/search',
             `Original wording plus simplified paraphrases all returned nothing.`),
        step('inference', 'Treated as an internal system with no public API', 'Preflight rule',
             'Orbit coverage is sensitive to phrasing, so a single zero-result is not trusted. Only a gap that survives re-probing is reported as a gap.'),
        step('assumption', `Lead time set to ${TIERS.CUSTOM.days} days`, 'config.json → leadTimeDays.CUSTOM',
             'Local calibration, not a measurement.'),
      ],
    };
  }

  const ranked = rankCandidates(capability, searchResult);
  const best = chosen?.ep
    ? (ranked.find((r) => r.ep.id === chosen.ep.id) ?? ranked[0])
    : ranked[0];
  const brief = chosen?.brief ?? null;
  const authText = brief?.match(/\bAUTH\b\s*\n([\s\S]*?)(?:\n\s*\n|BASE URL)/i)?.[1] ?? '';
  const tier = classifyAuth(best.ep, authText);
  const flags = [...best.flags];
  if (!authText.trim()) flags.push('AUTH_UNVERIFIED');

  const of = orbitFit(brief);
  const fit = of ? of.pct : Math.round(best.fit * 100);
  if (fit < 60) flags.push('WEAK_FIT');

  // A public catalogue cannot contain the customer's internal systems. When the
  // capability names one, scope it as custom work regardless of what the
  // catalogue happened to return, the vendor tier below would understate it.
  if (INTERNAL.test(capability)) {
    flags.push('INTERNAL_MISMATCH');
    return { capability, tier: 'CUSTOM', days: TIERS.CUSTOM.days, endpoint: best.ep, hygiene: [],
      candidateCount: candidates.length, flags, leak: best.leak, fit,
      fitVerdict: of?.verdict ?? 'heuristic', brief, alternatives: [],
      trace: [
        step('evidence', `Orbit returned ${candidates.length} candidates`, 'POST /v1/search', `q="${capability}"`),
        step('evidence', `Best match was ${best.ep.provider ?? 'a third-party vendor'}, a public API`,
             'POST /v1/search', best.ep.name),
        step('inference', 'Capability names an org-internal system', 'Preflight rule',
             'Matched an internality marker ("our", "internal", "in-house", "proprietary"). A public catalogue cannot contain the customer\'s internal systems, so a public match here is almost certainly wrong.'),
        step('assumption', `Lead time ${TIERS.CUSTOM.days} days`, 'config.json → leadTimeDays.CUSTOM',
             'Local calibration, not a measurement.'),
      ] };
  }

  if (authText.trim() && !/\bNONE\b/.test(tier) &&
      /scheme is (not )?present|provide any auth|separately/i.test(authText)) {
    flags.push('AUTH_UNVERIFIED');
  }

  const authQuote = authText.trim().replace(/\s+/g, ' ').slice(0, 190);
  const trace = [
    step('evidence', `Orbit returned ${candidates.length} candidate endpoints`,
         'POST /v1/search', `q="${capability}"`),
    step('inference', `Selected ${best.ep.provider ?? 'candidate'} ,  ${best.ep.name}`,
         'Preflight ranking',
         `Ranked on blocking defects first, then unresolved tenant hosts, then keyword fit. ${ranked.length - 1} alternatives were available.`),
    of ? step('evidence', `Orbit rated this endpoint "${of.verdict}" for the capability`,
              'POST /v1/integrate → FIT', brief?.split('\n').slice(0, 4).join(' ').slice(0, 190))
       : step('inference', 'Orbit returned no FIT verdict; fell back to keyword overlap',
              'Preflight heuristic', 'Weaker signal than an Orbit verdict.'),
    authQuote
      ? step('evidence', `Authorisation tier ${tier}`, 'POST /v1/integrate → AUTH', authQuote)
      : step('inference', `Authorisation tier ${tier} assumed`, 'Preflight conservative default',
             'Orbit returned no AUTH section. The classifier never infers "no auth" from missing evidence; it floors at API key and raises AUTH_UNVERIFIED.'),
    step('assumption', `Lead time ${TIERS[tier].days} days`, `config.json → leadTimeDays.${tier}`,
         'Local calibration. Replace with your own delivery history before quoting a date.'),
  ];
  if (best.flags.length) {
    trace.push(step('evidence', `${best.flags.length} risk flag(s) raised`, 'Derived from the catalogued URL and method',
      best.flags.map((f) => FLAG_DEFS[f].title).join('; ')));
  }

  // Orbit rejected every candidate, including after its own re-search hint.
  // That is a catalogue gap, not an internal system: keep the vendor's auth
  // tier so we do not inflate a 15-minute integration into a custom build.
  if (chosen?.rejected) {
    flags.push('CATALOG_GAP');
    trace.push(step('inference', 'Scoped as a catalogue gap, not a custom build', 'Preflight rule',
      'Orbit rejected every candidate including after its own re-search hint. The vendor API very likely exists but is absent from the catalogue, so the vendor auth tier is retained rather than inflated to a custom build.'));
    return { capability, tier, days: TIERS[tier].days, endpoint: best.ep, hygiene: [],
      candidateCount: candidates.length, flags, leak: best.leak, fit,
      fitVerdict: of?.verdict ?? 'heuristic', brief, alternatives: [], trace };
  }

  // Blocking flags on *rejected* candidates still matter: an engineer browsing
  // the same Orbit results by hand would happily copy one of these.
  const hygiene = ranked
    .filter((r) => r.flags.some((f) => FLAG_DEFS[f].blocking))
    .map((r) => ({
      capability, name: r.ep.name, provider: r.ep.provider,
      url: redactUrl(r.ep.url ?? ''), selected: r.ep.id === best.ep.id,
      flags: r.flags.filter((f) => FLAG_DEFS[f].blocking), leak: r.leak,
    }));

  return {
    capability, tier, days: TIERS[tier].days, endpoint: best.ep, hygiene, trace,
    candidateCount: candidates.length, flags, leak: best.leak,
    fit, fitVerdict: of?.verdict ?? 'heuristic', brief: brief ?? null,
    alternatives: ranked.slice(1, 4).map((r) => ({
      name: r.ep.name, provider: r.ep.provider, flags: r.flags,
    })),
  };
}

// --- Roll-up ----------------------------------------------------------------
export function buildReport(rows) {
  const criticalDays = Math.max(0, ...rows.map((r) => r.days));
  const driver = rows.find((r) => r.days === criticalDays) ?? null;

  const phase = (r) => {
    if (r.tier === 'CUSTOM' || r.tier === 'ENTERPRISE') return 3;
    if (r.tier === 'OAUTH') return 2;
    const held = ['VENDOR_UNREVIEWED', 'WEAK_FIT', 'AUTH_UNVERIFIED'];
    if (r.flags.some((f) => FLAG_DEFS[f].blocking || held.includes(f))) return 2;
    return 1;
  };
  const phases = { 1: [], 2: [], 3: [] };
  for (const r of rows) phases[phase(r)].push(r);

  const pilotDays = Math.max(0, ...phases[1].map((r) => r.days));
  const blocking = rows.flatMap((r) =>
    r.flags.filter((f) => FLAG_DEFS[f].blocking).map((f) => ({ capability: r.capability, flag: f })));

  // Only vendors we actually intend to call enter the security review. A row
  // scoped as custom work, or blocked on a defect, contributes nothing, its
  // matched vendor is one we have already decided not to use.
  const vendors = [...new Set(rows
    .filter((r) => r.tier !== 'CUSTOM' && !r.flags.some((f) => FLAG_DEFS[f].blocking))
    .map((r) => r.endpoint?.provider).filter(Boolean))];
  const hygiene = rows.flatMap((r) => r.hygiene ?? []);
  const scanned = rows.reduce((a, r) => a + r.candidateCount, 0);

  return {
    criticalDays, driver, phases, pilotDays, blocking, vendors, hygiene, scanned,
    counts: rows.reduce((a, r) => ({ ...a, [r.tier]: (a[r.tier] ?? 0) + 1 }), {}),
  };
}
