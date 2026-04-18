// ═══════════════════════════════════════════════════════════
//  WeatherQuant — api/snapshot.js (v3)
//  Stores full ensemble distribution so check.js can score
//  calibration (Brier) and update bias corrections
// ═══════════════════════════════════════════════════════════

import { kv } from '@vercel/kv';

export const config = { maxDuration: 60 };

var CITIES = [
  { id:'nyc',  name:'New York City',  lat:40.7128, lon:-74.0060,  kalshi:'KXHIGHNY',    tz:'America/New_York' },
  { id:'chi',  name:'Chicago',        lat:41.7868, lon:-87.7522,  kalshi:'KXHIGHCHI',   tz:'America/Chicago' },
  { id:'mia',  name:'Miami',          lat:25.7959, lon:-80.2870,  kalshi:'KXHIGHMIA',   tz:'America/New_York' },
  { id:'lax',  name:'Los Angeles',    lat:33.9382, lon:-118.3886, kalshi:'KXHIGHLAX',   tz:'America/Los_Angeles' },
  { id:'sfo',  name:'San Francisco',  lat:37.6213, lon:-122.3790, kalshi:'KXHIGHTSFO',  tz:'America/Los_Angeles' },
  { id:'phi',  name:'Philadelphia',   lat:39.8744, lon:-75.2424,  kalshi:'KXHIGHPHIL',  tz:'America/New_York' },
  { id:'aus',  name:'Austin',         lat:30.1944, lon:-97.6700,  kalshi:'KXHIGHAUS',   tz:'America/Chicago' },
  { id:'den',  name:'Denver',         lat:39.8561, lon:-104.6737, kalshi:'KXHIGHDEN',   tz:'America/Denver' },
  { id:'sea',  name:'Seattle',        lat:47.4502, lon:-122.3088, kalshi:'KXHIGHTSEA',  tz:'America/Los_Angeles' },
  { id:'lv',   name:'Las Vegas',      lat:36.0840, lon:-115.1537, kalshi:'KXHIGHTLV',   tz:'America/Los_Angeles' },
  { id:'bos',  name:'Boston',         lat:42.3656, lon:-71.0096,  kalshi:'KXHIGHTBOS',  tz:'America/New_York' },
  { id:'nola', name:'New Orleans',    lat:29.9934, lon:-90.2580,  kalshi:'KXHIGHTNOLA', tz:'America/Chicago' },
  { id:'dc',   name:'Washington DC',  lat:38.8512, lon:-77.0402,  kalshi:'KXHIGHTDC',   tz:'America/New_York' },
];

var ENSEMBLE_MODELS = 'gfs_seamless,ecmwf_ifs025,icon_seamless,gem_global';

function getTodayStr() { return new Date().toLocaleDateString('en-CA', { timeZone:'America/New_York' }); }
function getTomorrowStr() { var d=new Date(); d.setDate(d.getDate()+1); return d.toLocaleDateString('en-CA', { timeZone:'America/New_York' }); }

async function safeFetch(url, timeout) {
  timeout = timeout || 6000;
  var ctrl = new AbortController();
  var t = setTimeout(function(){ ctrl.abort(); }, timeout);
  try {
    var r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent':'WeatherQuant/3.0', 'Accept':'application/json' } });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch(e) { clearTimeout(t); return null; }
}

async function getEnsembleForecast(city) {
  var url = 'https://ensemble-api.open-meteo.com/v1/ensemble?latitude=' + city.lat
    + '&longitude=' + city.lon
    + '&hourly=temperature_2m&models=' + ENSEMBLE_MODELS
    + '&temperature_unit=fahrenheit&timezone=auto&forecast_days=3';
  var data = await safeFetch(url, 14000);
  if (!data || !data.hourly || !data.hourly.time) return null;

  var hourly = data.hourly;
  var memberKeys = [];
  for (var k in hourly) if (k.indexOf('temperature_2m_member') === 0) memberKeys.push(k);
  if (hourly.temperature_2m && Array.isArray(hourly.temperature_2m)) memberKeys.push('temperature_2m');
  if (memberKeys.length === 0) return null;

  var today = getTodayStr();
  var tomorrow = getTomorrowStr();
  var todayHighs = [], tomorrowHighs = [];
  var times = hourly.time;

  for (var m=0; m<memberKeys.length; m++) {
    var series = hourly[memberKeys[m]];
    if (!Array.isArray(series)) continue;
    var tMax=null, tmMax=null;
    for (var h=0; h<times.length; h++) {
      var day = String(times[h]).substring(0,10);
      var v = series[h];
      if (v===null||v===undefined||isNaN(v)) continue;
      if (day === today) { if (tMax===null||v>tMax) tMax = v; }
      else if (day === tomorrow) { if (tmMax===null||v>tmMax) tmMax = v; }
    }
    if (tMax !== null) todayHighs.push(tMax);
    if (tmMax !== null) tomorrowHighs.push(tmMax);
  }

  return { today: todayHighs, tomorrow: tomorrowHighs, totalMembers: memberKeys.length };
}

async function getBias(cityId) {
  try {
    var b = await kv.get('bias:' + cityId);
    if (!b) return null;
    var obj = typeof b === 'string' ? JSON.parse(b) : b;
    if (!obj || typeof obj.meanError !== 'number' || (obj.count||0) < 3) return null;
    return obj.meanError;
  } catch(e) { return null; }
}

function applyBias(members, e) { if (!e || !members.length) return members; return members.map(function(m){ return m - e; }); }

function summarize(members) {
  if (!members || !members.length) return { mean:null, std:null, count:0 };
  var n = members.length, sum = 0;
  for (var i=0;i<n;i++) sum += members[i];
  var mean = sum/n, sq = 0;
  for (var j=0;j<n;j++) sq += (members[j]-mean)*(members[j]-mean);
  return { mean: Math.round(mean*10)/10, std: Math.round(Math.sqrt(sq/n)*10)/10, count: n };
}

function tempInBracket(t, b) {
  if (!b || t === null) return false;
  var s = String(b).toLowerCase();
  var r = s.match(/(\d+)°?\s*to\s*(\d+)/);
  var be = s.match(/(\d+)°?\s*or\s*below/);
  var ab = s.match(/(\d+)°?\s*or\s*above/);
  if (r) return t >= parseInt(r[1]) && t <= parseInt(r[2]) + 0.9;
  if (be) return t <= parseInt(be[1]) + 0.9;
  if (ab) return t >= parseInt(ab[1]);
  return false;
}

function computeBracketProbs(members, markets) {
  if (!members.length || !markets.length) return [];
  var n = members.length;
  return markets.map(function(m) {
    var hits = 0;
    for (var i=0;i<n;i++) if (tempInBracket(members[i], m.subtitle)) hits++;
    var price = Math.max(parseFloat(m.last_price_dollars || m.last_price) || 0, parseFloat(m.yes_ask_dollars || m.yes_ask) || 0);
    return {
      ticker: m.ticker,
      bracket: m.yes_sub_title || m.subtitle || '',
      probability: Math.round((hits/n) * 1000) / 1000,
      marketPrice: price,
      volume: parseInt(m.volume_fp || m.volume) || 0
    };
  });
}

async function getKalshi(seriesTicker) {
  var url = 'https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=' + seriesTicker + '&status=open&with_nested_markets=true&limit=5';
  var data = await safeFetch(url);
  if (!data || !data.events || !data.events.length) return null;

  var today = getTodayStr(), tomorrow = getTomorrowStr();
  var todayEv = null, tomEv = null;

  for (var e=0;e<data.events.length;e++) {
    var ev = data.events[e];
    if (!ev.markets || !ev.markets.length) continue;
    var tm = ev.event_ticker ? ev.event_ticker.match(/(\d{2})([A-Z]{3})(\d{2})$/) : null;
    var d = '';
    if (tm) {
      var mo = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
      d = '20' + tm[1] + '-' + (mo[tm[2]]||'01') + '-' + tm[3];
    }
    if (d !== today && d !== tomorrow) continue;
    var result = { marketDate: d, eventTicker: ev.event_ticker, markets: ev.markets };
    if (d === today) todayEv = result;
    if (d === tomorrow) tomEv = result;
  }
  return todayEv || tomEv || null;
}

export default async function handler(req, res) {
  var cronHeader = req.headers['x-vercel-cron'];
  if (!cronHeader && req.query.key !== 'snapshot2026') return res.status(401).json({ error:'Unauthorized' });

  try {
    var today = getTodayStr();
    var snapshots = [];

    for (var i=0; i<CITIES.length; i++) {
      var city = CITIES[i];
      var ens = await getEnsembleForecast(city);
      var kalshi = await getKalshi(city.kalshi);
      var bias = await getBias(city.id);

      var targetDate = (kalshi && kalshi.marketDate) || today;
      var rawMembers = ens ? (targetDate === today ? ens.today : ens.tomorrow) : [];
      var members = applyBias(rawMembers.slice(), bias);
      var sum = summarize(members);
      var bracketProbs = kalshi ? computeBracketProbs(members, kalshi.markets) : [];

      // Find market favorite + our top probability bracket
      var marketFav = null, marketFavPrice = 0;
      var topProb = null, topProbVal = 0;
      for (var b=0; b<bracketProbs.length; b++) {
        if (bracketProbs[b].marketPrice > marketFavPrice) {
          marketFav = bracketProbs[b].bracket;
          marketFavPrice = bracketProbs[b].marketPrice;
        }
        if (bracketProbs[b].probability > topProbVal) {
          topProb = bracketProbs[b].bracket;
          topProbVal = bracketProbs[b].probability;
        }
      }

      snapshots.push({
        cityId: city.id,
        cityName: city.name,
        targetDate: targetDate,
        // Ensemble summary
        forecastHigh: sum.mean,          // for backwards compat
        ensembleMean: sum.mean,
        ensembleStd: sum.std,
        memberCount: sum.count,
        biasApplied: bias,
        // Full bracket distribution
        bracketProbs: bracketProbs,
        // Market info
        marketFavorite: marketFav,
        marketFavoritePrice: marketFavPrice,
        topProbBracket: topProb,
        topProbability: Math.round(topProbVal * 1000) / 1000,
        eventTicker: kalshi ? kalshi.eventTicker : null,
        snapshotTime: new Date().toISOString(),
        actualHigh: null,
        result: null,
        brierScore: null
      });

      await new Promise(function(r){ setTimeout(r, 250); });
    }

    var snapDate = snapshots[0] ? snapshots[0].targetDate : today;
    await kv.set('snapshot:' + snapDate, snapshots);

    var dl = await kv.get('snapshot_dates');
    var dates = dl ? (typeof dl === 'string' ? JSON.parse(dl) : dl) : [];
    if (dates.indexOf(snapDate) === -1) {
      dates.push(snapDate);
      dates.sort();
      await kv.set('snapshot_dates', dates);
    }

    res.status(200).json({ success:true, date:snapDate, cities:snapshots.length, snapshots:snapshots });
  } catch(err) {
    console.error('Snapshot error:', err);
    res.status(500).json({ error:'Snapshot failed', detail:err.message });
  }
}