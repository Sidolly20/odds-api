// routes/live.js — live scores.
//
// Source 1: Bzzoiro (same list address ZurePicks uses, through the shared polite client in lib/bzz.js).
// Source 2: football-data.org (backup, big competitions only) when Bzzoiro cannot answer.
// If both fail, we may serve our last copy for at most 3 minutes; after that we say "unavailable".
// We never serve old scores as if they were live.
//
// One shared copy is kept in memory for 60 seconds, so many visitors cost very few calls.

const express = require('express');
const router = express.Router();
const { bzzGet, bzzState } = require('../lib/bzz');
const { fetchFootballDataLive } = require('../lib/footballDataLive');
const { fetchEspnLive } = require('../lib/espnLive');

// Same team = same name after dropping "FC", accents and punctuation.
const nameKey = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\b(fc|afc|cf|sc|ac|as|fk|sk|cd|ud|club|de|the)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const sameName = (a, b) => { a = nameKey(a); b = nameKey(b); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); };

// football-data gives scores but no minute. ESPN gives a real clock. Where both list the same match
// (both team names agree, kick-offs within 4 hours) we keep football-data's id and take ESPN's clock.
// Matches only ESPN has are added as they are.
function mergeEspn(fd, es) {
  const used = new Set();
  const merged = fd.map((f) => {
    const hit = es.find((e) => !used.has(e.id) && sameName(e.home.name, f.home.name) && sameName(e.away.name, f.away.name) &&
      Math.abs(Date.parse(e.kickoff) - Date.parse(f.kickoff)) < 4 * 3600e3);
    if (!hit) return f;
    used.add(hit.id);
    return {
      ...f,
      status: hit.status,
      period: hit.period,
      minute: hit.minute ?? f.minute,
      minute_estimated: hit.minute == null ? f.minute_estimated : false,
      score: hit.score.home != null && hit.score.away != null ? hit.score : f.score
    };
  });
  return merged.concat(es.filter((e) => !used.has(e.id)));
}

// While matches are in play we ask every 60 s. While NOTHING is live we only ask every 90 s.
// (Change with LIVE_CACHE_SECONDS / LIVE_IDLE_SECONDS on Render if you ever need to.)
const ACTIVE_SECONDS = parseInt(process.env.LIVE_CACHE_SECONDS) || 60;
const IDLE_SECONDS = parseInt(process.env.LIVE_IDLE_SECONDS) || 90;
const MAX_STALE_SECONDS = 180;
const cacheSeconds = () => (cache.events && cache.events.length === 0 ? IDLE_SECONDS : ACTIVE_SECONDS);

const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const livePath = () => `/events/?status=live&date_from=${day(-1)}&date_to=${day(1)}&limit=200`;

let cache = { events: null, fetchedAt: 0, source: null, why: null, notes: null };
let inFlight = null; // if a fetch is already running, everyone waits for the same one

// Bzzoiro's free Image API serves badges by id (no key needed).
const IMG = 'https://sports.bzzoiro.com/img';
const teamLogo = (id) => (id ? `${IMG}/team/${id}/` : null);
const leagueLogo = (id) => (id ? `${IMG}/league/${id}/` : null);

function mapEvent(e) {
  return {
    id: e.id,
    league: { id: e.league_id ?? null, name: e.league_name ?? null, logo: leagueLogo(e.league_id) },
    home: { id: e.home_team_id ?? null, name: e.home_team ?? null, logo: teamLogo(e.home_team_id) },
    away: { id: e.away_team_id ?? null, name: e.away_team ?? null, logo: teamLogo(e.away_team_id) },
    kickoff: e.event_date ?? null,
    status: e.status ?? null,
    period: e.period ?? null,
    minute: e.current_minute ?? null,
    score: { home: e.home_score ?? null, away: e.away_score ?? null },
    halftime: { home: e.home_score_ht ?? null, away: e.away_score_ht ?? null },
    extra_time_score: e.extra_time_score ?? null,
    penalty_shootout: e.penalty_shootout ?? null,
    last_updated: e.last_updated ?? null,
    source: 'bzzoiro'
  };
}

async function fromBzzoiro() {
  const { data } = await bzzGet(livePath(), cacheSeconds(), MAX_STALE_SECONDS);
  const list = Array.isArray(data) ? data : data.events || data.results || [];
  return list.map(mapEvent);
}

async function loadLive() {
  try {
    return { events: await fromBzzoiro(), source: 'bzzoiro', why: null, notes: null };
  } catch (err) {
    console.error('Bzzoiro live failed, trying football-data and ESPN:', err.message);
    let fd = [];
    let fdErr = null;
    let es = [];
    let esErr = null;
    try { fd = await fetchFootballDataLive(); } catch (e) { fdErr = e.message; }
    try { es = await fetchEspnLive(); } catch (e) { esErr = e.message; }
    if (fdErr && esErr) throw new Error(`football-data: ${fdErr}; ESPN: ${esErr}`);
    const source = es.length ? (fd.length ? 'football-data+espn' : fdErr ? 'espn' : 'football-data+espn') : 'football-data';
    return { events: mergeEspn(fd, es), source, why: err.message, notes: { football_data_error: fdErr, espn_error: esErr, espn_live: es.length } };
  }
}

async function getLiveEvents() {
  const age = (Date.now() - cache.fetchedAt) / 1000;
  if (cache.events && age < cacheSeconds()) {
    return { events: cache.events, stale: false, source: cache.source };
  }

  if (!inFlight) {
    inFlight = loadLive()
      .then((r) => {
        cache = { events: r.events, fetchedAt: Date.now(), source: r.source, why: r.why, notes: r.notes };
        return r;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  try {
    const r = await inFlight;
    return { events: r.events, stale: false, source: r.source };
  } catch (err) {
    const oldAge = (Date.now() - cache.fetchedAt) / 1000;
    if (cache.events && oldAge < MAX_STALE_SECONDS) {
      return { events: cache.events, stale: true, source: cache.source };
    }
    throw err;
  }
}

// GET /v1/live — all matches in play right now
// Optional: ?league_id=80 to see just one league
router.get('/', async (req, res) => {
  try {
    const { events, stale, source } = await getLiveEvents();

    let out = events;
    if (req.query.league_id) {
      const id = parseInt(req.query.league_id);
      out = events.filter((e) => e.league.id === id);
    }

    res.json({
      count: out.length,
      stale,
      source,
      updated_at: new Date(cache.fetchedAt).toISOString(),
      // Plain-language health check: shows WHY scores may be missing. Contains no keys.
      diag: {
        source,
        bzzoiro_failed_because: cache.why,
        backups: cache.notes,
        bzzoiro: bzzState(),
        live_count: events.length,
        with_score: events.filter((e) => e.score && e.score.home != null && e.score.away != null).length,
        with_minute: events.filter((e) => e.minute != null).length
      },
      matches: out
    });
  } catch (err) {
    console.error('Live scores error:', err.message);
    res.status(502).json({ error: 'Live scores are temporarily unavailable.' });
  }
});

module.exports = router;
