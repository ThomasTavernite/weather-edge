// ═══════════════════════════════════════════════════════════
//  WeatherQuant — api/accuracy.js
//  Returns accuracy stats and recent results for the frontend
// ═══════════════════════════════════════════════════════════

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  try {
    // Get overall stats
    var statsData = await kv.get('accuracy_stats');
    var stats = statsData ? (typeof statsData === 'string' ? JSON.parse(statsData) : statsData) : null;

    // Get list of snapshot dates
    var dateListData = await kv.get('snapshot_dates');
    var dates = dateListData ? (typeof dateListData === 'string' ? JSON.parse(dateListData) : dateListData) : [];

    // Get the most recent 7 days of snapshots
    var recentDays = [];
    var recentDates = dates.slice(-7);

    for (var i = recentDates.length - 1; i >= 0; i--) {
      var snapData = await kv.get('snapshot:' + recentDates[i]);
      if (snapData) {
        var snaps = typeof snapData === 'string' ? JSON.parse(snapData) : snapData;
        // Only include checked ones (with results)
        var checked = snaps.filter(function(s) { return s.result && s.result !== 'no_data'; });
        var wins = snaps.filter(function(s) { return s.result === 'forecast_wins' || s.result === 'both_correct'; });

        recentDays.push({
          date: recentDates[i],
          total: checked.length,
          forecastWins: wins.length,
          accuracy: checked.length > 0 ? Math.round(wins.length / checked.length * 100) : null,
          cities: snaps.map(function(s) {
            return {
              city: s.cityName,
              forecastHigh: s.forecastHigh,
              actualHigh: s.actualHigh,
              marketFavorite: s.marketFavorite,
              result: s.result,
              diff: s.forecastDiff
            };
          })
        });
      }
    }

    // Calculate overall accuracy percentage
    var overallAccuracy = null;
    if (stats && stats.totalChecked > 0) {
      overallAccuracy = Math.round(stats.forecastCorrect / stats.totalChecked * 100);
    }

    res.status(200).json({
      hasData: stats !== null && stats.totalChecked > 0,
      stats: stats ? {
        totalPredictions: stats.totalChecked,
        forecastCorrect: stats.forecastCorrect,
        marketCorrect: stats.marketCorrect,
        overallAccuracy: overallAccuracy,
        avgForecastDiff: stats.avgForecastDiff,
        daysTracked: stats.daysTracked
      } : null,
      recentDays: recentDays,
      totalDaysRecorded: dates.length
    });

  } catch (err) {
    console.error('Accuracy error:', err);
    res.status(200).json({ hasData: false, stats: null, recentDays: [], totalDaysRecorded: 0 });
  }
}