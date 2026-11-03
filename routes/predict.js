// routes/predict.js — the core product. Calculates and returns win
// probabilities for a given fixture, and saves the result back onto
// the fixture row so repeated calls don't recalculate every time.

const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const { predictMatch } = require('../lib/predict');

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
