// routes/odds.js — bookmaker odds, powered by Bzzoiro Sports Data.
//
// Free Bzzoiro keys return CONSENSUS odds only (one averaged price per match,
// market and outcome), pre-match only. Rows are passed through exactly as
// Bzzoiro sends them, so nothing here depends on guessed field names.
//
// Responses are cached for 3 minutes (Bzzoiro itself caches for about 3 minutes,
// so asking more often gains nothing). Needs BZZOIRO_KEY on the server.

const express = require('express');
const router = express.Router();

const BASE = 'https://sports.bzzoiro.com/api/v2/odds/';
const CACHE_SECONDS = 180;
const MAX_CACHE_ENTRIES = 200;

// Only these filters are passed on. (bookmaker_slug is deliberately NOT passed:
// on a free key it would return a 403 from Bzzoiro.)
const ALLOWED = [
  'event_id', 'league_id', 'season_id', 'team_id',
  'market', 'outcome', 'updated_after',
  'min_decimal_odds', 'max_decimal_odds', 'movement'
];

const cache = new Map();    // url -> { body, fetchedAt }
const inFlight = new Map(); // url -> promise

class UpstreamError extends Error {
  constructor(status, body) {
    super(`Bzzoiro returned ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function fetchOdds(url) {
  const key = process.env.BZZOIRO_KEY;
  if (!key) throw new Error('BZZOIRO_KEY is not set on the server.');

  const res = await fetch(url, { headers: { Authorization: `Token ${key}` } });

  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch (e) { /* ignore */ }
    throw new UpstreamError(res.status, body);
  }

  const data = await res.json();
  const results = Array.isArray(data) ? data : (data.results ?? data.odds ?? []);
  // Drop Bzzoiro's own "next / previous" links — they point at THEIR server.
  return { count: data.count ?? results.length, results };
}

async function getOdds(url) {
  const hit = cache.get(url);
  if (hit && (Date.now() - hit.fetchedAt) / 1000 < CACHE_SECONDS) {
    return { ...hit.body, cached_at: new Date(hit.fetchedAt).toISOString(), stale: false };
  }

  if (!inFlight.has(url)) {
    const p = fetchOdds(url)
      .then((body) => {
        if (cache.size >= MAX_CACHE_ENTRIES) {
          cache.delete(cache.keys().next().value); // drop the oldest entry
        }
        cache.set(url, { body, fetchedAt: Date.now() });
        return body;
      })
      .finally(() => inFlight.delete(url));
    inFlight.set(url, p);
  }

  try {
    const body = await inFlight.get(url);
    const fresh = cache.get(url);
    return { ...body, cached_at: new Date(fresh ? fresh.fetchedAt : Date.now()).toISOString(), stale: false };
  } catch (err) {
    // A rejected request from the customer (400) should go back to them as is.
    if (err instanceof UpstreamError && err.status === 400) throw err;
    // Otherwise, if we hold an older copy, serve it and say so.
    if (hit) {
      return { ...hit.body, cached_at: new Date(hit.fetchedAt).toISOString(), stale: true };
    }
    throw err;
  }
}

// GET /v1/odds?event_id=123            odds for one match
// GET /v1/odds?league_id=17&market=1x2 match-result odds for a league
// Other filters: season_id, team_id, outcome, updated_after, limit, offset
router.get('/', async (req, res) => {
  const params = new URLSearchParams();

  for (const name of ALLOWED) {
    if (req.query[name] !== undefined && req.query[name] !== '') {
      params.set(name, String(req.query[name]));
    }
  }

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  // Sort so the same request always makes the same cache key.
  params.sort();
  const url = `${BASE}?${params.toString()}`;

  try {
    const out = await getOdds(url);
    res.json({
      count: out.count,
      limit,
      offset,
      type: 'consensus',
      stale: out.stale,
      cached_at: out.cached_at,
      odds: out.results
    });
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 400) {
      return res.status(400).json(err.body || { error: 'Invalid odds request.' });
    }
    console.error('Odds error:', err.message);
    res.status(502).json({ error: 'Odds are temporarily unavailable.' });
  }
});

module.exports = router;
