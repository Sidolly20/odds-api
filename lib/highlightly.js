// lib/highlightly.js — last-resort live scores from Highlightly.
// Free/Basic plan: 100 requests a day. This file keeps us well under that.
//
// Rules:
//  - One list call covers all of today's matches. No per-match calls.
//  - Never more than one call per MIN_GAP_MS. Between calls we reuse the last answer, marked with as_of.
//  - Stops itself at DAILY_BUDGET calls per UTC day, and when Highlightly reports few requests left.
//  - Only in-play matches are returned.

const BASE = 'https://soccer.highlightly.net';

const CONFIG = {
  MIN_GAP_MS: 15 * 60e3,  // at most one real call every 15 minutes
  DAILY_BUDGET: 60,       // our own cap per UTC day (leaves 40 spare on a 100 plan)
  REMAINING_FLOOR: 5,     // stop if Highlightly says this few requests are left
  TIMEOUT_MS: 8000
};

const IN_PLAY = new Set([
  'First half', 'Second half', 'Half time', 'Extra time', 'Break time', 'Penalties', 'In progress'
]);

let state = {
  day: '',
  callsToday: 0,
  lastCallAt: 0,
  lastResult: null,   // { events, as_of } from the last successful call
  lastError: null,
  remaining: null,
  limit: null
};

const utcDay = () => new Date().toISOString().slice(0, 10);
const lagosDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());

function resetIfNewDay() {
  if (state.day !== utcDay()) {
    state.day = utcDay();
    state.callsToday = 0;
  }
}

// "3 - 1" -> { home: 3, away: 1 }
function parseScore(s) {
  const m = String(s || '').match(/(\d+)\s*-\s*(\d+)/);
  return m ? { home: parseInt(m[1]), away: parseInt(m[2]) } : { home: null, away: null };
}

function mapMatch(m) {
  const sc = parseScore(m.state && m.state.score && m.state.score.current);
  return {
    id: `hl-${m.id}`,
    league: { id: m.league?.id ?? null, name: m.league?.name ?? null, logo: m.league?.logo ?? null },
    home: { id: m.homeTeam?.id ?? null, name: m.homeTeam?.name ?? null, logo: m.homeTeam?.logo ?? null },
    away: { id: m.awayTeam?.id ?? null, name: m.awayTeam?.name ?? null, logo: m.awayTeam?.logo ?? null },
    kickoff: m.date ?? null,
    status: 'live',
    period: m.state?.description ?? null,
    minute: m.state?.clock ?? null,
    minute_estimated: false,
    score: sc,
    source: 'highlightly'
  };
}

// Returns { events, as_of }. Throws if it cannot or should not call.
async function fetchHighlightlyLive() {
  const key = process.env.HIGHLIGHTLY_KEY;
  if (!key) throw new Error('HIGHLIGHTLY_KEY not set');

  resetIfNewDay();
  const now = Date.now();

  if (state.lastResult && now - state.lastCallAt < CONFIG.MIN_GAP_MS) {
    return state.lastResult;
  }
  if (state.callsToday >= CONFIG.DAILY_BUDGET) {
    throw new Error(`Highlightly daily budget used (${state.callsToday}/${CONFIG.DAILY_BUDGET})`);
  }
  if (state.remaining != null && state.remaining <= CONFIG.REMAINING_FLOOR) {
    throw new Error(`Highlightly quota low (${state.remaining} left)`);
  }

  state.lastCallAt = now;
  state.callsToday++;

  const url = `${BASE}/matches?date=${lagosDay()}&timezone=Africa%2FLagos&limit=100`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CONFIG.TIMEOUT_MS);

  try {
    const res = await fetch(url, { headers: { 'x-rapidapi-key': key }, signal: ctl.signal });

    const rem = res.headers.get('x-ratelimit-requests-remaining');
    const lim = res.headers.get('x-ratelimit-requests-limit');
    if (rem != null) state.remaining = parseInt(rem);
    if (lim != null) state.limit = parseInt(lim);

    if (!res.ok) throw new Error(`Highlightly responded ${res.status}`);

    const body = await res.json();
    const list = Array.isArray(body.data) ? body.data : [];
    const events = list.filter((m) => IN_PLAY.has(m.state?.description)).map(mapMatch);

    state.lastResult = { events, as_of: new Date().toISOString() };
    state.lastError = null;
    return state.lastResult;
  } catch (err) {
    state.lastError = err.message;
    state.lastResult = null;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Safe status for /api/status diagnostics. Never includes the key.
function highlightlyState() {
  return {
    key_set: !!process.env.HIGHLIGHTLY_KEY,
    calls_today: state.callsToday,
    daily_budget: CONFIG.DAILY_BUDGET,
    remaining: state.remaining,
    limit: state.limit,
    last_call_at: state.lastCallAt ? new Date(state.lastCallAt).toISOString() : null,
    last_error: state.lastError,
    min_gap_minutes: CONFIG.MIN_GAP_MS / 60e3
  };
}

module.exports = { fetchHighlightlyLive, highlightlyState };
