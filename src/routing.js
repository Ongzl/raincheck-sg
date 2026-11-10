// Routing, normalised into one itinerary shape:
// { label, durationMin, startTime, endTime, walkOnly, legs: [{ mode, label, from, to, startTime, endTime, durationMin, distanceM, points }] }
// Times are epoch ms. Points are [lat, lon].
//
// Provider chain (all free, no card):
//   1. OneMap public-transport routing (bus + MRT, several itineraries)  needs ONEMAP_EMAIL/ONEMAP_PASSWORD
//   2. OpenRouteService walking                                          needs ORS_API_KEY
//   3. Public OSRM demo server walking (FOSSGIS)                         no key, demo use only

import { decodePolyline } from './polyline.js';

const ONEMAP = 'https://www.onemap.gov.sg';
const UA = 'raincheck-sg-prototype (student project)';
let token = null; // { value, expiresAt, scheme }

export function routingProvider() {
  if ((process.env.ONEMAP_EMAIL && process.env.ONEMAP_PASSWORD) || process.env.ONEMAP_TOKEN) return 'onemap';
  if (process.env.ORS_API_KEY) return 'ors';
  return 'osrm';
}

// ---------- place search (OneMap search works without a token) ----------

export async function searchPlaces(query) {
  const url = `${ONEMAP}/api/common/elastic/search?searchVal=${encodeURIComponent(query)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
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
  if (process.env.ONEMAP_TOKEN) return { value: process.env.ONEMAP_TOKEN, scheme: token?.scheme ?? '' };
  if (token && token.expiresAt - Date.now() > 10 * 60 * 1000) return token;
  const res = await fetch(`${ONEMAP}/api/auth/post/getToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ email: process.env.ONEMAP_EMAIL, password: process.env.ONEMAP_PASSWORD }),
  });
  if (!res.ok) throw new Error(`OneMap login failed (${res.status}). Check ONEMAP_EMAIL / ONEMAP_PASSWORD.`);
  const body = await res.json();
  token = {
    value: body.access_token,
    expiresAt: Number(body.expiry_timestamp) * 1000 || Date.now() + 24 * 3600 * 1000,
    scheme: token?.scheme ?? '',
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
  const tok = await oneMapToken();
  // The docs and community clients disagree on whether a "Bearer " prefix is needed, so try both.
  for (const scheme of tok.scheme ? [tok.scheme] : ['', 'Bearer ']) {
    const res = await fetch(url, { headers: { Authorization: scheme + tok.value, 'User-Agent': UA } });
    if (res.status === 401 || res.status === 403) continue;
    if (!res.ok) throw new Error(`OneMap routing returned ${res.status}`);
    if (token) token.scheme = scheme;
    return parseOneMapPlan(await res.json());
  }
  throw new Error('OneMap rejected the token (401). Check your OneMap account.');
}

const MODE_NAMES = { WALK: 'Walk', BUS: 'Bus', SUBWAY: 'MRT', RAIL: 'MRT', TRAM: 'LRT' };

export function parseOneMapPlan(body) {
  const itineraries = body?.plan?.itineraries ?? [];
  return itineraries.map((it) => {
    const legs = it.legs.map((leg) => {
      const mode = leg.mode === 'WALK' ? 'WALK' : leg.mode;
      const route = leg.routeShortName || leg.route || '';
      return {
        mode,
        label: mode === 'WALK' ? 'Walk' : `${MODE_NAMES[mode] ?? mode} ${route}`.trim(),
        from: leg.from?.name ?? '',
        to: leg.to?.name ?? '',
        startTime: Number(leg.startTime),
        endTime: Number(leg.endTime),
        durationMin: Number(leg.duration) / 60,
        distanceM: Number(leg.distance) || 0,
        points: leg.legGeometry?.points ? decodePolyline(leg.legGeometry.points) : [],
      };
    });
    const rides = legs.filter((l) => l.mode !== 'WALK').map((l) => l.label);
    return {
      label: rides.length ? rides.join(' → ') : 'Walk all the way',
      durationMin: Number(it.duration) / 60,
      startTime: Number(it.startTime),
      endTime: Number(it.endTime),
      walkOnly: rides.length === 0,
      legs,
    };
  });
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
  const url = `https://api.openrouteservice.org/v2/directions/foot-walking?api_key=${process.env.ORS_API_KEY}&start=${from.lon},${from.lat}&end=${to.lon},${to.lat}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`OpenRouteService returned ${res.status}`);
  const f = (await res.json()).features[0];
  const points = f.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  return walkItinerary(points, f.properties.summary.duration, f.properties.summary.distance, from, to, departAt);
}

async function osrmWalk(from, to, departAt) {
  const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=polyline&steps=false`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`OSRM demo server returned ${res.status}`);
  const r = (await res.json()).routes?.[0];
  if (!r) throw new Error('No walking route found');
  return walkItinerary(decodePolyline(r.geometry), r.duration, r.distance, from, to, departAt);
}

/** Returns { provider, itineraries, note } */
export async function getItineraries(from, to, departAt) {
  const provider = routingProvider();
  if (provider === 'onemap') {
    const itineraries = await oneMapPublicTransport(from, to, departAt);
    if (itineraries.length) return { provider, itineraries, note: null };
  }
  const note = 'Walking-only route: add a free OneMap account to compare bus and MRT options.';
  if (provider === 'ors' || (provider === 'onemap' && process.env.ORS_API_KEY)) {
    return { provider: 'ors', itineraries: await orsWalk(from, to, departAt), note };
  }
  return { provider: 'osrm', itineraries: await osrmWalk(from, to, departAt), note };
}
