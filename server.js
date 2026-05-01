const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

const API_KEY = '06cba23f71945f8e5ae6e6242d76972a';
const API_URL = 'https://v3.football.api-sports.io';

const LIGA_CONFIG = {
  39:  { name: 'Premier League',   faktor: 1.00, bazaGG: 52 },
  40:  { name: 'Championship',     faktor: 1.02, bazaGG: 54 },
  78:  { name: 'Bundesliga',       faktor: 1.05, bazaGG: 56 },
  140: { name: 'La Liga',          faktor: 0.95, bazaGG: 50 },
  135: { name: 'Serie A',          faktor: 0.90, bazaGG: 48 },
  61:  { name: 'Ligue 1',          faktor: 0.95, bazaGG: 50 },
  2:   { name: 'Champions League', faktor: 1.02, bazaGG: 54 },
  3:   { name: 'Europa League',    faktor: 1.00, bazaGG: 52 },
  144: { name: 'Pro League',       faktor: 1.03, bazaGG: 55 },
  94:  { name: 'Primeira Liga',    faktor: 0.97, bazaGG: 51 },
  88:  { name: 'Eredivisie',       faktor: 1.05, bazaGG: 57 },
};

const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

app.get('/', (req, res) => res.json({ status: 'GG Backend radi!', version: '2.0' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', cache_size: cache.size }));

async function apiGet(endpoint, params = {}) {
  const resp = await axios.get(`${API_URL}${endpoint}`, {
    params,
    headers: { 'x-apisports-key': API_KEY },
    timeout: 10000
  });
  return resp.data.response || [];
  async function getTeamId(name) {
  const cacheKey = `team_${name.toLowerCase()}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const results = await apiGet('/teams', { search: name });
  if (!results.length) throw new Error(`Tim nije pronađen: ${name}`);
  const id = results[0].team.id;
  setCache(cacheKey, id);
  return id;
}

async function getTeamStatsSeason(teamId, leagueId, season) {
  const cacheKey = `stats_${teamId}_${leagueId}_${season}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const results = await apiGet('/teams/statistics', {
      team: teamId, league: leagueId, season
    });
    if (!results || !results.fixtures) return null;
    const played = results.fixtures.played?.total || 0;
    if (played === 0) return null;
    const goalsFor = results.goals?.for?.total?.total || 0;
    const goalsAgainst = results.goals?.against?.total?.total || 0;
    const cleanSheets = results.clean_sheet?.total || 0;
    const failedToScore = results.failed_to_score?.total || 0;
    const btts = Math.round(
      ((played - cleanSheets) / played * 0.5 +
       (played - failedToScore) / played * 0.5) * 100
    );
    const data = {
      played,
      avgFor: +(goalsFor / played).toFixed(2),
      avgAgainst: +(goalsAgainst / played).toFixed(2),
      avgTotal: +((goalsFor + goalsAgainst) / played).toFixed(2),
      cleanSheets, failedToScore,
      btts: Math.min(95, Math.max(5, btts))
    };
    setCache(cacheKey, data);
    return data;
  } catch(e) { return null; }
}

async function getTeamBTTS(teamId, leagueId) {
  const sezone = [2023, 2024];
  const results = await Promise.all(
    sezone.map(s => getTeamStatsSeason(teamId, leagueId, s))
  );
  const valid = results.filter(r => r !== null);
  if (!valid.length) return { btts: 50, avgFor: 1.3, avgAgainst: 1.3, avgTotal: 2.6 };
  return {
    btts: Math.round(valid.reduce((s,r) => s+r.btts, 0) / valid.length),
    avgFor: +(valid.reduce((s,r) => s+r.avgFor, 0) / valid.length).toFixed(2),
    avgAgainst: +(valid.reduce((s,r) => s+r.avgAgainst, 0) / valid.length).toFixed(2),
    avgTotal: +(valid.reduce((s,r) => s+r.avgTotal, 0) / valid.length).toFixed(2)
  };
}

async function getTeamForm(teamId, leagueId, season) {
  const cacheKey = `form_${teamId}_${leagueId}_${season}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const fixtures = await apiGet('/fixtures', {
      team: teamId, league: leagueId, season, status: 'FT', last: 10
    });
    if (!fixtures.length) return 50;
    const last5 = fixtures.slice(-5);
    const bttsCount = last5.filter(f => (f.goals?.home??0)>0 && (f.goals?.away??0)>0).length;
    const formBtts = Math.round((bttsCount / last5.length) * 100);
    setCache(cacheKey, formBtts);
    return formBtts;
  } catch(e) { return 50; }
  async function getH2H(homeId, awayId) {
  const cacheKey = `h2h_${Math.min(homeId,awayId)}_${Math.max(homeId,awayId)}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  try {
    const matches = await apiGet('/fixtures/headtohead', {
      h2h: `${homeId}-${awayId}`, last: 20
    });
    const allMatches = matches.filter(m => m.fixture?.status?.short === 'FT');
    if (!allMatches.length) return { matches: 0, ggPct: 50, avgGoals: 2.5, gg3Pct: 30 };
    const ggCount = allMatches.filter(m => (m.goals?.home??0)>0 && (m.goals?.away??0)>0).length;
    const gg3Count = allMatches.filter(m => {
      const hg = m.goals?.home??0; const ag = m.goals?.away??0;
      return hg>0 && ag>0 && (hg+ag)>=3;
    }).length;
    const totalGoals = allMatches.reduce((s,m) => s+(m.goals?.home??0)+(m.goals?.away??0), 0);
    const result = {
      matches: allMatches.length,
      ggPct: Math.round((ggCount/allMatches.length)*100),
      gg3Pct: Math.round((gg3Count/allMatches.length)*100),
      avgGoals: +(totalGoals/allMatches.length).toFixed(2)
    };
    setCache(cacheKey, result);
    return result;
  } catch(e) { return { matches: 0, ggPct: 50, avgGoals: 2.5, gg3Pct: 30 }; }
}

app.post('/api/fixtures', async (req, res) => {
  const { league, season, from, to } = req.body;
  try {
    const params = { season: season || 2024, from, to };
    if (league) params.league = league;
    const fixtures = await apiGet('/fixtures', params);
    const matches = fixtures.map(f => ({
      id: f.fixture.id,
      home: f.teams.home.name,
      away: f.teams.away.name,
      homeId: f.teams.home.id,
      awayId: f.teams.away.id,
      date: f.fixture.date ? f.fixture.date.split('T')[0] : '',
      time: f.fixture.date ? (f.fixture.date.split('T')[1]||'').slice(0,5) : '',
      status: f.fixture.status?.short || 'NS',
      league: f.league?.name || '',
      leagueId: f.league?.id || league
    }));
    res.json(matches);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/analyze', async (req, res) => {
  const { home, away, homeId: homeIdIn, awayId: awayIdIn, leagueId, season } = req.body;
  const cacheKey = `analyze_${home}_${away}_${leagueId}`.toLowerCase().replace(/\s/g,'_');
  const cached = getCache(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });
  try {
    const [homeId, awayId] = await Promise.all([
      homeIdIn ? Promise.resolve(homeIdIn) : getTeamId(home),
      awayIdIn ? Promise.resolve(awayIdIn) : getTeamId(away)
    ]);
    const lgId = leagueId || 39;
    const ligaConfig = LIGA_CONFIG[lgId] || { name: 'Liga', faktor: 1.00, bazaGG: 52 };
    const [homeStats, awayStats, homeForm, awayForm, h2h] = await Promise.all([
      getTeamBTTS(homeId, lgId),
      getTeamBTTS(awayId, lgId),
      getTeamForm(homeId, lgId, season || 2024),
      getTeamForm(awayId, lgId, season || 2024),
      getH2H(homeId, awayId)
    ]);
    const teamAvgBTTS = Math.round((homeStats.btts + awayStats.btts) / 2);
    const formAvg = Math.round((homeForm + awayForm) / 2);
    const h2hGG = h2h.matches > 0 ? h2h.ggPct : teamAvgBTTS;
    let ggRaw = (h2hGG*0.40) + (teamAvgBTTS*0.30) + (formAvg*0.20) + (ligaConfig.bazaGG*0.10);
    let ggPct = Math.round(ggRaw * ligaConfig.faktor);
    ggPct = Math.min(90, Math.max(15, ggPct));
    const avgTotalGoals = +((homeStats.avgFor + awayStats.avgFor + h2h.avgGoals) / 3).toFixed(2);
    let gg3Pct = Math.round(ggPct * Math.min(avgTotalGoals / 3.0, 1.0));
    gg3Pct = Math.min(ggPct, Math.max(10, gg3Pct));
    const level = p => p >= 63 ? 'high' : p >= 45 ? 'medium' : 'low';
    const result = {
      home, away, league: ligaConfig.name,
      home_avg_for: homeStats.avgFor, home_avg_against: homeStats.avgAgainst,
      home_btts_pct: homeStats.btts, home_form: homeForm,
      away_avg_for: awayStats.avgFor, away_avg_against: awayStats.avgAgainst,
      away_btts_pct: awayStats.btts, away_form: awayForm,
      h2h_matches: h2h.matches, h2h_gg_pct: h2h.ggPct,
      h2h_gg3_pct: h2h.gg3Pct, h2h_avg_goals: h2h.avgGoals,
      avg_total: avgTotalGoals, liga_faktor: ligaConfig.faktor,
      liga_baza_gg: ligaConfig.bazaGG, gg_percent: ggPct, gg3_percent: gg3Pct,
      gg_level: level(ggPct), gg3_level: level(gg3Pct),
      reasoning_gg: `H2H obrazac (${h2h.matches} mečeva): ${h2hGG}% GG. ${home} BTTS ${homeStats.btts}%, ${away} BTTS ${awayStats.btts}%. Forma: ${home} ${homeForm}%, ${away} ${awayForm}%. Liga faktor: ${ligaConfig.faktor}.`,
      reasoning_gg3: `Prosj. golova H2H: ${h2h.avgGoals}. ${home} avg dat: ${homeStats.avgFor}, ${away} avg dat: ${awayStats.avgFor}. Ukupni avg: ${avgTotalGoals}.`
    };
    setCache(cacheKey, result);
    res.json(result);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`GG Backend v2.0 radi na portu ${PORT}`));
}
}
