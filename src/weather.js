// Fetches and caches NEA weather data from data.gov.sg (free, no key needed).
// Keyless limit is 6 requests per 10 seconds, so every endpoint is cached server-side.

const BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
const CACHE_MS = 5 * 60 * 1000;
const env = globalThis.process?.env ?? {}; // empty in the browser
const cache = new Map();

async function getJson(path) {
  const headers = {};
  if (env.DATA_GOV_SG_API_KEY) headers['x-api-key'] = env.DATA_GOV_SG_API_KEY;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(BASE + path, { headers });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (!res.ok) throw new Error(`data.gov.sg ${path} returned ${res.status}`);
    const body = await res.json();
    // When rate-limited the API sometimes answers 200 with data: null.
    if (body.data) return body.data;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`data.gov.sg ${path} returned no data (rate limited?)`);
}

// Caches the in-flight promise, so concurrent requests on a cold or expired cache share one upstream call.
function cached(key, path) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = getJson(path);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key); // don't cache failures
  });
  return promise;
}

/** 2-hour forecast for 47 areas: { validFrom, validTo, updated, areas: [{ name, point, forecast }] } */
export async function getTwoHour() {
  const data = await cached('2h', '/two-hr-forecast');
  const item = data.items[0];
  const byArea = new Map(item.forecasts.map((f) => [f.area, f.forecast]));
  return {
    validFrom: Date.parse(item.valid_period.start),
    validTo: Date.parse(item.valid_period.end),
    validText: item.valid_period.text,
    updated: item.update_timestamp,
    areas: data.area_metadata.map((a) => ({
      name: a.name,
      point: [a.label_location.latitude, a.label_location.longitude],
      forecast: byArea.get(a.name) ?? null,
    })),
  };
}

/** 24-hour forecast: 5 regions x ~3 periods: { updated, general, periods: [{ start, end, text, regions: {north: 'Showers', ...} }] } */
export async function getTwentyFourHour() {
  const data = await cached('24h', '/twenty-four-hr-forecast');
  const rec = data.records[0];
  return {
    updated: rec.updatedTimestamp,
    general: rec.general?.forecast?.text ?? null,
    periods: rec.periods.map((p) => ({
      start: Date.parse(p.timePeriod.start),
      end: Date.parse(p.timePeriod.end),
      text: p.timePeriod.text,
      regions: Object.fromEntries(Object.entries(p.regions).map(([k, v]) => [k, typeof v === 'string' ? v : v.text])),
    })),
  };
}

/** Latest 5-minute rainfall readings: { timestamp, stations: [{ id, name, point, mm }] } */
export async function getRainfall(at) {
  const path = at ? `/rainfall?date=${encodeURIComponent(at)}` : '/rainfall';
  const data = at ? await getJson(path) : await cached('rain', path);
  const reading = data.readings[0];
  const values = new Map((reading?.data ?? []).map((d) => [d.stationId, d.value]));
  return {
    timestamp: reading?.timestamp ?? null,
    stations: data.stations.map((s) => ({
      id: s.id,
      name: s.name,
      point: [s.location.latitude, s.location.longitude],
      mm: values.has(s.id) ? values.get(s.id) : null,
    })),
  };
}

export async function getAllWeather() {
  // Sequential on purpose: keeps us well inside the keyless rate limit on a cold cache.
  const twoHour = await getTwoHour();
  const twentyFour = await getTwentyFourHour();
  const rainfall = await getRainfall();
  return { twoHour, twentyFour, rainfall };
}
