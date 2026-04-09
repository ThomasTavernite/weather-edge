// ═══════════════════════════════════════════════════════════
//  WeatherQuant — api/verify.js
//  Pulls Kalshi's official rules_primary field for each city
//  to verify the exact NWS station used for settlement
//  Access: /api/verify?key=verify2026
// ═══════════════════════════════════════════════════════════

var SERIES = [
  { id: 'nyc',   name: 'New York City',   ticker: 'KXHIGHNY',    station: 'KNYC' },
  { id: 'chi',   name: 'Chicago',         ticker: 'KXHIGHCHI',   station: 'KMDW' },
  { id: 'mia',   name: 'Miami',           ticker: 'KXHIGHMIA',   station: 'KMIA' },
  { id: 'lax',   name: 'Los Angeles',     ticker: 'KXHIGHLAX',   station: 'KLAX' },
  { id: 'sfo',   name: 'San Francisco',   ticker: 'KXHIGHTSFO',  station: 'KSFO' },
  { id: 'phi',   name: 'Philadelphia',    ticker: 'KXHIGHPHIL',  station: 'KPHL' },
  { id: 'aus',   name: 'Austin',          ticker: 'KXHIGHAUS',   station: 'KAUS' },
  { id: 'den',   name: 'Denver',          ticker: 'KXHIGHDEN',   station: 'KDEN' },
  { id: 'sea',   name: 'Seattle',         ticker: 'KXHIGHTSEA',  station: 'KSEA' },
  { id: 'lv',    name: 'Las Vegas',       ticker: 'KXHIGHTLV',   station: 'KLAS' },
  { id: 'bos',   name: 'Boston',          ticker: 'KXHIGHTBOS',  station: 'KBOS' },
  { id: 'nola',  name: 'New Orleans',     ticker: 'KXHIGHTNOLA', station: 'KMSY' },
  { id: 'dc',    name: 'Washington DC',   ticker: 'KXHIGHTDC',   station: 'KDCA' },
];

async function safeFetch(url) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, 10000);
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

export default async function handler(req, res) {
  if (req.query.key !== 'verify2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var results = [];

  for (var i = 0; i < SERIES.length; i++) {
    var s = SERIES[i];
    var url = 'https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=' + s.ticker + '&status=open&with_nested_markets=true&limit=1';
    var data = await safeFetch(url);

    var ruleText = null;
    var stationFound = null;
    var verified = false;

    if (data && data.events && data.events.length > 0) {
      var ev = data.events[0];
      if (ev.markets && ev.markets.length > 0) {
        ruleText = ev.markets[0].rules_primary || null;

        // Search for station identifiers in the rules text
        if (ruleText) {
          // Look for ICAO station codes (K + 3 letters)
          var stationMatch = ruleText.match(/\b(K[A-Z]{3})\b/g);
          if (stationMatch) {
            stationFound = stationMatch;
            verified = stationMatch.indexOf(s.station) !== -1;
          }

          // Also look for common station name references
          var lowerRules = ruleText.toLowerCase();
          var nameChecks = {
            'KNYC': ['central park'],
            'KMDW': ['midway'],
            'KMIA': ['miami international', 'miami intl'],
            'KLAX': ['lax', 'los angeles international'],
            'KSFO': ['sfo', 'san francisco international'],
            'KPHL': ['philadelphia international', 'phl'],
            'KAUS': ['bergstrom', 'austin-bergstrom'],
            'KDEN': ['denver international', 'dia'],
            'KSEA': ['sea-tac', 'seattle-tacoma'],
            'KLAS': ['mccarran', 'harry reid', 'las vegas'],
            'KBOS': ['logan', 'boston logan'],
            'KMSY': ['louis armstrong', 'new orleans'],
            'KDCA': ['reagan', 'national airport', 'dca']
          };

          var names = nameChecks[s.station] || [];
          for (var n = 0; n < names.length; n++) {
            if (lowerRules.indexOf(names[n]) !== -1) {
              verified = true;
              break;
            }
          }
        }
      }
    }

    results.push({
      city: s.name,
      cityId: s.id,
      ourStation: s.station,
      stationsInRules: stationFound,
      verified: verified,
      status: verified ? '✅ VERIFIED' : (ruleText ? '⚠️ REVIEW NEEDED' : '❌ NO RULES FOUND'),
      rulesText: ruleText
    });

    await new Promise(function(r) { setTimeout(r, 300); });
  }

  var allVerified = results.every(function(r) { return r.verified; });
  var verifiedCount = results.filter(function(r) { return r.verified; }).length;

  res.status(200).json({
    summary: {
      total: results.length,
      verified: verifiedCount,
      unverified: results.length - verifiedCount,
      allClear: allVerified
    },
    results: results
  });
}