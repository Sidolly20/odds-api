// routes/results.js — finished matches with final scores, newest first.
// Main source: Bzzoiro (cached 60 seconds).
// Backup: football-data.org finished matches, used only when Bzzoiro cannot answer.

const express = require('express');
const router = express.Router();
const { bzzGet, UpstreamError } = require('../lib/bzz');
const { getLeagueNames } = require('../lib/leagues');
const { fetchFootballDataFinished } = require('../lib/footballDataLive');
const S = require('../lib/shape');

// GET /v1/results
// Finished matches from the last 2 days by default, newest first.
// Optional: league_id, team_name, date_from, date_to (YYYY-MM-DD), limit (max 50), offset
router.get('/', async (req, res) => {
  const base = new URLSearchParams();
  base.set('status', 'finished');

  let leagueId = null;
  if (req.query.league_id) {
    const n = parseInt(req.query.league_id);
    if (!Number.isInteger(n)) return res.status(400).json({ error: 'league_id must be a number.' });
    leagueId = n;
    base.set('league_id', String(n));
  }
  for (const name of ['date_from', 'date_to']) {
    if (req.query[name] && !S.DATE_RE.test(req.query[name])) {
      return res.status(400).json({ error: `${name} must look like 2026-11-05.` });
    }
  }
  const dateTo = req.query.date_to || S.today();
  const dateFrom = req.query.date_from || S.addDays(dateTo, -2);
  base.set('date_from', dateFrom);
  base.set('date_to', dateTo);
  const teamName = req.query.team_name ? String(req.query.team_name).slice(0, 60) : null;
  if (teamName) base.set('team_name', teamName);

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
  const offset = Math.min(Math.max(parseInt(req.query.offset) || 0, 0), 300);
  const window = { from: dateFrom, to: dateTo };

  // ---- main path: Bzzoiro ----
  try {
    const PAGE = 200;
    const all = [];
    let total = 0;
    let stale = false;
    for (let k = 0; k < 3; k++) {
      const p = new URLSearchParams(base);
      p.set('limit', String(PAGE));
      p.set('offset', String(k * PAGE));
      p.sort();
      const r = await bzzGet(`/events/?${p.toString()}`, 60);
      stale = stale || r.stale;
      const list = S.listOf(r.data);
      total = r.data.count ?? list.length;
      all.push(...list);
      if ((k + 1) * PAGE >= total || list.length < PAGE) break;
    }

    const finished = all
      .filter((e) => e.status === 'finished')
      .sort((a, b) => S.kickoffOf(b).localeCompare(S.kickoffOf(a)));
    const page = finished.slice(offset, offset + limit);
    const names = await getLeagueNames();

    return res.json({
      window,
      limit,
      offset,
      has_more: finished.length > offset + limit || all.length < total,
      stale,
      source: 'bzzoiro',
      results: page.map((e) => ({
        id: e.id,
        ...S.sides(e, names),
        kickoff: S.kickoffOf(e) || null,
        status: e.status ?? null,
        period: e.period || null,
        score: { home: e.home_score ?? null, away: e.away_score ?? null },
        halftime: { home: e.home_score_ht ?? null, away: e.away_score_ht ?? null },
        extra_time_score: e.extra_time_score ?? null,
        penalty_shootout: e.penalty_shootout ?? null
      }))
    });
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 400) {
      return res.status(400).json(err.body || { error: 'Invalid request.' });
    }
    console.error('Results: Bzzoiro failed, trying football-data:', err.message);
  }

  // ---- backup: football-data finished matches ----
  try {
    const fd = await fetchFootballDataFinished(dateFrom, dateTo);
    const filtered = fd
      .filter((m) => leagueId === null || m.league.id === leagueId)
      .filter((m) => !teamName || [m.home.name, m.away.name].some((n) => n && n.toLowerCase().includes(teamName.toLowerCase())))
      .sort((a, b) => String(b.kickoff).localeCompare(String(a.kickoff)));
    const page = filtered.slice(offset, offset + limit);
    return res.json({
      window,
      limit,
      offset,
      has_more: filtered.length > offset + limit,
      stale: true,
      source: 'football-data',
      results: page
    });
  } catch (err) {
    console.error('Results: football-data backup failed:', err.message);
    return res.status(502).json({ error: 'Results are temporarily unavailable.' });
  }
});

module.exports = router;
