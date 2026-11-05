// lib/predict.js — the actual prediction engine.
//
// How it works, in plain terms:
// 1. Look at each team's last N finished matches (form).
// 2. Turn that into a "strength score" — points earned per game, adjusted
//    by goal difference (a team that wins 3-0 is stronger than one that
//    scrapes by 1-0).
// 3. Compare home team strength vs away team strength, add a home-advantage
//    boost (home teams statistically win more often in football).
// 4. Convert the strength gap into win/draw/away percentages using a
//    logistic curve — this is the same family of approach real odds
//    compilers and rating systems (like Elo) use, just simplified.
//
// This is a legitimate, defensible statistical method. It is NOT a
// guarantee — no model predicts football with certainty. Treat the
// output as "probability", not "guaranteed outcome".

const supabase = require('./supabase');

const HOME_ADVANTAGE = 0.25; // strength boost for playing at home
const FORM_MATCHES = 8;       // how many recent matches to consider per team
const MIN_MATCHES_FOR_CONFIDENCE = 3; // below this, we fall back to a neutral estimate

// Fetch a team's recent finished matches (home or away), most recent first
async function getRecentMatches(teamName, limit = FORM_MATCHES) {
  const { data, error } = await supabase
    .from('fixtures')
    .select('*')
    .or(`home_team.eq.${teamName},away_team.eq.${teamName}`)
    .eq('status', 'FINISHED')
    .not('home_score', 'is', null)
    .order('utc_date', { ascending: false })
    .limit(limit);

  if (error) {
    console.error(`Error fetching form for ${teamName}:`, error.message);
    return [];
  }
  return data || [];
}

// Turn a list of finished matches into a single "strength score" for one team.
// Points per game (3/1/0) blended with average goal difference.
function calculateStrength(matches, teamName) {
  if (matches.length === 0) return null;

  let points = 0;
  let goalDiffTotal = 0;

  for (const m of matches) {
    const isHome = m.home_team === teamName;
    const teamScore = isHome ? m.home_score : m.away_score;
    const oppScore = isHome ? m.away_score : m.home_score;

    if (teamScore > oppScore) points += 3;
    else if (teamScore === oppScore) points += 1;

    goalDiffTotal += (teamScore - oppScore);
  }

  const avgPoints = points / matches.length;       // 0 to 3
  const avgGoalDiff = goalDiffTotal / matches.length; // can be negative

  // Blend into one strength number. Points matter most; goal difference
  // nudges it so dominant wins count for a bit more than narrow ones.
  return avgPoints + avgGoalDiff * 0.15;
}

// Convert two strength scores into home/draw/away percentages using a
// logistic function — a standard way to turn a "who's better" gap into
// a smooth probability curve instead of a hard cutoff.
function strengthsToPercentages(homeStrength, awayStrength) {
  const gap = (homeStrength + HOME_ADVANTAGE) - awayStrength;

  // Logistic curve centered on the gap. k controls how sharply the
  // probability shifts as the gap grows — tuned to feel sane for football
  // (big strength gaps shouldn't produce 99% certainty; upsets happen).
  const k = 0.55;
  const homeWinRaw = 1 / (1 + Math.exp(-k * gap));
  const awayWinRaw = 1 / (1 + Math.exp(k * gap));

  // Draws are common in football (~25-28% historically). We carve out a
  // baseline draw chance, then split what's left between home/away
  // proportionally to their raw win likelihoods.
  const baseDrawPct = 26;
  const remaining = 100 - baseDrawPct;

  const totalRaw = homeWinRaw + awayWinRaw;
  const homeWinPct = Math.round((homeWinRaw / totalRaw) * remaining);
  const awayWinPct = Math.round((awayWinRaw / totalRaw) * remaining);
  const drawPct = 100 - homeWinPct - awayWinPct; // ensures they sum to exactly 100

  return {
    home_win_pct: homeWinPct,
    draw_pct: drawPct,
    away_win_pct: awayWinPct
  };
}

// Main entry point: given a home team and away team name, return percentages.
async function predictMatch(homeTeam, awayTeam) {
  const [homeMatches, awayMatches] = await Promise.all([
    getRecentMatches(homeTeam),
    getRecentMatches(awayTeam)
  ]);

  const homeStrength = calculateStrength(homeMatches, homeTeam);
  const awayStrength = calculateStrength(awayMatches, awayTeam);

  // Not enough history for one or both teams — return a neutral estimate
  // rather than a confident-looking number built on thin data.
  if (
    homeMatches.length < MIN_MATCHES_FOR_CONFIDENCE ||
    awayMatches.length < MIN_MATCHES_FOR_CONFIDENCE
  ) {
    return {
      home_win_pct: 40,
      draw_pct: 26,
      away_win_pct: 34,
      confidence: 'low',
      note: 'Not enough recent match history yet — estimate will improve as more results are collected.'
    };
  }

  const percentages = strengthsToPercentages(homeStrength, awayStrength);
  return { ...percentages, confidence: 'normal' };
}

module.exports = { predictMatch, getRecentMatches, calculateStrength };
