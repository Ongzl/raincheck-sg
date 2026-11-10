// Tiny zero-dependency server: serves the web app and two JSON endpoints.
//   GET  /api/search?q=bishan          place search (OneMap)
//   POST /api/check {from, to, departAt}  the rain check
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

if (existsSync('.env')) process.loadEnvFile('.env');

const { runCheck } = await import('./src/check.js');
const { searchPlaces, routingProvider } = await import('./src/routing.js');

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 10_000) throw new Error('Request too large');
  }
  return JSON.parse(s || '{}');
}

function validPlace(p) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat > 1.1 && p.lat < 1.5 && p.lon > 103.5 && p.lon < 104.1;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (q.length < 2) return send(res, 200, []);
      return send(res, 200, await searchPlaces(q));
    }
    if (url.pathname === '/api/status') {
      return send(res, 200, { routing: routingProvider() });
    }
    if (url.pathname === '/api/check' && req.method === 'POST') {
      const { from, to, departAt } = await readBody(req);
      if (!validPlace(from) || !validPlace(to)) return send(res, 400, { error: 'Pick a start and destination in Singapore.' });
      const when = Number(departAt) || Date.now();
      if (when > Date.now() + 36 * 3600 * 1000) return send(res, 400, { error: 'Forecasts only reach about 24 hours ahead.' });
      const { _itineraries, ...result } = await runCheck({ from, to, departAt: when });
      return send(res, 200, result);
    }
    // Static files
    const path = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC, path);
    if (!file.startsWith(PUBLIC) || !existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream');
  } catch (err) {
    console.error(err);
    return send(res, 502, { error: err.message });
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`Rain Check SG running at http://localhost:${port}  (routing: ${routingProvider()})`);
});
