// ═══════════════════════════════════════════════════════════
//  WeatherQuant — api/overview.js (v2)
//  Multi-model forecasts + smart divergence filtering
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

// Models to query from Open-Meteo (each is an independent weather model)
var MODELS = ['gfs_seamless', 'ecmwf_ifs025', 'icon_seamless'];

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

// ─── Multi-model forecasts from Open-Meteo ───────────────
// Returns { "2026-04-14": { highs: [{source, temp},...], lows: [{source, temp},...] }, ... }
async function getMultiModelForecasts(city) {
  var modelsParam = MODELS.join(',');
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + city.lat
    + '&longitude=' + city.lon
    + '&daily=temperature_2m_max,temperature_2m_min'
    + '&temperature_unit=fahrenheit&timezone=auto&forecast_days=3'
    + '&models=' + modelsParam;

  var data = await safeFetch(url, 8000);
  if (!data) return null;

  var result = {};
  // When using &models=, Open-Meteo returns per-model keys like:
  //   temperature_2m_max_gfs_seamless, temperature_2m_max_ecmwf_ifs025, etc.
  // The "daily" block contains all of them plus a "time" array
  var daily = data.daily;
  if (!daily || !daily.time) return null;

  var modelNames = {
    'gfs_seamless': 'GFS',
    'ecmwf_ifs025': 'ECMWF',
    'icon_seamless': 'ICON'
  };

  for (var d = 0; d < daily.time.length; d++) {
    var date = daily.time[d];
    result[date] = { highs: [], lows: [] };

    for (var m = 0; m < MODELS.length; m++) {
      var model = MODELS[m];
      var highKey = 'temperature_2m_max_' + model;
      var lowKey = 'temperature_2m_min_' + model;

      // Open-Meteo may also return plain keys if only one model, so handle both
      var highVal = daily[highKey] ? daily[highKey][d] : null;
      var lowVal = daily[lowKey] ? daily[lowKey][d] : null;

      if (highVal !== null && highVal !== undefined) {
        result[date].highs.push({ source: modelNames[model] || model, temp: highVal });
      }
      if (lowVal !== null && lowVal !== undefined) {
        result[date].lows.push({ source: modelNames[model] || model, temp: lowVal });
      }
    }

    // Fallback: if multi-model keys didn't work, try the default keys
    if (result[date].highs.length === 0 && daily.temperature_2m_max) {
      var fallbackHigh = daily.temperature_2m_max[d];
      if (fallbackHigh !== null && fallbackHigh !== undefined) {
        result[date].highs.push({ source: 'Open-Meteo', temp: fallbackHigh });
      }
    }
    if (result[date].lows.length === 0 && daily.temperature_2m_min) {
      var fallbackLow = daily.temperature_2m_min[d];
      if (fallbackLow !== null && fallbackLow !== undefined) {
        result[date].lows.push({ source: 'Open-Meteo', temp: fallbackLow });
      }
    }
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

// ─── Compute consensus from multiple model forecasts ─────
// Returns { high, low, sourceCount, spread, sources[] }
function computeConsensus(modelData, dateStr) {
  if (!modelData || !modelData[dateStr]) return { high: null, low: null, sourceCount: 0, spread: 0, sources: [] };

  var entry = modelData[dateStr];
  var highs = entry.highs.map(function(h) { return h.temp; });
  var lows = entry.lows.map(function(l) { return l.temp; });
  var sources = entry.highs.map(function(h) { return h.source; });

  var avgHigh = highs.length ? Math.round(highs.reduce(function(a, b) { return a + b; }, 0) / highs.length * 10) / 10 : null;
  var avgLow = lows.length ? Math.round(lows.reduce(function(a, b) { return a + b; }, 0) / lows.length * 10) / 10 : null;

  // Spread = max difference between model forecasts (measures agreement)
  var spread = 0;
  if (highs.length > 1) {
    var maxH = Math.max.apply(null, highs);
    var minH = Math.min.apply(null, highs);
    spread = Math.round((maxH - minH) * 10) / 10;
  }

  return {
    high: avgHigh,
    low: avgLow,
    sourceCount: highs.length,
    spread: spread,
    sources: sources,
    individualHighs: highs
  };
}

// ─── Smart signal builder ────────────────────────────────
function buildSignal(consensus, kalshiData) {
  if (!kalshiData || !kalshiData.markets || !kalshiData.markets.length || consensus.high === null) return null;

  var consensusHigh = consensus.high;

  var sorted = kalshiData.markets.slice().sort(function(a, b) {
    return getMarketPrice(b) - getMarketPrice(a);
  });
  var fav = sorted[0];
  var favPrice = getMarketPrice(fav);
  if (favPrice <= 0.01) return null;

  // ── Gate 1: Market already settled or near-certain ──
  // If the top bracket is $0.90+, the market is decided. No actionable signal.
  if (favPrice >= 0.90) {
    return {
      type: 'SETTLED',
      consensusBracket: null,
      consensusBracketPrice: null,
      marketFavorite: fav.subtitle,
      marketFavoritePrice: favPrice,
      confidence: null,
      totalVolume: 0,
      priceSpread: 0,
      nearBoundary: false,
      reason: 'Market is settled or near-certain'
    };
  }

  // Calculate total volume
  var totalVolume = 0;
  for (var v = 0; v < kalshiData.markets.length; v++) {
    totalVolume += parseInt(kalshiData.markets[v].volume) || 0;
  }

  var secondPrice = sorted.length > 1 ? getMarketPrice(sorted[1]) : 0;
  var priceSpread = favPrice - secondPrice;

  // ── Find which bracket the consensus falls into ──
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

  var isMatch = match.ticker === fav.ticker;

  // ── Gate 2: Single-source divergence suppression ──
  // If we only have 1 model, don't trust divergence — show ALIGNED with a note
  if (!isMatch && consensus.sourceCount < 2) {
    return {
      type: 'LOW_DATA',
      consensusBracket: match.subtitle,
      consensusBracketPrice: getMarketPrice(match),
      marketFavorite: fav.subtitle,
      marketFavoritePrice: favPrice,
      confidence: 'LOW',
      totalVolume: totalVolume,
      priceSpread: Math.round(priceSpread * 100),
      nearBoundary: false,
      reason: 'Only 1 forecast source — not enough data to call divergence'
    };
  }

  // ── Gate 3: Tiny price spread = noise ──
  if (!isMatch && priceSpread < 0.03) {
    isMatch = true; // Downgrade to ALIGNED
  }

  // ── Gate 4: Model disagreement check ──
  // If models themselves disagree by 3°F+, signal is unreliable
  if (!isMatch && consensus.spread >= 3) {
    return {
      type: 'UNCERTAIN',
      consensusBracket: match.subtitle,
      consensusBracketPrice: getMarketPrice(match),
      marketFavorite: fav.subtitle,
      marketFavoritePrice: favPrice,
      confidence: 'LOW',
      totalVolume: totalVolume,
      priceSpread: Math.round(priceSpread * 100),
      nearBoundary: false,
      modelSpread: consensus.spread,
      reason: 'Forecast models disagree by ' + consensus.spread + '°F — signal unreliable'
    };
  }

  // ── Gate 5: Low volume suppression ──
  // Markets with very low volume have unreliable prices
  if (!isMatch && totalVolume < 50) {
    return {
      type: 'LOW_VOLUME',
      consensusBracket: match.subtitle,
      consensusBracketPrice: getMarketPrice(match),
      marketFavorite: fav.subtitle,
      marketFavoritePrice: favPrice,
      confidence: 'LOW',
      totalVolume: totalVolume,
      priceSpread: Math.round(priceSpread * 100),
      nearBoundary: false,
      reason: 'Market volume too low for reliable signal'
    };
  }

  // ── Confidence level for valid signals ──
  var confidence = 'HIGH';
  if (totalVolume < 500) confidence = 'LOW';
  else if (totalVolume < 2000) confidence = 'MODERATE';
  if (priceSpread < 0.05 && confidence !== 'LOW') confidence = 'MODERATE';
  // Boost confidence if all models agree tightly
  if (consensus.spread <= 1 && consensus.sourceCount >= 3 && confidence === 'MODERATE') confidence = 'HIGH';

  // Boundary check
  var nearBoundary = false;
  var fracPart = consensusHigh % 1;
  if (fracPart >= 0.7 || fracPart <= 0.3) nearBoundary = true;

  return {
    type: isMatch ? 'ALIGNED' : 'DIVERGENCE',
    consensusBracket: match.subtitle,
    consensusBracketPrice: getMarketPrice(match),
    marketFavorite: fav.subtitle,
    marketFavoritePrice: favPrice,
    confidence: confidence,
    totalVolume: totalVolume,
    priceSpread: Math.round(priceSpread * 100),
    nearBoundary: nearBoundary,
    modelSpread: consensus.spread,
    sourceCount: consensus.sourceCount,
    reason: null
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

    // Step 2: Fetch weather data in parallel (multi-model)
    var results = await Promise.all(CITIES.map(async function(city) {
      var modelData = await getMultiModelForecasts(city);
      var observation = null;
      try { observation = await getNWSObservation(city); } catch(e) {}

      var kalshiToday = kalshiTodayMap[city.id];
      var kalshiTomorrow = kalshiTomorrowMap[city.id];

      // Compute consensus from all models
      var consensusToday = computeConsensus(modelData, today);
      var consensusTomorrow = computeConsensus(modelData, tomorrow);

      // Build source list for frontend display
      var forecastsToday = [];
      if (modelData && modelData[today]) {
        for (var i = 0; i < modelData[today].highs.length; i++) {
          forecastsToday.push({
            source: modelData[today].highs[i].source,
            high: modelData[today].highs[i].temp,
            low: modelData[today].lows[i] ? modelData[today].lows[i].temp : null
          });
        }
      }
      var forecastsTomorrow = [];
      if (modelData && modelData[tomorrow]) {
        for (var j = 0; j < modelData[tomorrow].highs.length; j++) {
          forecastsTomorrow.push({
            source: modelData[tomorrow].highs[j].source,
            high: modelData[tomorrow].highs[j].temp,
            low: modelData[tomorrow].lows[j] ? modelData[tomorrow].lows[j].temp : null
          });
        }
      }

      return {
        id: city.id, name: city.name,
        currentTemp: observation ? observation.tempF : null,
        currentDesc: observation ? observation.desc : '',
        // Today
        forecastsToday: forecastsToday,
        forecastDate: today,
        consensusToday: { high: consensusToday.high, low: consensusToday.low },
        kalshiToday: kalshiToday,
        signalToday: buildSignal(consensusToday, kalshiToday),
        sourceCountToday: consensusToday.sourceCount,
        modelSpreadToday: consensusToday.spread,
        // Tomorrow
        forecastsTomorrow: forecastsTomorrow,
        forecastDateTomorrow: tomorrow,
        consensusTomorrow: { high: consensusTomorrow.high, low: consensusTomorrow.low },
        kalshiTomorrow: kalshiTomorrow,
        signalTomorrow: buildSignal(consensusTomorrow, kalshiTomorrow),
        sourceCountTomorrow: consensusTomorrow.sourceCount,
        modelSpreadTomorrow: consensusTomorrow.spread,
      };
    }));

    res.status(200).json({ cities: results, today: today, tomorrow: tomorrow, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Overview error:', err);
    res.status(500).json({ error: 'Failed to fetch data', detail: err.message });
  }
}