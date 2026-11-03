// jobs/fetchFixtures.js — pulls upcoming matches from football-data.org
// and stores them in Supabase. This runs on a timer (every few hours),
// NOT on every API request — that's what keeps us from hitting the
// free tier's rate limit and getting banned.

// Load .env FIRST if this file is run directly, before anything else
// reads process.env (lib/supabase.js reads it as soon as it's required).
if (require.main === module) {
  require('dotenv').config();
}

require('../lib/fixDns'); // fixes "fetch failed" on some Windows/ISP networks
const supabase = require('../lib/supabase');

const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_API_KEY;
const BASE_URL = 'https://api.football-data.org/v4';

// A few popular competitions on the free tier. Add more competition
// codes here later (PL = Premier League, PD = La Liga, etc.)
const COMPETITIONS = ['PL', 'PD', 'SA', 'BL1', 'CL'];

async function fetchCompetitionMatches(code) {
  const res = await fetch(`${BASE_URL}/competitions/${code}/matches?status=SCHEDULED`, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY }
  });

  if (!res.ok) {
    console.error(`Failed to fetch ${code}: ${res.status} ${res.statusText}`);
    return [];
  }

  const data = await res.json();
  return data.matches || [];
}

function mapMatchToRow(match) {
  return {
    id: match.id,
    competition: match.competition?.name || null,
    home_team: match.homeTeam?.name || null,
    away_team: match.awayTeam?.name || null,
    utc_date: match.utcDate,
    status: match.status,
    home_score: match.score?.fullTime?.home ?? null,
    away_score: match.score?.fullTime?.away ?? null,
    updated_at: new Date().toISOString()
  };
}

async function fetchAndStoreFixtures() {
  console.log('Starting fixture fetch...');
  let totalSaved = 0;

  for (const code of COMPETITIONS) {
    const matches = await fetchCompetitionMatches(code);
    if (matches.length === 0) continue;

    const rows = matches.map(mapMatchToRow);

    // upsert = insert new rows, update existing ones (matched by id)
    const { error } = await supabase.from('fixtures').upsert(rows, { onConflict: 'id' });

    if (error) {
      console.error(`Error saving ${code} fixtures:`, error.message);
    } else {
      totalSaved += rows.length;
      console.log(`Saved ${rows.length} fixtures for ${code}`);
    }

    // Small delay between competitions to be gentle on the free rate limit
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  console.log(`Fixture fetch complete. Total saved: ${totalSaved}`);
}

module.exports = fetchAndStoreFixtures;

// Allows running this file directly: node jobs/fetchFixtures.js
if (require.main === module) {
  fetchAndStoreFixtures().then(() => process.exit(0));
}
