#!/usr/bin/env node
// The experiment behind lib/paraphrase.mjs and INTERNAL_MISMATCH.
//
// A zero-result from Orbit is Preflight's strongest claim: it drives the
// custom-build verdict and usually the headline critical path. This checks
// whether that signal survives rephrasing. It does not: the same capability,
// phrased five ways, returned 0, 10, 10, 0 and 10 results, and the top hit for
// "internal wiki" was Wikimedia Foundation.
//
// The conclusion was not to paraphrase more aggressively. Stripping the words
// that make a capability org-internal asks an easier question and answers it
// confidently and wrongly. See DECISIONS.md, correction 4.
//
//   node phrasing.mjs
import * as orbit from './lib/orbit.mjs';

const GROUPS = {
  'internal knowledge base': [
    'search an internal company knowledge base of documents',
    'search our internal company knowledge base',
    'search the internal wiki for documents',
    'full text search over internal company documents',
    'query our internal document store',
  ],
  'internal HRIS lookup': [
    "look up an employee's compensation band in our internal HRIS",
    'query our internal HRIS',
    'read employee salary data from our internal HR system',
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [name, variants] of Object.entries(GROUPS)) {
  console.log(`\n### ${name}`);
  for (const q of variants) {
    let r = null;
    try { r = await orbit.search(q, 10); } catch (e) { console.log('  error:', e.message); continue; }
    const top = r.data?.[0];
    console.log(`  ${String(r.meta.total).padStart(2)} results  ${(top?.provider ?? 'none').padEnd(20)} "${q}"`);
    if (!r._cached) await sleep(700);
  }
}
