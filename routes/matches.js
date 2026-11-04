// routes/matches.js — upcoming matches in ONE call: teams, badges, league,
// kickoff, and the consensus odds (home / draw / away, goals, both-teams-to-score).
//
// Data comes from Bzzoiro Sports Data (free plan), cached in memory:
//   match list  -> 60 seconds
//   odds        -> 3 minutes (Bzzoiro itself only refreshes about that often)

const express = require('express');
const router = express.Router();
const { bzzGet, UpstreamError } = require('../lib/bzz');

const IMG = 'https://sports.bzzoiro.com/img';
const teamLogo = (id) => (id ? `${IMG}/team/${id}/` : null);
const leagueLogo = (id) => (id ? `${IMG}/league/${id}/` : null);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The list may name some fields slightly differently from the live feed,
// so each value tries the likely names in turn.
const nameOf = (v) => (typeof v === 'string' ? v : v?.name ?? null);
const idOf = (v) => (v && typeof v === 'object' ? v.id ?? null : null);

function mapEvent(e, odds) {
  const homeId = e.home_team_id ?? idOf(e.home_team) ?? idOf(e.home);
  const awayId = e.away_team_id ?? idOf(e.away_team) ?? idOf(e.away);
  const leagueId = e.league_id ?? idOf(e.league);

  return {
    id: e.id,
    league: {
      id: leagueId ?? null,
      name: e.league_name ?? nameOf(e.league),
      logo: leagueLogo(leagueId)
    },
    home: {
      id: homeId ?? null,
      name: e.home_team_name ?? nameOf(e.home_team) ?? nameOf(e.home),
      logo: teamLogo(homeId)
    },
    away: {
      id: awayId ?? null,
      name: e.away_team_name ?? nameOf(e.away_team) ?? nameOf(e.away),
      logo: teamLogo(awayId)
    },
    kickoff: e.event_date ?? e.kickoff ?? e.start_time ?? null,
    status: e.status ?? null,
    odds: odds
      ? {
          type: 'consensus',
          home_win: odds.odds?.home_win ?? null,
          draw: odds.odds?.draw ?? null,
          away_win: odds.odds?.away_win ?? null,
          over_15_goals: odds.odds?.over_15_goals ?? null,
          over_25_goals: odds.odds?.over_25_goals ?? null,
          over_35_goals: odds.odds?.over_35_goals ?? null,
          under_15_goals: odds.odds?.under_15_goals ?? null,
          under_25_goals: odds.odds?.under_25_goals ?? null,
          under_35_goals: odds.odds?.under_35_goals ?? null,
          btts_yes: odds.odds?.btts_yes ?? null,
          btts_no: odds.odds?.btts_no ?? null,
          last_checked: odds.last_update_at ?? null,
          next_check: odds.next_update_at ?? null
        }
      : null
  };
}

// Matches that had no odds are remembered for 3 minutes, so we don't ask again
// on every request.
const noOddsUntil = new Map();

// Fetch odds for a few matches at a time, so we never hit Bzzoiro with a burst.
async function oddsFor(ids) {
  const out = new Map();
  const CHUNK = 5;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const results = await Promise.all(
      part.map((id) => {
        if ((noOddsUntil.get(id) || 0) > Date.now()) return null;
        return bzzGet(`/events/${id}/odds/`, 180)
          .then((r) => r.data)
          .catch(() => {
            // a match with no odds should not break the list
            if (noOddsUntil.size > 1000) noOddsUntil.clear();
            noOddsUntil.set(id, Date.now() + 180 * 1000);
            return null;
          });
      })
    );
    part.forEach((id, idx) => out.set(id, results[idx]));
  }
  return out;
}

// GET /v1/matches
// Optional: league_id, date_from, date_to (YYYY-MM-DD), team_name, limit (max 20), offset
router.get('/', async (req, res) => {
  const params = new URLSearchParams();
  params.set('status', 'upcoming');

  if (req.query.league_id) {
    const n = parseInt(req.query.league_id);
    if (!Number.isInteger(n)) return res.status(400).json({ error: 'league_id must be a number.' });
    params.set('league_id', String(n));
  }
  for (const name of ['date_from', 'date_to']) {
    if (req.query[name]) {
      if (!DATE_RE.test(req.query[name])) {
        return res.status(400).json({ error: `${name} must look like 2026-11-05.` });
      }
      params.set(name, req.query[name]);
    }
  }
  if (req.query.team_name) params.set('team_name', String(req.query.team_name).slice(0, 60));

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 20);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  params.sort();

  try {
    const { data, stale } = await bzzGet(`/events/?${params.toString()}`, 60);
    const list = Array.isArray(data) ? data : (data.results ?? data.events ?? []);
    const oddsMap = await oddsFor(list.map((e) => e.id).filter(Boolean));

    res.json({
      count: data.count ?? list.length,
      limit,
      offset,
      stale,
      matches: list.map((e) => mapEvent(e, oddsMap.get(e.id)))
    });
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 400) {
      return res.status(400).json(err.body || { error: 'Invalid request.' });
    }
    console.error('Matches error:', err.message);
    res.status(502).json({ error: 'Matches are temporarily unavailable.' });
  }
});

module.exports = router;
