// Pure decision logic: weather + itineraries -> a verdict with reasons and alternatives.
// No network calls here, so it's easy to test.

import { nearest, samplePath } from './geo.js';
import { userError } from './errors.js';

export const LEVELS = ['fine', 'light', 'heavy'];

// Label points for the 24-hour forecast's 5 regions (the same points data.gov.sg uses for its regional readings).
export const REGIONS = {
  north: [1.41803, 103.82],
  south: [1.29587, 103.82],
  east: [1.35735, 103.94],
  west: [1.35735, 103.7],
  central: [1.35735, 103.82],
};

/** NEA forecast text -> 0 fine, 1 light (umbrella's enough), 2 heavy/thundery (change something), null unknown. */
export function severityOf(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes('thunder') || t.includes('heavy')) return 2;
  if (t.includes('rain') || t.includes('shower') || t.includes('drizzle')) return 1;
  return 0;
}

/** Max 5-minute rain-gauge reading -> level. 0 = dry, under 1 mm per 5 min = light, 1 mm or more (~12 mm/h+) = heavy. */
export function observedLevel(maxMm) {
  if (maxMm == null) return null;
  if (maxMm <= 0) return 0;
  return maxMm < 1 ? 1 : 2;
}

export function regionOf(point) {
  return nearest(point, Object.entries(REGIONS), ([, p]) => p).item[0];
}

/**
 * Forecast for one place and time. Uses the 2-hour forecast (47 areas) when the time falls inside its window,
 * otherwise the 24-hour forecast (5 regions, ~3 blocks), otherwise nothing.
 */
export function forecastAt(point, time, weather) {
  const two = weather.twoHour;
  if (two && time >= two.validFrom - 15 * 60 * 1000 && time < two.validTo) {
    const { item: area } = nearest(point, two.areas, (a) => a.point);
    return { source: '2h', place: area.name, text: area.forecast, severity: severityOf(area.forecast), window: two.validText };
  }
  const period = periodAt(weather.twentyFour, time);
  if (period) {
    const region = regionOf(point);
    const text = period.regions[region];
    return { source: '24h', place: `${region} region`, text, severity: severityOf(text), window: period.text };
  }
  return { source: null, place: null, text: null, severity: null, window: null };
}

export function periodAt(twentyFour, time) {
  const periods = twentyFour?.periods ?? [];
  const exact = periods.find((p) => time >= p.start && time < p.end);
  if (exact) return exact;
  // Shortly before the first block starts (forecast issued at 11:30 for 12:00 onwards): use the first block.
  if (periods[0] && time < periods[0].start && periods[0].start - time <= 60 * 60 * 1000) return periods[0];
  return null;
}

const worse = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));
const CONFIDENCE_RANK = { high: 0, rough: 1, none: 2 };

/** Checks the forecast along a walking leg, at the time you'd be at each point. */
export function assessLeg(leg, weather) {
  const samples = samplePath(leg.points?.length ? leg.points : [], 150);
  const span = leg.endTime - leg.startTime;
  const forecasts = samples.map(({ point, fraction }) => forecastAt(point, leg.startTime + span * fraction, weather));
  let severity = null;
  let confidence = forecasts.length ? 'high' : 'none';
  const places = new Map();
  for (const f of forecasts) {
    if (f.source === null) confidence = 'none';
    else if (f.source === '24h' && confidence === 'high') confidence = 'rough';
    severity = worse(severity, f.severity);
    if (f.place && !places.has(f.place)) places.set(f.place, f);
  }
  const wetShare = forecasts.length ? forecasts.filter((f) => f.severity >= 1).length / forecasts.length : 0;
  return {
    ...leg,
    points: undefined,
    severity,
    confidence,
    wetMin: leg.durationMin * wetShare,
    trivial: leg.durationMin < 1,
    forecasts: [...places.values()].map(({ source, place, text, severity: s, window }) => ({ source, place, text, severity: s, window })),
  };
}

/** "Expo MRT Station (CG1)", "EXPO" and "Expo Stn" all become "expo". */
function stationKey(name = '') {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(mrt|lrt|station|stn|interchange|int)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * A walk between two rides that starts and ends at the same station is a transfer inside the
 * station (e.g. changing lines at Expo): it's indoors, so it can't get you wet.
 * A walk to a differently named stop (e.g. "Kent Ridge" -> "Kent Ridge Stn Exit A") stays exposed.
 */
export function isInStationTransfer(legs, i) {
  const leg = legs[i];
  if (leg.mode !== 'WALK' || i === 0 || i === legs.length - 1) return false;
  if (legs[i - 1].mode === 'WALK' || legs[i + 1].mode === 'WALK') return false;
  const from = stationKey(leg.from);
  return from !== '' && from === stationKey(leg.to);
}

export function assessItinerary(itinerary, weather) {
  const legs = itinerary.legs.map((leg, i, all) => {
    if (isInStationTransfer(all, i)) return { ...leg, points: undefined, label: 'Change lines (inside the station)', sheltered: true, transfer: true };
    return leg.mode === 'WALK' ? assessLeg(leg, weather) : { ...leg, points: undefined, sheltered: true };
  });
  const walks = legs.filter((l) => l.mode === 'WALK' && !l.trivial && !l.sheltered);
  let severity = walks.length ? null : 0;
  let confidence = 'high';
  for (const w of walks) {
    severity = worse(severity, w.severity);
    if (CONFIDENCE_RANK[w.confidence] > CONFIDENCE_RANK[confidence]) confidence = w.confidence;
  }
  const walkMin = walks.reduce((s, w) => s + w.durationMin, 0);
  const wetMin = walks.reduce((s, w) => s + w.wetMin, 0);
  return { ...itinerary, legs, severity, confidence, walkMin, wetMin };
}

const fmtMin = (m) => `${Math.max(1, Math.round(m))} min`;

function reasonFor(it) {
  if (it.severity == null) return 'No forecast covers this trip yet. Forecasts only reach about 24 hours ahead.';
  const walks = it.legs.filter((l) => l.mode === 'WALK' && !l.trivial && !l.sheltered);
  if (!walks.length) return 'There’s no real walking on this route, so rain won’t reach you.';
  if (it.severity === 0) return `No rain forecast for your ${fmtMin(it.walkMin)} of walking.`;
  const leg = walks.find((w) => w.severity === it.severity);
  const f = leg.forecasts.find((x) => x.severity === it.severity) ?? leg.forecasts[0];
  const where = f.source === '2h' ? `around ${f.place}` : `for the ${f.place}`;
  const route = leg.from && leg.to && leg.from !== leg.to ? ` from ${leg.from} to ${leg.to}` : leg.from ? ` at ${leg.from}` : '';
  return `${f.text} forecast ${where} (${f.window}) during your ${fmtMin(leg.durationMin)} walk${route}.`;
}

export function mapsLink(from, to, mode = 'transit') {
  return `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lon}&destination=${to.lat},${to.lon}&travelmode=${mode}`;
}

/** The main entry point. Returns everything the UI shows. */
export function buildVerdict({ itineraries, weather, from, to, departAt, now = Date.now(), note = null }) {
  const assessed = itineraries.map((it) => assessItinerary(it, weather));
  if (!assessed.length) throw userError('No route found for this trip.');
  // Primary = the one that gets you there first (what Google Maps would send you on anyway).
  // Compare arrival times, not ride durations: OneMap options can leave at different times.
  const arrival = (it) => (Number.isFinite(it.endTime) ? it.endTime : it.startTime + it.durationMin * 60000);
  const primary = assessed.reduce((a, b) => (arrival(b) < arrival(a) ? b : a));
  const level = primary.severity == null ? 'unknown' : LEVELS[primary.severity];

  const alternatives = [];
  if (primary.severity >= 1) {
    // Never suggest a route with worse rain than the one you'd take anyway.
    const others = assessed.filter((it) => it !== primary && it.severity != null && it.severity <= primary.severity);
    const best = others.sort((a, b) => a.severity - b.severity || a.wetMin - b.wetMin || a.walkMin - b.walkMin)[0];
    if (best && (best.severity < primary.severity || primary.wetMin - best.wetMin >= 2)) {
      const extra = Math.round((arrival(best) - arrival(primary)) / 60000);
      alternatives.push({
        type: 'route',
        title: `Take ${best.label} instead`,
        detail: `${fmtMin(best.wetMin)} walking in rain instead of ${fmtMin(primary.wetMin)} · ${extra > 0 ? `arrives ${extra} min later` : 'arrives no later'}`,
        itineraryIndex: assessed.indexOf(best),
      });
    }
  }
  if (primary.severity === 2) {
    alternatives.push({ type: 'ride', title: 'Take a taxi or ride-hail', detail: 'Door to door, so you skip the wet walk entirely.', link: mapsLink(from, to, 'driving') });
  }
  if (primary.severity >= 1) {
    const region = regionOf([from.lat, from.lon]);
    const periods = weather.twentyFour?.periods ?? [];
    const current = periodAt(weather.twentyFour, departAt);
    const next = current ? periods[periods.indexOf(current) + 1] : null;
    if (next) {
      // Compare like with like: the next regional block against the current regional block.
      const nowSev = severityOf(current.regions[region]);
      const nextSev = severityOf(next.regions[region]);
      if (nextSev != null && nowSev != null && nextSev < nowSev && nextSev < primary.severity) {
        alternatives.push({
          type: 'timing',
          title: `Or go later: the outlook improves for ${next.text}`,
          detail: `24-hour forecast for the ${region} region: ${next.regions[region]}. This is a rough regional outlook, so check again before you leave.`,
        });
      }
    }
  }

  // What the nearest rain gauge sees right now (only meaningful if you're leaving soon).
  let rightNow = null;
  if (Math.abs(departAt - now) <= 30 * 60 * 1000 && weather.rainfall) {
    const stations = weather.rainfall.stations.filter((s) => s.mm != null);
    const near = nearest([from.lat, from.lon], stations, (s) => s.point);
    if (near && near.distance <= 3000) {
      const s = near.item;
      rightNow = {
        station: s.name,
        distanceM: Math.round(near.distance),
        mm: s.mm,
        text: s.mm > 0
          ? `Raining now at the rain gauge on ${s.name} (${s.mm} mm in the last 5 min).`
          : `Dry right now at the rain gauge on ${s.name}.`,
      };
    }
  }

  const headline = {
    fine: 'Fine: no rain on your walks',
    light: 'Light rain: your umbrella’s enough',
    heavy: 'Heavy rain on your walk: change something',
    unknown: 'No forecast for this trip yet',
  }[level];

  return {
    level,
    headline,
    reason: reasonFor(primary),
    confidence: primary.confidence,
    confidenceText: {
      high: 'Based on the 2-hour forecast for the areas you’ll walk through.',
      rough: 'Rough outlook from the 24-hour regional forecast. Check again within 2 hours of leaving.',
      none: 'No forecast available for this time.',
    }[primary.confidence],
    rightNow,
    alternatives,
    note,
    departAt,
    from,
    to,
    mapsLink: mapsLink(from, to, primary.walkOnly ? 'walking' : 'transit'),
    primaryIndex: assessed.indexOf(primary),
    itineraries: assessed.map((it) => ({
      label: it.label,
      durationMin: Math.round(it.durationMin),
      arriveAt: arrival(it),
      walkMin: Math.round(it.walkMin),
      wetMin: Math.round(it.wetMin),
      level: it.severity == null ? 'unknown' : LEVELS[it.severity],
      legs: it.legs.map((l) => ({
        mode: l.mode,
        label: l.label,
        from: l.from,
        to: l.to,
        startTime: l.startTime,
        durationMin: Math.round(l.durationMin),
        level: l.sheltered ? 'sheltered' : l.trivial ? 'trivial' : l.severity == null ? 'unknown' : LEVELS[l.severity],
        forecasts: l.forecasts ?? [],
      })),
    })),
    sources: {
      twoHour: weather.twoHour ? { window: weather.twoHour.validText, updated: weather.twoHour.updated } : null,
      twentyFour: weather.twentyFour ? { updated: weather.twentyFour.updated } : null,
      rainfall: weather.rainfall ? { timestamp: weather.rainfall.timestamp } : null,
    },
  };
}
