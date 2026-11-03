// server.js — Step 1: basic server, proves the deploy works.
// Later steps add: database caching, data fetch jobs, prediction logic, API keys.

require('dotenv').config();
const express = require('express');
const cors = require('cors');

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

// Placeholder route — this is where /v1/predict will live once we wire up
// the database and your prediction logic in later steps.
app.get('/v1/ping', (req, res) => {
  res.json({ pong: true });
});

app.listen(PORT, () => {
  console.log(`odds-api listening on port ${PORT}`);
});
