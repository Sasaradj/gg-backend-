const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ==================== API KLJUČEVI (postavi u environment na Renderu) ====================
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || '06cba23f71945f8e5ae6e6242d76972a';
const ODDS_API_KEY = process.env.ODDS_API_KEY; // OBAVEZNO!

const API_FOOTBALL_URL = 'https://v3.football.api-sports.io';
const ODDS_API_URL = 'https://api.the-odds-api.com/v4';

// ==================== LIGA MAPIRANJE ====================
const LIGA_CONFIG = {
  39:  { name: 'Premier League',    faktor: 1.00, bazaGG: 52, sport_key: 'soccer_england_premier_league' },
  78:  { name: 'Bundesliga',        faktor: 1.05, bazaGG: 56, sport_key: 'soccer_germany_bundesliga' },
  140: { name: 'La Liga',           faktor: 0.95, bazaGG: 50, sport_key: 'soccer_spain_la_liga' },
  135: { name: 'Serie A',           faktor: 0.90, bazaGG: 48, sport_key: 'soccer_italy_serie_a' },
  61:  { name: 'Ligue 1',           faktor: 0.95, bazaGG: 50, sport_key: 'soccer_france_ligue_one' },
  88:  { name: 'Eredivisie',        faktor: 1.05, bazaGG: 57, sport_key: 'soccer_netherlands_eredivisie' },
  2:   { name: 'Champions League',  faktor: 1.02, bazaGG: 54, sport_key: 'soccer_uefa_champions_league' },
  3:   { name: 'Europa League',     faktor: 1.00, bazaGG: 52, sport_key: 'soccer_uefa_europa_league' },
};

// ==================== KEŠIRANJE ====================
const cache = new Map();
const CACHE_TTL = {
  stats: 24 * 60 * 60 * 1000, // 24h
  odds:  60 * 60 * 1000,      // 1h
};

function getCache(key, ttlKey = 'stats') {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL[ttlKey]) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data, ttlKey = 'stats') {
  cache.set(key, { data, ts: Date.now() });
}

// ==================== HELPER ZA API-FOOTBALL ====================
async function apiFootball(endpoint, params) {
  try {
    const res = await axios.get(`${API_FOOTBALL_URL}${endpoint}`, {
      params, headers: { 'x-apisports-key': API_FOOTBALL_KEY }, timeout: 10000
    });
    return res.data.response || [];
  } catch (err) {
    console.error(`API-Football error (${endpoint}):`, err.message);
    return [];
  }
}

// ==================== DOHVATI ID TIMA ====================
async function getTeamId(name) {
  const cacheKey = `team_${name.toLowerCase()}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const results = await apiFootball('/teams', { search: name });
  if (!results.length) throw new Error(`Tim nije pronađen: ${name}`);
  const id = results[0].team.id;
  setCache(cacheKey, id);
  return id;
}

// ==================== STATISTIKE TIMA (2023-2024) ====================
async function getTeamStatsSeason(teamId, leagueId, season) {
  const cacheKey = `stats_${teamId}_${leagueId}_${season}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const results = await apiFootball('/teams/statistics', { team: teamId, league: leagueId, season });
  if (!results || !results.fixtures) return null;
  const played = results.fixtures.played?.total || 0;
  if (played === 0) return null;
  const goalsFor = results.goals?.for?.total?.total || 0;
  const goalsAgainst = results.goals?.against?.total?.total || 0;
  const cleanSheets = results.clean_sheet?.total || 0;
  const failedToScore = results.failed_to_score?.total || 0;
  const btts = Math.round(((played - cleanSheets) / played * 0.5 + (played - failedToScore) / played * 0.5) * 100);
  const data = {
    played, avgFor: +(goalsFor / played).toFixed(2), avgAgainst: +(goalsAgainst / played).toFixed(2),
    avgTotal: +((goalsFor + goalsAgainst) / played).toFixed(2), btts: Math.min(95, Math.max(5, btts))
  };
  setCache(cacheKey, data);
  return data;
}

async function getTeamBTTS(teamId, leagueId) {
  const sezone = [2023, 2024];
  const results = await Promise.all(sezone.map(s => getTeamStatsSeason(teamId, leagueId, s)));
  const valid = results.filter(r => r !== null);
  if (!valid.length) return { btts: 50, avgFor: 1.3, avgAgainst: 1.3, avgTotal: 2.6 };
  return {
    btts: Math.round(valid.reduce((s, r) => s + r.btts, 0) / valid.length),
    avgFor: +(valid.reduce((s, r) => s + r.avgFor, 0) / valid.length).toFixed(2),
    avgAgainst: +(valid.reduce((s, r) => s + r.avgAgainst, 0) / valid.length).toFixed(2),
    avgTotal: +(valid.reduce((s, r) => s + r.avgTotal, 0) / valid.length).toFixed(2)
  };
}

async function getTeamForm(teamId, leagueId, season) {
  const cacheKey = `form_${teamId}_${leagueId}_${season}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const fixtures = await apiFootball('/fixtures', { team: teamId, league: leagueId, season, status: 'FT', last: 10 });
  if (!fixtures.length) return 50;
  const last5 = fixtures.slice(-5);
  const bttsCount = last5.filter(f => (f.goals?.home ?? 0) > 0 && (f.goals?.away ?? 0) > 0).length;
  const form = Math.round((bttsCount / last5.length) * 100);
  setCache(cacheKey, form);
  return form;
}

async function getH2H(homeId, awayId) {
  const cacheKey = `h2h_${Math.min(homeId, awayId)}_${Math.max(homeId, awayId)}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const matches = await apiFootball('/fixtures/headtohead', { h2h: `${homeId}-${awayId}`, last: 20 });
  const finished = matches.filter(m => m.fixture?.status?.short === 'FT');
  if (!finished.length) return { matches: 0, ggPct: 50, avgGoals: 2.5, gg3Pct: 30 };
  const ggCount = finished.filter(m => (m.goals?.home ?? 0) > 0 && (m.goals?.away ?? 0) > 0).length;
  const gg3Count = finished.filter(m => {
    const total = (m.goals?.home ?? 0) + (m.goals?.away ?? 0);
    return (m.goals?.home ?? 0) > 0 && (m.goals?.away ?? 0) > 0 && total >= 3;
  }).length;
  const totalGoals = finished.reduce((s, m) => s + (m.goals?.home ?? 0) + (m.goals?.away ?? 0), 0);
  const result = { matches: finished.length, ggPct: Math.round((ggCount / finished.length) * 100), gg3Pct: Math.round((gg3Count / finished.length) * 100), avgGoals: +(totalGoals / finished.length).toFixed(2) };
  setCache(cacheKey, result);
  return result;
}

// ==================== ANALIZA JEDNOG MEČA ====================
async function analyzeMatch(home, away, leagueId) {
  const liga = LIGA_CONFIG[leagueId] || LIGA_CONFIG[39];
  const [homeId, awayId] = await Promise.all([getTeamId(home), getTeamId(away)]);
  const [homeStats, awayStats, homeForm, awayForm, h2h] = await Promise.all([
    getTeamBTTS(homeId, leagueId), getTeamBTTS(awayId, leagueId),
    getTeamForm(homeId, leagueId, 2024), getTeamForm(awayId, leagueId, 2024),
    getH2H(homeId, awayId)
  ]);
  const teamAvgBTTS = Math.round((homeStats.btts + awayStats.btts) / 2);
  const formAvg = Math.round((homeForm + awayForm) / 2);
  const h2hGG = h2h.matches > 0 ? h2h.ggPct : teamAvgBTTS;
  let ggRaw = (h2hGG * 0.40) + (teamAvgBTTS * 0.30) + (formAvg * 0.20) + (liga.bazaGG * 0.10);
  let ggPct = Math.min(90, Math.max(15, Math.round(ggRaw * liga.faktor)));
  const avgTotalGoals = +((homeStats.avgFor + awayStats.avgFor + h2h.avgGoals) / 3).toFixed(2);
  let gg3Pct = Math.min(ggPct, Math.max(10, Math.round(ggPct * Math.min(avgTotalGoals / 3.0, 1.0))));
  return { ggPct, gg3Pct, avgTotalGoals, h2hMatches: h2h.matches, h2hGGpct: h2h.ggPct };
}

// ==================== ENDPOINT: DOHVAĆANJE MEČEVA ZA 7 DANA (The Odds API) ====================
app.get('/api/upcoming', async (req, res) => {
  const { leagueId } = req.query;
  if (!leagueId || !LIGA_CONFIG[leagueId]) return res.status(400).json({ error: 'Nepoznata liga' });
  const liga = LIGA_CONFIG[leagueId];
  if (!ODDS_API_KEY) return res.status(500).json({ error: 'ODDS_API_KEY nije postavljen' });

  const cacheKey = `upcoming_${leagueId}`;
  const cached = getCache(cacheKey, 'odds');
  if (cached) return res.json(cached);

  try {
    // 1. Dohvati upcoming eventove za sport_key
    const eventsUrl = `${ODDS_API_URL}/sports/${liga.sport_key}/events?apiKey=${ODDS_API_KEY}`;
    const eventsRes = await axios.get(eventsUrl);
    const events = eventsRes.data || [];
    if (!events.length) return res.json([]);

    // 2. Za svaki event dohvati kvote (markets: h2h, btts, totals)
    const oddsPromises = events.map(async (event) => {
      const oddsUrl = `${ODDS_API_URL}/sports/${liga.sport_key}/events/${event.id}/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h,btts,totals&bookmakers=bet365`;
      try {
        const oddsRes = await axios.get(oddsUrl);
        const oddsData = oddsRes.data;
        const bookmaker = oddsData.bookmakers?.[0];
        const h2h = bookmaker?.markets?.find(m => m.key === 'h2h')?.outcomes;
        const btts = bookmaker?.markets?.find(m => m.key === 'btts')?.outcomes;
        const totals = bookmaker?.markets?.find(m => m.key === 'totals')?.outcomes;
        const homeOdds = h2h?.find(o => o.name === event.home_team)?.price;
        const awayOdds = h2h?.find(o => o.name === event.away_team)?.price;
        const drawOdds = h2h?.find(o => o.name === 'Draw')?.price;
        const bttsYes = btts?.find(o => o.name === 'Yes')?.price;
        const over25 = totals?.find(o => o.point === 2.5 && o.name === 'Over')?.price;
        return {
          id: event.id,
          home: event.home_team,
          away: event.away_team,
          commence_time: event.commence_time,
          odds: { home: homeOdds, away: awayOdds, draw: drawOdds, btts_yes: bttsYes, over_25: over25 }
        };
      } catch (e) { return null; }
    });
    const matchesWithOdds = (await Promise.all(oddsPromises)).filter(m => m !== null);
    setCache(cacheKey, matchesWithOdds, 'odds');
    res.json(matchesWithOdds);
  } catch (err) {
    console.error('Upcoming error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== ENDPOINT: ANALIZA ZA SVE MEČEVE IZ LISTE ====================
app.post('/api/analyze-batch', async (req, res) => {
  const { matches, leagueId } = req.body;
  if (!matches || !Array.isArray(matches)) return res.status(400).json({ error: 'Nedostaje lista mečeva' });
  const results = [];
  for (const m of matches) {
    try {
      const { ggPct, gg3Pct, avgTotalGoals, h2hMatches, h2hGGpct } = await analyzeMatch(m.home, m.away, leagueId);
      const implGG = m.odds?.btts_yes ? (1 / m.odds.btts_yes) * 100 : null;
      const valueGG = implGG ? ggPct - implGG : null;
      results.push({
        home: m.home, away: m.away, commence_time: m.commence_time,
        gg_percent: ggPct, gg3_percent: gg3Pct, avg_total: avgTotalGoals,
        odds: m.odds, implied_gg_pct: implGG, value_gg: valueGG,
        h2h_matches: h2hMatches, h2h_gg_pct: h2hGGpct,
        value_bet: (valueGG !== null && valueGG > 5)
      });
    } catch (err) {
      results.push({ home: m.home, away: m.away, error: err.message });
    }
    await new Promise(r => setTimeout(r, 300)); // throttle
  }
  res.json(results);
});

// ==================== STARI ENDPOINT ZA RUČNU ANALIZU (opcija) ====================
app.post('/api/analyze', async (req, res) => {
  const { home, away, leagueId } = req.body;
  try {
    const { ggPct, gg3Pct, avgTotalGoals, h2hMatches, h2hGGpct } = await analyzeMatch(home, away, leagueId);
    res.json({ gg_percent: ggPct, gg3_percent: gg3Pct, avg_total: avgTotalGoals, h2h_matches: h2hMatches, h2h_gg_pct: h2hGGpct });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', cacheSize: cache.size }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));