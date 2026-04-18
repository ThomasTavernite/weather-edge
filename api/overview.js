// ═══════════════════════════════════════════════════════════
//  WeatherQuant — api/overview.js (v3)
//  Ensemble probabilistic forecasting + EV-based signals
// ═══════════════════════════════════════════════════════════

import { kv } from '@vercel/kv';

export const config = { maxDuration: 60 };

var CITIES = [
  { id:'nyc',  name:'New York City',  lat:40.7128, lon:-74.0060,  nws:'KNYC', kalshi:'KXHIGHNY',    tz:'America/New_York' },
  { id:'chi',  name:'Chicago',        lat:41.7868, lon:-87.7522,  nws:'KMDW', kalshi:'KXHIGHCHI',   tz:'America/Chicago' },
  { id:'mia',  name:'Miami',          lat:25.7959, lon:-80.2870,  nws:'KMIA', kalshi:'KXHIGHMIA',   tz:'America/New_York' },
  { id:'lax',  name:'Los Angeles',    lat:33.9382, lon:-118.3886, nws:'KLAX', kalshi:'KXHIGHLAX',   tz:'America/Los_Angeles' },
  { id:'sfo',  name:'San Francisco',  lat:37.6213, lon:-122.3790, nws:'KSFO', kalshi:'KXHIGHTSFO',  tz:'America/Los_Angeles' },
  { id:'phi',  name:'Philadelphia',   lat:39.8744, lon:-75.2424,  nws:'KPHL', kalshi:'KXHIGHPHIL',  tz:'America/New_York' },
  { id:'aus',  name:'Austin',         lat:30.1944, lon:-97.6700,  nws:'KAUS', kalshi:'KXHIGHAUS',   tz:'America/Chicago' },
  { id:'den',  name:'Denver',         lat:39.8561, lon:-104.6737, nws:'KDEN', kalshi:'KXHIGHDEN',   tz:'America/Denver' },
  { id:'sea',  name:'Seattle',        lat:47.4502, lon:-122.3088, nws:'KSEA', kalshi:'KXHIGHTSEA',  tz:'America/Los_Angeles' },
  { id:'lv',   name:'Las Vegas',      lat:36.0840, lon:-115.1537, nws:'KLAS', kalshi:'KXHIGHTLV',   tz:'America/Los_Angeles' },
  { id:'bos',  name:'Boston',         lat:42.3656, lon:-71.0096,  nws:'KBOS', kalshi:'KXHIGHTBOS',  tz:'America/New_York' },
  { id:'nola', name:'New Orleans',    lat:29.9934, lon:-90.2580,  nws:'KMSY', kalshi:'KXHIGHTNOLA', tz:'America/Chicago' },
  { id:'dc',   name:'Washington DC',  lat:38.8512, lon:-77.0402,  nws:'KDCA', kalshi:'KXHIGHTDC',   tz:'America/New_York' },
];

// 4 independent ensemble systems ≈ 143 members total
var ENSEMBLE_MODELS = 'gfs_seamless,ecmwf_ifs025,icon_seamless,gem_global';

// ─── Utilities ───────────────────────────────────────────
function getTodayStr() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
function getTomorrowStr() { var d=new Date(); d.setDate(d.getDate()+1); return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
function getLocalHour(tz) { return parseInt(new Date().toLocaleString('en-US', { hour:'numeric', hour12:false, timeZone:tz })); }

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

// ─── Ensemble forecast ──────────────────────────────────
// Pulls ~143 members in ONE call, returns daily high per member for today + tomorrow
async function getEnsembleForecast(city) {
  var url = 'https://ensemble-api.open-meteo.com/v1/ensemble?latitude=' + city.lat
    + '&longitude=' + city.lon
    + '&hourly=temperature_2m'
    + '&models=' + ENSEMBLE_MODELS
    + '&temperature_unit=fahrenheit&timezone=auto&forecast_days=3';

  var data = await safeFetch(url, 14000);
  if (!data || !data.hourly || !data.hourly.time) return null;

  var hourly = data.hourly;
  var times = hourly.time;

  // Grab every member series (key starts with "temperature_2m_member")
  var memberKeys = [];
  for (var k in hourly) {
    if (k.indexOf('temperature_2m_member') === 0) memberKeys.push(k);
  }
  // Include the control run if present
  if (hourly.temperature_2m && Array.isArray(hourly.temperature_2m)) memberKeys.push('temperature_2m');

  if (memberKeys.length === 0) return null;

  var today = getTodayStr();
  var tomorrow = getTomorrowStr();
  var todayHighs = [];
  var tomorrowHighs = [];

  for (var m = 0; m < memberKeys.length; m++) {
    var series = hourly[memberKeys[m]];
    if (!Array.isArray(series)) continue;
    var tMax = null, tmMax = null;
    for (var h = 0; h < times.length; h++) {
      var day = String(times[h]).substring(0, 10);
      var v = series[h];
      if (v === null || v === undefined || isNaN(v)) continue;
      if (day === today) { if (tMax === null || v > tMax) tMax = v; }
      else if (day === tomorrow) { if (tmMax === null || v > tmMax) tmMax = v; }
    }
    if (tMax !== null) todayHighs.push(tMax);
    if (tmMax !== null) tomorrowHighs.push(tmMax);
  }

  return { today: todayHighs, tomorrow: tomorrowHighs, totalMembers: memberKeys.length };
}

// Pull bias correction from KV — rolling mean (predicted - actual) per city
async function getBias(cityId) {
  try {
    var b = await kv.get('bias:' + cityId);
    if (!b) return null;
    var obj = typeof b === 'string' ? JSON.parse(b) : b;
    // Require at least 3 data points before applying
    if (!obj || typeof obj.meanError !== 'number' || (obj.count || 0) < 3) return null;
    return obj.meanError;
  } catch(e) { return null; }
}

// Apply bias correction: subtract rolling mean error from every member
function applyBias(members, meanError) {
  if (!meanError || !members.length) return members;
  return members.map(function(m) { return m - meanError; });
}

// Post-noon observation override: day's high can't be less than what's already observed
function applyObsOverride(members, currentObs, localHour) {
  if (!members.length || currentObs === null || localHour < 13) return members;
  return members.map(function(m) { return m < currentObs ? currentObs : m; });
}

// ─── Ensemble stats + bracket probabilities ──────────────
function summarize(members) {
  if (!members || !members.length) return { mean:null, std:null, min:null, max:null, count:0, p10:null, p90:null };
  var n = members.length;
  var sum = 0; for (var i=0;i<n;i++) sum += members[i];
  var mean = sum/n;
  var sqSum = 0; for (var j=0;j<n;j++) sqSum += (members[j]-mean)*(members[j]-mean);
  var std = Math.sqrt(sqSum/n);
  var sorted = members.slice().sort(function(a,b){ return a-b; });
  return {
    mean: Math.round(mean*10)/10,
    std: Math.round(std*10)/10,
    min: Math.round(sorted[0]*10)/10,
    max: Math.round(sorted[n-1]*10)/10,
    p10: Math.round(sorted[Math.floor(n*0.1)]*10)/10,
    p90: Math.round(sorted[Math.floor(n*0.9)]*10)/10,
    count: n
  };
}

function tempInBracket(temp, bracket) {
  if (!bracket || temp === null) return false;
  var s = String(bracket).toLowerCase();
  var range = s.match(/(\d+)°?\s*to\s*(\d+)/);
  var below = s.match(/(\d+)°?\s*or\s*below/);
  var above = s.match(/(\d+)°?\s*or\s*above/);
  if (range) return temp >= parseInt(range[1]) && temp <= parseInt(range[2]) + 0.9;
  if (below) return temp <= parseInt(below[1]) + 0.9;
  if (above) return temp >= parseInt(above[1]);
  return false;
}

function getMarketPrice(m) {
  var last = parseFloat(m.lastPrice) || 0;
  var ask = parseFloat(m.yesAsk) || 0;
  return Math.max(last, ask);
}

function computeBracketProbs(members, markets) {
  if (!members || !members.length || !markets || !markets.length) return [];
  var n = members.length;
  return markets.map(function(m) {
    var hits = 0;
    for (var i=0;i<n;i++) if (tempInBracket(members[i], m.subtitle)) hits++;
    var prob = hits / n;
    var price = getMarketPrice(m);
    var ev = price > 0.01 ? (prob / price - 1) : 0;
    return {
      ticker: m.ticker,
      bracket: m.subtitle,
      probability: Math.round(prob * 1000) / 1000,
      marketPrice: price,
      marketImplied: Math.round(price * 1000) / 1000,
      ev: Math.round(ev * 100) / 100,
      volume: parseInt(m.volume) || 0,
      memberHits: hits
    };
  });
}

// ─── Signal logic — EV-based, not gate-based ─────────────
function buildSignal(bracketProbs, summary, totalVolume) {
  if (!bracketProbs || !bracketProbs.length) return null;

  var byEV = bracketProbs.slice().sort(function(a,b){ return b.ev - a.ev; });
  var byProb = bracketProbs.slice().sort(function(a,b){ return b.probability - a.probability; });
  var byPrice = bracketProbs.slice().sort(function(a,b){ return b.marketPrice - a.marketPrice; });

  var best = byEV[0];
  var mostLikely = byProb[0];
  var marketFav = byPrice[0];

  var MIN_VOLUME = 50;
  var MIN_MEMBERS = 30;
  var OPP_EV = 0.15;
  var MIN_PROB = 0.08;

  var type;
  if (summary.count < MIN_MEMBERS) type = 'LOW_DATA';
  else if (totalVolume < MIN_VOLUME) type = 'LOW_VOLUME';
  else if (best.ev >= OPP_EV && best.probability >= MIN_PROB) type = 'OPPORTUNITY';
  else if (best.ev > 0.05) type = 'WATCH';
  else if (mostLikely.ticker === marketFav.ticker) type = 'ALIGNED';
  else type = 'NO_EDGE';

  // Confidence from ensemble spread
  var confidence = 'LOW';
  if (summary.std !== null) {
    if (summary.std <= 1.2) confidence = 'HIGH';
    else if (summary.std <= 2.2) confidence = 'MODERATE';
  }
  // Downgrade confidence if uncertainty band straddles multiple brackets heavily
  if (summary.p90 !== null && summary.p10 !== null && (summary.p90 - summary.p10) > 6) confidence = 'LOW';

  return {
    type: type,
    confidence: confidence,
    bestBracket: best.bracket,
    bestProbability: best.probability,
    bestMarketPrice: best.marketPrice,
    bestEV: best.ev,
    mostLikelyBracket: mostLikely.bracket,
    mostLikelyProbability: mostLikely.probability,
    marketFavorite: marketFav.bracket,
    marketFavoritePrice: marketFav.marketPrice,
    ensembleMean: summary.mean,
    ensembleStd: summary.std,
    ensembleP10: summary.p10,
    ensembleP90: summary.p90,
    memberCount: summary.count,
    totalVolume: totalVolume
  };
}

// ─── NWS obs ─────────────────────────────────────────────
async function getNWSObs(city) {
  var data = await safeFetch('https://api.weather.gov/stations/' + city.nws + '/observations/latest');
  if (!data || !data.properties) return null;
  var c = data.properties.temperature ? data.properties.temperature.value : null;
  if (c === null || c === undefined) return null;
  return { tempF: Math.round((c * 9/5 + 32) * 10)/10, desc: data.properties.textDescription || '' };
}

// ─── Kalshi ──────────────────────────────────────────────
function parseKalshiEvent(ev, today, tomorrow) {
  if (!ev.markets || !ev.markets.length) return null;
  var tm = ev.event_ticker ? ev.event_ticker.match(/(\d{2})([A-Z]{3})(\d{2})$/) : null;
  var marketDate = '';
  if (tm) {
    var mo = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
    marketDate = '20' + tm[1] + '-' + (mo[tm[2]]||'01') + '-' + tm[3];
  }
  if (marketDate !== today && marketDate !== tomorrow) return null;

  var markets = ev.markets.map(function(m){
    return {
      ticker: m.ticker,
      subtitle: m.yes_sub_title || m.subtitle || '',
      yesAsk: m.yes_ask_dollars || m.yes_ask,
      lastPrice: m.last_price_dollars || m.last_price,
      volume: m.volume_fp || m.volume || 0
    };
  }).filter(function(m){ return m.subtitle; });

  return { eventTicker: ev.event_ticker, title: ev.title || '', subtitle: ev.sub_title || '', markets: markets, marketDate: marketDate };
}

// ─── Main handler ────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=120, stale-while-revalidate=300');

  try {
    var today = getTodayStr();
    var tomorrow = getTomorrowStr();

    // Step 1: Kalshi sequential (rate-limit safe)
    var kTodayMap = {}, kTomorrowMap = {};
    for (var i=0;i<CITIES.length;i++) {
      var c = CITIES[i];
      var u = 'https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=' + c.kalshi + '&status=open&with_nested_markets=true&limit=5';
      var d = await safeFetch(u);
      if (d && d.events && d.events.length) {
        for (var e=0;e<d.events.length;e++) {
          var p = parseKalshiEvent(d.events[e], today, tomorrow);
          if (p && p.marketDate === today) kTodayMap[c.id] = p;
          if (p && p.marketDate === tomorrow) kTomorrowMap[c.id] = p;
        }
      }
      if (!kTodayMap[c.id]) kTodayMap[c.id] = null;
      if (!kTomorrowMap[c.id]) kTomorrowMap[c.id] = null;
      await new Promise(function(r){ setTimeout(r, 200); });
    }

    // Step 2: Ensembles + obs in parallel
    var results = await Promise.all(CITIES.map(async function(city) {
      var ens = await getEnsembleForecast(city);
      var obs = null;
      try { obs = await getNWSObs(city); } catch(_) {}
      var bias = await getBias(city.id);
      var localHour = getLocalHour(city.tz);

      var todayMembers = ens ? ens.today.slice() : [];
      var tomorrowMembers = ens ? ens.tomorrow.slice() : [];

      // Apply bias correction
      if (bias !== null) {
        todayMembers = applyBias(todayMembers, bias);
        tomorrowMembers = applyBias(tomorrowMembers, bias);
      }

      // Apply obs override (today only, after ~1 PM local)
      if (obs && obs.tempF !== null) {
        todayMembers = applyObsOverride(todayMembers, obs.tempF, localHour);
      }

      var sumToday = summarize(todayMembers);
      var sumTom = summarize(tomorrowMembers);

      var kToday = kTodayMap[city.id];
      var kTom = kTomorrowMap[city.id];

      var probsToday = kToday ? computeBracketProbs(todayMembers, kToday.markets) : [];
      var probsTom = kTom ? computeBracketProbs(tomorrowMembers, kTom.markets) : [];

      var totalVolToday = probsToday.reduce(function(a,b){ return a + b.volume; }, 0);
      var totalVolTom = probsTom.reduce(function(a,b){ return a + b.volume; }, 0);

      var sigToday = kToday ? buildSignal(probsToday, sumToday, totalVolToday) : null;
      var sigTom = kTom ? buildSignal(probsTom, sumTom, totalVolTom) : null;

      return {
        id: city.id, name: city.name,
        currentTemp: obs ? obs.tempF : null,
        currentDesc: obs ? obs.desc : '',
        localHour: localHour,
        biasApplied: bias,
        forecastDate: today,
        forecastDateTomorrow: tomorrow,
        ensembleToday: sumToday,
        ensembleTomorrow: sumTom,
        bracketProbsToday: probsToday,
        bracketProbsTomorrow: probsTom,
        kalshiToday: kToday,
        kalshiTomorrow: kTom,
        signalToday: sigToday,
        signalTomorrow: sigTom,
      };
    }));

    res.status(200).json({
      cities: results,
      today: today,
      tomorrow: tomorrow,
      ensembleModels: ENSEMBLE_MODELS.split(','),
      updatedAt: new Date().toISOString()
    });
  } catch(err) {
    console.error('Overview error:', err);
    res.status(500).json({ error: 'Failed to fetch data', detail: err.message });
  }
}