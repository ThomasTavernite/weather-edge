// ═══════════════════════════════════════════════════════════
//  WeatherBid — api/overview.js (DUAL MARKET version)
//  Shows today's active market AND tomorrow's early opportunities
//  when both are available on Kalshi
// ═══════════════════════════════════════════════════════════

const CITIES = [
  { id: 'nyc',   name: 'New York City',  lat: 40.7128,  lon: -74.0060,  nws: 'KNYC', kalshi: 'KXHIGHNY'   },
  { id: 'chi',   name: 'Chicago',        lat: 41.7868,  lon: -87.7522,  nws: 'KMDW', kalshi: 'KXHIGHCHI'  },
  { id: 'mia',   name: 'Miami',          lat: 25.7959,  lon: -80.2870,  nws: 'KMIA', kalshi: 'KXHIGHMIA'  },
  { id: 'lax',   name: 'Los Angeles',    lat: 33.9382,  lon: -118.3886, nws: 'KLAX', kalshi: 'KXHIGHLAX'  },
  { id: 'sfo',   name: 'San Francisco',  lat: 37.6213,  lon: -122.3790, nws: 'KSFO', kalshi: 'KXHIGHTSFO' },
  { id: 'phi',   name: 'Philadelphia',   lat: 39.8744,  lon: -75.2424,  nws: 'KPHL', kalshi: 'KXHIGHPHIL' },
  { id: 'aus',   name: 'Austin',         lat: 30.1944,  lon: -97.6700,  nws: 'KAUS', kalshi: 'KXHIGHAUS'  },
  { id: 'den',   name: 'Denver',         lat: 39.8561,  lon: -104.6737, nws: 'KDEN', kalshi: 'KXHIGHDEN'  },
  { id: 'sea',   name: 'Seattle',        lat: 47.4502,  lon: -122.3088, nws: 'KSEA', kalshi: 'KXHIGHTSEA' },
  { id: 'lv',    name: 'Las Vegas',      lat: 36.0840,  lon: -115.1537, nws: 'KLAS', kalshi: 'KXHIGHTLV'  },
  { id: 'bos',   name: 'Boston',         lat: 42.3656,  lon: -71.0096,  nws: 'KBOS', kalshi: 'KXHIGHTBOS' },
  { id: 'nola',  name: 'New Orleans',    lat: 29.9934,  lon: -90.2580,  nws: 'KMSY', kalshi: 'KXHIGHTNOLA'},
  { id: 'dc',    name: 'Washington DC',  lat: 38.8512,  lon: -77.0402,  nws: 'KDCA', kalshi: 'KXHIGHTDC'  },
];

function getTodayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function getTomorrowStr() {
  var d = new Date(); d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function getETHour() {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
}

async function safeFetch(url, timeout) {
  timeout = timeout || 5000;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeout);
  try {
    var res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'WeatherBid/1.0', 'Accept': 'application/json' }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch(e) {
    clearTimeout(timer);
    return null;
  }
}

async function getOpenMeteo(city) {
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + city.lat + '&longitude=' + city.lon + '&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto&forecast_days=3';
  var data = await safeFetch(url);
  if (!data || !data.daily) return null;
  var result = {};
  for (var i = 0; i < data.daily.time.length; i++) {
    result[data.daily.time[i]] = { high: data.daily.temperature_2m_max[i], low: data.daily.temperature_2m_min[i] };
  }
  return result;
}

async function getNWSObservation(city) {
  var data = await safeFetch('https://api.weather.gov/stations/' + city.nws + '/observations/latest');
  if (!data || !data.properties || (data.properties.temperature.value === null && data.properties.temperature.value !== 0)) return null;
  var c = data.properties.temperature.value;
  return { tempF: Math.round((c * 9 / 5 + 32) * 10) / 10, desc: data.properties.textDescription || '' };
}

// Returns BOTH today and tomorrow events when available
async function getKalshiBoth(seriesTicker) {
  var url = 'https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=' + seriesTicker + '&status=open&with_nested_markets=true&limit=5';
  var data = await safeFetch(url);
  if (!data || !data.events || !data.events.length) return { today: null, tomorrow: null };

  var today = getTodayStr();
  var tomorrow = getTomorrowStr();
  var todayEvent = null, tomorrowEvent = null;

  for (var e = 0; e < data.events.length; e++) {
    var ev = data.events[e];
    if (!ev.markets || !ev.markets.length) continue;
    var tickerMatch = ev.event_ticker ? ev.event_ticker.match(/(\d{2})([A-Z]{3})(\d{2})$/) : null;
    var marketDate = '';
    if (tickerMatch) {
      var months = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
      marketDate = '20' + tickerMatch[1] + '-' + (months[tickerMatch[2]] || '01') + '-' + tickerMatch[3];
    }
    if (marketDate !== today && marketDate !== tomorrow) continue;

    var markets = ev.markets.map(function(m) {
      return {
        ticker: m.ticker,
        subtitle: m.yes_sub_title || m.subtitle || '',
        yesAsk: m.yes_ask_dollars || m.yes_ask,
        lastPrice: m.last_price_dollars || m.last_price,
        volume: m.volume_fp || m.volume || 0
      };
    }).filter(function(m) { return m.subtitle; });

    var result = { eventTicker: ev.event_ticker, title: ev.title || '', subtitle: ev.sub_title || '', markets: markets, marketDate: marketDate };
    if (marketDate === today) todayEvent = result;
    if (marketDate === tomorrow) tomorrowEvent = result;
  }
  return { today: todayEvent, tomorrow: tomorrowEvent };
}

function buildSignal(consensusHigh, kalshiData) {
  if (!kalshiData || !kalshiData.markets || !kalshiData.markets.length || consensusHigh === null) return null;
  var sorted = kalshiData.markets.slice().sort(function(a, b) {
    return (parseFloat(b.lastPrice) || parseFloat(b.yesAsk) || 0) - (parseFloat(a.lastPrice) || parseFloat(a.yesAsk) || 0);
  });
  var fav = sorted[0];
  var match = null;
  for (var i = 0; i < kalshiData.markets.length; i++) {
    var m = kalshiData.markets[i];
    var s = m.subtitle.toLowerCase();
    var range = s.match(/(\d+)°?\s*to\s*(\d+)/);
    var below = s.match(/(\d+)°?\s*or\s*below/);
    var above = s.match(/(\d+)°?\s*or\s*above/);
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

function buildCityResult(city, openMeteoMap, observation, kalshiData, targetDate) {
  var forecasts = [];
  if (openMeteoMap && openMeteoMap[targetDate]) {
    forecasts.push({ source: 'Open-Meteo', high: openMeteoMap[targetDate].high, low: openMeteoMap[targetDate].low });
  }
  var highs = forecasts.filter(function(f) { return f.high != null; }).map(function(f) { return f.high; });
  var lows = forecasts.filter(function(f) { return f.low != null; }).map(function(f) { return f.low; });
  var consensusHigh = highs.length ? Math.round(highs.reduce(function(a, b) { return a + b; }, 0) / highs.length * 10) / 10 : null;
  var consensusLow = lows.length ? Math.round(lows.reduce(function(a, b) { return a + b; }, 0) / lows.length * 10) / 10 : null;

  return {
    forecasts: forecasts,
    forecastDate: targetDate,
    consensus: { high: consensusHigh, low: consensusLow },
    kalshi: kalshiData,
    signal: buildSignal(consensusHigh, kalshiData)
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  try {
    var etHour = getETHour();

    var results = await Promise.all(CITIES.map(async function(city) {
      var openMeteoMap, observation, kalshiBoth;
      try {
        var fetches = await Promise.all([
          getOpenMeteo(city),
          getNWSObservation(city).catch(function() { return null; }),
          getKalshiBoth(city.kalshi)
        ]);
        openMeteoMap = fetches[0];
        observation = fetches[1];
        kalshiBoth = fetches[2];
      } catch(e) {
        openMeteoMap = null;
        observation = null;
        kalshiBoth = { today: null, tomorrow: null };
      }

      var today = getTodayStr();
      var tomorrow = getTomorrowStr();

      // Build today's market data
      var todayData = null;
      if (kalshiBoth.today) {
        todayData = buildCityResult(city, openMeteoMap, observation, kalshiBoth.today, today);
      }

      // Build tomorrow's market data
      var tomorrowData = null;
      if (kalshiBoth.tomorrow) {
        tomorrowData = buildCityResult(city, openMeteoMap, observation, kalshiBoth.tomorrow, tomorrow);
      }

      // Primary = today's market during the day, but also include tomorrow
      var primary = todayData || tomorrowData;
      var primaryDate = todayData ? today : tomorrow;

      return {
        id: city.id,
        name: city.name,
        currentTemp: observation ? observation.tempF : null,
        currentDesc: observation ? observation.desc : '',
        // Primary market (what shows on the card)
        forecasts: primary ? primary.forecasts : [],
        forecastDate: primary ? primary.forecastDate : today,
        consensus: primary ? primary.consensus : { high: null, low: null },
        kalshi: primary ? primary.kalshi : null,
        signal: primary ? primary.signal : null,
        // Tomorrow's market (for "Next Day" section)
        tomorrow: tomorrowData ? {
          forecasts: tomorrowData.forecasts,
          forecastDate: tomorrowData.forecastDate,
          consensus: tomorrowData.consensus,
          kalshi: tomorrowData.kalshi,
          signal: tomorrowData.signal
        } : null,
        // Flag so frontend knows both are available
        hasTomorrow: tomorrowData !== null,
        hasToday: todayData !== null
      };
    }));

    res.status(200).json({ cities: results, updatedAt: new Date().toISOString(), etHour: etHour });
  } catch (err) {
    console.error('Overview error:', err);
    res.status(500).json({ error: 'Failed to fetch data', detail: err.message });
  }
}