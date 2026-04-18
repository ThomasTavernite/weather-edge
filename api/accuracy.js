// ═══════════════════════════════════════════════════════════
//  WeatherQuant — api/accuracy.js (v3)
//  Returns hit rate + Brier calibration + opportunity win rate
// ═══════════════════════════════════════════════════════════

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate=600');

  try {
    var statsData = await kv.get('accuracy_stats');
    var stats = statsData ? (typeof statsData === 'string' ? JSON.parse(statsData) : statsData) : null;

    var dateListData = await kv.get('snapshot_dates');
    var dates = dateListData ? (typeof dateListData === 'string' ? JSON.parse(dateListData) : dateListData) : [];

    var recentDays = [];
    var recent = dates.slice(-7);
    for (var i = recent.length - 1; i >= 0; i--) {
      var snapData = await kv.get('snapshot:' + recent[i]);
      if (!snapData) continue;
      var snaps = typeof snapData === 'string' ? JSON.parse(snapData) : snapData;
      var checked = snaps.filter(function(s){ return s.result && s.result !== 'no_data' && s.result !== 'not_settled'; });
      var wins = checked.filter(function(s){ return s.result === 'forecast_wins' || s.result === 'both_correct'; });
      var brierVals = checked.filter(function(s){ return s.brierScore !== null && s.brierScore !== undefined }).map(function(s){ return s.brierScore; });
      var avgBrier = brierVals.length ? brierVals.reduce(function(a,b){ return a+b; }, 0) / brierVals.length : null;

      recentDays.push({
        date: recent[i],
        total: checked.length,
        forecastWins: wins.length,
        accuracy: checked.length > 0 ? Math.round(wins.length / checked.length * 100) : null,
        avgBrier: avgBrier !== null ? Math.round(avgBrier * 1000) / 1000 : null,
        cities: snaps.map(function(s){
          return {
            city: s.cityName,
            forecastHigh: s.ensembleMean !== undefined ? s.ensembleMean : s.forecastHigh,
            ensembleStd: s.ensembleStd,
            settledTemp: s.settledTemp,
            winningBracket: s.winningBracket,
            topProbBracket: s.topProbBracket,
            topProbability: s.topProbability,
            marketFavorite: s.marketFavorite,
            result: s.result,
            brierScore: s.brierScore,
            diff: s.forecastDiff
          };
        })
      });
    }

    var overallAccuracy = null, avgBrier = null, oppRate = null;
    if (stats && stats.totalChecked > 0) {
      overallAccuracy = Math.round(stats.forecastCorrect / stats.totalChecked * 100);
    }
    if (stats && stats.brierCount > 0) {
      avgBrier = Math.round(stats.brierSum / stats.brierCount * 1000) / 1000;
    }
    if (stats && stats.opportunityTotal > 0) {
      oppRate = Math.round(stats.opportunityCorrect / stats.opportunityTotal * 100);
    }

    res.status(200).json({
      hasData: stats !== null && stats.totalChecked > 0,
      stats: stats ? {
        totalPredictions: stats.totalChecked,
        forecastCorrect: stats.forecastCorrect,
        marketCorrect: stats.marketCorrect,
        overallAccuracy: overallAccuracy,
        avgForecastDiff: stats.avgForecastDiff,
        daysTracked: stats.daysTracked,
        avgBrier: avgBrier,
        opportunityTotal: stats.opportunityTotal || 0,
        opportunityCorrect: stats.opportunityCorrect || 0,
        opportunityHitRate: oppRate
      } : null,
      recentDays: recentDays,
      totalDaysRecorded: dates.length
    });
  } catch(err) {
    console.error('Accuracy error:', err);
    res.status(200).json({ hasData: false, stats: null, recentDays: [], totalDaysRecorded: 0 });
  }
}