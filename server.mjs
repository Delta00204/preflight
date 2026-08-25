#!/usr/bin/env node
// Preflight, integration readiness for enterprise agent deployments.
// Local-only HTTP server, zero dependencies.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as orbit from './lib/orbit.mjs';
import { paraphrase } from './lib/paraphrase.mjs';
import { scoreCapability, rankCandidates, buildReport, TIERS, FLAGS, CONFIG } from './lib/score.mjs';
import { toolsFor } from './lib/toolgen.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Request limits. Every capability costs at least one Orbit call, and Orbit is
// rate-limited, so an uncapped array is a way to burn someone else's quota.
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CAPABILITIES = 12;
const MAX_CAPABILITY_CHARS = 512;   // Orbit rejects longer queries anyway.
const PORT = Number(process.env.PORT ?? 7878);
const HOST = '127.0.0.1';
// Charset is not optional: without it the browser guesses latin-1 and every
// em dash renders as mojibake.
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

// Runs the scan, emitting NDJSON progress events as it goes.
async function scan(capabilities, task, emit) {
  orbit.resetStats();
  const t0 = Date.now();
  const rows = [];
  for (const [i, cap] of capabilities.entries()) {
    emit({ type: 'progress', step: i + 1, total: capabilities.length, capability: cap, stage: 'search' });
    let searchResult = null;
    const probes = [cap];
    try {
      searchResult = await orbit.search(cap, 8);
    } catch (err) {
      emit({ type: 'warn', capability: cap, message: `search failed: ${err.message}` });
    }

    // Zero results is our strongest claim, and empirically the least stable.
    // Re-probe with simplified phrasings before declaring a coverage gap.
    if (!searchResult?.data?.length) {
      for (const alt of paraphrase(cap)) {
        emit({ type:'progress', step:i+1, total:capabilities.length, capability:cap, stage:'re-probe phrasing' });
        try {
          const retry = await orbit.search(alt, 8);
          probes.push(alt);
          if (retry?.data?.length) {
            emit({ type:'warn', capability: cap,
                   message: `zero results for original phrasing; "${alt}" returned ${retry.meta.total}` });
            searchResult = retry;
            break;
          }
        } catch { /* keep probing */ }
      }
    }

    // Orbit's brief opens with its own FIT verdict, and when it rejects an
    // endpoint it usually says what to search for instead. Two loops: walk our
    // ranked candidates, then follow Orbit's own remediation hint.
    const REJECTED = /\bFIT\b\s*\n\s*not at all/i;
    let chosen = null;

    const tryCandidates = async (cands, stage) => {
      for (const [n, cand] of cands.entries()) {
        emit({ type:'progress', step:i+1, total:capabilities.length, capability:cap,
               stage: n === 0 ? stage : `${stage} #${n + 1}` });
        try {
          // `task` must describe what THIS endpoint does. Appending the wider
          // deployment goal makes Orbit judge one endpoint against the whole
          // programme and reject correct picks.
          const res = await orbit.integrate(cap, [{ id: cand.ep.id, type: cand.ep.resourceType }]);
          const brief = res?.data?.[0]?.taskBrief ?? null;
          const rejected = REJECTED.test(brief ?? '');
          chosen = { ep: cand.ep, brief, rejected };
          if (!rejected) return true;
        } catch (err) {
          emit({ type: 'warn', capability: cap, message: `integrate failed: ${err.message}` });
        }
      }
      return false;
    };

    let ok = await tryCandidates(rankCandidates(cap, searchResult).slice(0, 3), 'integrate');

    // Orbit told us why it rejected and what to look for. Use it.
    if (!ok && chosen?.brief) {
      const hint = chosen.brief.match(/Search again for ([^.]+)\./i)?.[1];
      if (hint) {
        emit({ type:'warn', capability: cap,
               message: `Orbit rejected all candidates; following its hint: "${hint.trim().slice(0,90)}"` });
        emit({ type:'progress', step:i+1, total:capabilities.length, capability:cap, stage:'re-search on Orbit hint' });
        try {
          const retry = await orbit.search(hint.trim(), 8);
          if (retry?.data?.length) {
            ok = await tryCandidates(rankCandidates(cap, retry).slice(0, 2), 'integrate (hinted)');
            if (ok) searchResult = retry;
          }
        } catch (err) {
          emit({ type: 'warn', capability: cap, message: `hint re-search failed: ${err.message}` });
        }
      }
    }

    const row = scoreCapability(cap, searchResult, chosen);
    row.probes = probes;
    rows.push(row);
    emit({ type: 'row', row });
  }

  const report = buildReport(rows);
  const telemetry = { ...orbit.stats, wallMs: Date.now() - t0,
    orbitCalls: orbit.stats.search + orbit.stats.integrate };
  emit({ type: 'done', report, rows, tools: toolsFor(rows), tiers: TIERS,
         flags: FLAGS, config: CONFIG, telemetry });
}

// Errors explain what to fix; they never leak a stack trace to the client.
function bad(res, code, message) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message }));
}

const server = createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (err) {
    console.error('unhandled request error:', err);
    if (!res.headersSent) bad(res, 500, 'Something went wrong handling that request.');
    else res.end();
  }
});

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/api/scan') {
    const raw = await new Promise((resolve, reject) => {
      let b = '', n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
        b += c;
      });
      req.on('end', () => resolve(b || '{}'));
      req.on('error', reject);
    }).catch((err) => ({ __error: err.message }));

    if (raw && raw.__error) return bad(res, 413, raw.__error);

    let body;
    try { body = JSON.parse(raw); }
    catch { return bad(res, 400, 'Request body is not valid JSON.'); }

    const caps = Array.isArray(body?.capabilities)
      ? body.capabilities.filter((c) => typeof c === 'string' && c.trim())
      : null;
    if (!caps || caps.length === 0) return bad(res, 400, 'Provide a non-empty "capabilities" array of strings.');
    if (caps.length > MAX_CAPABILITIES) return bad(res, 400, `At most ${MAX_CAPABILITIES} capabilities per assessment.`);
    const tooLong = caps.find((c) => c.length > MAX_CAPABILITY_CHARS);
    if (tooLong) return bad(res, 400, `Each capability must be ${MAX_CAPABILITY_CHARS} characters or fewer.`);
    const goal = typeof body?.goal === 'string' ? body.goal.slice(0, MAX_CAPABILITY_CHARS) : 'Enterprise agent deployment';

    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' });
    const emit = (o) => res.write(JSON.stringify(o) + '\n');
    try {
      await scan(caps, goal, emit);
    } catch (err) {
      emit({ type: 'error', message: err.message });
    }
    return res.end();
  }

  if (url.pathname === '/api/brief') {
    const b = await readFile(join(ROOT, 'briefs/support-agent.json'), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(b);
  }

  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const buf = await readFile(join(ROOT, 'public', file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'text/plain; charset=utf-8' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

// A single bad request must never take the process down.
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

server.listen(PORT, HOST, () => {
  console.log(`\n  Preflight running at  http://${HOST}:${PORT}\n`);
});
