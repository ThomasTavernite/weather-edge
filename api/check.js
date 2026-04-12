// ═══════════════════════════════════════════════════════════
//  WeatherQuant — api/check.js
//  Scores accuracy by checking KALSHI'S OWN SETTLEMENT DATA
//  not NWS observations. This ensures our accuracy matches
//  exactly what traders experience.
// ═══════════════════════════════════════════════════════════

import { kv } from '@vercel/kv';

export const config = { maxDuration: 60 };

async function safeFetch(url) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 8000);
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

// Get the actual settlement result from Kalshi's own API
// Returns: { winningBracket: "56° to 57°", settledTemp: 57 } or null
async function getKalshiSettlement(eventTicker) {
  if (!eventTicker) return null;

  var url = 'https://api.elections.kalshi.com/trade-api/v2/events/' + eventTicker + '?with_nested_markets=true';
  var data = await safeFetch(url);

  if (!data || !data.event || !data.event.markets) {
    // Try alternate endpoint
    url = 'https://api.elections.kalshi.com/trade-api/v2/events?event_ticker=' + eventTicker + '&with_nested_markets=true&limit=1';
    data = await safeFetch(url);
    if (!data || !data.events || !data.events.length) return null;
    data = { event: data.events[0] };
  }

  var markets = data.event.markets;
  if (!markets || !markets.length) return null;

  // Find the bracket that won (result = "yes")
  var winner = null;
  for (var i = 0; i < markets.length; i++) {
    if (markets[i].result === 'yes') {
      winner = markets[i];
      break;
    }
  }

  if (!winner) return null; // Market hasn't settled yet

  var bracket = winner.yes_sub_title || winner.subtitle || '';
  
  // Extract the temperature from the winning bracket for diff calculation
  var settledTemp = null;
  var s = bracket.toLowerCase();
  var range = s.match(/(\d+)°?\s*to\s*(\d+)/);
  var below = s.match(/(\d+)°?\s*or\s*below/);
  var above = s.match(/(\d+)°?\s*or\s*above/);
  
  if (range) settledTemp = (parseInt(range[1]) + parseInt(range[2])) / 2;
  else if (below) settledTemp = parseInt(below[1]);
  else if (above) settledTemp = parseInt(above[1]);

  return { winningBracket: bracket, settledTemp: settledTemp };
}

// Check if a forecast temp falls within a bracket string
function tempInBracket(temp, bracket) {
  if (!bracket || temp === null) return false;
  var s = bracket.toLowerCase();
  var range = s.match(/(\d+)°?\s*to\s*(\d+)/);
  var below = s.match(/(\d+)°?\s*or\s*below/);
  var above = s.match(/(\d+)°?\s*or\s*above/);

  if (range) return temp >= parseInt(range[1]) && temp <= parseInt(range[2]) + 0.9;
  if (below) return temp <= parseInt(below[1]) + 0.9;
  if (above) return temp >= parseInt(above[1]);
  return false;
}

export default async function handler(req, res) {
  var cronHeader = req.headers['x-vercel-cron'];
  var manualKey = req.query.key;
  if (!cronHeader && manualKey !== 'check2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    var yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    var checkDate = req.query.date || yesterdayStr;

    var snapshotData = await kv.get('snapshot:' + checkDate);
    if (!snapshotData) {
      return res.status(404).json({ error: 'No snapshot found for ' + checkDate });
    }

    var snapshots = typeof snapshotData === 'string' ? JSON.parse(snapshotData) : snapshotData;
    var results = [];
    var totalChecked = 0;
    var forecastCorrect = 0;
    var marketCorrect = 0;
    var divergenceTotal = 0;
    var divergenceForecastWins = 0;

    for (var i = 0; i < snapshots.length; i++) {
      var snap = snapshots[i];

      if (!snap.forecastHigh || !snap.eventTicker) {
        results.push(snap);
        continue;
      }

      // Get Kalshi's actual settlement — THE source of truth
      var settlement = await getKalshiSettlement(snap.eventTicker);

      if (!settlement) {
        snap.result = 'not_settled';
        results.push(snap);
        continue;
      }

      snap.winningBracket = settlement.winningBracket;
      snap.settledTemp = settlement.settledTemp;

      // Did our forecast point to the winning bracket?
      var forecastInWinner = tempInBracket(snap.forecastHigh, settlement.winningBracket);

      // Did the market favorite match the winning bracket?
      var marketWasRight = snap.marketFavorite === settlement.winningBracket;

      // Calculate forecast diff from settled temp
      if (settlement.settledTemp !== null) {
        snap.forecastDiff = Math.round(Math.abs(snap.forecastHigh - settlement.settledTemp) * 10) / 10;
      }

      if (forecastInWinner && marketWasRight) {
        snap.result = 'both_correct';
        forecastCorrect++;
        marketCorrect++;
        if (snap.signalType === 'DIVERGENCE') { divergenceTotal++; divergenceForecastWins++; }
      } else if (forecastInWinner && !marketWasRight) {
        snap.result = 'forecast_wins';
        forecastCorrect++;
        if (snap.signalType === 'DIVERGENCE') { divergenceTotal++; divergenceForecastWins++; }
      } else if (!forecastInWinner && marketWasRight) {
        snap.result = 'market_wins';
        marketCorrect++;
        if (snap.signalType === 'DIVERGENCE') { divergenceTotal++; }
      } else {
        snap.result = 'both_wrong';
        if (snap.signalType === 'DIVERGENCE') { divergenceTotal++; }
      }

      totalChecked++;
      results.push(snap);

      await new Promise(function(r) { setTimeout(r, 300); });
    }

    // Save updated snapshot
    await kv.set('snapshot:' + checkDate, results);

    // Update running accuracy stats
    var statsData = await kv.get('accuracy_stats');
    var stats = statsData ? (typeof statsData === 'string' ? JSON.parse(statsData) : statsData) : {
      totalChecked: 0, forecastCorrect: 0, marketCorrect: 0,
      daysTracked: 0, avgForecastDiff: 0, totalForecastDiff: 0,
      divergenceTotal: 0, divergenceForecastWins: 0
    };

    stats.totalChecked += totalChecked;
    stats.forecastCorrect += forecastCorrect;
    stats.marketCorrect += marketCorrect;
    stats.daysTracked += 1;
    stats.divergenceTotal = (stats.divergenceTotal || 0) + divergenceTotal;
    stats.divergenceForecastWins = (stats.divergenceForecastWins || 0) + divergenceForecastWins;

    var dayDiffSum = 0, dayDiffCount = 0;
    for (var j = 0; j < results.length; j++) {
      if (results[j].forecastDiff !== undefined) {
        dayDiffSum += results[j].forecastDiff;
        dayDiffCount++;
      }
    }
    if (dayDiffCount > 0) {
      stats.totalForecastDiff = (stats.totalForecastDiff || 0) + dayDiffSum;
      stats.avgForecastDiff = Math.round(stats.totalForecastDiff / stats.totalChecked * 10) / 10;
    }

    await kv.set('accuracy_stats', stats);

    res.status(200).json({
      success: true, date: checkDate,
      totalChecked: totalChecked,
      forecastCorrect: forecastCorrect,
      marketCorrect: marketCorrect,
      stats: stats, results: results
    });

  } catch (err) {
    console.error('Check error:', err);
    res.status(500).json({ error: 'Check failed', detail: err.message });
  }
}