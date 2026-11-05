// lib/apiFootball.js — BACKUP source for live scores (API-Football, api-sports.io).
// Used only when Bzzoiro fails. Has its own daily budget so the free plan
// (100 calls/day) is never wasted. Needs env var API_FOOTBALL_KEY (optional:
// if it is missing, the backup is simply switched off).

const URL = 'https://v3.football.api-sports.io/fixtures?live=all';
const DAILY_BUDGET = parseInt(process.env.API_FOOTBALL_DAILY_BUDGET) || 90; // keep 10 spare

const supabase = require('./supabase');

let day = '';
let used = 0;
let loaded = false;

// Restore today's count from Supabase after a restart (table: api_budget).
// If the table does not exist yet, we quietly keep counting in memory only.
async function restore(today) {
  loaded = true;
  try {
    const { data } = await supabase.from('api_budget').select('used,day').eq('provider', 'api-football').single();
    if (data && data.day === today) used = Math.max(used, data.used || 0);
  } catch (e) { /* table missing: memory only */ }
}

function persist() {
  supabase.from('api_budget')
    .upsert({ provider: 'api-football', day, used })
    .then(() => { }).catch(() => { });
}

function budgetLeft() {
  const today = new Date().toISOString().slice(0, 10);
  if (day !== today) { day = today; used = 0; loaded = false; }
  if (!loaded) restore(today);
  return DAILY_BUDGET - used;
}

const logo = (u) => u || null;

// Same shape as mapEvent() in routes/live.js, so websites notice no difference.
function mapFixture(f) {
  const short = f.fixture?.status?.short;
  return {
    id: f.fixture?.id ?? null,
    league: { id: f.league?.id ?? null, name: f.league?.name ?? null, logo: logo(f.league?.logo) },
    home: { id: f.teams?.home?.id ?? null, name: f.teams?.home?.name ?? null, logo: logo(f.teams?.home?.logo) },
    away: { id: f.teams?.away?.id ?? null, name: f.teams?.away?.name ?? null, logo: logo(f.teams?.away?.logo) },
    kickoff: f.fixture?.date ?? null,
    status: short === 'HT' ? 'halftime' : 'inprogress',
    period: short ?? null,
    minute: f.fixture?.status?.elapsed ?? null,
    score: { home: f.goals?.home ?? null, away: f.goals?.away ?? null },
    halftime: { home: f.score?.halftime?.home ?? null, away: f.score?.halftime?.away ?? null },
    extra_time_score: null,
    penalty_shootout: null,
    last_updated: new Date().toISOString(),
    source: 'api-football'
  };
}

async function fetchLiveBackup() {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY is not set (backup disabled).');
  if (budgetLeft() <= 0) throw new Error('API-Football daily budget used up.');

  used += 1;
  persist();
  const res = await fetch(URL, { headers: { 'x-apisports-key': key } });
  if (!res.ok) throw new Error(`API-Football returned ${res.status}`);
  const data = await res.json();
  // api-sports reports quota problems inside a 200 response
  if (data.errors && Object.keys(data.errors).length) {
    throw new Error(`API-Football error: ${JSON.stringify(data.errors)}`);
  }
  return (data.response || []).map(mapFixture);
}

module.exports = { fetchLiveBackup, budgetLeft };
