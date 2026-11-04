// routes/live.js — live scores, powered by Bzzoiro Sports Data.
//
// Not stored in the database: live scores change every few seconds, so the
// server keeps ONE shared copy in memory for 30 seconds. Every customer reads
// that copy, so Bzzoiro is called at most about twice a minute no matter how
// many people use this endpoint.
//
// Needs the environment variable BZZOIRO_KEY (set it on Render).

const express = require('express');
const router = express.Router();

const BZZOIRO_URL = 'https://sports.bzzoiro.com/api/v2/events/live/?limit=200';
const CACHE_SECONDS = 30;

let cache = { events: null, fetchedAt: 0 };
let inFlight = null; // if a fetch is already running, everyone waits for the same one

// Bzzoiro's free Image API serves badges by id (no key needed).
// If a team or league has no image it answers 204 (empty) — show a placeholder.
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
    last_updated: e.last_updated ?? null
  };
}

async function fetchFromBzzoiro() {
  const key = process.env.BZZOIRO_KEY;
  if (!key) {
    throw new Error('BZZOIRO_KEY is not set on the server.');
  }

  const res = await fetch(BZZOIRO_URL, {
    headers: { Authorization: `Token ${key}` }
  });

  if (!res.ok) {
    throw new Error(`Bzzoiro returned ${res.status}`);
  }

  const data = await res.json();
  const list = data.events || data.results || [];
  return list.map(mapEvent);
}

async function getLiveEvents() {
  const age = (Date.now() - cache.fetchedAt) / 1000;
  if (cache.events && age < CACHE_SECONDS) {
    return { events: cache.events, stale: false };
  }

  if (!inFlight) {
    inFlight = fetchFromBzzoiro()
      .then((events) => {
        cache = { events, fetchedAt: Date.now() };
        return events;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  try {
    const events = await inFlight;
    return { events, stale: false };
  } catch (err) {
    // If Bzzoiro fails but we have an older copy, serve it and say so.
    if (cache.events) {
      return { events: cache.events, stale: true };
    }
    throw err;
  }
}

// GET /v1/live — all matches in play right now
// Optional: ?league_id=80 to see just one league
router.get('/', async (req, res) => {
  try {
    const { events, stale } = await getLiveEvents();

    let out = events;
    if (req.query.league_id) {
      const id = parseInt(req.query.league_id);
      out = events.filter((e) => e.league.id === id);
    }

    res.json({
      count: out.length,
      stale,
      updated_at: new Date(cache.fetchedAt).toISOString(),
      matches: out
    });
  } catch (err) {
    console.error('Live scores error:', err.message);
    res.status(502).json({ error: 'Live scores are temporarily unavailable.' });
  }
});

module.exports = router;
