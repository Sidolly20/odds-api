// lib/leagues.js — league id -> league name, loaded once a day from Bzzoiro.
// (Bzzoiro's match lists carry only a league id.)

const { bzzGet } = require('./bzz');

async function getLeagueNames() {
  const names = new Map();
  try {
    for (let page = 0; page < 5; page++) {
      const { data } = await bzzGet(`/leagues/?limit=200&offset=${page * 200}`, 86400);
      const list = Array.isArray(data) ? data : (data.results ?? data.leagues ?? []);
      for (const l of list) {
        const name = l.name ?? l.league_name ?? l.title ?? null;
        if (l.id != null && name) names.set(l.id, name);
      }
      if (list.length < 200) break;
    }
  } catch (err) {
    console.error('League names error:', err.message);
  }
  return names;
}

module.exports = { getLeagueNames };
