const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

const API_KEY = '06cba23f71945f8e5ae6e6242d76972a';
const API_URL = 'https://v3.football.api-sports.io';

// ============================================================
// LIGA FAKTORI I BAZA GG%
// ============================================================
const LIGA_CONFIG = {
  39:  { name: 'Premier League',    faktor: 1.00, bazaGG: 52 },
  40:  { name: 'Championship',      faktor: 1.02, bazaGG: 54 },
  78:  { name: 'Bundesliga',        faktor: 1.05, bazaGG: 56 },
  140: { name: 'La Liga',           faktor: 0.95, bazaGG: 50 },
  135: { name: 'Serie A',           faktor: 0.90, bazaGG: 48 },
  61:  { name: 'Ligue 1',           faktor: 0.95, bazaGG: 50 },
  2:   { name: 'Champions League',  faktor: 1.02, bazaGG: 54 },
  3:   { name: 'Europa League',     faktor: 1.00, bazaGG: 52 },
  144: { name: 'Pro League',        faktor: 1.03, bazaGG: 55 },
  94:  { name: 'Primeira Liga',     faktor: 0.97, bazaGG: 51 },
  88:  { name: 'Eredivisie',        faktor: 1.05, bazaGG: 57 },
};

// ============================================================
// KEŠIRANJE (24h za statistike, 1h za kvote)
// ============================================================
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const ODDS_CACHE_TTL = 60 * 60 * 1000; // 1 sat

function getCache(key, ttl = CACHE_TTL) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data, ttl = CACHE_TTL) {
  cache.set(key, { data, ts: Date.now() });
}

// ============================================================
// HEALTH / ROOT
// ============================================================
app.get('/', (req, res) => res.json({ status: 'GG Backend + Odds API radi!', version: '3.0' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', cache_size: cache.size }));

// ============================================================
// API HELPER
// ============================================================
async function apiGet(endpoint, params = {}) {
  const resp = await axios.get(`${API_URL}${endpoint}`, {
    params,
    headers: { 'x-apisports-key': API_KEY },
    timeout: 10000
  });
  return resp.data.response || [];
}

// ============================================================
// DOHVATI ID TIMA
// ============================================================
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

// ============================================================
// STATISTIKE TIMA ZA JEDNU SEZONU
// ============================================================
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
      cleanSheets,
      failedToScore,
      btts: Math.min(95, Math.max(5, btts))
    };

    setCache(cacheKey, data);
    return data;
  } catch(e) {
    return null;
  }
}

// ============================================================
// PROSJEČNI BTTS TIMA KROZ 2 SEZONE
// ============================================================
async function getTeamBTTS(teamId, leagueId) {
  const sezone = [2023, 2024];
  const results = await Promise.all(
    sezone.map(s => getTeamStatsSeason(teamId, leagueId, s))
  );
  const valid = results.filter(r => r !== null);
  if (!valid.length) return { btts: 50, avgFor: 1.3, avgAgainst: 1.3, avgTotal: 2.6 };

  const avgBtts = Math.round(valid.reduce((s, r) => s + r.btts, 0) / valid.length);
  const avgFor = +(valid.reduce((s, r) => s + r.avgFor, 0) / valid.length).toFixed(2);
  const avgAgainst = +(valid.reduce((s, r) => s + r.avgAgainst, 0) / valid.length).toFixed(2);
  const avgTotal = +(valid.reduce((s, r) => s + r.avgTotal, 0) / valid.length).toFixed(2);

  return { btts: avgBtts, avgFor, avgAgainst, avgTotal };
}

// ============================================================
// FORMA - zadnjih 5 mečeva
// ============================================================
async function getTeamForm(teamId, leagueId, season) {
  const cacheKey = `form_${teamId}_${leagueId}_${season}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const fixtures = await apiGet('/fixtures', {
      team: teamId, league: leagueId, season,
      status: 'FT', last: 10
    });

    if (!fixtures.length) return 50;

    const last5 = fixtures.slice(-5);
    const bttsCount = last5.filter(f => {
      const hg = f.goals?.home ?? 0;
      const ag = f.goals?.away ?? 0;
      return hg > 0 && ag > 0;
    }).length;

    const formBtts = Math.round((bttsCount / last5.length) * 100);
    setCache(cacheKey, formBtts);
    return formBtts;
  } catch(e) {
    return 50;
  }
}

// ============================================================
// H2H KROZ 3 SEZONE
// ============================================================
async function getH2H(homeId, awayId) {
  const cacheKey = `h2h_${Math.min(homeId,awayId)}_${Math.max(homeId,awayId)}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  let allMatches = [];

  try {
    const matches = await apiGet('/fixtures/headtohead', {
      h2h: `${homeId}-${awayId}`,
      last: 20
    });
    allMatches = matches.filter(m => m.fixture?.status?.short === 'FT');
  } catch(e) {
    return { matches: 0, ggPct: 50, avgGoals: 2.5, gg3Pct: 30 };
  }

  if (!allMatches.length) {
    return { matches: 0, ggPct: 50, avgGoals: 2.5, gg3Pct: 30 };
  }

  const ggCount = allMatches.filter(m =>
    (m.goals?.home ?? 0) > 0 && (m.goals?.away ?? 0) > 0
  ).length;

  const gg3Count = allMatches.filter(m => {
    const total = (m.goals?.home ?? 0) + (m.goals?.away ?? 0);
    const hg = m.goals?.home ?? 0;
    const ag = m.goals?.away ?? 0;
    return hg > 0 && ag > 0 && total >= 3;
  }).length;

  const totalGoals = allMatches.reduce((s, m) =>
    s + (m.goals?.home ?? 0) + (m.goals?.away ?? 0), 0
  );

  const result = {
    matches: allMatches.length,
    ggPct: Math.round((ggCount / allMatches.length) * 100),
    gg3Pct: Math.round((gg3Count / allMatches.length) * 100),
    avgGoals: +(totalGoals / allMatches.length).toFixed(2)
  };

  setCache(cacheKey, result);
  return result;
}

// ============================================================
// KVOTE (ODDS) ENDPOINTI
// ============================================================

// 1. Dohvati kvote za određeni meč (po fixture ID)
app.get('/api/odds/:fixtureId', async (req, res) => {
  const { fixtureId } = req.params;
  const { bookmaker } = req.query; // opcionalno: ime kladionice (npr. "bet365")

  const cacheKey = `odds_${fixtureId}_${bookmaker || 'all'}`;
  const cached = getCache(cacheKey, ODDS_CACHE_TTL);
  if (cached) return res.json({ fromCache: true, odds: cached });

  try {
    let params = { fixture: fixtureId };
    const oddsData = await apiGet('/odds', params);

    if (!oddsData.length) {
      return res.json({ fixtureId, odds: [], message: "Nema kvota za ovaj meč." });
    }

    let results = oddsData;
    if (bookmaker) {
      results = oddsData.filter(bm => bm.bookmaker.name.toLowerCase().includes(bookmaker.toLowerCase()));
    }

    // Izvuci samo bitne podatke: ime kladionice, kvote za "GG" (Yes) i "Over 2.5"
    const formatted = results.map(bm => ({
      bookmaker: bm.bookmaker.name,
      bets: bm.bets.map(bet => ({
        name: bet.name,
        values: bet.values.map(v => ({
          value: v.value,
          odd: v.odd
        }))
      }))
    }));

    setCache(cacheKey, formatted, ODDS_CACHE_TTL);
    res.json({ fixtureId, odds: formatted });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Lista dostupnih kladionica za ligu/sezonu
app.get('/api/odds/bookmakers', async (req, res) => {
  const { league, season } = req.query;
  if (!league || !season) {
    return res.status(400).json({ error: "Potrebno je poslati league i season" });
  }
  const cacheKey = `bookmakers_${league}_${season}`;
  const cached = getCache(cacheKey, ODDS_CACHE_TTL);
  if (cached) return res.json(cached);

  try {
    const oddsData = await apiGet('/odds', { league, season });
    const bookmakersSet = new Set();
    oddsData.forEach(odd => {
      odd.bookmaker?.name && bookmakersSet.add(odd.bookmaker.name);
    });
    const result = { league, season, bookmakers: Array.from(bookmakersSet) };
    setCache(cacheKey, result, ODDS_CACHE_TTL);
    res.json(result);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Kombinovana analiza + kvote za "GG" (oba tima daju gol)
app.post('/api/analyze-odds', async (req, res) => {
  const { home, away, homeId, awayId, leagueId, season, fixtureId, bookmaker } = req.body;

  // Prvo pokreni postojeću analizu (GG procenat)
  const analyzePayload = { home, away, homeId, awayId, leagueId, season };
  let analyzeResult;
  try {
    const analyzeRes = await new Promise((resolve, reject) => {
      const mockRes = {
        json: resolve,
        status: (code) => ({ json: (err) => reject(err) })
      };
      app._router.handle({ body: analyzePayload, method: 'POST', url: '/api/analyze' }, mockRes, () => {});
    });
    analyzeResult = analyzeRes;
  } catch(e) {
    return res.status(500).json({ error: "Greška u analizi: " + e.message });
  }

  // Zatim dohvati kvote – ako imamo fixtureId, inače pokušaj pronaći fixture iz home/away/league/season
  let oddsData = null;
  if (fixtureId) {
    try {
      const oddsResp = await axios.get(`http://localhost:${PORT}/api/odds/${fixtureId}?bookmaker=${bookmaker || ''}`);
      oddsData = oddsResp.data.odds;
    } catch(e) { /* ignore */ }
  } else {
    // Opciono: potraži fixture po timovima i ligi
    try {
      const fixturesResp = await apiGet('/fixtures', {
        league: leagueId,
        season: season || 2024,
        team: homeId || await getTeamId(home)
      });
      const match = fixturesResp.find(f =>
        f.teams.home.name.toLowerCase() === home.toLowerCase() &&
        f.teams.away.name.toLowerCase() === away.toLowerCase() &&
        f.fixture.status?.short === 'NS'
      );
      if (match) {
        const oddsResp = await axios.get(`http://localhost:${PORT}/api/odds/${match.fixture.id}?bookmaker=${bookmaker || ''}`);
        oddsData = oddsResp.data.odds;
      }
    } catch(e) { /* ignore */ }
  }

  // Izvuci najbolju kvotu za "Both Teams to Score -> Yes"
  let bestGGodd = null;
  if (oddsData && oddsData.length) {
    for (const bm of oddsData) {
      const ggBet = bm.bets.find(bet => bet.name === 'Both Teams to Score');
      if (ggBet) {
        const yesOdd = ggBet.values.find(v => v.value === 'Yes');
        if (yesOdd && (!bestGGodd || yesOdd.odd > bestGGodd.odd)) {
          bestGGodd = { bookmaker: bm.bookmaker, odd: yesOdd.odd };
        }
      }
    }
  }

  res.json({
    analysis: analyzeResult,
    best_gg_odds: bestGGodd,
    odds_available: !!oddsData
  });
});

// ============================================================
// POST /api/analyze (originalna GG analiza)
// ============================================================
app.post('/api/analyze', async (req, res) => {
  const { home, away, homeId: homeIdIn, awayId: awayIdIn, leagueId, season } = req.body;

  const cacheKey = `analyze_${home}_${away}_${leagueId}`.toLowerCase().replace(/\s/g,'_');
  const cached = getCache(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    // Dohvati ID timova
    const [homeId, awayId] = await Promise.all([
      homeIdIn ? Promise.resolve(homeIdIn) : getTeamId(home),
      awayIdIn ? Promise.resolve(awayIdIn) : getTeamId(away)
    ]);

    const lgId = leagueId || 39;
    const ligaConfig = LIGA_CONFIG[lgId] || { name: 'Liga', faktor: 1.00, bazaGG: 52 };

    // Paralelno dohvati sve podatke
    const [homeStats, awayStats, homeForm, awayForm, h2h] = await Promise.all([
      getTeamBTTS(homeId, lgId),
      getTeamBTTS(awayId, lgId),
      getTeamForm(homeId, lgId, season || 2024),
      getTeamForm(awayId, lgId, season || 2024),
      getH2H(homeId, awayId)
    ]);

    // Formula
    const teamAvgBTTS = Math.round((homeStats.btts + awayStats.btts) / 2);
    const formAvg = Math.round((homeForm + awayForm) / 2);
    const h2hGG = h2h.matches > 0 ? h2h.ggPct : teamAvgBTTS;

    let ggRaw = (h2hGG * 0.40) + (teamAvgBTTS * 0.30) + (formAvg * 0.20) + (ligaConfig.bazaGG * 0.10);
    let ggPct = Math.round(ggRaw * ligaConfig.faktor);
    ggPct = Math.min(90, Math.max(15, ggPct));

    const avgTotalGoals = +((homeStats.avgFor + awayStats.avgFor + h2h.avgGoals) / 3).toFixed(2);
    let gg3Pct = Math.round(ggPct * Math.min(avgTotalGoals / 3.0, 1.0));
    gg3Pct = Math.min(ggPct, Math.max(10, gg3Pct));

    const level = p => p >= 63 ? 'high' : p >= 45 ? 'medium' : 'low';

    const reasoning_gg = [
      `H2H obrazac (${h2h.matches} mečeva): ${h2hGG}% GG.`,
      `${home} BTTS ${homeStats.btts}%, ${away} BTTS ${awayStats.btts}%.`,
      `Forma zadnjih 5: ${home} ${homeForm}%, ${away} ${awayForm}%.`,
      `Liga faktor ${ligaConfig.name}: ${ligaConfig.faktor}.`
    ].join(' ');

    const reasoning_gg3 = [
      `Prosj. golova H2H: ${h2h.avgGoals}.`,
      `${home} avg: ${homeStats.avgFor} dat, ${awayStats.avgFor} dat ${away}.`,
      `Ukupni avg za GG3+ kalkulaciju: ${avgTotalGoals}.`
    ].join(' ');

    const result = {
      home, away,
      league: ligaConfig.name,
      home_avg_for: homeStats.avgFor,
      home_avg_against: homeStats.avgAgainst,
      home_btts_pct: homeStats.btts,
      home_form: homeForm,
      away_avg_for: awayStats.avgFor,
      away_avg_against: awayStats.avgAgainst,
      away_btts_pct: awayStats.btts,
      away_form: awayForm,
      h2h_matches: h2h.matches,
      h2h_gg_pct: h2h.ggPct,
      h2h_gg3_pct: h2h.gg3Pct,
      h2h_avg_goals: h2h.avgGoals,
      avg_total: avgTotalGoals,
      liga_faktor: ligaConfig.faktor,
      liga_baza_gg: ligaConfig.bazaGG,
      gg_percent: ggPct,
      gg3_percent: gg3Pct,
      gg_level: level(ggPct),
      gg3_level: level(gg3Pct),
      reasoning_gg,
      reasoning_gg3
    };

    setCache(cacheKey, result);
    res.json(result);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/fixtures (original)
// ============================================================
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
      time: f.fixture.date ? (f.fixture.date.split('T')[1] || '').slice(0,5) : '',
      status: f.fixture.status?.short || 'NS',
      league: f.league?.name || '',
      leagueId: f.league?.id || league
    }));

    res.json(matches);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`GG Backend v3.0 (sa odds) radi na portu ${PORT}`));