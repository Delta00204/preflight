#!/usr/bin/env node
// Guards the committed Orbit cache. The catalogue is user-published content and
// does contain live credentials: a Positionstack key was observed in a search
// result during development. Nothing stops a future cache entry carrying one,
// so this runs in CI and fails the build rather than relying on a manual check.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PATTERNS = [
  ['credential in query string', /[?&][a-z_-]*(?:key|token|secret|password|access_key|apikey|appid|auth)[a-z_-]*=([A-Za-z0-9_.\-]{16,})/gi],
  ['bearer token',               /Bearer\s+([A-Za-z0-9._\-]{20,})/g],
  ['JWT',                        /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g],
  ['AWS access key id',          /\b(AKIA[0-9A-Z]{16})\b/g],
  ['GitHub token',               /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g],
  ['private key block',          /(-----BEGIN [A-Z ]*PRIVATE KEY-----)/g],
  ['credentials in URL',         /(https?:\/\/[^/\s:]+:[^@/\s]+@)/g],
];
// Templates and obvious placeholders are how a well-formed collection marks the
// spot where a secret belongs. Those are fine; literals are not.
const PLACEHOLDER = /^(your|enter|xxx|test|demo|example|sample|string|token|secret|key|placeholder|<|\{)/i;
const isPlaceholder = (v) => v.includes('{{') || v.includes('${') || v.includes('<') || PLACEHOLDER.test(v);

const dirs = ['.cache', 'briefs', 'lib', 'public', 'docs'];
let scanned = 0, findings = 0;

for (const dir of dirs) {
  let entries = [];
  try { entries = await readdir(dir); } catch { continue; }
  for (const name of entries) {
    if (!/\.(json|mjs|js|html|md)$/.test(name)) continue;
    const file = join(dir, name);
    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    scanned++;
    for (const [label, re] of PATTERNS) {
      for (const m of text.matchAll(re)) {
        const value = m[1] ?? m[0];
        if (isPlaceholder(value)) continue;
        findings++;
        console.error(`  FAIL  ${label} in ${file}: ${value.slice(0, 4)}${'*'.repeat(8)}${value.slice(-2)}`);
      }
    }
  }
}

console.log(`  scanned ${scanned} files across ${dirs.join(', ')}`);
if (findings) {
  console.error(`\n  ${findings} potential credential(s) found. Do not publish until resolved.`);
  process.exit(1);
}
console.log('  no credentials found');
