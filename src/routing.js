// Routing, normalised into one itinerary shape:
// { label, durationMin, startTime, endTime, walkOnly, legs: [{ mode, label, from, to, startTime, endTime, durationMin, distanceM, points }] }
// Times are epoch ms. Points are [lat, lon].
//
// Provider chain (all free, no card). Each step falls through to the next if it fails:
//   1. OneMap public-transport routing (bus + MRT)      needs ONEMAP_EMAIL/ONEMAP_PASSWORD or ONEMAP_TOKEN (server only)
//   2. Transitous public-transport routing (bus + MRT)  no key; community service for open-source, non-commercial apps
//   3. OpenRouteService walking                         needs ORS_API_KEY
//   4. Public OSRM demo server walking (FOSSGIS)        no key, demo use only

import { decodePolyline } from './polyline.js';
import { userError } from './errors.js';

const ONEMAP = 'https://www.onemap.gov.sg';
const TRANSITOUS = 'https://api.transitous.org/api/v1/plan';
// Transitous asks API users to identify themselves with an app name, version and contact (User-Agent in Node;
// browsers send the page as Referer instead, and the page shows contact details).
const UA = 'raincheck-sg/0.1 (+https://github.com/Ongzl/raincheck-sg)';
// Runs in Node (server) and in the browser (GitHub Pages build). Browsers have no process.env and set their own User-Agent.
const env = globalThis.process?.env ?? {};
const UA_HEADER = globalThis.process?.versions?.node ? { 'User-Agent': UA } : {};
let token = null; // { value, expiresAt, scheme }

/** The first-choice routing source; getItineraries falls back down the chain if it fails. */
export function routingProvider() {
  if ((env.ONEMAP_EMAIL && env.ONEMAP_PASSWORD) || env.ONEMAP_TOKEN) return 'onemap';
  return 'transitous';
}

// ---------- place search (OneMap search works without a token) ----------

export async function searchPlaces(query) {
  const url = `${ONEMAP}/api/common/elastic/search?searchVal=${encodeURIComponent(query)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const res = await fetch(url, { headers: { ...UA_HEADER } });
  if (res.status === 429) throw userError('Place search is busy. Wait a few seconds and try again.', 503);
  if (!res.ok) throw new Error(`OneMap search returned ${res.status}`);
  const body = await res.json();
  return (body.results ?? []).slice(0, 6).map((r) => ({
    label: titleCase(r.BUILDING && r.BUILDING !== 'NIL' ? r.BUILDING : r.SEARCHVAL),
    address: titleCase(r.ADDRESS),
    lat: Number(r.LATITUDE),
    lon: Number(r.LONGITUDE),
  }));
}

function titleCase(s = '') {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Mrt|Lrt|Hdb|Nus|Ntu|Smu|Sutd|Sim|Ite|Cbd|Ubs)\b/g, (m) => m.toUpperCase());
}

// ---------- OneMap public transport ----------

async function oneMapToken() {
  if (env.ONEMAP_TOKEN) {
    if (!token) token = { value: env.ONEMAP_TOKEN, expiresAt: Infinity, scheme: '' };
    return token;
  }
  if (token && token.expiresAt - Date.now() > 10 * 60 * 1000) return token;
  const res = await fetch(`${ONEMAP}/api/auth/post/getToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...UA_HEADER },
    body: JSON.stringify({ email: env.ONEMAP_EMAIL, password: env.ONEMAP_PASSWORD }),
  });
  if (!res.ok) throw new Error(`OneMap login failed (${res.status}). Check ONEMAP_EMAIL / ONEMAP_PASSWORD.`);
  const body = await res.json();
  token = {
    value: body.access_token,
    expiresAt: Number(body.expiry_timestamp) * 1000 || Date.now() + 24 * 3600 * 1000,
    scheme: '',
  };
  return token;
}

/** OneMap wants Singapore-local date (MM-DD-YYYY) and time (HH:MM:SS). */
export function sgtDateTime(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${d.getUTCFullYear()}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`,
  };
}

async function oneMapPublicTransport(from, to, departAt) {
  const { date, time } = sgtDateTime(departAt);
  const url =
    `${ONEMAP}/api/public/routingsvc/route?start=${from.lat},${from.lon}&end=${to.lat},${to.lon}` +
    `&routeType=pt&date=${date}&time=${encodeURIComponent(time)}&mode=TRANSIT&maxWalkDistance=1000&numItineraries=3`;
  // A cached token can be revoked before it expires: on rejection, log in again once and retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await oneMapToken();
    // The docs and community clients disagree on whether a "Bearer " prefix is needed, so try both
    // the first time and remember whichever works.
    for (const scheme of tok.schemeKnown ? [tok.scheme] : ['', 'Bearer ']) {
      const res = await fetch(url, { headers: { Authorization: scheme + tok.value, ...UA_HEADER } });
      if (res.status === 401 || res.status === 403) continue;
      if (!res.ok) throw new Error(`OneMap routing returned ${res.status}`);
      tok.scheme = scheme;
      tok.schemeKnown = true;
      return parseOneMapPlan(await res.json());
    }
    if (env.ONEMAP_TOKEN) break; // a fixed token can't be refreshed
    token = null;
  }
  throw new Error('OneMap rejected the token (401). Check your OneMap account.');
}

const MODE_NAMES = { WALK: 'Walk', BUS: 'Bus', SUBWAY: 'MRT', RAIL: 'MRT', TRAM: 'LRT' };

/** Leg path; if the router leaves out the geometry, fall back to the leg's start and end points. */
function legPoints(leg) {
  if (leg.legGeometry?.points) return decodePolyline(leg.legGeometry.points, Number(leg.legGeometry.precision) || 5);
  const ends = [leg.from, leg.to].filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lon)));
  return ends.map((p) => [Number(p.lat), Number(p.lon)]);
}

// Both OneMap and Transitous return OpenTripPlanner-style plans: itineraries made of legs.
// OneMap gives times as epoch ms; Transitous as ISO strings. Date.parse/Number handle both.
const toMs = (t) => (typeof t === 'number' || /^\d+$/.test(String(t)) ? Number(t) : Date.parse(t));
const BIG_MODES = { METRO: 'SUBWAY', RAIL: 'SUBWAY', SUBWAY: 'SUBWAY', LIGHT_RAIL: 'TRAM', TRAM: 'TRAM', COACH: 'BUS', BUS: 'BUS' };

function parsePlanItineraries(itineraries) {
  return itineraries.map((it) => {
    const legs = it.legs.map((leg) => {
      const mode = leg.mode === 'WALK' ? 'WALK' : BIG_MODES[leg.mode] ?? leg.mode;
      const route = leg.routeShortName || leg.route || '';
      return {
        mode,
        label: mode === 'WALK' ? 'Walk' : `${MODE_NAMES[mode] ?? mode} ${route}`.trim(),
        from: leg.from?.name ?? '',
        to: leg.to?.name ?? '',
        startTime: toMs(leg.startTime),
        endTime: toMs(leg.endTime),
        durationMin: Number(leg.duration) / 60,
        distanceM: Number(leg.distance) || 0,
        points: legPoints(leg),
      };
    });
    const rides = legs.filter((l) => l.mode !== 'WALK').map((l) => l.label);
    return {
      label: rides.length ? rides.join(' → ') : 'Walk all the way',
      durationMin: Number(it.duration) / 60,
      startTime: toMs(it.startTime),
      endTime: toMs(it.endTime),
      walkOnly: rides.length === 0,
      legs,
    };
  });
}

export function parseOneMapPlan(body) {
  return parsePlanItineraries(body?.plan?.itineraries ?? []);
}

/** Transitous returns the next few departures, often of the same route: keep the earliest of each distinct route. */
export function parseTransitousPlan(body) {
  const seen = new Set();
  return parsePlanItineraries(body?.itineraries ?? []).filter((it) => {
    if (seen.has(it.label)) return false;
    seen.add(it.label);
    return true;
  });
}

// ---------- Transitous public transport (keyless, works from a browser) ----------

async function transitousPublicTransport(from, to, departAt) {
  const url =
    `${TRANSITOUS}?fromPlace=${from.lat},${from.lon}&toPlace=${to.lat},${to.lon}` +
    `&time=${encodeURIComponent(new Date(departAt).toISOString())}&numItineraries=5`;
  const res = await fetch(url, { headers: { ...UA_HEADER } });
  if (!res.ok) throw new Error(`Transitous returned ${res.status}`);
  return parseTransitousPlan(await res.json());
}

// ---------- walking-only fallbacks ----------

function walkItinerary(points, durationS, distanceM, from, to, departAt) {
  const leg = {
    mode: 'WALK',
    label: 'Walk',
    from: from.label ?? '',
    to: to.label ?? '',
    startTime: departAt,
    endTime: departAt + durationS * 1000,
    durationMin: durationS / 60,
    distanceM,
    points,
  };
  return [{ label: 'Walk all the way', durationMin: durationS / 60, startTime: leg.startTime, endTime: leg.endTime, walkOnly: true, legs: [leg] }];
}

async function orsWalk(from, to, departAt) {
  const url = `https://api.openrouteservice.org/v2/directions/foot-walking?api_key=${env.ORS_API_KEY}&start=${from.lon},${from.lat}&end=${to.lon},${to.lat}`;
  const res = await fetch(url, { headers: { ...UA_HEADER } });
  if (!res.ok) throw new Error(`OpenRouteService returned ${res.status}`);
  const f = (await res.json()).features[0];
  const points = f.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  return walkItinerary(points, f.properties.summary.duration, f.properties.summary.distance, from, to, departAt);
}

async function osrmWalk(from, to, departAt) {
  const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=polyline&steps=false`;
  const res = await fetch(url, { headers: { ...UA_HEADER } });
  if (!res.ok) throw new Error(`OSRM demo server returned ${res.status}`);
  const r = (await res.json()).routes?.[0];
  if (!r) throw userError('No walking route found for this trip.');
  return walkItinerary(decodePolyline(r.geometry), r.duration, r.distance, from, to, departAt);
}

/** Returns { provider, itineraries, note } */
export async function getItineraries(from, to, departAt) {
  // Routers name the trip ends "Origin"/"Destination" or "START"/"END" and stops in capitals: use the user's names.
  const ENDS = { Origin: from.label, START: from.label, Destination: to.label, END: to.label };
  const tidy = (itineraries) => {
    for (const it of itineraries) {
      for (const l of it.legs) Object.assign(l, { from: ENDS[l.from] ?? titleCase(l.from), to: ENDS[l.to] ?? titleCase(l.to) });
    }
    return itineraries;
  };

  const transit = [];
  if (routingProvider() === 'onemap') transit.push(['onemap', oneMapPublicTransport]);
  transit.push(['transitous', transitousPublicTransport]);
  let found = false;
  for (const [provider, plan] of transit) {
    try {
      const itineraries = await plan(from, to, departAt);
      if (itineraries.length) return { provider, itineraries: tidy(itineraries), note: null };
      found = true; // the router worked but had no bus/MRT option
    } catch (err) {
      // Don't let one router's outage take the whole app down: try the next one, then walking.
      console.error(`${provider} routing failed:`, err.message);
    }
  }

  const note = found
    ? 'No bus or MRT option found for this trip, so this is a walking-only route.'
    : 'Bus and MRT options are unavailable right now, so this is a walking-only route.';
  if (env.ORS_API_KEY) return { provider: 'ors', itineraries: await orsWalk(from, to, departAt), note };
  return { provider: 'osrm', itineraries: await osrmWalk(from, to, departAt), note };
}
