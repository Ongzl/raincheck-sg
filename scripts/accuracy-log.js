#!/usr/bin/env node
// Two-week accuracy log: is the forecast good enough for a 10-20 minute walk?
//
//   npm run log -- predict "Bishan MRT" "Junction 8"     record what the app predicts if you leave now
//   npm run log -- observe                                after the walk: fetch what the rain gauges measured
//   npm run log -- observe --felt heavy [--id 3]          ...and record what you felt on the latest (or given) trip
//   npm run log -- report                                 match rate vs the 70% target
//
// Entries are stored in data/accuracy-log.json (git-ignored: it's your personal travel log).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const { runCheck } = await import('../src/check.js');
const { searchPlaces } = await import('../src/routing.js');
const { getRainfall } = await import('../src/weather.js');
const { samplePath, nearest } = await import('../src/geo.js');
const { LEVELS, observedLevel } = await import('../src/verdict.js');

const FILE = 'data/accuracy-log.json';
const TARGET = 0.7;
const load = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : []);
const save = (log) => { mkdirSync('data', { recursive: true }); writeFileSync(FILE, JSON.stringify(log, null, 2)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sgtIso(ms) {
  // Rainfall API wants Singapore-local time, rounded down to a 5-minute reading.
  const rounded = Math.floor(ms / 300000) * 300000;
  return new Date(rounded + 8 * 3600 * 1000).toISOString().slice(0, 19);
}

async function place(q) {
  const [hit] = await searchPlaces(q);
  if (!hit) throw new Error(`No place found for "${q}"`);
  return hit;
}

async function predict(fromQ, toQ) {
  const from = await place(fromQ);
  const to = await place(toQ);
  const r = await runCheck({ from, to, departAt: Date.now() });
  const primary = r._itineraries[r.primaryIndex];
  const walks = primary.legs
    .filter((l) => l.mode === 'WALK' && l.durationMin >= 1)
    .map((l) => ({ startTime: l.startTime, endTime: l.endTime, points: samplePath(l.points, 300).map((s) => s.point) }));
  const log = load();
  log.push({ id: log.length + 1, createdAt: new Date().toISOString(), from: from.label, to: to.label, predicted: r.level, confidence: r.confidence, reason: r.reason, walks, observed: null, felt: null });
  save(log);
  console.log(`#${log.length} ${from.label} -> ${to.label}: predicted ${r.level} (${r.confidence})\n  ${r.reason}\nAfter your walk, run: npm run log -- observe --felt dry|light|heavy`);
}

async function observe(felt, id) {
  const log = load();
  // --felt describes one specific trip: the one given by --id, or else the most recently logged trip.
  const feltTarget = felt ? (id ? log.find((e) => e.id === id) : log.at(-1)) : null;
  if (felt && !feltTarget) throw new Error(`No logged trip #${id}`);
  if (feltTarget) {
    feltTarget.felt = felt;
    console.log(`#${feltTarget.id} ${feltTarget.from} -> ${feltTarget.to}: you felt ${felt}`);
  }
  const pending = log.filter((e) => !e.observed && e.walks.every((w) => w.endTime < Date.now()));
  if (!pending.length) {
    save(log);
    return console.log('No gauge readings to fetch (walks still in progress, or all done).');
  }
  for (const e of pending) {
    if (!e.walks.length) {
      e.observed = 'no walking'; // nothing exposed to check; excluded from the report
      continue;
    }
    let max = null;
    for (const w of e.walks) {
      for (let t = w.startTime; t <= w.endTime + 299999; t += 300000) {
        const rain = await getRainfall(sgtIso(t));
        const stations = rain.stations.filter((s) => s.mm != null);
        for (const p of w.points) {
          const near = nearest(p, stations, (s) => s.point);
          if (near && near.distance <= 3000) max = Math.max(max ?? 0, near.item.mm);
        }
        await sleep(1800); // stay under 6 requests / 10 s
      }
    }
    const lvl = observedLevel(max);
    e.observed = lvl == null ? 'no gauge nearby' : LEVELS[lvl];
    e.observedMaxMm = max;
    console.log(`#${e.id} predicted ${e.predicted}, gauges measured ${e.observed} (max ${max ?? '-'} mm / 5 min)${e.felt ? `, you felt ${e.felt}` : ''}`);
  }
  save(log);
}

function report() {
  const done = load().filter((e) => e.observed && LEVELS.includes(e.observed) && e.predicted !== 'unknown');
  if (!done.length) return console.log('No observed trips yet.');
  const truth = (e) => e.felt ?? e.observed;
  const exact = done.filter((e) => e.predicted === truth(e)).length;
  const wetDry = done.filter((e) => (e.predicted !== 'fine') === (truth(e) !== 'fine')).length;
  console.table(done.map((e) => ({ id: e.id, trip: `${e.from} -> ${e.to}`, when: e.createdAt.slice(0, 16), predicted: e.predicted, gauges: e.observed, felt: e.felt ?? '' })));
  const pct = (n) => `${Math.round((n / done.length) * 100)}%`;
  console.log(`Trips: ${done.length}`);
  console.log(`Exact level match: ${pct(exact)}`);
  console.log(`Wet vs dry match:  ${pct(wetDry)}  (target ${TARGET * 100}%: ${wetDry / done.length >= TARGET ? 'PASS' : 'not yet'})`);
}

const [cmd, ...rest] = process.argv.slice(2);
const feltIdx = rest.indexOf('--felt');
const felt = feltIdx >= 0 ? rest[feltIdx + 1] : null;
if (felt && !LEVELS.includes(felt === 'dry' ? 'fine' : felt)) throw new Error('--felt must be dry, light or heavy');
const idIdx = rest.indexOf('--id');
const id = idIdx >= 0 ? Number(rest[idIdx + 1]) : null;

if (cmd === 'predict' && rest.length >= 2) await predict(rest[0], rest[1]);
else if (cmd === 'observe') await observe(felt === 'dry' ? 'fine' : felt, id);
else if (cmd === 'report') report();
else {
  console.log('Usage:\n  npm run log -- predict "<from>" "<to>"\n  npm run log -- observe [--felt dry|light|heavy] [--id N]\n  npm run log -- report');
}
