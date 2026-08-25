// A zero-result from Orbit is Preflight's strongest claim: it drives the
// custom-build verdict and usually the critical path. Empirically that signal
// is unstable, the same capability phrased five ways returned 0, 10, 10, 0, 10
// (see phrasing.mjs). Long, qualified queries under-retrieve; shorter ones hit.
//
// So never conclude "no public API" from one phrasing. Progressively simplify
// and re-probe; only a gap that survives every variant is reported as a gap.

const FILLER = /\b(the|an|a)\b/gi;

// Never stripped: these words are what make the capability org-internal.
// Removing them turns "search our internal wiki" into "search a wiki", which
// Orbit answers confidently and wrongly.
export const INTERNAL = /\b(our|my|internal|in-house|proprietary|company'?s)\b/i;

export function paraphrase(capability) {
  const base = capability.trim().replace(/\s+/g, ' ');
  const out = new Set();

  // 1. Drop articles only.
  out.add(base.replace(FILLER, ' ').replace(/\s+/g, ' ').trim());

  // 2. Drop a trailing prepositional phrase ("... of documents", "... in a CRM").
  out.add(base.replace(/\s+\b(of|in|from|for|to)\b\s+.*$/i, '').trim());

  // 3. Both, then clipped to the core verb phrase.
  const core = base.replace(FILLER, ' ')
    .replace(/\s+\b(of|in|from|for|to)\b\s+.*$/i, '')
    .replace(/\s+/g, ' ').trim();
  out.add(core);
  out.add(core.split(' ').slice(0, 4).join(' '));

  return [...out].filter((v) => v && v.toLowerCase() !== base.toLowerCase() && v.split(' ').length >= 2);
}
