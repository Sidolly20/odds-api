// lib/bzz.js — one shared, cached and POLITE way to call Bzzoiro Sports Data.
//
// - Adds the API key (BZZOIRO_KEY) for you.
// - Keeps each answer in memory for a set number of seconds, so many customers
//   asking the same thing cost Bzzoiro only one call.
// - If many requests arrive at the same moment, they share one call.
// - Calls are spaced out (BZZ_GAP_MS, default 150 ms) so we never fire hundreds at once.
// - If Bzzoiro answers 429 (too many requests), ALL calls pause (it obeys Retry-After,
//   otherwise 30 s, doubling up to 10 minutes). While paused we do not call Bzzoiro at all,
//   which stops us making the problem worse.
// - If Bzzoiro fails but we hold an older copy, we serve it (marked stale), but only while
//   it is younger than maxStaleSeconds (default 30 minutes). Never forever.

const BASE = process.env.BZZOIRO_BASE || 'https://sports.bzzoiro.com/api/v2';
const MAX_ENTRIES = 500;
const GAP_MS = parseInt(process.env.BZZ_GAP_MS) || 150;

const cache = new Map();    // path -> { body, fetchedAt }
const inFlight = new Map(); // path -> promise

class UpstreamError extends Error {
  constructor(status, body) {
    super(`Bzzoiro returned ${status}`);
    this.status = status;
    this.body = body;
  }
}

// ---------- pacing and the 429 pause ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chain = Promise.resolve();
let lastAt = 0;
function paced(fn) {
  const run = chain.then(async () => {
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    return fn();
  });
  chain = run.catch(() => { });
  return run;
}

let pausedUntil = 0;
let strikes = 0;
let lastFailure = null; // { at, status, message } — the most recent time Bzzoiro refused or failed
const pausedForSeconds = () => Math.max(0, Math.ceil((pausedUntil - Date.now()) / 1000));

function onLimited(res) {
  const ra = parseInt(res.headers.get('retry-after'));
  const secs = ra > 0 ? Math.min(ra, 900) : Math.min(600, 30 * 2 ** strikes);
  strikes += 1;
  pausedUntil = Date.now() + secs * 1000;
  const hdr = {};
  res.headers.forEach((v, k) => { if (/retry|limit|remaining|reset|quota/i.test(k)) hdr[k] = v; });
  console.error(`Bzzoiro said 429. Pausing ALL Bzzoiro calls for ${secs}s. Headers: ${JSON.stringify(hdr)}`);
}

function noteFailure(status, message) {
  lastFailure = { at: new Date().toISOString(), status, message: String(message).slice(0, 160) };
}

async function request(path) {
  const key = process.env.BZZOIRO_KEY;
  if (!key) throw new Error('BZZOIRO_KEY is not set on the server.');
  if (pausedForSeconds() > 0) throw new UpstreamError(429, { paused: true, seconds: pausedForSeconds() });

  const res = await paced(() => fetch(`${BASE}${path}`, { headers: { Authorization: `Token ${key}` } }));

  if (res.status === 429) {
    onLimited(res);
    noteFailure(429, 'Too many requests (rate limit or daily allowance)');
    let body = null;
    try { body = await res.json(); } catch (e) { /* ignore */ }
    if (body) console.error('Bzzoiro 429 body:', JSON.stringify(body).slice(0, 300));
    throw new UpstreamError(429, body);
  }
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch (e) { /* ignore */ }
    noteFailure(res.status, body ? JSON.stringify(body) : 'HTTP ' + res.status);
    throw new UpstreamError(res.status, body);
  }
  strikes = 0;
  return res.json();
}

// bzzGet('/events/?status=upcoming', 60) -> { data, stale }
async function bzzGet(path, ttlSeconds, maxStaleSeconds = 1800) {
  const hit = cache.get(path);
  if (hit && (Date.now() - hit.fetchedAt) / 1000 < ttlSeconds) {
    return { data: hit.body, stale: false };
  }

  if (!inFlight.has(path)) {
    const p = request(path)
      .then((body) => {
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(path, { body, fetchedAt: Date.now() });
        return body;
      })
      .finally(() => inFlight.delete(path));
    inFlight.set(path, p);
  }

  try {
    const data = await inFlight.get(path);
    return { data, stale: false };
  } catch (err) {
    const tooOld = hit && (Date.now() - hit.fetchedAt) / 1000 >= maxStaleSeconds;
    if (hit && !tooOld && !(err instanceof UpstreamError && err.status === 400)) {
      return { data: hit.body, stale: true };
    }
    throw err;
  }
}

// Like bzzGet, but returns null instead of throwing (a match with no odds or no
// prediction should never break a whole list). Failures are remembered for
// a few minutes so we don't ask again on every request.
const noneUntil = new Map();
async function bzzGetSafe(path, ttlSeconds, noneSeconds = 180, maxStaleSeconds = 6 * 3600) {
  if ((noneUntil.get(path) || 0) > Date.now()) return null;
  try {
    const r = await bzzGet(path, ttlSeconds, maxStaleSeconds);
    return r.data;
  } catch (err) {
    if (noneUntil.size > 2000) noneUntil.clear();
    noneUntil.set(path, Date.now() + noneSeconds * 1000);
    return null;
  }
}

// A small summary for the /v1/live "diag" block (no keys, nothing secret).
const bzzState = () => ({ paused_seconds: pausedForSeconds(), last_failure: lastFailure, key_set: !!process.env.BZZOIRO_KEY });

module.exports = { bzzGet, bzzGetSafe, UpstreamError, pausedForSeconds, bzzState };
