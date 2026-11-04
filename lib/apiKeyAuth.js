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

async function apiKeyAuth(req, res, next) {
  const key = req.header('x-api-key');

  if (!key) {
    return res.status(401).json({ error: 'Missing API key. Send it as the x-api-key header.' });
  }

  const { data: keyRow, error } = await supabase
    .from('api_keys')
    .select('*')
    .eq('key', key)
    .single();

  if (error || !keyRow) {
    return res.status(401).json({ error: 'Invalid API key.' });
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Reset both counters if this is a new day since last use.
  let callsToday = keyRow.calls_today || 0;
  let heavyToday = keyRow.heavy_calls_today || 0;
  if (keyRow.last_reset !== today) {
    callsToday = 0;
    heavyToday = 0;
  }

  const heavy = isHeavy(req);
  const used = heavy ? heavyToday : callsToday;
  const limit = heavy ? keyRow.daily_limit * HEAVY_MULTIPLIER : keyRow.daily_limit;

  if (used >= limit) {
    return res.status(429).json({
      error: 'Daily call limit reached for this API key.',
      daily_limit: limit,
      group: heavy ? 'live-and-matches' : 'standard'
    });
  }

  if (heavy) heavyToday += 1;
  else callsToday += 1;

  // Save usage (fire-and-forget is fine here; worst case we undercount by one
  // request if this fails, not worth blocking the response).
  supabase
    .from('api_keys')
    .update({ calls_today: callsToday, heavy_calls_today: heavyToday, last_reset: today })
    .eq('key', key)
    .then(() => { })
    .catch(() => { });

  req.apiKeyOwner = keyRow.owner_name;
  req.apiKeyTier = keyRow.tier;
  next();
}

module.exports = apiKeyAuth;