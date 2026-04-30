const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const API_KEY = '06cba23f71945f8e5ae6e6242d76972a';
const API_URL = 'https://v3.football.api-sports.io';

app.get('/', (req, res) => res.json({ status: 'GG Backend radi!' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/fixtures', async (req, res) => {
  const { league, season, from, to } = req.body;
  try {
    const params = { season, from, to };
    if (league) params.league = league;
    const resp = await axios.get(`${API_URL}/fixtures`, {
      params,
      headers: { 'x-apisports-key': API_KEY }
    });
    const matches = (resp.data.response || []).map(f => ({
      id: f.fixture.id,
      home: f.teams.home.name,
      away: f.teams.away.name,
      date: f.fixture.date ? f.fixture.date.split('T')[0] : '',
      time: f.fixture.date ? f.fixture.date.split('T')[1]?.slice(0,5) : '',
      status: f.fixture.status.short,
      league: f.league.name
    }));
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  const { home, away, leagueId, season } = req.body;
  try {
    const [homeTeamRes, awayTeamRes] = await Promise.all([
      axios.get(`${API_URL}/teams`, { params: { search: home }, headers: { 'x-apisports-key': API_KEY } }),
      axios.get(`${API_URL}/teams`, { params: { search: away }, headers: { 'x-apisports-key': API_KEY } })
    ]);
    const homeId = homeTeamRes.data.response[0]?.team.id;
    const awayId = awayTeamRes.data.response[0]?.team.id;
    if (!homeId || !awayId) throw new Error('Tim nije pronađen');

    const getStats = async (teamId) => {
      const s = await axios.get(`${API_URL}/teams/statistics`, {
        params: { league: leagueId || 39, season: season || 2024, team: teamId },
        headers: { 'x-apisports-key': API_KEY }
      });
      const r = s.data.response;
      const played = r.fixtures?.played?.total || 1;
      const goalsFor = r.goals?.for?.total?.total || 0;
      const goalsAgainst = r.goals?.against?.total?.total || 0;
      const cleanSheets = r.clean_sheet?.total || 0;
      const failedToScore = r.failed_to_score?.total || 0;
      const btts = Math.round(((played - cleanSheets) / played * 50) + ((played - failedToScore) / played * 50));
      return {
        avgFor: +(goalsFor / played).toFixed(2),
        avgAgainst: +(goalsAgainst / played).toFixed(2),
        avgTotal: +((goalsFor + goalsAgainst) / played).toFixed(2),
        cleanSheets,
        failedToScore,
        btts: Math.min(100, Math.max(0, btts))
      };
    };

    const [homeStats, awayStats] = await Promise.all([getStats(homeId), getStats(awayId)]);

    const h2hRes = await axios.get(`${API_URL}/fixtures/headtohead`, {
      params: { h2h: `${homeId}-${awayId}`, last: 10 },
      headers: { 'x-apisports-key': API_KEY }
    });
    const h2h = h2hRes.data.response || [];
    const h2hGG = h2h.length ? Math.round(h2h.filter(m => m.goals.home > 0 && m.goals.away > 0).length / h2h.length * 100) : 0;
    const h2hAvg = h2h.length ? +(h2h.reduce((s, m) => s + m.goals.home + m.goals.away, 0) / h2h.length).toFixed(2) : 0;

    const avgTotal = +((homeStats.avgFor + awayStats.avgFor) / 2).toFixed(2);
    const ggPct = Math.round(homeStats.btts * 0.35 + awayStats.btts * 0.35 + Math.min(h2hGG, 100) * 0.30);
    const gg3Pct = Math.round(ggPct * Math.min(avgTotal / 3.0, 1.0));
    const level = p => p >= 60 ? 'high' : p >= 40 ? 'medium' : 'low';

    res.json({
      home, away,
      home_avg_for: homeStats.avgFor, home_avg_against: homeStats.avgAgainst,
      home_btts_pct: homeStats.btts, home_cs: homeStats.cleanSheets,
      away_avg_for: awayStats.avgFor, away_avg_against: awayStats.avgAgainst,
      away_btts_pct: awayStats.btts, away_cs: awayStats.cleanSheets,
      h2h_matches: h2h.length, h2h_gg_pct: h2hGG, h2h_avg_goals: h2hAvg,
      avg_total: avgTotal,
      gg_percent: ggPct, gg3_percent: gg3Pct,
      gg_level: level(ggPct), gg3_level: level(gg3Pct),
      reasoning_gg: `${home} BTTS ${homeStats.btts}%, ${away} BTTS ${awayStats.btts}%. H2H GG ${h2hGG}% od ${h2h.length} mečeva.`,
      reasoning_gg3: `Prosj. golova po meču: ${avgTotal}. GG3+ zahtijeva 3+ golova.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server radi na portu ${PORT}`));
