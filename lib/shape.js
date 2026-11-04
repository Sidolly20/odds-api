// lib/shape.js — small helpers that turn Bzzoiro's data into our own clean shape.

const IMG = 'https://sports.bzzoiro.com/img';
const teamLogo = (id) => (id ? `${IMG}/team/${id}/` : null);
const leagueLogo = (id) => (id ? `${IMG}/league/${id}/` : null);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const kickoffOf = (e) => String(e.event_date ?? e.kickoff ?? e.start_time ?? '');
const listOf = (data) => (Array.isArray(data) ? data : (data.results ?? data.events ?? []));

const nameOf = (v) => (typeof v === 'string' ? v : v?.name ?? null);
const idOf = (v) => (v && typeof v === 'object' ? v.id ?? null : null);

// league + home + away, the part every match shape shares
function sides(e, leagueNames) {
  const homeId = e.home_team_id ?? idOf(e.home_team) ?? idOf(e.home);
  const awayId = e.away_team_id ?? idOf(e.away_team) ?? idOf(e.away);
  const leagueId = e.league_id ?? idOf(e.league) ?? idOf(e.competition) ?? idOf(e.tournament);
  return {
    league: {
      id: leagueId ?? null,
      name:
        e.league_name ?? nameOf(e.league) ?? e.competition_name ?? nameOf(e.competition) ??
        e.tournament_name ?? nameOf(e.tournament) ?? leagueNames.get(leagueId) ?? null,
      logo: leagueLogo(leagueId)
    },
    home: {
      id: homeId ?? null,
      name: e.home_team_name ?? nameOf(e.home_team) ?? nameOf(e.home),
      logo: teamLogo(homeId)
    },
    away: {
      id: awayId ?? null,
      name: e.away_team_name ?? nameOf(e.away_team) ?? nameOf(e.away),
      logo: teamLogo(awayId)
    }
  };
}

// Bzzoiro's consensus odds block -> flat, predictable fields
function mapOdds(o) {
  if (!o) return null;
  const x = o.odds || {};
  return {
    type: 'consensus',
    home_win: x.home_win ?? null,
    draw: x.draw ?? null,
    away_win: x.away_win ?? null,
    over_15_goals: x.over_15_goals ?? null,
    over_25_goals: x.over_25_goals ?? null,
    over_35_goals: x.over_35_goals ?? null,
    under_15_goals: x.under_15_goals ?? null,
    under_25_goals: x.under_25_goals ?? null,
    under_35_goals: x.under_35_goals ?? null,
    btts_yes: x.btts_yes ?? null,
    btts_no: x.btts_no ?? null,
    last_checked: o.last_update_at ?? null,
    next_check: o.next_update_at ?? null
  };
}

// Bzzoiro's model prediction -> flat fields.
// (Their docs: market probabilities are 0-100, confidence is 0-1.)
function mapPrediction(p) {
  if (!p) return null;
  const m = p.markets || {};
  const r = m.match_result || {};
  if (r.prob_home == null && r.prob_draw == null && r.prob_away == null) return null;
  return {
    source: 'bzzoiro-model',
    home_win_pct: r.prob_home ?? null,
    draw_pct: r.prob_draw ?? null,
    away_win_pct: r.prob_away ?? null,
    predicted: r.predicted ?? null,
    expected_goals: { home: m.expected_goals?.home ?? null, away: m.expected_goals?.away ?? null },
    over_15_pct: m.over_under?.prob_over_15 ?? null,
    over_25_pct: m.over_under?.prob_over_25 ?? null,
    over_35_pct: m.over_under?.prob_over_35 ?? null,
    btts_yes_pct: m.btts?.prob_yes ?? null,
    most_likely_score: m.score?.most_likely ?? null,
    favorite: p.recommendations?.favorite ?? null,
    confidence: p.model?.confidence ?? null
  };
}

module.exports = {
  teamLogo, leagueLogo, DATE_RE, today, addDays,
  kickoffOf, listOf, sides, mapOdds, mapPrediction
};
