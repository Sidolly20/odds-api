// lib/apiKeyAuth.js — checks the x-api-key header on every request to a
// protected route. Looks up the key in Supabase, resets the daily counters
// if it's a new day, blocks the request if the key is missing, unknown,
// or has used up its daily limit. 'owner' tier (you) is effectively unlimited.
//
// Busy endpoints (/v1/live and /v1/matches) have their OWN counter
// (heavy_calls_today) with a limit that is HEAVY_MULTIPLIER times the normal
// daily_limit, so a website that refreshes often does not use up the key.

const supabase = require('./supabase');

const HEAVY_MULTIPLIER = 20;

function isHeavy(req) {
  const path = (req.originalUrl || '').split('?')[0];
  return path.startsWith('/v1/live') || path.startsWith('/v1/matches');
}

// Keys are cached in memory for 60 seconds and usage is counted in memory,
// then saved to Supabase at most every 10 seconds per key. This turns
// "2 database calls per visitor request" into about 1 call per 10 seconds.
const CACHE_MS = 60 * 1000;
const FLUSH_MS = 10 * 1000;
const keyCache = new Map(); // key -> { row, calls, heavy, day, loadedAt, flushedAt, dirty }

async function loadKey(key) {
  const { data: keyRow, error } = await supabase.from('api_keys').select('*').eq('key', key).single();
  if (error || !keyRow) return null;
  const today = new Date().toISOString().slice(0, 10);
  const fresh = keyRow.last_reset !== today;
  return {
    row: keyRow,
    calls: fresh ? 0 : (keyRow.calls_today || 0),
    heavy: fresh ? 0 : (keyRow.heavy_calls_today || 0),
    day: today,
    loadedAt: Date.now(),
    flushedAt: Date.now(),
    dirty: false
  };
}

function flush(key, e) {
  e.dirty = false;
  e.flushedAt = Date.now();
  supabase
    .from('api_keys')
    .update({ calls_today: e.calls, heavy_calls_today: e.heavy, last_reset: e.day })
    .eq('key', key)
    .then(() => { })
    .catch(() => { e.dirty = true; });
}

async function apiKeyAuth(req, res, next) {
  const key = req.header('x-api-key');

  if (!key) {
    return res.status(401).json({ error: 'Missing API key. Send it as the x-api-key header.' });
  }

  let e = keyCache.get(key);
  const today = new Date().toISOString().slice(0, 10);

  // Reload from the database if not cached, or the cache is old and has nothing unsaved.
  if (!e || (Date.now() - e.loadedAt > CACHE_MS && !e.dirty)) {
    const loaded = await loadKey(key);
    if (!loaded) {
      keyCache.delete(key);
      return res.status(401).json({ error: 'Invalid API key.' });
    }
    if (keyCache.size > 500) keyCache.clear();
    keyCache.set(key, loaded);
    e = loaded;
  }

  if (e.day !== today) { e.day = today; e.calls = 0; e.heavy = 0; }

  const heavy = isHeavy(req);
  const used = heavy ? e.heavy : e.calls;
  const limit = heavy ? e.row.daily_limit * HEAVY_MULTIPLIER : e.row.daily_limit;

  if (used >= limit) {
    return res.status(429).json({
      error: 'Daily call limit reached for this API key.',
      daily_limit: limit,
      group: heavy ? 'live-and-matches' : 'standard'
    });
  }

  if (heavy) e.heavy += 1; else e.calls += 1;
  e.dirty = true;
  if (Date.now() - e.flushedAt > FLUSH_MS) flush(key, e);

  req.apiKeyOwner = e.row.owner_name;
  req.apiKeyTier = e.row.tier;
  next();
}

module.exports = apiKeyAuth;
