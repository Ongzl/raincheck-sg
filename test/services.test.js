// Network-facing modules, tested with a stubbed fetch (no real network calls).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ONEMAP_TOKEN;
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('falls back to a walking route when OneMap fails', async () => {
  process.env.ONEMAP_TOKEN = 'test-token';
  const { getItineraries } = await import('../src/routing.js');
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('onemap.gov.sg')) return json({ error: 'down' }, 503);
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
