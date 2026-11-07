// lib/footballDataLive.js — BACKUP source for live scores: football-data.org (free key you already have).
// Used only when Bzzoiro cannot answer. Free tier = the big competitions only (PL, La Liga, Serie A,
// Bundesliga, Ligue 1, Champions League and a few more), 10 calls per minute, scores can be a little late.
// Needs FOOTBALL_DATA_API_KEY (the same one the fixtures job uses). If it is missing the backup is off.

const URL = 'https://api.football-data.org/v4/matches?status=IN_PLAY,PAUSED';

function estimateMinute(f) {
  // The free plan does not send the minute, so we estimate it from kick-off. It is marked as an estimate.
  if (f.minute !== undefined && f.minute !== null) return Number(f.minute);
  const t = Date.parse(f.utcDate);
  if (!t) return null;
  let m = Math.floor((Date.now() - t) / 60000);
  if (m > 60) m -= 15; // half-time break
  return Math.max(1, Math.min(m, 90));
}

function mapMatch(f) {
  const half = f.status === 'PAUSED';
  return {
    id: f.id ?? null,
    league: { id: f.competition?.id ?? null, name: f.competition?.name ?? null, logo: f.competition?.emblem ?? null },
    home: { id: f.homeTeam?.id ?? null, name: f.homeTeam?.name ?? null, logo: f.homeTeam?.crest ?? null },
    away: { id: f.awayTeam?.id ?? null, name: f.awayTeam?.name ?? null, logo: f.awayTeam?.crest ?? null },
    kickoff: f.utcDate ?? null,
    status: half ? 'halftime' : 'inprogress',
    period: half ? 'HT' : null,
    minute: half ? 45 : estimateMinute(f),
    minute_estimated: !half && (f.minute === undefined || f.minute === null),
    score: { home: f.score?.fullTime?.home ?? null, away: f.score?.fullTime?.away ?? null },
    halftime: { home: f.score?.halfTime?.home ?? null, away: f.score?.halfTime?.away ?? null },
    extra_time_score: null,
    penalty_shootout: null,
    last_updated: new Date().toISOString(),
    source: 'football-data'
  };
}

async function fetchFootballDataLive() {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) throw new Error('FOOTBALL_DATA_API_KEY is not set (backup disabled).');
  const res = await fetch(URL, { headers: { 'X-Auth-Token': key }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`football-data returned ${res.status}`);
  const data = await res.json();
  return (data.matches || []).map(mapMatch);
}


// ---------- finished matches (used by /v1/results when Bzzoiro cannot answer) ----------
// One call covers the whole date window. Cached 5 minutes so repeated page loads don't use the 10-per-minute limit.
const FINISHED_TTL_MS = 5 * 60e3;
let finishedCache = { key: '', at: 0, list: [] };

function mapFinished(f) {
  const s = f.score || {};
  return {
    id: f.id ?? null,
    league: { id: f.competition?.id ?? null, name: f.competition?.name ?? null, logo: f.competition?.emblem ?? null },
    home: { id: f.homeTeam?.id ?? null, name: f.homeTeam?.name ?? null, logo: f.homeTeam?.crest ?? null },
    away: { id: f.awayTeam?.id ?? null, name: f.awayTeam?.name ?? null, logo: f.awayTeam?.crest ?? null },
    kickoff: f.utcDate ?? null,
    status: 'finished',
    period: null,
    score: { home: s.fullTime?.home ?? null, away: s.fullTime?.away ?? null },
    halftime: { home: s.halfTime?.home ?? null, away: s.halfTime?.away ?? null },
    extra_time_score: null,
    penalty_shootout: s.penalties && s.penalties.home != null ? s.penalties : null,
    last_updated: new Date().toISOString(),
    source: 'football-data'
  };
}

async function fetchFootballDataFinished(dateFrom, dateTo) {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) throw new Error('FOOTBALL_DATA_API_KEY is not set (backup disabled).');
  const cacheKey = `${dateFrom}|${dateTo}`;
  if (finishedCache.key === cacheKey && Date.now() - finishedCache.at < FINISHED_TTL_MS) return finishedCache.list;
  const url = `https://api.football-data.org/v4/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}`;
  const res = await fetch(url, { headers: { 'X-Auth-Token': key }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`football-data returned ${res.status}`);
  const data = await res.json();
  const list = (data.matches || []).map(mapFinished).filter((m) => m.score.home != null && m.score.away != null);
  finishedCache = { key: cacheKey, at: Date.now(), list };
  return list;
}

module.exports = { fetchFootballDataLive, fetchFootballDataFinished };
