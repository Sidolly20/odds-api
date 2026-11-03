// lib/apiKeyAuth.js — checks the x-api-key header on every request to a
// protected route. Looks up the key in Supabase, resets the daily counter
// if it's a new day, blocks the request if the key is missing, unknown,
// or has used up its daily limit. 'owner' tier (you) is effectively unlimited.

const supabase = require('./supabase');

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

  // Reset the counter if this is a new day since last use.
  let callsToday = keyRow.calls_today;
  if (keyRow.last_reset !== today) {
    callsToday = 0;
  }

  if (callsToday >= keyRow.daily_limit) {
    return res.status(429).json({
      error: 'Daily call limit reached for this API key.',
      daily_limit: keyRow.daily_limit
    });
  }

  // Increment and save usage (fire-and-forget is fine here; worst case we
  // undercount by one request if this fails, not worth blocking the response).
  supabase
    .from('api_keys')
    .update({ calls_today: callsToday + 1, last_reset: today })
    .eq('key', key)
    .then(() => {})
    .catch(() => {});

  req.apiKeyOwner = keyRow.owner_name;
  req.apiKeyTier = keyRow.tier;
  next();
}

module.exports = apiKeyAuth;
