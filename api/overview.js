// ═══════════════════════════════════════════════════════════
//  WeatherEdge — api/overview.js (FAST version)
//  Hardcoded NWS grid coordinates to skip /points/ lookup
//  NWS is non-blocking — page loads with Open-Meteo if NWS is slow
// ═══════════════════════════════════════════════════════════

const CITIES = [
  { id: 'nyc',   name: 'New York City',  lat: 40.7128,  lon: -74.0060,  nws: 'KNYC', grid: 'OKX/33,37',    kalshi: 'KXHIGHNY'   },
  { id: 'chi',   name: 'Chicago',        lat: 41.7868,  lon: -87.7522,  nws: 'KMDW', grid: 'LOT/65,72',    kalshi: 'KXHIGHCHI'  },
  { id: 'mia',   name: 'Miami',          lat: 25.7959,  lon: -80.2870,  nws: 'KMIA', grid: 'MFL/111,50',   kalshi: 'KXHIGHMIA'  },
  { id: 'lax',   name: 'Los Angeles',    lat: 33.9382,  lon: -118.3886, nws: 'KLAX', grid: 'LOX/150,44',   kalshi: 'KXHIGHLAX'  },
  { id: 'sfo',   name: 'San Francisco',  lat: 37.6213,  lon: -122.3790, nws: 'KSFO', grid: 'MTR/84,105',   kalshi: 'KXHIGHTSFO' },
  { id: 'phi',   name: 'Philadelphia',   lat: 39.8744,  lon: -75.2424,  nws: 'KPHL', grid: 'PHI/49,75',    kalshi: 'KXHIGHPHIL' },
  { id: 'aus',   name: 'Austin',         lat: 30.1944,  lon: -97.6700,  nws: 'KAUS', grid: 'EWX/156,91',   kalshi: 'KXHIGHAUS'  },
  { id: 'den',   name: 'Denver',         lat: 39.8561,  lon: -104.6737, nws: 'KDEN', grid: 'BOU/62,60',    kalshi: 'KXHIGHDEN'  },
  { id: 'sea',   name: 'Seattle',        lat: 47.4502,  lon: -122.3088, nws: 'KSEA', grid: 'SEW/124,67',   kalshi: 'KXHIGHTSEA' },
  { id: 'lv',    name: 'Las Vegas',      lat: 36.0840,  lon: -115.1537, nws: 'KLAS', grid: 'VEF/122,97',   kalshi: 'KXHIGHTLV'  },
  { id: 'bos',   name: 'Boston',         lat: 42.3656,  lon: -71.0096,  nws: 'KBOS', grid: 'BOX/71,90',    kalshi: 'KXHIGHTBOS' },
  { id: 'nola',  name: 'New Orleans',    lat: 29.9934,  lon: -90.2580,  nws: 'KMSY', grid: 'LIX/76,74',    kalshi: 'KXHIGHTNOLA'},
  { id: 'dc',    name: 'Washington DC',  lat: 38.8512,  lon: -77.0402,  nws: 'KDCA', grid: 'LWX/97,71',    kalshi: 'KXHIGHTDC'  },
];

function getTodayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function getTomorrowStr() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ─── Safe Fetch (5s timeout — fail fast) ─────────────────
async function safeFetch(url, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'WeatherEdge/1.0 (contact@weatheredge.com)', 'Accept': 'application/json' }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ─── Open-Meteo (fast, no auth, most reliable) ───────────
async function getOpenMeteo(city) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto&forecast_days=3`;
  const data = await safeFetch(url);
  if (!data?.daily) return null;
  const result = {};
  for (let i = 0; i < data.daily.time.length; i++) {
    result[data.daily.time[i]] = { high: data.daily.temperature_2m_max[i], low: data.daily.temperature_2m_min[i] };
  }
  return result;
}

// ─── NWS Forecast (uses hardcoded grid — skips /points/) ─
async function getNWSForecast(city) {
  const [office, coords] = city.grid.split('/');
  const url = `https://api.weather.gov/gridpoints/${office}/${coords}/forecast`;
  const fc = await safeFetch(url);
  if (!fc?.properties?.periods) return null;

  const result = {};
  for (const p of fc.properties.periods) {
    const pDate = p.startTime.slice(0, 10);
    if (!result[pDate]) result[pDate] = { high: null, low: null };
    if (p.isDaytime) result[pDate].high = p.temperature;
    else result[pDate].low = p.temperature;
  }
  return result;
}

// ─── NWS Current Observation ─────────────────────────────
async function getNWSObservation(city) {
  const data = await safeFetch(`https://api.weather.gov/stations/${city.nws}/observations/latest`);
  if (!data?.properties?.temperature?.value && data?.properties?.temperature?.value !== 0) return null;
  const c = data.properties.temperature.value;
  return { tempF: Math.round((c * 9 / 5 + 32) * 10) / 10, desc: data.properties.textDescription || '' };
}

// ─── Kalshi (today or tomorrow only) ─────────────────────
async function getKalshi(seriesTicker) {
  const url = `https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=${seriesTicker}&status=open&with_nested_markets=true&limit=5`;
  const data = await safeFetch(url);
  if (!data?.events?.length) return null;

  const today = getTodayStr();
  const tomorrow = getTomorrowStr();
  let todayEvent = null, tomorrowEvent = null;

  for (const ev of data.events) {
    if (!ev.markets?.length) continue;
    const tickerMatch = ev.event_ticker?.match(/(\d{2})([A-Z]{3})(\d{2})$/);
    let marketDate = '';
    if (tickerMatch) {
      const months = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
      marketDate = `20${tickerMatch[1]}-${months[tickerMatch[2]] || '01'}-${tickerMatch[3]}`;
    }
    if (marketDate !== today && marketDate !== tomorrow) continue;

    const markets = ev.markets.map(m => ({
      ticker: m.ticker,
      subtitle: m.yes_sub_title || m.subtitle || '',
      yesAsk: m.yes_ask_dollars || m.yes_ask,
      lastPrice: m.last_price_dollars || m.last_price,
      volume: m.volume_fp || m.volume || 0
    })).filter(m => m.subtitle);

    const result = { eventTicker: ev.event_ticker, title: ev.title || '', subtitle: ev.sub_title || '', markets, marketDate };
    if (marketDate === today) todayEvent = result;
    if (marketDate === tomorrow) tomorrowEvent = result;
  }
  return todayEvent || tomorrowEvent || null;
}

// ─── Build Signal ────────────────────────────────────────
function buildSignal(consensusHigh, kalshiData) {
  if (!kalshiData?.markets?.length || consensusHigh === null) return null;
  const sorted = [...kalshiData.markets].sort((a, b) =>
    (parseFloat(b.lastPrice) || parseFloat(b.yesAsk) || 0) - (parseFloat(a.lastPrice) || parseFloat(a.yesAsk) || 0)
  );
  const fav = sorted[0];

  let match = null;
  for (const m of kalshiData.markets) {
    const s = m.subtitle.toLowerCase();
    const range = s.match(/(\d+)°?\s*to\s*(\d+)/);
    const below = s.match(/(\d+)°?\s*or\s*below/);
    const above = s.match(/(\d+)°?\s*or\s*above/);
    if (range && consensusHigh >= parseInt(range[1]) && consensusHigh <= parseInt(range[2]) + 0.9) { match = m; break; }
    if (below && consensusHigh <= parseInt(below[1])) { match = m; break; }
    if (above && consensusHigh >= parseInt(above[1])) { match = m; break; }
  }
  if (!match || !fav) return null;
  return {
    type: match.ticker === fav.ticker ? 'ALIGNED' : 'DIVERGENCE',
    consensusBracket: match.subtitle,
    consensusBracketPrice: parseFloat(match.lastPrice) || parseFloat(match.yesAsk) || 0,
    marketFavorite: fav.subtitle,
    marketFavoritePrice: parseFloat(fav.lastPrice) || parseFloat(fav.yesAsk) || 0
  };
}

// ─── Main Handler ────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  try {
    const results = await Promise.all(CITIES.map(async (city) => {
      // Fetch all sources in parallel — NWS failures don't block the response
      const [openMeteoMap, nwsForecastMap, observation, kalshi] = await Promise.all([
        getOpenMeteo(city),
        getNWSForecast(city).catch(() => null),   // non-blocking
        getNWSObservation(city).catch(() => null), // non-blocking
        getKalshi(city.kalshi)
      ]);

      const targetDate = kalshi?.marketDate || getTodayStr();
      const forecasts = [];

      if (openMeteoMap?.[targetDate]) {
        forecasts.push({ source: 'Open-Meteo', high: openMeteoMap[targetDate].high, low: openMeteoMap[targetDate].low });
      }
      if (nwsForecastMap?.[targetDate]) {
        forecasts.push({ source: 'NWS', high: nwsForecastMap[targetDate].high, low: nwsForecastMap[targetDate].low });
      }

      const highs = forecasts.filter(f => f.high != null).map(f => f.high);
      const lows = forecasts.filter(f => f.low != null).map(f => f.low);
      const consensusHigh = highs.length ? Math.round(highs.reduce((a, b) => a + b, 0) / highs.length * 10) / 10 : null;
      const consensusLow = lows.length ? Math.round(lows.reduce((a, b) => a + b, 0) / lows.length * 10) / 10 : null;

      return {
        id: city.id, name: city.name,
        currentTemp: observation?.tempF || null,
        currentDesc: observation?.desc || '',
        forecasts, forecastDate: targetDate,
        consensus: { high: consensusHigh, low: consensusLow },
        kalshi, signal: buildSignal(consensusHigh, kalshi),
      };
    }));

    res.status(200).json({ cities: results, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Overview error:', err);
    res.status(500).json({ error: 'Failed to fetch data', detail: err.message });
  }
}