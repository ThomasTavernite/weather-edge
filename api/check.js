// ═══════════════════════════════════════════════════════════
//  WeatherBid — api/check.js
//  Runs daily via Vercel Cron at 11 AM ET (after NWS reports)
//  Pulls the actual high temp from NWS observations
//  Compares to yesterday's snapshot and scores accuracy
// ═══════════════════════════════════════════════════════════

import { kv } from '@vercel/kv';

export const config = {
  maxDuration: 60
};

// NWS station IDs — these are the EXACT stations Kalshi settles against
var STATIONS = {
  nyc: 'KNYC', chi: 'KMDW', mia: 'KMIA', lax: 'KLAX',
  sfo: 'KSFO', phi: 'KPHL', aus: 'KAUS', den: 'KDEN',
  sea: 'KSEA', lv: 'KLAS', bos: 'KBOS', nola: 'KMSY', dc: 'KDCA'
};

async function safeFetch(url) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 8000);
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

// Get yesterday's actual high from NWS observations
async function getActualHigh(stationId, targetDate) {
  // Fetch recent observations and find the max temp for the target date
  var url = 'https://api.weather.gov/stations/' + stationId + '/observations?start=' + targetDate + 'T00:00:00-05:00&end=' + targetDate + 'T23:59:59-05:00&limit=100';
  var data = await safeFetch(url);
  if (!data || !data.features || !data.features.length) return null;

  var maxTemp = -999;
  for (var i = 0; i < data.features.length; i++) {
    var obs = data.features[i];
    var tempC = obs.properties && obs.properties.temperature && obs.properties.temperature.value;
    if (tempC !== null && tempC !== undefined) {
      var tempF = Math.round((tempC * 9 / 5 + 32) * 10) / 10;
      if (tempF > maxTemp) maxTemp = tempF;
    }
  }

  return maxTemp > -999 ? maxTemp : null;
}

// Determine if a temp falls within a bracket string like "56° to 57°" or "53° or below"
function tempInBracket(temp, bracket) {
  if (!bracket) return false;
  var s = bracket.toLowerCase();
  var range = s.match(/(\d+)°?\s*to\s*(\d+)/);
  var below = s.match(/(\d+)°?\s*or\s*below/);
  var above = s.match(/(\d+)°?\s*or\s*above/);

  if (range) {
    var lo = parseInt(range[1]);
    var hi = parseInt(range[2]);
    return temp >= lo && temp <= hi + 0.9;
  }
  if (below) return temp <= parseInt(below[1]);
  if (above) return temp >= parseInt(above[1]);
  return false;
}

// Figure out which bracket a temp falls in given a bracket string format
function findBracketForTemp(temp, brackets) {
  for (var i = 0; i < brackets.length; i++) {
    if (tempInBracket(temp, brackets[i])) return brackets[i];
  }
  return null;
}

export default async function handler(req, res) {
  var cronHeader = req.headers['x-vercel-cron'];
  var manualKey = req.query.key;

  if (!cronHeader && manualKey !== 'check2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Get yesterday's date
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    var yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Allow checking a specific date via query param
    var checkDate = req.query.date || yesterdayStr;

    // Load the snapshot for that date
    var snapshotData = await kv.get('snapshot:' + checkDate);
    if (!snapshotData) {
      return res.status(404).json({ error: 'No snapshot found for ' + checkDate });
    }

    var snapshots = typeof snapshotData === 'string' ? JSON.parse(snapshotData) : snapshotData;
    var results = [];
    var totalChecked = 0;
    var forecastCorrect = 0;
    var marketCorrect = 0;

    for (var i = 0; i < snapshots.length; i++) {
      var snap = snapshots[i];
      var station = STATIONS[snap.cityId];
      if (!station || !snap.forecastHigh || !snap.marketFavorite) {
        results.push(snap);
        continue;
      }

      // Get actual high temp from NWS
      var actualHigh = await getActualHigh(station, snap.targetDate);
      if (actualHigh === null) {
        snap.result = 'no_data';
        results.push(snap);
        continue;
      }

      snap.actualHigh = actualHigh;

      // Did actual temp fall in forecast's predicted bracket?
      // Forecast consensus is a number — find which bracket it pointed to
      // We check: was the actual temp closer to our forecast or to the market favorite?
      var forecastDiff = Math.abs(actualHigh - snap.forecastHigh);

      // Check if actual fell in the market favorite bracket
      var marketWasRight = tempInBracket(actualHigh, snap.marketFavorite);

      // Check if forecast was within 2°F (our consensus bracket would be right)
      var forecastWasClose = forecastDiff <= 2;

      if (forecastWasClose && marketWasRight) {
        snap.result = 'both_correct';
        forecastCorrect++;
        marketCorrect++;
      } else if (forecastWasClose && !marketWasRight) {
        snap.result = 'forecast_wins';
        forecastCorrect++;
      } else if (!forecastWasClose && marketWasRight) {
        snap.result = 'market_wins';
        marketCorrect++;
      } else {
        snap.result = 'both_wrong';
      }

      snap.forecastDiff = Math.round(forecastDiff * 10) / 10;
      totalChecked++;
      results.push(snap);

      await new Promise(function(r) { setTimeout(r, 300); });
    }

    // Save updated snapshot with results
    await kv.set('snapshot:' + checkDate, JSON.stringify(results));

    // Update running accuracy stats
    var statsData = await kv.get('accuracy_stats');
    var stats = statsData ? (typeof statsData === 'string' ? JSON.parse(statsData) : statsData) : {
      totalChecked: 0,
      forecastCorrect: 0,
      marketCorrect: 0,
      daysTracked: 0,
      avgForecastDiff: 0,
      totalForecastDiff: 0
    };

    stats.totalChecked += totalChecked;
    stats.forecastCorrect += forecastCorrect;
    stats.marketCorrect += marketCorrect;
    stats.daysTracked += 1;

    var dayDiffSum = 0;
    var dayDiffCount = 0;
    for (var j = 0; j < results.length; j++) {
      if (results[j].forecastDiff !== undefined) {
        dayDiffSum += results[j].forecastDiff;
        dayDiffCount++;
      }
    }
    if (dayDiffCount > 0) {
      stats.totalForecastDiff += dayDiffSum;
      stats.avgForecastDiff = Math.round(stats.totalForecastDiff / stats.totalChecked * 10) / 10;
    }

    await kv.set('accuracy_stats', JSON.stringify(stats));

    res.status(200).json({
      success: true,
      date: checkDate,
      totalChecked: totalChecked,
      forecastCorrect: forecastCorrect,
      marketCorrect: marketCorrect,
      stats: stats,
      results: results
    });

  } catch (err) {
    console.error('Check error:', err);
    res.status(500).json({ error: 'Check failed', detail: err.message });
  }
}