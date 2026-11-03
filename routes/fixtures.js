// routes/fixtures.js — serves fixtures from OUR database, never calling
// football-data.org directly. This is what makes "unlimited calls" safe.

const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET /v1/fixtures — upcoming matches, soonest first
router.get('/', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);

  const { data, error } = await supabase
    .from('fixtures')
    .select('*')
    .gte('utc_date', new Date().toISOString())
    .order('utc_date', { ascending: true })
    .limit(limit);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ count: data.length, fixtures: data });
});

module.exports = router;
