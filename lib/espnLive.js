// lib/espnLive.js — EXTRA backup for live scores: ESPN's public scoreboard feed (no key needed).
//
// NOTE: this is an UNOFFICIAL, undocumented feed. It can change or block us without warning.
// So everything here is defensive: every field is checked, and anything unexpected is skipped.
// It is only called when Bzzoiro cannot answer, and one shared copy is kept for 60 seconds.
// What it adds: a REAL match clock (football-data's free plan has none) and a second score source.

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
// ESPN league codes: Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Champions League,
// Europa League, Championship, Eredivisie, Primeira Liga.
const LEAGUES = (process.env.ESPN_LEAGUES || 'eng.1,esp.1,ita.1,ger.1,fra.1,uefa.champions,uefa.europa,eng.2,ned.1,por.1')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CACHE_SECONDS = 60;
const ID_OFFSET = 9000000000; // keeps ESPN ids from clashing with real ids

let cache = { at: 0, events: [] };
let inFlight = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function minuteOf(status) {
  // displayClock looks like "67'" or "45'+2'" -> take the first number.
  const m = /(\d+)/.exec(String(status?.displayClock ?? ''));
  if (m) return Number(m[1]);
  const secs = num(status?.clock);
  return secs && secs > 0 ? Math.ceil(secs / 60) : null;
}

function parseEvent(ev, leagueName) {
  try {
    const comp = ev?.competitions?.[0];
    const status = ev?.status || comp?.status;
    if (!comp || !status || status.type?.state !== 'in') return null; // live matches only
    const cs = Array.isArray(comp.competitors) ? comp.competitors : [];
    const h = cs.find((c) => c?.homeAway === 'home');
    const a = cs.find((c) => c?.homeAway === 'away');
    const hn = h?.team?.displayName || h?.team?.name;
    const an = a?.team?.displayName || a?.team?.name;
    if (!hn || !an || ev.id == null) return null;
    const half = /HALFTIME/i.test(String(status.type?.name || '')) || /^half/i.test(String(status.type?.detail || ''));
    return {
      id: ID_OFFSET + (num(ev.id) || 0),
      league: { id: null, name: leagueName || null, logo: null },
      home: { id: null, name: hn, logo: h?.team?.logo || null },
      away: { id: null, name: an, logo: a?.team?.logo || null },
      kickoff: ev.date || comp.date || null,
      status: half ? 'halftime' : 'inprogress',
      period: half ? 'HT' : null,
      minute: half ? 45 : minuteOf(status),
      minute_estimated: false,
      score: { home: num(h?.score), away: num(a?.score) },
      halftime: { home: null, away: null },
      extra_time_score: null,
      penalty_shootout: null,
      last_updated: new Date().toISOString(),
      source: 'espn'
    };
  } catch (e) {
    return null;
  }
}

async function loadOne(code) {
  const res = await fetch(`${BASE}/${code}/scoreboard`, {
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; SportyPredictz)' },
    signal: AbortSignal.timeout(6000)
  });
  if (!res.ok) throw new Error(`ESPN ${code} returned ${res.status}`);
  const data = await res.json();
  const name = data?.leagues?.[0]?.name || null;
  const list = Array.isArray(data?.events) ? data.events : [];
  return list.map((e) => parseEvent(e, name)).filter(Boolean);
}

async function loadAll() {
  const out = [];
  let ok = 0;
  let lastErr = null;
  for (const code of LEAGUES) {      // one at a time, with a small gap, so we stay polite
    try { out.push(...(await loadOne(code))); ok += 1; } catch (e) { lastErr = e; }
    await sleep(250);
  }
  if (!ok) throw lastErr || new Error('ESPN returned nothing');
  return out;
}

async function fetchEspnLive() {
  if ((Date.now() - cache.at) / 1000 < CACHE_SECONDS) return cache.events;
  if (!inFlight) {
    inFlight = loadAll()
      .then((events) => { cache = { at: Date.now(), events }; return events; })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

module.exports = { fetchEspnLive, parseEvent };
