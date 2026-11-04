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

function mapEvent(e, odds, leagueNames) {
  const homeId = e.home_team_id ?? idOf(e.home_team) ?? idOf(e.home);
  const awayId = e.away_team_id ?? idOf(e.away_team) ?? idOf(e.away);
  const leagueId = e.league_id ?? idOf(e.league) ?? idOf(e.competition) ?? idOf(e.tournament);

  return {
    id: e.id,
    league: {
      id: leagueId ?? null,
      name:
        e.league_name ?? nameOf(e.league) ?? e.competition_name ?? nameOf(e.competition) ??
        e.tournament_name ?? nameOf(e.tournament) ?? leagueNames.get(leagueId) ?? null,
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

// ---------- league names (loaded once a day) ----------
// Bzzoiro's match list only carries a league id, so names come from /leagues/.
let leagueSample = null;
async function getLeagueNames() {
  const names = new Map();
  try {
    for (let page = 0; page < 5; page++) {
      const { data } = await bzzGet(`/leagues/?limit=200&offset=${page * 200}`, 86400);
      const list = Array.isArray(data) ? data : (data.results ?? data.leagues ?? []);
      if (page === 0 && list[0]) leagueSample = list[0];
      for (const l of list) {
        const name = l.name ?? l.league_name ?? l.title ?? null;
        if (l.id != null && name) names.set(l.id, name);
      }
      if (list.length < 200) break;
    }
  } catch (err) {
    console.error('League names error:', err.message);
  }
  return names;
}

// ---------- dates (UTC, YYYY-MM-DD) ----------
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const kickoffOf = (e) => String(e.event_date ?? e.kickoff ?? e.start_time ?? '');
const listOf = (data) => (Array.isArray(data) ? data : (data.results ?? data.events ?? []));

// Walk the window from the SOONEST match onward, keeping only matches that
// have not started, until we have enough. Works whether Bzzoiro lists the
// window oldest-first or newest-first.
async function collectUpcoming(base, needed, keepAll) {
  const PAGE = 200;
  const MAX_PAGES = 4;
  const pathFor = (off, lim) => {
    const p = new URLSearchParams(base);
    p.set('limit', String(lim));
    p.set('offset', String(off));
    p.sort();
    return `/events/?${p.toString()}`;
  };

  const first = await bzzGet(pathFor(0, PAGE), 60);
  let stale = first.stale;
  const total = first.data.count ?? listOf(first.data).length;
  const firstList = listOf(first.data);
  const newestFirst =
    firstList.length > 1 && kickoffOf(firstList[0]) > kickoffOf(firstList[firstList.length - 1]);

  const keep = (e) => keepAll || e.status === 'notstarted';
  const kept = [];
  let exhausted = false;

  for (let k = 0; k < MAX_PAGES && kept.length < needed; k++) {
    let off;
    let len;
    if (newestFirst) {
      const upper = total - PAGE * k; // rows not yet read, counted from the soonest end
      if (upper <= 0) { exhausted = true; break; }
      off = Math.max(0, upper - PAGE);
      len = upper - off;
    } else {
      off = PAGE * k;
      len = Math.min(PAGE, total - off);
      if (len <= 0) { exhausted = true; break; }
    }

    let list;
    if (!newestFirst && k === 0) {
      list = firstList;
    } else {
      const r = await bzzGet(pathFor(off, len), 60);
      stale = stale || r.stale;
      list = listOf(r.data);
    }
    list = [...list].sort((a, b) => kickoffOf(a).localeCompare(kickoffOf(b)));
    for (const e of list) if (keep(e)) kept.push(e);
    if (off === 0 || (!newestFirst && off + len >= total)) exhausted = true;
  }

  return { kept, stale, exhausted };
}

// GET /v1/matches
// Matches that have not started yet, today + the next 7 days by default, soonest first.
// Optional: league_id, date_from, date_to (YYYY-MM-DD), team_name, limit (max 20), offset,
//           include_started=1 (also show finished / cancelled / in-play),
//           debug=1 (adds one raw match and one raw league, to check field names)
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
  const offset = Math.min(Math.max(parseInt(req.query.offset) || 0, 0), 200);
  const keepAll = req.query.include_started === '1';

  try {
    const { kept, stale, exhausted } = await collectUpcoming(base, offset + limit + 1, keepAll);
    const page = kept.slice(offset, offset + limit);
    const hasMore = kept.length > offset + limit || !exhausted;

    const [oddsMap, leagueNames] = await Promise.all([
      oddsFor(page.map((e) => e.id).filter(Boolean)),
      getLeagueNames()
    ]);

    const body = {
      window: { from: dateFrom, to: dateTo },
      limit,
      offset,
      has_more: hasMore,
      stale,
      matches: page.map((e) => mapEvent(e, oddsMap.get(e.id), leagueNames))
    };
    if (req.query.debug === '1') {
      body.raw_first_event = page[0] || null;
      body.raw_first_league = leagueSample;
    }
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
