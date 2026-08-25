#!/usr/bin/env node
// Validation harness. Runs every brief through the live server and asserts
// invariants the product's credibility depends on.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:7878';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? ` ,  ${detail}` : ''}`);
};

async function runScan(brief) {
  const res = await fetch(`${BASE}/api/scan`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capabilities: brief.capabilities, goal: brief.goal }),
  });
  const text = await res.text();
  const events = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return events.find((e) => e.type === 'done');
}

// The suite exercised the API but never the page, so a parse error in the
// inline script shipped a completely dead UI while every assertion passed.
console.log('=== Browser bundle ===');
{
  const html = await readFile('public/index.html', 'utf8');
  const js = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  check('page contains an inline script', js.length > 500);
  await mkdir('.cache', { recursive: true });
  await writeFile('.cache/inline.js', js);
  let err = '';
  try { execFileSync(process.execPath, ['--check', '.cache/inline.js'], { stdio: 'pipe' }); }
  catch (e) { err = (e.stderr?.toString() ?? e.message).split('\n').slice(0, 3).join(' ').trim(); }
  check('inline script parses', !err, err);

  // Layout rules, asserted from the stylesheet. Screenshot geometry from the
  // browser pane is unreliable (it rescales), so reason from the CSS instead.
  const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  const flat = css.replace(/\s+/g, '');
  const bps = [...new Set([...css.matchAll(/@media \(max-width:(\d+)px\)/g)].map((m) => +m[1]))];
  check('at most two width breakpoints', bps.length <= 2, bps.join(','));
  check('phases are three columns by default', /\.phases\{display:grid;grid-template-columns:repeat\(3,1fr\)/.test(flat));
  check('phases stack at the narrow breakpoint', /\.phases\{grid-template-columns:1fr\}/.test(flat));
  check('the capability table can scroll horizontally', /\.tablewrap\{overflow-x:auto/.test(flat));
  check('prose is held to a measure', /max-width:\d+ch/.test(flat));
  check('chart rows stack at the narrow breakpoint', /\.track\{grid-template-columns:1fr/.test(flat));

  const ids = ['run','reset','caps','out','tbody','findings','hygiene','phases','tools','statgrid','provbar','provlegend','expandall','cal','verdict','chart','status','scanned','observed','assumed','toolsum','stamp'];
  const missing = ids.filter((i) => !html.includes(`id="${i}"`));
  check('every element the script queries exists in the markup', !missing.length, missing.join(','));
}

// Hostile input. A public deployment is only as safe as its worst request.
console.log('\n=== Request handling ===');
{
  const post = async (body, raw=false) => {
    try {
      const r = await fetch(`${BASE}/api/scan`, { method:'POST',
        headers:{'content-type':'application/json'},
        body: raw ? body : JSON.stringify(body) });
      return r.status;
    } catch { return 0; }
  };
  check('malformed JSON is rejected, not fatal', await post('{bad', true) === 400);
  check('missing capabilities is rejected',       await post({}) === 400);
  check('empty capabilities is rejected',         await post({capabilities:[]}) === 400);
  check('wrong capabilities type is rejected',    await post({capabilities:'x'}) === 400);
  check('non-string members are rejected',        await post({capabilities:[1,2]}) === 400);
  check('the capability count is capped',         await post({capabilities:Array(40).fill('weather')}) === 400);
  check('the capability length is capped',        await post({capabilities:['a'.repeat(900)]}) === 400);

  const traversal = await Promise.all(
    ['/../server.mjs','/../config.json','/%2e%2e%2fserver.mjs','/../.cache/server.log']
      .map(async (p) => (await fetch(`${BASE}${p}`)).status));
  check('static paths cannot escape public/', traversal.every((s) => s === 404), traversal.join(','));

  check('the server is still up after all of that',
    (await fetch(`${BASE}/api/brief`)).ok);
}

const files = (await readdir('briefs')).filter((f) => f.endsWith('.json')).sort();
const all = [];

for (const f of files) {
  const brief = JSON.parse(await readFile(`briefs/${f}`, 'utf8'));
  process.stdout.write(`\n=== ${brief.name} (${brief.capabilities.length} capabilities) ===\n`);
  const t0 = Date.now();
  const done = await runScan(brief);
  if (!done) { check(`${f} completed`, false, 'no done event'); continue; }
  const { report, rows, tools } = done;
  all.push({ f, brief, done });

  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s · critical ${report.criticalDays}d · pilot ${report.pilotDays}d · ${report.scanned} candidates scanned`);
  for (const r of rows) {
    console.log(`    ${r.tier.padEnd(11)}${String(r.days).padStart(3)}d  ${(r.endpoint?.provider ?? ', ').padEnd(14)}${r.capability.slice(0, 44)}`);
  }

  // --- Invariants ---------------------------------------------------------
  check('every row carries a known tier',
    rows.every((r) => ['NONE','API_KEY','OAUTH','ENTERPRISE','CUSTOM'].includes(r.tier)));

  check('undocumented auth is never read as no-auth',
    rows.filter((r) => r.tier === 'NONE')
        .every((r) => !/scheme is (not )?present|provide any auth|separately/i.test(r.brief ?? '')),
    rows.filter((r) => r.tier === 'NONE').map((r) => r.endpoint?.provider).join(','));

  check('contract-gated vendors never score as no-auth',
    rows.filter((r) => /oracle|sap|workday|mastercard|visa|servicenow/i.test(r.endpoint?.provider ?? ''))
        .every((r) => r.tier !== 'NONE'));

  check('NONE tier only on explicit Orbit evidence',
    rows.filter((r) => r.tier === 'NONE')
        .every((r) => /no authentication|without credentials|no auth/i.test(r.brief ?? '')),
    rows.filter((r) => r.tier === 'NONE').map((r) => r.endpoint?.provider).join(','));

  check('zero-coverage implies CUSTOM tier',
    rows.filter((r) => r.candidateCount === 0).every((r) => r.tier === 'CUSTOM' && r.days === 60));

  check('critical path equals slowest capability',
    report.criticalDays === Math.max(...rows.map((r) => r.days)));

  check('pilot phase contains no OAuth/enterprise/custom work',
    report.phases['1'].every((r) => r.tier === 'NONE' || r.tier === 'API_KEY'));

  check('pilot phase excludes unknown vendors and weak matches',
    report.phases['1'].every((r) =>
      !r.flags.some((f) => ['VENDOR_UNREVIEWED','WEAK_FIT','AUTH_UNVERIFIED'].includes(f))),
    report.phases['1'].flatMap((r) => r.flags).join(','));

  check('catalogue gaps keep the vendor auth tier, not a custom-build tier',
    rows.filter((r) => r.flags.includes('CATALOG_GAP')).every((r) => r.tier !== 'CUSTOM'));

  check('capabilities naming an internal system are scoped as custom work',
    rows.filter((r) => /\b(our|my|internal|in-house|proprietary)\b/i.test(r.capability))
        .every((r) => r.tier === 'CUSTOM' && r.flags.includes('INTERNAL_MISMATCH')));

  check('every row carries a decision trace with exactly one assumption',
    rows.every((r) => (r.trace ?? []).length >= 3 &&
      (r.trace ?? []).filter((s) => s.kind === 'assumption').length === 1),
    rows.map((r) => (r.trace ?? []).filter((s) => s.kind === 'assumption').length).join(','));

  const blockingFlags = Object.entries(done.flags).filter(([, v]) => v.blocking).map(([k]) => k);
  check('security-review vendor list excludes rows we will not integrate',
    report.vendors.every((v) => rows.some((r) =>
      r.endpoint?.provider === v && r.tier !== 'CUSTOM' &&
      !r.flags.some((f) => done.flags[f].blocking))),
    report.vendors.join(','));

  check('vendor count never exceeds integrable capability count',
    report.vendors.length <= rows.filter((r) => r.tier !== 'CUSTOM').length);

  check('tools emitted only for non-blocking rows',
    tools.length === rows.filter((r) => r.endpoint &&
      !r.flags.some((x) => blockingFlags.includes(x))).length);

  check('no tool schema exposes a secret parameter',
    tools.every((t) => !Object.keys(t.input_schema.properties)
      .some((k) => /key|token|secret|password|appid/i.test(k))),
    tools.flatMap((t) => Object.keys(t.input_schema.properties)).join(','));

  const blob = JSON.stringify({ report, tools });
  check('no unredacted secret survives into output',
    !/[?&][a-z_-]*(key|token|secret|access_key)[a-z_-]*=[A-Za-z0-9]{16,}/i.test(blob));

  check('every emitted tool has a non-empty name and description',
    tools.every((t) => t.name.length > 2 && t.description.length > 20));
}

// --- Cross-brief ground truth ------------------------------------------------
console.log('\n=== Ground truth (vendor auth models) ===');
const flat = all.flatMap((a) => a.done.rows).filter((r) => r.endpoint);
const byVendor = (v) => flat.filter((r) => (r.endpoint.provider ?? '').toLowerCase().includes(v));
const expect = { slack:'OAUTH', github:'OAUTH', hubspot:'OAUTH', brevo:'API_KEY', razorpay:'API_KEY' };
for (const [v, want] of Object.entries(expect)) {
  const hits = byVendor(v).filter((r) => !r.flags.includes('CATALOG_GAP') && !r.flags.includes('INTERNAL_MISMATCH'));
  if (!hits.length) { console.log(`  SKIP  ${v}, not selected in any brief`); continue; }
  check(`${v} classified ${want}`, hits.every((r) => r.tier === want),
    hits.map((r) => r.tier).join(','));
}

console.log('\n=== Determinism ===');
const first = all[0];
const again = await runScan(first.brief);
check('identical inputs produce identical report',
  JSON.stringify(again.report.counts) === JSON.stringify(first.done.report.counts) &&
  again.report.criticalDays === first.done.report.criticalDays);

await writeFile('.cache/validation.json', JSON.stringify(all.map(a => ({
  brief: a.brief.name, report: a.done.report, rows: a.done.rows.map(r => ({
    capability: r.capability, tier: r.tier, days: r.days, fit: r.fit,
    provider: r.endpoint?.provider ?? null, flags: r.flags })),
})), null, 2));

console.log(`\n${'='.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(52)}`);
process.exit(fail ? 1 : 0);
