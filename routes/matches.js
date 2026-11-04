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
  const leagueId = e.league_id ?? idOf(e.league) ?? idOf(e.competition) ?? idOf(e.tournament);

  return {
    id: e.id,
    league: {
      id: leagueId ?? null,
      name:
        e.league_name ?? nameOf(e.league) ?? e.competition_name ?? nameOf(e.competition) ??
        e.tournament_name ?? nameOf(e.tournament) ?? null,
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

// Dates are handled in UTC, as YYYY-MM-DD.
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const kickoffOf = (e) => e.event_date ?? e.kickoff ?? e.start_time ?? null;

// GET /v1/matches
// Default window: today through the next 7 days, soonest first.
// Optional: league_id, date_from, date_to (YYYY-MM-DD), team_name, limit (max 20), offset
//           debug=1 adds one raw match from Bzzoiro (to check field names)
router.get('/', async (req, res) => {
  const base = new URLSearchParams();
  base.set('status', 'upcoming');

  if (req.query.league_id) {
    const n = parseInt(req.query.league_id);
    if (!Number.isInteger(n)) return res.status(400).json({ error: 'league_id must be a number.' });
    base.set('league_id', String(n));
  }

  for (const name of ['date_from', 'date_to']) {
    if (req.query[name] && !DATE_RE.test(req.query[name])) {
      return res.status(400).json({ error: `${name} must look like 2026-11-05.` });
    }
  }
  const dateFrom = req.query.date_from || today();
  const dateTo = req.query.date_to || addDays(dateFrom, 7);
  base.set('date_from', dateFrom);
  base.set('date_to', dateTo);

  if (req.query.team_name) base.set('team_name', String(req.query.team_name).slice(0, 60));

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 20);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

  const pathFor = (off, lim) => {
    const p = new URLSearchParams(base);
    p.set('limit', String(lim));
    p.set('offset', String(off));
    p.sort();
    return `/events/?${p.toString()}`;
  };
  const listOf = (data) => (Array.isArray(data) ? data : (data.results ?? data.events ?? []));

  try {
    let { data, stale } = await bzzGet(pathFor(offset, limit), 60);
    let list = listOf(data);
    const total = data.count ?? list.length;

    // Bzzoiro may return the LATEST matches first. We want the SOONEST first,
    // so if the page comes back newest-first, fetch the other end instead.
    const newestFirst =
      list.length > 1 && String(kickoffOf(list[0])) > String(kickoffOf(list[list.length - 1]));
    if (newestFirst && total > limit) {
      const start = Math.max(0, total - offset - limit);
      const len = Math.min(limit, total - offset);
      if (len > 0) {
        const second = await bzzGet(pathFor(start, len), 60);
        list = listOf(second.data);
        stale = stale || second.stale;
      } else {
        list = [];
      }
    }
    list = [...list].sort((a, b) => String(kickoffOf(a)).localeCompare(String(kickoffOf(b))));

    const oddsMap = await oddsFor(list.map((e) => e.id).filter(Boolean));

    const body = {
      count: total,
      window: { from: dateFrom, to: dateTo },
      limit,
      offset,
      stale,
      matches: list.map((e) => mapEvent(e, oddsMap.get(e.id)))
    };
    if (req.query.debug === '1' && list[0]) body.raw_first_event = list[0];
    res.json(body);
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 400) {
      return res.status(400).json(err.body || { error: 'Invalid request.' });
    }
    console.error('Matches error:', err.message);
    res.status(502).json({ error: 'Matches are temporarily unavailable.' });
  }
});

module.exports = router;
