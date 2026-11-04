// lib/bzz.js — one shared, cached way to call Bzzoiro Sports Data.
//
// - Adds the API key (BZZOIRO_KEY) for you.
// - Keeps each answer in memory for a set number of seconds, so many customers
//   asking the same thing cost Bzzoiro only one call.
// - If many requests arrive at the same moment, they share one call.
// - If Bzzoiro fails but we hold an older copy, we serve that (marked stale).

const BASE = 'https://sports.bzzoiro.com/api/v2';
const MAX_ENTRIES = 500;

const cache = new Map();    // path -> { body, fetchedAt }
const inFlight = new Map(); // path -> promise

class UpstreamError extends Error {
  constructor(status, body) {
    super(`Bzzoiro returned ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function request(path) {
  const key = process.env.BZZOIRO_KEY;
  if (!key) throw new Error('BZZOIRO_KEY is not set on the server.');

  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Token ${key}` } });

  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch (e) { /* ignore */ }
    throw new UpstreamError(res.status, body);
  }
  return res.json();
}

// bzzGet('/events/?status=upcoming', 60) -> { data, stale }
async function bzzGet(path, ttlSeconds) {
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
    if (hit && !(err instanceof UpstreamError && err.status === 400)) {
      return { data: hit.body, stale: true };
    }
    throw err;
  }
}

// Like bzzGet, but returns null instead of throwing (a match with no odds or no
// prediction should never break a whole list). Failures are remembered for
// a few minutes so we don't ask again on every request.
const noneUntil = new Map();
async function bzzGetSafe(path, ttlSeconds, noneSeconds = 180) {
  if ((noneUntil.get(path) || 0) > Date.now()) return null;
  try {
    const r = await bzzGet(path, ttlSeconds);
    return r.data;
  } catch (err) {
    if (noneUntil.size > 2000) noneUntil.clear();
    noneUntil.set(path, Date.now() + noneSeconds * 1000);
    return null;
  }
}

module.exports = { bzzGet, bzzGetSafe, UpstreamError };
