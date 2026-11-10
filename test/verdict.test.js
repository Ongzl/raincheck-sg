import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePolyline } from '../src/polyline.js';
import { severityOf, forecastAt, buildVerdict, observedLevel, regionOf } from '../src/verdict.js';
import { parseOneMapPlan, parseTransitousPlan, sgtDateTime } from '../src/routing.js';
import { samplePath } from '../src/geo.js';

// --- helpers to build fixtures ---
function encode(points) {
  let out = '';
  let pLat = 0;
  let pLon = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of points) {
    const a = Math.round(lat * 1e5);
    const b = Math.round(lon * 1e5);
    out += enc(a - pLat) + enc(b - pLon);
    pLat = a;
    pLon = b;
  }
  return out;
}

const T0 = Date.parse('2026-11-10T16:00:00+08:00');
const MIN = 60_000;
const BISHAN = [1.3508, 103.8484];
const TOA_PAYOH = [1.3343, 103.8563];

function weather({ bishan = 'Thundery Showers', toaPayoh = 'Thundery Showers', next = 'Cloudy' } = {}) {
  return {
    twoHour: {
      validFrom: Date.parse('2026-11-10T15:30:00+08:00'),
      validTo: Date.parse('2026-11-10T17:30:00+08:00'),
      validText: '3.30 pm to 5.30 pm',
      areas: [
        { name: 'Bishan', point: [1.350772, 103.839], forecast: bishan },
        { name: 'Toa Payoh', point: [1.334304, 103.856327], forecast: toaPayoh },
        { name: 'Ang Mo Kio', point: [1.375, 103.839], forecast: 'Cloudy' },
      ],
    },
    twentyFour: {
      periods: [
        { start: Date.parse('2026-11-10T12:00:00+08:00'), end: Date.parse('2026-11-10T18:00:00+08:00'), text: 'Midday to 6 pm', regions: { north: 'Showers', south: 'Showers', east: 'Showers', west: 'Showers', central: 'Thundery Showers' } },
        { start: Date.parse('2026-11-10T18:00:00+08:00'), end: Date.parse('2026-11-11T06:00:00+08:00'), text: '6 pm to 6 am', regions: { north: next, south: next, east: next, west: next, central: next } },
      ],
    },
    rainfall: { timestamp: '2026-11-10T15:55:00+08:00', stations: [{ id: 'S1', name: 'Bishan Street 13', point: [1.351, 103.848], mm: 0.4 }] },
  };
}

// A OneMap-style plan: (0) fastest, 11 min walk; (1) bus with 2 min walk, slower.
function oneMapPlan() {
  const leg = (mode, startMin, endMin, points, extra = {}) => ({
    mode, startTime: T0 + startMin * MIN, endTime: T0 + endMin * MIN, duration: (endMin - startMin) * 60, distance: 500,
    from: { name: 'A' }, to: { name: 'B' }, legGeometry: { points: encode(points) }, ...extra,
  });
  return {
    plan: {
      itineraries: [
        { duration: 18 * 60, startTime: T0, endTime: T0 + 18 * MIN, legs: [
          leg('WALK', 0, 11, [BISHAN, [1.345, 103.851], [1.34, 103.853]]),
          leg('SUBWAY', 11, 18, [[1.34, 103.853], TOA_PAYOH], { route: 'NS', routeShortName: 'NS' }),
        ] },
        { duration: 22 * 60, startTime: T0, endTime: T0 + 22 * MIN, legs: [
          leg('WALK', 0, 2, [BISHAN, [1.3505, 103.849]]),
          leg('BUS', 2, 20, [[1.3505, 103.849], [1.335, 103.856]], { route: '166', routeShortName: '166' }),
          leg('WALK', 20, 22, [[1.335, 103.856], TOA_PAYOH]),
        ] },
      ],
    },
  };
}

const from = { label: 'Bishan MRT', lat: BISHAN[0], lon: BISHAN[1] };
const to = { label: 'Toa Payoh', lat: TOA_PAYOH[0], lon: TOA_PAYOH[1] };

test('severity mapping follows the three-level scale', () => {
  assert.equal(severityOf('Partly Cloudy (Day)'), 0);
  assert.equal(severityOf('Fair & Warm'), 0);
  assert.equal(severityOf('Light Rain'), 1);
  assert.equal(severityOf('Showers'), 1);
  assert.equal(severityOf('Passing Showers'), 1);
  assert.equal(severityOf('Heavy Rain'), 2);
  assert.equal(severityOf('Thundery Showers'), 2);
  assert.equal(severityOf('Heavy Thundery Showers with Gusty Winds'), 2);
  assert.equal(severityOf(null), null);
});

test('decodes Google encoded polylines', () => {
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test('samplePath keeps both ends', () => {
  const s = samplePath([BISHAN, [1.345, 103.851], TOA_PAYOH], 150);
  assert.equal(s[0].fraction, 0);
  assert.equal(s.at(-1).fraction, 1);
});

test('forecastAt uses 2-hour areas inside the window, 24-hour regions outside, nothing beyond', () => {
  const w = weather({ bishan: 'Showers' });
  const near = forecastAt(BISHAN, T0, w);
  assert.equal(near.source, '2h');
  assert.equal(near.place, 'Bishan');
  const later = forecastAt(BISHAN, Date.parse('2026-11-10T20:00:00+08:00'), w);
  assert.equal(later.source, '24h');
  assert.equal(later.place, 'central region');
  assert.equal(later.text, 'Cloudy');
  assert.equal(forecastAt(BISHAN, Date.parse('2026-11-12T08:00:00+08:00'), w).source, null);
});

test('regionOf picks sensible regions', () => {
  assert.equal(regionOf([1.44, 103.79]), 'north'); // Woodlands
  assert.equal(regionOf([1.35, 103.94]), 'east'); // Tampines
  assert.equal(regionOf([1.34, 103.7]), 'west'); // Jurong West
  assert.equal(regionOf(BISHAN), 'central');
});

test('parses OneMap public transport itineraries', () => {
  const its = parseOneMapPlan(oneMapPlan());
  assert.equal(its.length, 2);
  assert.equal(its[0].label, 'MRT NS');
  assert.equal(its[1].label, 'Bus 166');
  assert.equal(its[0].legs[0].mode, 'WALK');
  assert.ok(its[0].legs[0].points.length >= 3);
});

test('heavy rain on the fastest route: verdict is heavy, suggests the bus, a ride and going later', () => {
  const v = buildVerdict({ itineraries: parseOneMapPlan(oneMapPlan()), weather: weather(), from, to, departAt: T0, now: T0 });
  assert.equal(v.level, 'heavy');
  assert.equal(v.primaryIndex, 0);
  assert.equal(v.confidence, 'high');
  assert.match(v.reason, /Thundery Showers/);
  const types = v.alternatives.map((a) => a.type);
  assert.deepEqual(types, ['route', 'ride', 'timing']);
  assert.match(v.alternatives[0].title, /Bus 166/);
  assert.match(v.rightNow.text, /Raining now/);
});

test('dry forecast: fine, no alternatives', () => {
  const v = buildVerdict({ itineraries: parseOneMapPlan(oneMapPlan()), weather: weather({ bishan: 'Cloudy', toaPayoh: 'Partly Cloudy (Day)' }), from, to, departAt: T0, now: T0 });
  assert.equal(v.level, 'fine');
  assert.equal(v.alternatives.length, 0);
});

test('light rain: umbrella is enough, no ride-hail suggestion', () => {
  const v = buildVerdict({ itineraries: parseOneMapPlan(oneMapPlan()), weather: weather({ bishan: 'Light Showers', toaPayoh: 'Light Showers', next: 'Showers' }), from, to, departAt: T0, now: T0 });
  assert.equal(v.level, 'light');
  assert.ok(!v.alternatives.some((a) => a.type === 'ride'));
});

test('a trip tonight uses the rough 24-hour outlook', () => {
  const plan = oneMapPlan();
  const shift = 4 * 60 * MIN; // 8 pm
  for (const it of plan.plan.itineraries) {
    it.startTime += shift; it.endTime += shift;
    for (const l of it.legs) { l.startTime += shift; l.endTime += shift; }
  }
  const v = buildVerdict({ itineraries: parseOneMapPlan(plan), weather: weather({ next: 'Showers' }), from, to, departAt: T0 + shift, now: T0 });
  assert.equal(v.level, 'light');
  assert.equal(v.confidence, 'rough');
  assert.equal(v.rightNow, null);
});

test('walk legs under a minute are ignored', () => {
  const plan = { plan: { itineraries: [{ duration: 600, startTime: T0, endTime: T0 + 10 * MIN, legs: [
    { mode: 'WALK', startTime: T0, endTime: T0 + 30_000, duration: 30, distance: 30, legGeometry: { points: encode([BISHAN, [1.3509, 103.8485]]) } },
    { mode: 'BUS', route: '52', startTime: T0 + 30_000, endTime: T0 + 10 * MIN, duration: 570, distance: 3000, legGeometry: { points: encode([BISHAN, TOA_PAYOH]) } },
  ] }] } };
  const v = buildVerdict({ itineraries: parseOneMapPlan(plan), weather: weather(), from, to, departAt: T0, now: T0 });
  assert.equal(v.level, 'fine');
});

test('never suggests a route with worse rain than the fastest one', () => {
  // Fastest: 10 min walking around Bishan (light showers). Other: only 3 min walking, but in Ang Mo Kio (thundery).
  const walk = (startMin, endMin, points) => ({ mode: 'WALK', startTime: T0 + startMin * MIN, endTime: T0 + endMin * MIN, duration: (endMin - startMin) * 60, distance: 500, legGeometry: { points: encode(points) } });
  const bus = (startMin, endMin) => ({ mode: 'BUS', route: '52', startTime: T0 + startMin * MIN, endTime: T0 + endMin * MIN, duration: (endMin - startMin) * 60, distance: 3000, legGeometry: { points: encode([BISHAN, [1.375, 103.839]]) } });
  const plan = { plan: { itineraries: [
    { duration: 15 * 60, startTime: T0, endTime: T0 + 15 * MIN, legs: [walk(0, 10, [BISHAN, [1.351, 103.84]]), bus(10, 15)] },
    { duration: 20 * 60, startTime: T0, endTime: T0 + 20 * MIN, legs: [bus(0, 17), walk(17, 20, [[1.375, 103.839], [1.376, 103.84]])] },
  ] } };
  const w = weather({ bishan: 'Light Showers' });
  w.twoHour.areas.find((a) => a.name === 'Ang Mo Kio').forecast = 'Thundery Showers';
  const v = buildVerdict({ itineraries: parseOneMapPlan(plan), weather: w, from, to, departAt: T0, now: T0 });
  assert.equal(v.level, 'light');
  assert.equal(v.itineraries[1].level, 'heavy');
  assert.ok(!v.alternatives.some((a) => a.type === 'route'), 'must not suggest the thundery route');
});

test('"go later" only appears when the regional outlook actually improves', () => {
  // 2-hour forecast is thundery (heavy); 24-hour central region is Showers now and Showers next: no improvement.
  const w = weather();
  w.twentyFour.periods[0].regions.central = 'Showers';
  w.twentyFour.periods[1].regions.central = 'Showers';
  const v = buildVerdict({ itineraries: parseOneMapPlan(oneMapPlan()), weather: w, from, to, departAt: T0, now: T0 });
  assert.equal(v.level, 'heavy');
  assert.ok(!v.alternatives.some((a) => a.type === 'timing'));
});

test('legs without geometry fall back to their start and end points', () => {
  const plan = oneMapPlan();
  const walk = plan.plan.itineraries[0].legs[0];
  delete walk.legGeometry;
  walk.from = { name: 'Bishan MRT', lat: BISHAN[0], lon: BISHAN[1] };
  walk.to = { name: 'Braddell', lat: 1.34, lon: 103.853 };
  const its = parseOneMapPlan(plan);
  assert.equal(its[0].legs[0].points.length, 2);
  const v = buildVerdict({ itineraries: its, weather: weather(), from, to, departAt: T0, now: T0 });
  assert.equal(v.level, 'heavy');
});

// Arithmetic encoder (no bitwise ops), so it can produce precision-7 polylines for Singapore longitudes.
function encodeP(points, precision) {
  const f = 10 ** precision;
  const enc = (v) => {
    let n = v < 0 ? -2 * v - 1 : 2 * v;
    let s = '';
    while (n >= 32) { s += String.fromCharCode(32 + (n % 32) + 63); n = Math.floor(n / 32); }
    return s + String.fromCharCode(n + 63);
  };
  let pLat = 0;
  let pLon = 0;
  let out = '';
  for (const [lat, lon] of points) {
    const a = Math.round(lat * f);
    const b = Math.round(lon * f);
    out += enc(a - pLat) + enc(b - pLon);
    pLat = a;
    pLon = b;
  }
  return out;
}

test('decodes precision-7 polylines without 32-bit overflow (Transitous)', () => {
  const pts = [[1.3510808, 103.8500768], [1.293301, 103.78442]];
  const decoded = decodePolyline(encodeP(pts, 7), 7);
  decoded.forEach(([lat, lon], i) => {
    assert.ok(Math.abs(lat - pts[i][0]) < 1e-7);
    assert.ok(Math.abs(lon - pts[i][1]) < 1e-7);
  });
});

test('parses Transitous plans: ISO times, precision 7, one entry per distinct route', () => {
  const geom = { points: encodeP([BISHAN, [1.345, 103.851]], 7), precision: 7 };
  const it = (start) => ({
    duration: 600,
    startTime: start,
    endTime: new Date(Date.parse(start) + 600000).toISOString(),
    legs: [{ mode: 'WALK', duration: 600, startTime: start, endTime: new Date(Date.parse(start) + 600000).toISOString(), from: { name: 'START' }, to: { name: 'END' }, legGeometry: geom }],
  });
  const its = parseTransitousPlan({ itineraries: [it('2026-11-10T08:00:00Z'), it('2026-11-10T08:06:00Z')] });
  assert.equal(its.length, 1, 'later departures of the same route are dropped');
  assert.equal(its[0].startTime, Date.parse('2026-11-10T08:00:00Z'));
  assert.ok(Math.abs(its[0].legs[0].points[0][1] - BISHAN[1]) < 1e-6);
});

test('OneMap date/time are Singapore local', () => {
  assert.deepEqual(sgtDateTime(Date.parse('2026-11-10T23:30:00Z')), { date: '11-11-2026', time: '07:30:00' });
});

test('rain gauge thresholds', () => {
  assert.equal(observedLevel(0), 0);
  assert.equal(observedLevel(0.2), 1);
  assert.equal(observedLevel(1.4), 2);
  assert.equal(observedLevel(null), null);
});

test('changing lines inside a station is sheltered; a walk to a different stop is not', () => {
  // MRT -> walk Expo -> Expo (same station) -> MRT -> walk Kent Ridge -> Kent Ridge Stn Exit A (different stop) -> bus
  const leg = (mode, a, b, from, to, extra = {}) => ({
    mode, startTime: T0 + a * MIN, endTime: T0 + b * MIN, duration: (b - a) * 60, distance: 200,
    from: { name: from }, to: { name: to }, legGeometry: { points: encode([BISHAN, [1.351, 103.849]]) }, ...extra,
  });
  const plan = { plan: { itineraries: [{ duration: 30 * 60, startTime: T0, endTime: T0 + 30 * MIN, legs: [
    leg('SUBWAY', 0, 5, 'Tampines East', 'EXPO', { route: 'DT' }),
    leg('WALK', 5, 8, 'EXPO', 'Expo MRT Station (CG1)'),
    leg('SUBWAY', 8, 15, 'EXPO', 'KENT RIDGE', { route: 'CG' }),
    leg('WALK', 15, 18, 'KENT RIDGE', 'Kent Ridge Stn Exit A/NUH'),
    leg('BUS', 18, 30, 'Kent Ridge Stn Exit A/NUH', 'Ctrl Lib', { route: '95' }),
  ] }] } };
  const v = buildVerdict({ itineraries: parseOneMapPlan(plan), weather: weather(), from, to, departAt: T0, now: T0 });
  const legs = v.itineraries[0].legs;
  assert.equal(legs[1].level, 'sheltered');
  assert.match(legs[1].label, /inside the station/);
  assert.equal(legs[3].level, 'heavy', 'walk to a differently named stop stays exposed');
  assert.equal(v.itineraries[0].walkMin, 3, 'only the exposed walk counts');
  assert.equal(v.itineraries[0].wetMin, 3);
});

test('first and last walks are never treated as in-station transfers', () => {
  const plan = { plan: { itineraries: [{ duration: 10 * 60, startTime: T0, endTime: T0 + 10 * MIN, legs: [
    { mode: 'WALK', startTime: T0, endTime: T0 + 3 * MIN, duration: 180, from: { name: 'Bishan' }, to: { name: 'BISHAN' }, legGeometry: { points: encode([BISHAN, [1.351, 103.849]]) } },
    { mode: 'SUBWAY', route: 'NS', startTime: T0 + 3 * MIN, endTime: T0 + 10 * MIN, duration: 420, from: { name: 'BISHAN' }, to: { name: 'TOA PAYOH' }, legGeometry: { points: encode([BISHAN, TOA_PAYOH]) } },
  ] }] } };
  const v = buildVerdict({ itineraries: parseOneMapPlan(plan), weather: weather(), from, to, departAt: T0, now: T0 });
  assert.equal(v.itineraries[0].legs[0].level, 'heavy');
});
