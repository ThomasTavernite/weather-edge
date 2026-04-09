// ═══════════════════════════════════════════════════════════
//  WeatherQuant — api/snapshot.js
//  Runs daily via Vercel Cron at 10 PM ET
//  Saves today's forecast consensus + Kalshi market favorite
//  for each city so we can check accuracy tomorrow
// ═══════════════════════════════════════════════════════════

import { kv } from '@vercel/kv';

export const config = {
  maxDuration: 60
};

const CITIES = [
  { id: 'nyc',   name: 'New York City',  lat: 40.7128,  lon: -74.0060,  kalshi: 'KXHIGHNY'   },
  { id: 'chi',   name: 'Chicago',        lat: 41.7868,  lon: -87.7522,  kalshi: 'KXHIGHCHI'  },
  { id: 'mia',   name: 'Miami',          lat: 25.7959,  lon: -80.2870,  kalshi: 'KXHIGHMIA'  },
  { id: 'lax',   name: 'Los Angeles',    lat: 33.9382,  lon: -118.3886, kalshi: 'KXHIGHLAX'  },
  { id: 'sfo',   name: 'San Francisco',  lat: 37.6213,  lon: -122.3790, kalshi: 'KXHIGHTSFO' },
  { id: 'phi',   name: 'Philadelphia',   lat: 39.8744,  lon: -75.2424,  kalshi: 'KXHIGHPHIL' },
  { id: 'aus',   name: 'Austin',         lat: 30.1944,  lon: -97.6700,  kalshi: 'KXHIGHAUS'  },
  { id: 'den',   name: 'Denver',         lat: 39.8561,  lon: -104.6737, kalshi: 'KXHIGHDEN'  },
  { id: 'sea',   name: 'Seattle',        lat: 47.4502,  lon: -122.3088, kalshi: 'KXHIGHTSEA' },
  { id: 'lv',    name: 'Las Vegas',      lat: 36.0840,  lon: -115.1537, kalshi: 'KXHIGHTLV'  },
  { id: 'bos',   name: 'Boston',         lat: 42.3656,  lon: -71.0096,  kalshi: 'KXHIGHTBOS' },
  { id: 'nola',  name: 'New Orleans',    lat: 29.9934,  lon: -90.2580,  kalshi: 'KXHIGHTNOLA'},
  { id: 'dc',    name: 'Washington DC',  lat: 38.8512,  lon: -77.0402,  kalshi: 'KXHIGHTDC'  },
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

async function getKalshi(seriesTicker) {
  var url = 'https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=' + seriesTicker + '&status=open&with_nested_markets=true&limit=5';
  var data = await safeFetch(url);
  if (!data || !data.events || !data.events.length) return null;

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

    // Find the market favorite (highest priced bracket)
    var sorted = ev.markets.slice().sort(function(a, b) {
      var pa = parseFloat(a.last_price_dollars || a.last_price) || parseFloat(a.yes_ask_dollars || a.yes_ask) || 0;
      var pb = parseFloat(b.last_price_dollars || b.last_price) || parseFloat(b.yes_ask_dollars || b.yes_ask) || 0;
      return pb - pa;
    });

    var fav = sorted[0];
    var result = {
      marketDate: marketDate,
      eventTicker: ev.event_ticker,
      marketFavorite: fav.yes_sub_title || fav.subtitle || '',
      marketFavoritePrice: parseFloat(fav.last_price_dollars || fav.last_price) || parseFloat(fav.yes_ask_dollars || fav.yes_ask) || 0
    };

    if (marketDate === today) todayEvent = result;
    if (marketDate === tomorrow) tomorrowEvent = result;
  }
  return todayEvent || tomorrowEvent || null;
}

function findConsensusBracket(consensusHigh, kalshiData) {
  // We don't have bracket list here, so just return the consensus temp
  // The check function will determine if it fell in the right bracket
  return consensusHigh;
}

export default async function handler(req, res) {
  // Simple auth to prevent random people from triggering this
  // Vercel Cron sends a special header
  var authHeader = req.headers['authorization'];
  var cronHeader = req.headers['x-vercel-cron'];
  var manualKey = req.query.key;

  // Allow: Vercel Cron, or manual trigger with ?key=snapshot2026
  if (!cronHeader && manualKey !== 'snapshot2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    var today = getTodayStr();
    var snapshots = [];

    for (var i = 0; i < CITIES.length; i++) {
      var city = CITIES[i];
      var openMeteo = await getOpenMeteo(city);
      var kalshi = await getKalshi(city.kalshi);

      var targetDate = (kalshi && kalshi.marketDate) || today;
      var forecastHigh = null;

      if (openMeteo && openMeteo[targetDate]) {
        forecastHigh = openMeteo[targetDate].high;
      }

      // Determine if this is a divergence or aligned
      var signalType = null;
      if (forecastHigh !== null && kalshi) {
        // Check if forecast falls in the market favorite bracket
        var favBracket = kalshi.marketFavorite.toLowerCase();
        var range = favBracket.match(/(\d+)°?\s*to\s*(\d+)/);
        var below = favBracket.match(/(\d+)°?\s*or\s*below/);
        var above = favBracket.match(/(\d+)°?\s*or\s*above/);
        var forecastInFav = false;
        if (range && forecastHigh >= parseInt(range[1]) && forecastHigh <= parseInt(range[2]) + 0.9) forecastInFav = true;
        if (below && forecastHigh <= parseInt(below[1])) forecastInFav = true;
        if (above && forecastHigh >= parseInt(above[1])) forecastInFav = true;
        signalType = forecastInFav ? 'ALIGNED' : 'DIVERGENCE';
      }

      var snapshot = {
        cityId: city.id,
        cityName: city.name,
        targetDate: targetDate,
        forecastHigh: forecastHigh,
        marketFavorite: kalshi ? kalshi.marketFavorite : null,
        marketFavoritePrice: kalshi ? kalshi.marketFavoritePrice : null,
        eventTicker: kalshi ? kalshi.eventTicker : null,
        signalType: signalType,
        snapshotTime: new Date().toISOString(),
        actualHigh: null,
        result: null
      };

      snapshots.push(snapshot);

      // Small delay between cities
      await new Promise(function(r) { setTimeout(r, 300); });
    }

    // Save to KV: key = "snapshot:2026-04-06"
    var snapshotDate = snapshots[0] ? snapshots[0].targetDate : today;
    await kv.set('snapshot:' + snapshotDate, snapshots);

    // Also maintain a list of all snapshot dates
    var dateList = await kv.get('snapshot_dates');
    var dates = [];
    if (dateList) {
      dates = typeof dateList === 'string' ? JSON.parse(dateList) : dateList;
    }
    if (dates.indexOf(snapshotDate) === -1) {
      dates.push(snapshotDate);
      dates.sort();
      await kv.set('snapshot_dates', dates);
    }

    res.status(200).json({
      success: true,
      date: snapshotDate,
      cities: snapshots.length,
      snapshots: snapshots
    });

  } catch (err) {
    console.error('Snapshot error:', err);
    res.status(500).json({ error: 'Snapshot failed', detail: err.message });
  }
}