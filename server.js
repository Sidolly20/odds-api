// server.js — odds-api
// Fixtures + predictions + standings (from our database) and live scores (cached).

require('dotenv').config();
require('./lib/fixDns'); // fixes "fetch failed" on some Windows/ISP networks
const express = require('express');
const cors = require('cors');
const fixturesRouter = require('./routes/fixtures');
const predictRouter = require('./routes/predict');
const standingsRouter = require('./routes/standings');
const liveRouter = require('./routes/live');
const fetchAndStoreFixtures = require('./jobs/fetchFixtures');
const fetchAndStoreStandings = require('./jobs/fetchStandings');
const apiKeyAuth = require('./lib/apiKeyAuth');

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

// The core product — win/draw/away probability for a given fixture.
// Protected by API key: every call must send a valid x-api-key header.
app.use('/v1/predict', apiKeyAuth, predictRouter);

// League tables. Also protected by API key.
app.use('/v1/standings', apiKeyAuth, standingsRouter);

// Live scores (from Bzzoiro). Also protected by API key.
app.use('/v1/live', apiKeyAuth, liveRouter);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fixtures first, then a one-minute pause, then standings.
// The pause keeps us under football-data.org's 10-calls-per-minute limit.
async function refreshAll() {
  try {
    await fetchAndStoreFixtures();
  } catch (err) {
    console.error('Fixtures fetch failed:', err.message);
  }

  await sleep(65 * 1000);

  try {
    await fetchAndStoreStandings();
  } catch (err) {
    console.error('Standings fetch failed:', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`odds-api listening on port ${PORT}`);

  // Fetch once on startup, then every 6 hours.
  refreshAll();
  setInterval(refreshAll, 6 * 60 * 60 * 1000); // 6 hours
});
