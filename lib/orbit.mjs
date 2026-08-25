// Orbit API client: disk-cached, rate-limit aware, sequential by default.
// Orbit rate-limits (429) and its catalog changes over time, so every response
// is cached to .cache/ keyed by request hash. Reruns of a scan are free.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, '.cache');
const SEARCH_URL = 'https://api.buildwithorbit.ai/v1/search';
const INTEGRATE_URL = 'https://api.buildwithorbit.ai/v1/integrate';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Orbit is a rate-limited external dependency with ~7s integrate latency.
// Instrument it: we cannot reason about a scan we cannot see.
export const stats = { search: 0, integrate: 0, cacheHits: 0, retries429: 0,
  errors: 0, msSearch: 0, msIntegrate: 0 };
export const resetStats = () => Object.keys(stats).forEach((k) => (stats[k] = 0));
const key = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 32);

async function cached(name, payload, fn) {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${name}-${key(payload)}.json`);
  try {
    const hit = { ...JSON.parse(await readFile(file, 'utf8')), _cached: true };
    stats.cacheHits++;
    return hit;
  } catch { /* cache miss */ }
  const data = await fn();
  await writeFile(file, JSON.stringify(data, null, 2));
  return { ...data, _cached: false };
}

// Retries on 429 with backoff. Orbit documents 429 as the rate-limit signal.
async function post(url, body, attempt = 0) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (res.status === 429 && attempt < 4) {
    stats.retries429++;
    await sleep(2000 * 2 ** attempt);
    return post(url, body, attempt + 1);
  }
  if (!res.ok) {
    stats.errors++;
    // Note: the docs promise 404 for unresolvable ids; the API returns 500.
    throw new Error(`Orbit ${res.status} ${res.statusText} on ${new URL(url).pathname}`);
  }
  return res.json();
}

async function timed(kind, key, payload, fn) {
  const t0 = Date.now();
  const out = await cached(key, payload, fn);
  const ms = Date.now() - t0;
  if (kind === 'search') { stats.search++; stats.msSearch += ms; }
  else { stats.integrate++; stats.msIntegrate += ms; }
  return { ...out, _ms: ms };
}

export function search(q, limit = 8) {
  return timed('search', 'search', { q, limit }, () =>
    post(`${SEARCH_URL}?limit=${limit}`, { q }));
}

export function integrate(task, resources) {
  return timed('integrate', 'integrate', { task, resources }, () =>
    post(INTEGRATE_URL, { task, resources }));
}
