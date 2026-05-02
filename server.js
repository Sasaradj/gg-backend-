const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const pLimit = require('p-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || '06cba23f71945f8e5ae6e6242d76972a';
const ODDS_API_KEY = process.env.ODDS_API_KEY;

const API_FOOTBALL_URL = 'https://v3.football.api-sports.io';
const ODDS_API_URL = 'https://api.the-odds-api.com/v4';

const LIGA_CONFIG = {
  39:  { name: 'Premier League',    faktor: 1.00, bazaGG: 52, sport_key: 'soccer_epl' },
  78:  { name: 'Bundesliga',        faktor: 1.05, bazaGG: 56, sport_key: 'soccer_germany_bundesliga' },
  140: { name: 'La Liga',           faktor: 0.95, bazaGG: 50, sport_key: 'soccer_spain_la_liga' },
  135: { name: 'Serie A',           faktor: 0.90, bazaGG: 48, sport_key: 'soccer_italy_serie_a' },
  61:  { name: 'Ligue 1',           faktor: 0.95, bazaGG: 50, sport_key: 'soccer_france_ligue_one' },
  88:  { name: 'Eredivisie',        faktor: 1.05, bazaGG: 57, sport_key: 'soccer_netherlands_eredivisie' },
};

const cache = new NodeCache({ stdTTL: 86400, maxKeys: 500, checkperiod: 3600 });
function getCache(key) { return cache.get(key); }
function setCache(key, data) { cache.set(key, data); }

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

const TEAM_NAME_MAP = {
  "Man Utd": "Manchester United", "Man United": "Manchester United", "Tottenham": "Tottenham Hotspur",
  "Spurs": "Tottenham Hotspur", "Newcastle": "Newcastle United", "Leeds": "Leeds United",
  "Wolves": "Wolverhampton Wanderers", "West Ham": "West Ham United", "Brighton": "Brighton & Hove Albion",
  "Leicester": "Leicester City", "FC Bayern": "Bayern Munich", "Bayern München": "Bayern Munich",
  "Leverkusen": "Bayer Leverkusen", "Atletico": "Atletico Madrid", "AC Milan": "Milan",
  "Inter": "Inter Milan", "Napoli": "Napoli", "Roma": "Roma", "PSG": "Paris Saint Germain"
};
function normalizeTeamName(name) { const n = name.trim(); return TEAM_NAME_MAP[n] || n; }

async function getTeamId(name) {
  const normalized = normalizeTeamName(name);
  const cacheKey = `team_${normalized.toLowerCase()}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const results = await apiFootball('/teams', { search: normalized });
  if (!results.length) throw new Error(`Tim nije pronađen: ${normalized}`);
  const id = results[0].team.id;
  setCache(cacheKey, id);
  return id;
}

async function getTeamStatsSeason(teamId, leagueId, season) {
  const cacheKey = `stats_${teamId}_${leagueId}_${season}`;
  let data = getCache(cacheKey);
  if (data) return data;
  const results = await apiFootball('/teams/statistics', { team: teamId, league: leagueId, season });
  if (!results || !results.fixtures) {
    const liga = LIGA_CONFIG[leagueId] || LIGA_CONFIG[39];
    const fallback = { played: 10, avgFor: 1.2, avgAgainst: 1.2, avgTotal: 2.4, btts: liga.bazaGG };
    setCache(cacheKey, fallback);
    return fallback;
  }
  const played = results.fixtures.played?.total || 0;
  if (played === 0) {
    const liga = LIGA_CONFIG[leagueId] || LIGA_CONFIG[39];
    const fallback = { played: 10, avgFor: 1.2, avgAgainst: 1.2, avgTotal: 2.4, btts: liga.bazaGG };
    setCache(cacheKey, fallback);
    return fallback;
  }
  const goalsFor = results.goals?.for?.total?.total || 0;
  const goalsAgainst = results.goals?.against?.total?.total || 0;
  const cleanSheets = results.clean_sheet?.total || 0;
  const failedToScore = results.failed_to_score?.total || 0;
  const btts = Math.round(((played - cleanSheets) / played * 0.5 + (played - failedToScore) / played * 0.5) * 100);
  const stats = {
    played, avgFor: +(goalsFor / played).toFixed(2), avgAgainst: +(goalsAgainst / played).toFixed(2),
    avgTotal: +((goalsFor + goalsAgainst) / played).toFixed(2), btts: Math.min(95, Math.max(5, btts))
  };
  setCache(cacheKey, stats);
  return stats;
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
  const gg3Count = finished.filter(m => (m.goals?.home ?? 0) + (m.goals?.away ?? 0) >= 3 && (m.goals?.home ?? 0) > 0 && (m.goals?.away ?? 0) > 0).length;
  const totalGoals = finished.reduce((s, m) => s + (m.goals?.home ?? 0) + (m.goals?.away ?? 0), 0);
  const result = { matches: finished.length, ggPct: Math.round((ggCount / finished.length) * 100), gg3Pct: Math.round((gg3Count / finished.length) * 100), avgGoals: +(totalGoals / finished.length).toFixed(2) };
  setCache(cacheKey, result);
  return result;
}

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

  let avgTotalGoals = +((homeStats.avgFor + awayStats.avgFor + h2h.avgGoals) / 3).toFixed(2);
  const defenseFactor = Math.min(1.2, Math.max(0.8, (homeStats.avgAgainst + awayStats.avgAgainst) / 2 / 1.5));
  const adjustedAvgTotal = avgTotalGoals * defenseFactor;
  let gg3Pct = Math.min(ggPct, Math.max(10, Math.round(ggPct * Math.min(adjustedAvgTotal / 3.0, 1.2))));

  let confidence = 30;
  if (h2h.matches >= 6) confidence = 90;
  else if (h2h.matches >= 3) confidence = 70;
  else if (h2h.matches > 0) confidence = 45;
  else confidence = 25;
  if (homeForm < 35 || awayForm < 35) confidence -= 10;
  confidence = Math.min(100, Math.max(0, confidence));

  let reasoning = `H2H (${h2h.matches} meča): GG ${h2h.ggPct}%. `;
  reasoning += `Forma: ${home} ${homeForm}% GG, ${away} ${awayForm}% GG. `;
  reasoning += `Odbrane: ${home} prima ${homeStats.avgAgainst}, ${away} prima ${awayStats.avgAgainst}. `;
  if (confidence < 50) reasoning += `⚠️ Niska pouzdanost (malo H2H podataka). `;
  if (gg3Pct > ggPct * 0.75) reasoning += `📈 Pogodno za GG3+ zbog slabih odbrana.`;

  return {
    ggPct, gg3Pct, avgTotalGoals,
    h2hMatches: h2h.matches,
    h2hGGpct: h2h.ggPct,
    confidence_score: confidence,
    reasoning_text: reasoning,
    home_avg_for: homeStats.avgFor,
    home_avg_against: homeStats.avgAgainst,
    home_form: homeForm,
    away_avg_for: awayStats.avgFor,
    away_avg_against: awayStats.avgAgainst,
    away_form: awayForm
  };
}

app.get('/api/top-leagues', (req, res) => {
  const leagues = Object.entries(LIGA_CONFIG).map(([id, cfg]) => ({
    id: parseInt(id),
    name: cfg.name,
    gg_percent: cfg.bazaGG,
    matches_analyzed: 380
  }));
  const sorted = leagues.sort((a, b) => b.gg_percent - a.gg_percent);
  res.json(sorted);
});

app.get('/api/upcoming', async (req, res) => {
  const { leagueId } = req.query;
  if (!leagueId || !LIGA_CONFIG[leagueId]) return res.status(400).json({ error: 'Nepoznata liga' });
  const liga = LIGA_CONFIG[leagueId];
  if (!ODDS_API_KEY) return res.status(500).json({ error: 'ODDS_API_KEY nije postavljen' });

  const cacheKey = `upcoming_${leagueId}`;
  let cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const eventsUrl = `${ODDS_API_URL}/sports/${liga.sport_key}/events?apiKey=${ODDS_API_KEY}`;
    const eventsRes = await axios.get(eventsUrl);
    const events = eventsRes.data || [];
    if (!events.length) return res.json([]);

    const oddsPromises = events.map(async (event) => {
      try {
        const oddsUrl = `${ODDS_API_URL}/sports/${liga.sport_key}/events/${event.id}/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=btts&bookmakers=bet365`;
        const oddsRes = await axios.get(oddsUrl);
        const bookmaker = oddsRes.data.bookmakers?.[0];
        const btts = bookmaker?.markets?.find(m => m.key === 'btts')?.outcomes;
        return {
          id: event.id, home: event.home_team, away: event.away_team,
          commence_time: event.commence_time,
          odds: { btts_yes: btts?.find(o => o.name === 'Yes')?.price }
        };
      } catch (e) { return null; }
    });
    const matches = (await Promise.all(oddsPromises)).filter(m => m !== null);
    setCache(cacheKey, matches);
    res.json(matches);
  } catch (err) {
    console.error('Upcoming error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const limit = pLimit(3);
app.post('/api/analyze-batch', async (req, res) => {
  const { matches, leagueId } = req.body;
  if (!matches || !Array.isArray(matches)) {
    return res.status(400).json({ error: 'Nedostaje lista mečeva' });
  }

  const tasks = matches.map(match => limit(async () => {
    const cacheKey = `analysis_${match.home}_${match.away}_${leagueId}`;
    const cached = getCache(cacheKey);
    if (cached) {
      cached.odds = match.odds;
      cached.implied_gg_pct = match.odds?.btts_yes ? (1 / match.odds.btts_yes) * 100 : null;
      const edge = (cached.gg_percent / 100) * (match.odds?.btts_yes || 1) - 1;
      cached.edge_percent = (edge * 100).toFixed(1);
      cached.value_bet = edge > 0.08 ? 'high_value' : (edge > 0.03 ? 'medium_value' : 'low_value');
      return cached;
    }

    try {
      const analysis = await analyzeMatch(match.home, match.away, leagueId);
      const bttsOdds = match.odds?.btts_yes;
      const impliedPct = bttsOdds ? (1 / bttsOdds) * 100 : null;
      const edge = (analysis.ggPct / 100) * (bttsOdds || 1) - 1;

      const result = {
        home: match.home,
        away: match.away,
        commence_time: match.commence_time,
        gg_percent: analysis.ggPct,
        gg3_percent: analysis.gg3Pct,
        avg_total: analysis.avgTotalGoals,
        h2h_matches: analysis.h2hMatches,
        h2h_gg_pct: analysis.h2hGGpct,
        confidence_score: analysis.confidence_score,
        reasoning_text: analysis.reasoning_text,
        odds: match.odds,
        implied_gg_pct: impliedPct,
        edge_percent: (edge * 100).toFixed(1),
        value_bet: edge > 0.08 ? 'high_value' : (edge > 0.03 ? 'medium_value' : 'low_value'),
        home_avg_for: analysis.home_avg_for,
        home_avg_against: analysis.home_avg_against,
        home_form: analysis.home_form,
        away_avg_for: analysis.away_avg_for,
        away_avg_against: analysis.away_avg_against,
        away_form: analysis.away_form
      };
      setCache(cacheKey, result);
      return result;
    } catch (err) {
      console.error(`Greška za ${match.home} vs ${match.away}:`, err.message);
      return { home: match.home, away: match.away, error: err.message };
    }
  }));

  const results = await Promise.all(tasks);
  res.json(results);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', cacheSize: cache.keys().length }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));