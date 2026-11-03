// server.js — Step 1: basic server, proves the deploy works.
// Later steps add: database caching, data fetch jobs, prediction logic, API keys.

require('dotenv').config();
require('./lib/fixDns'); // fixes "fetch failed" on some Windows/ISP networks
const express = require('express');
const cors = require('cors');
const fixturesRouter = require('./routes/fixtures');
const fetchAndStoreFixtures = require('./jobs/fetchFixtures');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check — Render and you can both use this to confirm the server is alive.
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'odds-api is running',
    time: new Date().toISOString()
  });
});

app.get('/v1/ping', (req, res) => {
  res.json({ pong: true });
});

// Real data, served from our own database, never live from football-data.org
app.use('/v1/fixtures', fixturesRouter);

app.listen(PORT, () => {
  console.log(`odds-api listening on port ${PORT}`);

  // Fetch fixtures once on startup, then every 6 hours.
  // This is what keeps us from hitting football-data.org on every user request.
  fetchAndStoreFixtures().catch((err) => console.error('Initial fetch failed:', err.message));
  setInterval(() => {
    fetchAndStoreFixtures().catch((err) => console.error('Scheduled fetch failed:', err.message));
  }, 6 * 60 * 60 * 1000); // 6 hours
});
