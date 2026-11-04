// routes/standings.js — league tables.
// - /v1/standings and /v1/standings/PL etc. come from OUR database (football-data.org).
// - /v1/standings/league/:id comes from Bzzoiro (any league they cover), cached in memory.

const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { bzzGet } = require('../lib/bzz');

// GET /v1/standings — which competitions have a table
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('standings')
    .select('competition_code, competition_name, season, updated_at')
    .order('competition_code', { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ count: data.length, competitions: data });
});

// GET /v1/standings/league/98 — table for ANY Bzzoiro league (current season)
// Optional: ?season_id=1635 to pick another season.
router.get('/league/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'League id must be a number, for example 98.' });
  }

  try {
    let seasonId = req.query.season_id ? parseInt(req.query.season_id, 10) : null;
    let seasonName = null;

    if (!seasonId) {
      const s = await bzzGet(`/leagues/${id}/season/`, 1800);
      seasonId = s.data && s.data.id;
      seasonName = s.data && s.data.name;
    }

    if (!Number.isInteger(seasonId)) {
      return res.status(502).json({ error: 'Could not work out the current season for this league.' });
    }

    const t = await bzzGet(`/leagues/${id}/standings/?season_id=${seasonId}`, 600);

    res.json({
      league_id: id,
      season_id: seasonId,
      season: seasonName,
      stale: t.stale,
      ...t.data
    });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: 'No league or table found for that id.' });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: 'Bzzoiro did not accept that request.' });
    }
    return res.status(502).json({ error: 'Could not get the table from the data provider right now.' });
  }
});

// GET /v1/standings/PL — the table for one competition
router.get('/:code', async (req, res) => {
  const code = req.params.code.toUpperCase();

  const { data, error } = await supabase
    .from('standings')
    .select('*')
    .eq('competition_code', code)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'No standings found for that competition code.' });
  }

  res.json({
    competition_code: data.competition_code,
    competition: data.competition_name,
    season: data.season,
    updated_at: data.updated_at,
    tables: data.tables
  });
});

module.exports = router;