const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({ origin: '*' }));
app.use(express.json());

const ODDS_API_KEY = process.env.ODDS_API_KEY; // tvoj ključ

// Endpoint koji vraća mečeve za odabranu ligu (sport_key)
app.get('/api/matches', async (req, res) => {
  const sportKey = req.query.sport_key || 'soccer_italy_serie_a';
  const url = `https://api.the-odds-api.com/v4/odds/?sport=${sportKey}&apiKey=${ODDS_API_KEY}&regions=eu&markets=btts&bookmakers=bet365`;
  try {
    const response = await axios.get(url);
    const events = response.data || [];
    const matches = events.map(event => {
      const btts = event.bookmakers?.[0]?.markets?.find(m => m.key === 'btts')?.outcomes;
      return {
        id: event.id,
        home: event.home_team,
        away: event.away_team,
        commence_time: event.commence_time,
        odds: { btts_yes: btts?.find(o => o.name === 'Yes')?.price }
      };
    }).filter(m => m.odds.btts_yes);
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));