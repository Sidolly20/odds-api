// routes/standings.js — serves league tables from OUR database,
// never calling football-data.org directly.

const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

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
