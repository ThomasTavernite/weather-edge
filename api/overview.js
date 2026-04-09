// ═══════════════════════════════════════════════════════════
//  WeatherQuant — api/overview.js
//  Returns BOTH today's and tomorrow's markets for each city
//  Sequential Kalshi calls to avoid rate limits
// ═══════════════════════════════════════════════════════════

var CITIES = [
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

async function safeFetch(url, timeout) {
  timeout = timeout || 5000;
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeout);
  try {
    var res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'WeatherQuant/1.0', 'Accept': 'application/json' }
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

function parseKalshiEvent(ev, today, tomorrow) {
  if (!ev.markets || !ev.markets.length) return null;
  var tickerMatch = ev.event_ticker ? ev.event_ticker.match(/(\d{2})([A-Z]{3})(\d{2})$/) : null;
  var marketDate = '';
  if (tickerMatch) {
    var months = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
    marketDate = '20' + tickerMatch[1] + '-' + (months[tickerMatch[2]] || '01') + '-' + tickerMatch[3];
  }
  if (marketDate !== today && marketDate !== tomorrow) return null;

  var markets = ev.markets.map(function(m) {
    return {
      ticker: m.ticker,
      subtitle: m.yes_sub_title || m.subtitle || '',
      yesAsk: m.yes_ask_dollars || m.yes_ask,
      lastPrice: m.last_price_dollars || m.last_price,
      volume: m.volume_fp || m.volume || 0
    };
  }).filter(function(m) { return m.subtitle; });

  return {
    eventTicker: ev.event_ticker,
    title: ev.title || '',
    subtitle: ev.sub_title || '',
    markets: markets,
    marketDate: marketDate
  };
}

function getMarketPrice(m) {
  var last = parseFloat(m.lastPrice) || 0;
  var ask = parseFloat(m.yesAsk) || 0;
  return Math.max(last, ask);
}

function buildSignal(consensusHigh, kalshiData) {
  if (!kalshiData || !kalshiData.markets || !kalshiData.markets.length || consensusHigh === null) return null;
  var sorted = kalshiData.markets.slice().sort(function(a, b) {
    return getMarketPrice(b) - getMarketPrice(a);
  });
  var fav = sorted[0];
  if (getMarketPrice(fav) <= 0.01) return null;
  var match = null;
  for (var i = 0; i < kalshiData.markets.length; i++) {
    var m = kalshiData.markets[i];
    var s = m.subtitle.toLowerCase();
    var range = s.match(/(\d+)°?\s*to\s*(\d+)/);
    var below = s.match(/(\d+)°?\s*or\s*below/);
    var above = s.match(/(\d+)°?\s*or\s*above/);
    if (range && consensusHigh >= parseInt(range[1]) && consensusHigh <= parseInt(range[2]) + 0.9) { match = m; break; }
    if (below && consensusHigh <= parseInt(below[1]) + 0.9) { match = m; break; }
    if (above && consensusHigh >= parseInt(above[1])) { match = m; break; }
  }
  if (!match || !fav) return null;
  return {
    type: match.ticker === fav.ticker ? 'ALIGNED' : 'DIVERGENCE',
    consensusBracket: match.subtitle,
    consensusBracketPrice: getMarketPrice(match),
    marketFavorite: fav.subtitle,
    marketFavoritePrice: getMarketPrice(fav)
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  try {
    var today = getTodayStr();
    var tomorrow = getTomorrowStr();

    // Step 1: Fetch ALL Kalshi data sequentially to avoid rate limits
    var kalshiTodayMap = {};
    var kalshiTomorrowMap = {};

    for (var k = 0; k < CITIES.length; k++) {
      var city = CITIES[k];
      var url = 'https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=' + city.kalshi + '&status=open&with_nested_markets=true&limit=5';
      var data = await safeFetch(url);

      if (data && data.events && data.events.length) {
        for (var e = 0; e < data.events.length; e++) {
          var parsed = parseKalshiEvent(data.events[e], today, tomorrow);
          if (parsed && parsed.marketDate === today) kalshiTodayMap[city.id] = parsed;
          if (parsed && parsed.marketDate === tomorrow) kalshiTomorrowMap[city.id] = parsed;
        }
      }
      if (!kalshiTodayMap[city.id]) kalshiTodayMap[city.id] = null;
      if (!kalshiTomorrowMap[city.id]) kalshiTomorrowMap[city.id] = null;

      await new Promise(function(r) { setTimeout(r, 200); });
    }

    // Step 2: Fetch weather data in parallel
    var results = await Promise.all(CITIES.map(async function(city) {
      var openMeteoMap = await getOpenMeteo(city);
      var observation = null;
      try { observation = await getNWSObservation(city); } catch(e) {}

      var kalshiToday = kalshiTodayMap[city.id];
      var kalshiTomorrow = kalshiTomorrowMap[city.id];

      // Today's forecasts
      var forecastsToday = [];
      if (openMeteoMap && openMeteoMap[today]) {
        forecastsToday.push({ source: 'Open-Meteo', high: openMeteoMap[today].high, low: openMeteoMap[today].low });
      }
      var highsToday = forecastsToday.filter(function(f) { return f.high != null; }).map(function(f) { return f.high; });
      var lowsToday = forecastsToday.filter(function(f) { return f.low != null; }).map(function(f) { return f.low; });
      var consensusHighToday = highsToday.length ? Math.round(highsToday.reduce(function(a,b){return a+b;},0) / highsToday.length * 10) / 10 : null;
      var consensusLowToday = lowsToday.length ? Math.round(lowsToday.reduce(function(a,b){return a+b;},0) / lowsToday.length * 10) / 10 : null;

      // Tomorrow's forecasts
      var forecastsTomorrow = [];
      if (openMeteoMap && openMeteoMap[tomorrow]) {
        forecastsTomorrow.push({ source: 'Open-Meteo', high: openMeteoMap[tomorrow].high, low: openMeteoMap[tomorrow].low });
      }
      var highsTom = forecastsTomorrow.filter(function(f) { return f.high != null; }).map(function(f) { return f.high; });
      var lowsTom = forecastsTomorrow.filter(function(f) { return f.low != null; }).map(function(f) { return f.low; });
      var consensusHighTomorrow = highsTom.length ? Math.round(highsTom.reduce(function(a,b){return a+b;},0) / highsTom.length * 10) / 10 : null;
      var consensusLowTomorrow = lowsTom.length ? Math.round(lowsTom.reduce(function(a,b){return a+b;},0) / lowsTom.length * 10) / 10 : null;

      return {
        id: city.id, name: city.name,
        currentTemp: observation ? observation.tempF : null,
        currentDesc: observation ? observation.desc : '',
        // Today
        forecastsToday: forecastsToday,
        forecastDate: today,
        consensusToday: { high: consensusHighToday, low: consensusLowToday },
        kalshiToday: kalshiToday,
        signalToday: buildSignal(consensusHighToday, kalshiToday),
        // Tomorrow
        forecastsTomorrow: forecastsTomorrow,
        forecastDateTomorrow: tomorrow,
        consensusTomorrow: { high: consensusHighTomorrow, low: consensusLowTomorrow },
        kalshiTomorrow: kalshiTomorrow,
        signalTomorrow: buildSignal(consensusHighTomorrow, kalshiTomorrow),
      };
    }));

    res.status(200).json({ cities: results, today: today, tomorrow: tomorrow, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Overview error:', err);
    res.status(500).json({ error: 'Failed to fetch data', detail: err.message });
  }
}