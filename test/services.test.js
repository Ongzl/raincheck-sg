// Network-facing modules, tested with a stubbed fetch (no real network calls).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.RAINCHECK_RETRY_MS = '1'; // keep retry back-off fast in tests
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ONEMAP_TOKEN;
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const transitousPlan = {
  itineraries: [
    { duration: 600, startTime: '2026-11-10T08:00:00Z', endTime: '2026-11-10T08:10:00Z', legs: [
      { mode: 'WALK', duration: 120, startTime: '2026-11-10T08:00:00Z', endTime: '2026-11-10T08:02:00Z', from: { name: 'START', lat: 1.35, lon: 103.84 }, to: { name: 'BISHAN', lat: 1.351, lon: 103.848 } },
      { mode: 'SUBWAY', routeShortName: 'CC', duration: 480, startTime: '2026-11-10T08:02:00Z', endTime: '2026-11-10T08:10:00Z', from: { name: 'BISHAN', lat: 1.351, lon: 103.848 }, to: { name: 'END', lat: 1.34, lon: 103.85 } },
    ] },
  ],
};

test('uses Transitous for bus/MRT when OneMap fails', async () => {
  process.env.ONEMAP_TOKEN = 'test-token';
  const { getItineraries } = await import('../src/routing.js');
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('onemap.gov.sg')) return json({ error: 'down' }, 503);
    if (String(url).includes('api.transitous.org')) return json(transitousPlan);
    throw new Error(`unexpected ${url}`);
  };
  const r = await getItineraries({ label: 'Home', lat: 1.35, lon: 103.84 }, { label: 'Office', lat: 1.34, lon: 103.85 }, Date.now());
  assert.equal(r.provider, 'transitous');
  assert.equal(r.note, null);
  assert.equal(r.itineraries[0].label, 'MRT CC');
  // "START"/"END" become the user's place names; stop names are title-cased.
  assert.equal(r.itineraries[0].legs[0].from, 'Home');
  assert.equal(r.itineraries[0].legs[0].to, 'Bishan');
  assert.equal(r.itineraries[0].legs[1].to, 'Office');
  assert.ok(calls[0].includes('onemap.gov.sg'), 'OneMap is tried first when configured');
});

test('falls back to a walking route when OneMap and Transitous both fail', async () => {
  process.env.ONEMAP_TOKEN = 'test-token';
  const { getItineraries } = await import('../src/routing.js');
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('onemap.gov.sg')) return json({ error: 'down' }, 503);
    if (String(url).includes('api.transitous.org')) throw new TypeError('Failed to fetch');
    if (String(url).includes('routing.openstreetmap.de')) {
      return json({ code: 'Ok', routes: [{ geometry: '_p~iF~ps|U_ulLnnqC', duration: 600, distance: 800 }] });
    }
    throw new Error(`unexpected ${url}`);
  };
  const from = { label: 'A', lat: 1.35, lon: 103.84 };
  const to = { label: 'B', lat: 1.34, lon: 103.85 };
  const r = await getItineraries(from, to, Date.now());
  assert.equal(r.provider, 'osrm');
  assert.equal(r.itineraries[0].walkOnly, true);
  assert.match(r.note, /unavailable/);
  assert.ok(calls.some((u) => u.includes('onemap.gov.sg')));
});

test('concurrent weather requests share one upstream call', async () => {
  const { getTwoHour } = await import('../src/weather.js');
  let count = 0;
  globalThis.fetch = async () => {
    count++;
    await new Promise((r) => setTimeout(r, 20));
    return json({
      code: 0,
      data: {
        area_metadata: [{ name: 'Bishan', label_location: { latitude: 1.35, longitude: 103.84 } }],
        items: [{ update_timestamp: 'x', valid_period: { start: '2026-11-10T15:30:00+08:00', end: '2026-11-10T17:30:00+08:00', text: '3.30 pm to 5.30 pm' }, forecasts: [{ area: 'Bishan', forecast: 'Showers' }] }],
      },
    });
  };
  const [a, b, c] = await Promise.all([getTwoHour(), getTwoHour(), getTwoHour()]);
  assert.equal(count, 1);
  assert.equal(a.areas[0].forecast, 'Showers');
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

const forecast24 = () => json({
  code: 0,
  data: { records: [{ updatedTimestamp: 'x', general: { forecast: { text: 'Showers' } }, periods: [
    { timePeriod: { start: '2026-11-10T12:00:00+08:00', end: '2026-11-10T18:00:00+08:00', text: 'Midday to 6 pm' }, regions: { north: { text: 'Showers' }, south: { text: 'Showers' }, east: { text: 'Showers' }, west: { text: 'Showers' }, central: { text: 'Showers' } } },
  ] }] },
});

test('retries when a rate-limited reply is blocked by the browser (network error)', async () => {
  const { getTwentyFourHour } = await import('../src/weather.js');
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls <= 2) throw new TypeError('Failed to fetch'); // what a 429 without CORS headers looks like
    return forecast24();
  };
  const f = await getTwentyFourHour();
  assert.equal(calls, 3);
  assert.equal(f.periods[0].regions.central, 'Showers');
});

test('gives a clear, user-facing message when the weather service stays busy', async () => {
  const { getRainfall } = await import('../src/weather.js');
  globalThis.fetch = async () => new Response('', { status: 429 });
  await assert.rejects(getRainfall('2026-11-10T09:00:00'), (err) => err.expose === true && /busy/.test(err.message));
});

test('a missing optional source (rain gauges) does not fail the whole check', async () => {
  const { getAllWeather } = await import('../src/weather.js');
  // 2-hour and 24-hour forecasts are cached by the tests above; only the rain gauges are fetched here.
  globalThis.fetch = async () => new Response('', { status: 429 });
  const w = await getAllWeather();
  assert.ok(w.twoHour);
  assert.ok(w.twentyFour);
  assert.equal(w.rainfall, null);
});
