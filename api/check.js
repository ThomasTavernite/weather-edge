// ═══════════════════════════════════════════════════════════
//  WeatherQuant — api/check.js (v3)
//  - Scores vs Kalshi settlement (source of truth)
//  - Computes Brier score per city per day
//  - Updates rolling per-city bias correction for future snapshots
// ═══════════════════════════════════════════════════════════

import { kv } from '@vercel/kv';

export const config = { maxDuration: 60 };

async function safeFetch(url) {
  var ctrl = new AbortController();
  var t = setTimeout(function(){ ctrl.abort(); }, 8000);
  try {
    var r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent':'WeatherQuant/3.0', 'Accept':'application/json' } });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch(e) { clearTimeout(t); return null; }
}

async function getKalshiSettlement(eventTicker) {
  if (!eventTicker) return null;
  var url = 'https://api.elections.kalshi.com/trade-api/v2/events/' + eventTicker + '?with_nested_markets=true';
  var data = await safeFetch(url);
  if (!data || !data.event || !data.event.markets) {
    url = 'https://api.elections.kalshi.com/trade-api/v2/events?event_ticker=' + eventTicker + '&with_nested_markets=true&limit=1';
    data = await safeFetch(url);
    if (!data || !data.events || !data.events.length) return null;
    data = { event: data.events[0] };
  }

  var markets = data.event.markets;
  if (!markets || !markets.length) return null;

  var winner = null, winnerTicker = null;
  for (var i=0;i<markets.length;i++) {
    if (markets[i].result === 'yes') { winner = markets[i]; winnerTicker = markets[i].ticker; break; }
  }
  if (!winner) return null;

  var bracket = winner.yes_sub_title || winner.subtitle || '';
  var settledTemp = null;
  var s = bracket.toLowerCase();
  var range = s.match(/(\d+)°?\s*to\s*(\d+)/);
  var below = s.match(/(\d+)°?\s*or\s*below/);
  var above = s.match(/(\d+)°?\s*or\s*above/);
  if (range) settledTemp = (parseInt(range[1]) + parseInt(range[2])) / 2;
  else if (below) settledTemp = parseInt(below[1]);
  else if (above) settledTemp = parseInt(above[1]);

  return { winningBracket: bracket, winningTicker: winnerTicker, settledTemp: settledTemp };
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

// Brier score: sum over all brackets of (predicted_prob - actual_outcome)^2
// actual_outcome is 1 for the winning bracket, 0 for all others
// Range: 0 (perfect) to ~2 (worst). Random = ~0.83 over 6 brackets.
function computeBrier(bracketProbs, winningTicker) {
  if (!bracketProbs || !bracketProbs.length || !winningTicker) return null;
  var total = 0;
  for (var i=0; i<bracketProbs.length; i++) {
    var bp = bracketProbs[i];
    var outcome = bp.ticker === winningTicker ? 1 : 0;
    var diff = bp.probability - outcome;
    total += diff * diff;
  }
  return Math.round(total * 1000) / 1000;
}

// Update rolling per-city bias. bias = predicted_mean - actual_settled_temp
// We keep EWMA with alpha=0.15 (recent days weighted higher)
async function updateBias(cityId, predictedMean, actualTemp) {
  if (predictedMean === null || actualTemp === null) return;
  var err = predictedMean - actualTemp;
  try {
    var existing = await kv.get('bias:' + cityId);
    var obj = existing ? (typeof existing === 'string' ? JSON.parse(existing) : existing) : { meanError:0, count:0, lastError:null };
    var alpha = 0.15;
    if (obj.count === 0) obj.meanError = err;
    else obj.meanError = alpha * err + (1 - alpha) * obj.meanError;
    obj.count = (obj.count || 0) + 1;
    obj.lastError = err;
    obj.updatedAt = new Date().toISOString();
    obj.meanError = Math.round(obj.meanError * 1000) / 1000;
    await kv.set('bias:' + cityId, obj);
  } catch(e) { /* ignore */ }
}

export default async function handler(req, res) {
  var cronHeader = req.headers['x-vercel-cron'];
  if (!cronHeader && req.query.key !== 'check2026') return res.status(401).json({ error:'Unauthorized' });

  try {
    var yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    var yStr = yesterday.toLocaleDateString('en-CA', { timeZone:'America/New_York' });
    var checkDate = req.query.date || yStr;

    var snapData = await kv.get('snapshot:' + checkDate);
    if (!snapData) return res.status(404).json({ error: 'No snapshot for ' + checkDate });

    var snapshots = typeof snapData === 'string' ? JSON.parse(snapData) : snapData;
    var results = [];

    // Running totals for this day
    var totalChecked = 0;
    var forecastCorrect = 0;     // our top-prob bracket = winning bracket
    var marketCorrect = 0;       // market favorite = winning bracket
    var brierSum = 0, brierCount = 0;
    var opportunityCorrect = 0, opportunityTotal = 0;
    var dayDiffSum = 0, dayDiffCount = 0;

    for (var i=0; i<snapshots.length; i++) {
      var snap = snapshots[i];
      if (!snap.eventTicker) { results.push(snap); continue; }

      var settlement = await getKalshiSettlement(snap.eventTicker);
      if (!settlement) { snap.result = 'not_settled'; results.push(snap); continue; }

      snap.winningBracket = settlement.winningBracket;
      snap.winningTicker = settlement.winningTicker;
      snap.settledTemp = settlement.settledTemp;

      // Forecast "hit" = our top-probability bracket matched the winner
      var ourPickHit = snap.topProbBracket === settlement.winningBracket;
      // Market "hit" = market favorite matched the winner
      var marketHit = snap.marketFavorite === settlement.winningBracket;

      // Brier score from full bracket probability distribution
      var brier = computeBrier(snap.bracketProbs || [], settlement.winningTicker);
      snap.brierScore = brier;

      // Diff between our ensemble mean and the settled midpoint
      if (settlement.settledTemp !== null && snap.ensembleMean !== null && snap.ensembleMean !== undefined) {
        snap.forecastDiff = Math.round(Math.abs(snap.ensembleMean - settlement.settledTemp) * 10) / 10;
        dayDiffSum += snap.forecastDiff;
        dayDiffCount++;
        // Update rolling bias
        await updateBias(snap.cityId, snap.ensembleMean, settlement.settledTemp);
      }

      // Result categorization
      if (ourPickHit && marketHit) snap.result = 'both_correct';
      else if (ourPickHit && !marketHit) snap.result = 'forecast_wins';
      else if (!ourPickHit && marketHit) snap.result = 'market_wins';
      else snap.result = 'both_wrong';

      if (ourPickHit) forecastCorrect++;
      if (marketHit) marketCorrect++;
      if (brier !== null) { brierSum += brier; brierCount++; }

      // Track OPPORTUNITY signal accuracy: did the bracket we flagged as best EV win?
      if (snap.bracketProbs && snap.bracketProbs.length) {
        var bestEvBracket = snap.bracketProbs.slice().sort(function(a,b){
          var ae = a.marketPrice > 0.01 ? (a.probability/a.marketPrice - 1) : -999;
          var be = b.marketPrice > 0.01 ? (b.probability/b.marketPrice - 1) : -999;
          return be - ae;
        })[0];
        if (bestEvBracket && bestEvBracket.marketPrice > 0.01) {
          var bestEv = bestEvBracket.probability / bestEvBracket.marketPrice - 1;
          if (bestEv >= 0.15 && bestEvBracket.probability >= 0.08) {
            opportunityTotal++;
            if (bestEvBracket.bracket === settlement.winningBracket) opportunityCorrect++;
          }
        }
      }

      totalChecked++;
      results.push(snap);
      await new Promise(function(r){ setTimeout(r, 250); });
    }

    await kv.set('snapshot:' + checkDate, results);

    // Roll up stats
    var statsData = await kv.get('accuracy_stats');
    var stats = statsData ? (typeof statsData === 'string' ? JSON.parse(statsData) : statsData) : {
      totalChecked:0, forecastCorrect:0, marketCorrect:0, daysTracked:0,
      avgForecastDiff:0, totalForecastDiff:0,
      brierSum:0, brierCount:0,
      opportunityCorrect:0, opportunityTotal:0
    };

    stats.totalChecked = (stats.totalChecked||0) + totalChecked;
    stats.forecastCorrect = (stats.forecastCorrect||0) + forecastCorrect;
    stats.marketCorrect = (stats.marketCorrect||0) + marketCorrect;
    stats.daysTracked = (stats.daysTracked||0) + 1;
    stats.brierSum = (stats.brierSum||0) + brierSum;
    stats.brierCount = (stats.brierCount||0) + brierCount;
    stats.opportunityCorrect = (stats.opportunityCorrect||0) + opportunityCorrect;
    stats.opportunityTotal = (stats.opportunityTotal||0) + opportunityTotal;

    if (dayDiffCount > 0) {
      stats.totalForecastDiff = (stats.totalForecastDiff||0) + dayDiffSum;
      stats.avgForecastDiff = Math.round(stats.totalForecastDiff / stats.totalChecked * 10) / 10;
    }

    await kv.set('accuracy_stats', stats);

    res.status(200).json({
      success: true, date: checkDate,
      totalChecked: totalChecked,
      forecastCorrect: forecastCorrect,
      marketCorrect: marketCorrect,
      avgBrier: brierCount > 0 ? Math.round((brierSum/brierCount) * 1000) / 1000 : null,
      opportunityHitRate: opportunityTotal > 0 ? Math.round(opportunityCorrect/opportunityTotal * 100) : null,
      stats: stats,
      results: results
    });
  } catch(err) {
    console.error('Check error:', err);
    res.status(500).json({ error:'Check failed', detail:err.message });
  }
}