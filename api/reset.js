// ═══════════════════════════════════════════════════════════
//  WeatherQuant — api/reset.js (v3)
//  Wipes accuracy stats, snapshot history, AND bias data
//  Run ONCE after deploying v3: /api/reset?key=reset2026
// ═══════════════════════════════════════════════════════════

import { kv } from '@vercel/kv';

var CITY_IDS = ['nyc','chi','mia','lax','sfo','phi','aus','den','sea','lv','bos','nola','dc'];

export default async function handler(req, res) {
  if (req.query.key !== 'reset2026') return res.status(401).json({ error:'Unauthorized' });

  try {
    await kv.set('accuracy_stats', {
      totalChecked: 0, forecastCorrect: 0, marketCorrect: 0,
      daysTracked: 0, avgForecastDiff: 0, totalForecastDiff: 0,
      brierSum: 0, brierCount: 0,
      opportunityCorrect: 0, opportunityTotal: 0
    });
    await kv.set('snapshot_dates', []);
    for (var i=0;i<CITY_IDS.length;i++) {
      await kv.del('bias:' + CITY_IDS[i]);
    }
    res.status(200).json({ success:true, message:'v3 reset complete. Stats, snapshot dates, and per-city bias all cleared.' });
  } catch(err) {
    res.status(500).json({ error:'Reset failed', detail:err.message });
  }
}