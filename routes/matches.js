// routes/matches.js
//   GET /v1/matches        upcoming matches: badges, odds and predictions in one call
//   GET /v1/matches/:id    one match: details, odds, prediction, head-to-head,
//                          lineups, goal/card timeline, stats
//
// All data comes from Bzzoiro Sports Data (free plan), cached in memory so many
// customers share the same few upstream calls.

const express = require('express');
const router = express.Router();
const { bzzGet, bzzGetSafe, UpstreamError } = require('../lib/bzz');
const { getLeagueNames } = require('../lib/leagues');
const S = require('../lib/shape');

// ---------- list: upcoming matches ----------

// Walk the window from the SOONEST match onward, keeping only matches that have
// not started, until we have enough. Works whether Bzzoiro lists the window
// oldest-first or newest-first.
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

  const first = await bzzGet(pathFor(0, PAGE), 180);
  let stale = first.stale;
  const firstList = S.listOf(first.data);
  const total = first.data.count ?? firstList.length;
  const newestFirst =
    firstList.length > 1 && S.kickoffOf(firstList[0]) > S.kickoffOf(firstList[firstList.length - 1]);

  const keep = (e) => keepAll || e.status === 'notstarted';
  const kept = [];
  let exhausted = false;

  for (let k = 0; k < MAX_PAGES && kept.length < needed; k++) {
    let off;
    let len;
    if (newestFirst) {
      const upper = total - PAGE * k;
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
      const r = await bzzGet(pathFor(off, len), 180);
      stale = stale || r.stale;
      list = S.listOf(r.data);
    }
    list = [...list].sort((a, b) => S.kickoffOf(a).localeCompare(S.kickoffOf(b)));
    for (const e of list) if (keep(e)) kept.push(e);
    if (off === 0 || (!newestFirst && off + len >= total)) exhausted = true;
  }

  return { kept, stale, exhausted };
}

// Odds + prediction for a page of matches, a few at a time (never a burst).
//
// Saving: the last good odds/prediction are stored in Supabase (table
// match_extras). Far-away matches are re-fetched rarely; matches kicking off
// soon refresh often. If Bzzoiro fails, the saved copy is shown instead.
const supabase = require('../lib/supabase');
const lastSaved = new Map(); // id -> time we last wrote it (limits database writes)

function ttlFor(e, near, mid, far) {
  const hrs = (new Date(S.kickoffOf(e)).getTime() - Date.now()) / 3600000;
  if (!isFinite(hrs) || hrs <= 3) return near;
  return hrs <= 24 ? mid : far;
}

async function loadSaved(ids) {
  try {
    const { data } = await supabase.from('match_extras').select('*').in('id', ids);
    return new Map((data || []).map((r) => [r.id, r]));
  } catch (err) {
    return new Map(); // table missing or database down: carry on without it
  }
}

async function enrich(events) {
  const out = new Map();
  const saved = await loadSaved(events.map((e) => e.id));
  const toSave = [];
  const CHUNK = 5;

  for (let i = 0; i < events.length; i += CHUNK) {
    await Promise.all(
      events.slice(i, i + CHUNK).map(async (e) => {
        const id = e.id;
        const old = saved.get(id);
        const ageSec = old ? (Date.now() - new Date(old.updated_at).getTime()) / 1000 : Infinity;
        // ONE shared time for odds and prediction (they are saved together with one timestamp,
        // so two different times would leave one of them never refreshed).
        // Kicking off within 3h: 10 min. Within a day: 30 min. Further away: 1 hour.
        const oddsTtl = ttlFor(e, 600, 1800, 3600);
        const predTtl = oddsTtl;

        // Saved copy still fresh enough -> no Bzzoiro call at all.
        let odds = old && old.odds && ageSec < oddsTtl ? old.odds : null;
        let prediction = old && old.prediction && ageSec < predTtl ? old.prediction : null;
        let fetched = false;

        if (!odds) {
          odds = await bzzGetSafe(`/events/${id}/odds/`, oddsTtl);
          if (odds) fetched = true;
        }
        if (!prediction) {
          prediction = await bzzGetSafe(`/events/${id}/prediction/`, predTtl);
          if (prediction) fetched = true;
        }

        // Bzzoiro had nothing -> fall back to whatever we saved earlier.
        if (!odds && old) odds = old.odds;
        if (!prediction && old) prediction = old.prediction;

        out.set(id, { odds, prediction });

        if (fetched && (odds || prediction) && Date.now() - (lastSaved.get(id) || 0) > 5 * 60 * 1000) {
          lastSaved.set(id, Date.now());
          toSave.push({ id, odds, prediction, updated_at: new Date().toISOString() });
        }
      })
    );
  }

  if (lastSaved.size > 5000) lastSaved.clear();
  if (toSave.length) {
    supabase.from('match_extras').upsert(toSave).then(() => { }).catch(() => { });
  }
  return out;
}

// GET /v1/matches
// Matches that have not started, today + the next 7 days by default, soonest first.
// Optional: league_id, date_from, date_to (YYYY-MM-DD), team_name, limit (max 20),
//           offset, include_started=1
router.get('/', async (req, res) => {
  const base = new URLSearchParams();
  base.set('status', 'upcoming');

  if (req.query.league_id) {
    const n = parseInt(req.query.league_id);
    if (!Number.isInteger(n)) return res.status(400).json({ error: 'league_id must be a number.' });
    base.set('league_id', String(n));
  }
  for (const name of ['date_from', 'date_to']) {
    if (req.query[name] && !S.DATE_RE.test(req.query[name])) {
      return res.status(400).json({ error: `${name} must look like 2026-11-05.` });
    }
  }
  const dateFrom = req.query.date_from || S.today();
  const dateTo = req.query.date_to || S.addDays(dateFrom, 7);
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

    const [extras, names] = await Promise.all([
      enrich(page.filter((e) => e.id)),
      getLeagueNames()
    ]);

    res.json({
      window: { from: dateFrom, to: dateTo },
      limit,
      offset,
      has_more: hasMore,
      stale,
      matches: page.map((e) => {
        const x = extras.get(e.id) || {};
        return {
          id: e.id,
          ...S.sides(e, names),
          kickoff: S.kickoffOf(e) || null,
          status: e.status ?? null,
          odds: S.mapOdds(x.odds),
          prediction: S.mapPrediction(x.prediction)
        };
      })
    });
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 400) {
      return res.status(400).json(err.body || { error: 'Invalid request.' });
    }
    console.error('Matches error:', err.message);
    res.status(502).json({ error: 'Matches are temporarily unavailable.' });
  }
});

// ---------- detail: one match ----------

// What ?include= can ask for, and how long each answer is kept.
const INCLUDE = {
  odds:       { path: (id) => `/events/${id}/odds/`,       ttl: 300 },
  prediction: { path: (id) => `/events/${id}/prediction/`, ttl: 600 },
  h2h:        { path: (id) => `/events/${id}/h2h/`,        ttl: 3600 },
  lineups:    { path: (id) => `/events/${id}/lineups/`,    ttl: 60 },
  incidents:  { path: (id) => `/events/${id}/incidents/`,  ttl: 20 },
  stats:      { path: (id) => `/events/${id}/stats/`,      ttl: 30 }
};

// GET /v1/matches/:id
// ?include=odds,prediction,h2h,lineups,incidents,stats   (default: odds,prediction)
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'The match id must be a number.' });
  }

  const wanted = String(req.query.include || 'odds,prediction')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((k) => !INCLUDE[k]);
  if (unknown.length) {
    return res.status(400).json({
      error: `Unknown include: ${unknown.join(', ')}.`,
      valid: Object.keys(INCLUDE)
    });
  }

  try {
    const [detail, names] = await Promise.all([bzzGet(`/events/${id}/`, 30), getLeagueNames()]);
    const e = detail.data;

    const results = await Promise.all(
      wanted.map(async (k) => [k, await bzzGetSafe(INCLUDE[k].path(id), INCLUDE[k].ttl)])
    );
    const got = Object.fromEntries(results);

    const body = {
      stale: detail.stale,
      match: {
        id: e.id ?? id,
        ...S.sides(e, names),
        season_id: e.season_id ?? null,
        stage: e.stage_name ?? e.stage ?? null,
        round: e.round_label ?? null,
        kickoff: S.kickoffOf(e) || null,
        status: e.status ?? null,
        period: e.period || null,
        minute: e.current_minute ?? null,
        score: { home: e.home_score ?? null, away: e.away_score ?? null },
        halftime: { home: e.home_score_ht ?? null, away: e.away_score_ht ?? null },
        extra_time_score: e.extra_time_score ?? null,
        penalty_shootout: e.penalty_shootout ?? null,
        neutral_ground: e.is_neutral_ground ?? null,
        local_derby: e.is_local_derby ?? null,
        weather: e.weather ?? null,
        attendance: e.attendance ?? null,
        highlights: e.highlights ?? [],
        replaced_by: e.replaced_by ?? null
      }
    };

    if (wanted.includes('odds')) body.odds = S.mapOdds(got.odds);
    if (wanted.includes('prediction')) body.prediction = S.mapPrediction(got.prediction);
    // The rest are passed through as Bzzoiro sends them (documented shapes).
    if (wanted.includes('h2h')) body.h2h = got.h2h ?? e.head_to_head ?? null;
    if (wanted.includes('lineups')) body.lineups = got.lineups;
    if (wanted.includes('incidents')) body.incidents = got.incidents;
    if (wanted.includes('stats')) body.stats = got.stats;

    res.json(body);
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) {
      return res.status(404).json({ error: 'Match not found.' });
    }
    console.error('Match detail error:', err.message);
    res.status(502).json({ error: 'Match details are temporarily unavailable.' });
  }
});

module.exports = router;
