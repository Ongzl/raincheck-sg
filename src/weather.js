// Fetches and caches NEA weather data from data.gov.sg (free, no key needed).
// Keyless limit is 6 requests per 10 seconds per IP address, so everything is cached
// (in memory, and in the browser's sessionStorage so a page reload doesn't refetch).

import { userError } from './errors.js';

const BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
const CACHE_MS = 5 * 60 * 1000;
const env = globalThis.process?.env ?? {}; // empty in the browser
const RETRY_MS = Number(env.RAINCHECK_RETRY_MS ?? 2000);
const cache = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path) {
  const headers = {};
  if (env.DATA_GOV_SG_API_KEY) headers['x-api-key'] = env.DATA_GOV_SG_API_KEY;
  // Back off for ~12 s in total: long enough for the 10-second rate-limit window to pass.
  const waits = [0, 1, 2, 3].map((n) => n * RETRY_MS);
  for (const wait of waits) {
    if (wait) await sleep(wait);
    let res;
    try {
      res = await fetch(BASE + path, { headers });
    } catch {
      // data.gov.sg's "429 Too Many Requests" reply has no CORS header, so in a browser it
      // surfaces as a network error rather than a 429. Treat it as rate limiting and retry.
      continue;
    }
    if (res.status === 429) continue;
    if (!res.ok) throw new Error(`data.gov.sg ${path} returned ${res.status}`);
    const body = await res.json();
    // When rate-limited the API sometimes answers 200 with data: null.
    if (body.data) return body.data;
  }
  throw userError('The weather service is busy right now (too many requests from your network). Try again in about 10 seconds.', 503);
}

// Browser only: survive page reloads. Wrapped in try/catch because storage can be blocked.
const store = typeof globalThis.sessionStorage === 'object' ? globalThis.sessionStorage : null;
function readStored(key) {
  try {
    const hit = JSON.parse(store?.getItem(`raincheck.wx.${key}`) ?? 'null');
    return hit && Date.now() - hit.at < CACHE_MS ? hit : null;
  } catch {
    return null;
  }
}
function writeStored(key, at, data) {
  try {
    store?.setItem(`raincheck.wx.${key}`, JSON.stringify({ at, data }));
  } catch {
    /* full or blocked: fine, the in-memory cache still works */
  }
}

// Caches the in-flight promise, so concurrent requests on a cold or expired cache share one upstream call.
function cached(key, path) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const stored = readStored(key);
  if (stored) {
    const promise = Promise.resolve(stored.data);
    cache.set(key, { at: stored.at, promise });
    return promise;
  }
  const at = Date.now();
  const promise = getJson(path);
  cache.set(key, { at, promise });
  promise.then(
    (data) => writeStored(key, at, data),
    () => {
      if (cache.get(key)?.promise === promise) cache.delete(key); // don't cache failures
    },
  );
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
  // Each source is optional on its own; the check only fails if neither forecast loads.
  const attempt = (fn) => fn().then((value) => ({ value }), (error) => ({ error }));
  const twoHour = await attempt(getTwoHour);
  const twentyFour = await attempt(getTwentyFourHour);
  const rainfall = await attempt(getRainfall);
  if (twoHour.error && twentyFour.error) throw twoHour.error;
  for (const [name, r] of Object.entries({ twoHour, twentyFour, rainfall })) {
    if (r.error) console.warn(`Weather source ${name} unavailable:`, r.error.message);
  }
  return { twoHour: twoHour.value ?? null, twentyFour: twentyFour.value ?? null, rainfall: rainfall.value ?? null };
}
