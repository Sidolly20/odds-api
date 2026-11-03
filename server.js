// server.js — Step 2/3 complete version
require('dotenv').config();
require('./lib/fixDns');
const express = require('express');
const cors = require('cors');
const fixturesRouter = require('./routes/fixtures');
const predictRouter = require('./routes/predict');
const fetchAndStoreFixtures = require('./jobs/fetchFixtures');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'odds-api is running', time: new Date().toISOString() });
});

app.get('/v1/ping', (req, res) => {
  res.json({ pong: true });
});

app.use('/v1/fixtures', fixturesRouter);
app.use('/v1/predict', predictRouter);

app.listen(PORT, () => {
  console.log(`odds-api listening on port ${PORT}`);
  fetchAndStoreFixtures().catch((err) => console.error('Initial fetch failed:', err.message));
  setInterval(() => {
    fetchAndStoreFixtures().catch((err) => console.error('Scheduled fetch failed:', err.message));
  }, 6 * 60 * 60 * 1000);
});
