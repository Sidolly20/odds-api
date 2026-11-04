// jobs/fetchStandings.js — pulls league tables from football-data.org
// and stores them in Supabase (one row per competition).
// Runs on a timer, NOT on every API request.
//
// The free plan allows 10 calls per minute, so this waits 7 seconds
// between calls (about 8 per minute) to stay safely under the limit.

if (require.main === module) {
  require('dotenv').config();
}

require('../lib/fixDns');
const supabase = require('../lib/supabase');

const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_API_KEY;
const BASE_URL = 'https://api.football-data.org/v4';
const COMPETITIONS = ['PL', 'PD', 'SA', 'BL1', 'CL'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mapRow(r) {
  return {
    position: r.position,
    team_id: r.team?.id ?? null,
    team: r.team?.name || null,
    crest: r.team?.crest || null,
    played: r.playedGames,
    won: r.won,
    draw: r.draw,
    lost: r.lost,
    points: r.points,
    goals_for: r.goalsFor,
    goals_against: r.goalsAgainst,
    goal_difference: r.goalDifference,
    form: r.form || null
  };
}

async function fetchAndStoreStandings() {
  console.log('Starting standings fetch...');
  let saved = 0;

  for (const code of COMPETITIONS) {
    try {
      const res = await fetch(`${BASE_URL}/competitions/${code}/standings`, {
        headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY }
      });

      if (!res.ok) {
        console.error(`Standings failed for ${code}: ${res.status} ${res.statusText}`);
      } else {
        const data = await res.json();

        // Keep only the overall table (not the separate home-only / away-only tables)
        const tables = (data.standings || [])
          .filter((s) => s.type === 'TOTAL')
          .map((s) => ({
            stage: s.stage || null,
            group: s.group || null,
            table: (s.table || []).map(mapRow)
          }));

        const start = data.season?.startDate?.slice(0, 4);
        const end = data.season?.endDate?.slice(0, 4);

        const { error } = await supabase.from('standings').upsert(
          {
            competition_code: code,
            competition_name: data.competition?.name || null,
            season: start && end ? `${start}/${end}` : null,
            tables,
            updated_at: new Date().toISOString()
          },
          { onConflict: 'competition_code' }
        );

        if (error) {
          console.error(`Error saving standings for ${code}:`, error.message);
        } else {
          saved++;
          console.log(`Saved standings for ${code}`);
        }
      }
    } catch (err) {
      console.error(`Standings error for ${code}:`, err.message);
    }

    await sleep(7000);
  }

  console.log(`Standings fetch complete. Saved: ${saved}`);
}

module.exports = fetchAndStoreStandings;

// Allows running directly: node jobs/fetchStandings.js
if (require.main === module) {
  fetchAndStoreStandings().then(() => process.exit(0));
}
