#!/usr/bin/env node
// Empirical coverage study of Orbit's public catalogue across enterprise domains.
// Search-only (fast); measures what an FDE would actually hit in the field.
import * as orbit from './lib/orbit.mjs';
import { rankCandidates, FLAGS } from './lib/score.mjs';
import { writeFile } from 'node:fs/promises';

const DOMAINS = {
  'Comms':    ['send a message to a Slack channel','post a message to Microsoft Teams','send a transactional email to a customer','send an SMS notification'],
  'ITSM':     ['create and update a customer support ticket','create a pagerduty incident','open an issue in a GitHub repository','query application error metrics'],
  'CRM':      ['look up a customer record in a CRM','create a sales opportunity','update a contact record','list accounts in a CRM'],
  'Finance':  ['issue a refund for a payment','create an invoice in an accounting system','initiate a bank payment transfer','look up a corporate card transaction'],
  'HR':       ['create a new employee record in an HR system','send a document for electronic signature','look up employee time off balance','run payroll for an employee'],
  'Identity': ['provision a user account in an identity provider','deactivate a user account','list group memberships for a user','reset a user password'],
  'Data':     ['run a SQL query against a data warehouse','list tables in a database','export a report as CSV','read rows from a spreadsheet'],
  'Internal': ['search our internal company knowledge base','read runbooks from our internal wiki','look up a record in our proprietary system','query our internal HRIS'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];

for (const [domain, caps] of Object.entries(DOMAINS)) {
  for (const cap of caps) {
    let res = null;
    try { res = await orbit.search(cap, 10); } catch (e) { console.error(`  ! ${cap}: ${e.message}`); }
    const ranked = rankCandidates(cap, res);
    const defective = ranked.filter((r) => r.flags.some((f) => FLAGS[f].blocking)).length;
    rows.push({
      domain, capability: cap,
      total: res?.meta?.total ?? 0,
      topVendor: ranked[0]?.ep?.provider ?? null,
      defective,
      defectRate: ranked.length ? defective / ranked.length : 0,
      leaks: ranked.filter((r) => r.leak).length,
    });
    process.stdout.write(`  ${domain.padEnd(9)} ${String(res?.meta?.total ?? 0).padStart(2)} results  ${defective} defective  ${cap.slice(0,44)}\n`);
    if (!res?._cached) await sleep(700);
  }
}

const byDomain = {};
for (const r of rows) {
  const d = byDomain[r.domain] ??= { capabilities: 0, zero: 0, results: 0, defective: 0, candidates: 0, leaks: 0 };
  d.capabilities++; d.results += r.total; d.defective += r.defective; d.leaks += r.leaks;
  d.candidates += r.total; if (r.total === 0) d.zero++;
}
await writeFile('.cache/coverage.json', JSON.stringify({ rows, byDomain }, null, 2));

console.log('\n  DOMAIN     CAPS  ZERO-COVERAGE  AVG RESULTS  DEFECT RATE  LEAKS');
for (const [d, s] of Object.entries(byDomain)) {
  console.log(`  ${d.padEnd(10)} ${String(s.capabilities).padStart(3)}   ${String(s.zero).padStart(6)}        ${(s.results/s.capabilities).toFixed(1).padStart(6)}      ${((s.defective/Math.max(s.candidates,1))*100).toFixed(0).padStart(5)}%   ${String(s.leaks).padStart(4)}`);
}
const tot = rows.reduce((a,r)=>({c:a.c+r.total, d:a.d+r.defective, z:a.z+(r.total?0:1), l:a.l+r.leaks}),{c:0,d:0,z:0,l:0});
console.log(`\n  ${rows.length} capabilities · ${tot.c} candidates · ${tot.z} zero-coverage · ${tot.d} defective (${(tot.d/tot.c*100).toFixed(1)}%) · ${tot.l} credential leaks`);
