// routes/predict.js — the core product. Calculates and returns win
// probabilities for a given fixture, and saves the result back onto
// the fixture row so repeated calls don't recalculate every time.

const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { predictMatch } = require('../lib/predict');

// GET /v1/predict/bulk?limit=10&competition=Premier%20League
// Predicts several upcoming matches in one call instead of one at a time.
// Put this BEFORE the /:fixtureId route below, or Express would try to
// treat "bulk" as a fixture id and fail.
router.get('/bulk', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const competition = req.query.competition;

  let query = supabase
    .from('fixtures')
    .select('*')
    .gte('utc_date', new Date().toISOString())
    .order('utc_date', { ascending: true })
    .limit(limit);

  if (competition) {
    query = query.eq('competition', competition);
  }

  const { data: fixtures, error } = await query;

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Predict each fixture. Sequential, not parallel — keeps load on the
  // database gentle rather than firing 50 queries at once.
  const results = [];
  for (const fixture of fixtures) {
    const prediction = await predictMatch(fixture.home_team, fixture.away_team);

    // Cache onto the row, same as the single-fixture endpoint does
    await supabase
      .from('fixtures')
      .update({
        home_win_pct: prediction.home_win_pct,
        draw_pct: prediction.draw_pct,
        away_win_pct: prediction.away_win_pct
      })
      .eq('id', fixture.id);

    results.push({
      fixture_id: fixture.id,
      competition: fixture.competition,
      home_team: fixture.home_team,
      away_team: fixture.away_team,
      utc_date: fixture.utc_date,
      prediction
    });
  }

  res.json({ count: results.length, predictions: results });
});

// GET /v1/predict/:fixtureId — predict one specific upcoming match
router.get('/:fixtureId', async (req, res) => {
  const fixtureId = req.params.fixtureId;

  const { data: fixture, error: fetchError } = await supabase
    .from('fixtures')
    .select('*')
    .eq('id', fixtureId)
    .single();

  if (fetchError || !fixture) {
    return res.status(404).json({ error: 'Fixture not found' });
  }

  const prediction = await predictMatch(fixture.home_team, fixture.away_team);

  // Cache the result onto the fixture row so we're not recalculating
  // on every single call — refreshed next time fixtures sync anyway.
  await supabase
    .from('fixtures')
    .update({
      home_win_pct: prediction.home_win_pct,
      draw_pct: prediction.draw_pct,
      away_win_pct: prediction.away_win_pct
    })
    .eq('id', fixtureId);

  res.json({
    fixture_id: fixture.id,
    competition: fixture.competition,
    home_team: fixture.home_team,
    away_team: fixture.away_team,
    utc_date: fixture.utc_date,
    prediction
  });
});

module.exports = router;
