// ═══════════════════════════════════════════════════════════
//  WeatherQuant — api/reset.js
//  One-time use: resets accuracy stats to zero
//  Access: /api/reset?key=reset2026
// ═══════════════════════════════════════════════════════════

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.query.key !== 'reset2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Reset accuracy stats
    await kv.set('accuracy_stats', {
      totalChecked: 0,
      forecastCorrect: 0,
      marketCorrect: 0,
      daysTracked: 0,
      avgForecastDiff: 0,
      totalForecastDiff: 0,
      divergenceTotal: 0,
      divergenceForecastWins: 0
    });

    // Clear snapshot dates list
    await kv.set('snapshot_dates', []);

    res.status(200).json({
      success: true,
      message: 'Accuracy stats and snapshot history reset to zero. Fresh start.'
    });

  } catch (err) {
    res.status(500).json({ error: 'Reset failed', detail: err.message });
  }
}