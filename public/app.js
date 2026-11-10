// Rain Check SG front end: plain JS, no build step.
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = { from: null, to: null, lastResult: null };
const STORE_KEY = 'raincheck.trips.v1';

// ---------- storage (per-device convenience only) ----------
function loadTrips() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) ?? []; } catch { return []; }
}
function saveTrips(trips) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(trips)); } catch { /* private mode: fine, trips just won't persist */ }
}

// ---------- time helpers (always Singapore time) ----------
const SGT = 8 * 3600 * 1000;
function nextOccurrence(hhmm, now = Date.now()) {
  const [h, m] = hhmm.split(':').map(Number);
  const sg = new Date(now + SGT);
  let t = Date.UTC(sg.getUTCFullYear(), sg.getUTCMonth(), sg.getUTCDate(), h, m) - SGT;
  if (t < now - 10 * 60 * 1000) t += 24 * 3600 * 1000; // already passed today: use tomorrow
  return t;
}
function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Singapore' });
}
function dayWord(ms, now = Date.now()) {
  const d = (x) => new Date(x + SGT).toISOString().slice(0, 10);
  return d(ms) === d(now) ? 'today' : 'tomorrow';
}

// ---------- place search ----------
function setupPlace(role) {
  const wrap = $(`.place[data-role=${role}]`);
  const input = $('input', wrap);
  const list = $('.suggestions', wrap);
  let timer;
  let latest = 0; // only the newest search may update the list
  let results = [];
  let active = -1;

  const render = () => {
    list.innerHTML = results.map((r, i) => `<li role="option" data-i="${i}" aria-selected="${i === active}">${esc(r.label)}<small>${esc(r.address)}</small></li>`).join('');
  };
  const choose = (r) => {
    state[role] = r;
    input.value = r.label;
    results = [];
    render();
  };
  input.addEventListener('input', () => {
    state[role] = null;
    clearTimeout(timer);
    const q = input.value.trim();
    const seq = ++latest;
    if (q.length < 2) { results = []; return render(); }
    timer = setTimeout(async () => {
      try {
        const found = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
        if (seq !== latest) return; // a newer query is in flight or done
        results = found;
        active = -1;
        render();
      } catch { /* ignore network blips while typing */ }
    }, 250);
  });
  input.addEventListener('keydown', (e) => {
    if (!results.length) return;
    if (e.key === 'ArrowDown') { active = (active + 1) % results.length; render(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { active = (active - 1 + results.length) % results.length; render(); e.preventDefault(); }
    if (e.key === 'Enter' && active >= 0) { choose(results[active]); e.preventDefault(); }
    if (e.key === 'Escape') { results = []; render(); }
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (li) { choose(results[Number(li.dataset.i)]); e.preventDefault(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { results = []; render(); }, 150));
  return { choose, input };
}

const fromBox = setupPlace('from');
const toBox = setupPlace('to');

$('#locate').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('Location isn’t available in this browser.');
  fromBox.input.value = 'Finding you…';
  navigator.geolocation.getCurrentPosition(
    (pos) => fromBox.choose({ label: 'My location', address: '', lat: pos.coords.latitude, lon: pos.coords.longitude }),
    () => { fromBox.input.value = ''; alert('Couldn’t get your location. Type a place instead.'); },
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

$('#swap').addEventListener('click', () => {
  const f = state.from;
  const t = state.to;
  const fv = fromBox.input.value;
  fromBox.input.value = toBox.input.value;
  toBox.input.value = fv;
  state.from = t;
  state.to = f;
});

// ---------- when ----------
const timeInput = $('#time');
function updateWhen() {
  const later = $('input[name=when]:checked').value === 'later';
  timeInput.hidden = !later;
  if (later && !timeInput.value) {
    const t = new Date(Date.now() + SGT + 3600 * 1000);
    timeInput.value = `${String(t.getUTCHours()).padStart(2, '0')}:00`;
  }
  $('#day-hint').textContent = later && timeInput.value ? dayWord(nextOccurrence(timeInput.value)) : '';
}
document.querySelectorAll('input[name=when]').forEach((r) => r.addEventListener('change', updateWhen));
timeInput.addEventListener('input', updateWhen);

// ---------- check ----------
async function check(from, to, departAt, title) {
  const out = $('#result');
  const btn = $('#check-btn');
  btn.disabled = true;
  out.innerHTML = '<p class="loading">Checking the forecast along your route…</p>';
  try {
    const res = await fetch('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to, departAt }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Something went wrong');
    state.lastResult = body;
    renderResult(body, title);
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    out.innerHTML = `<div class="card"><p class="error">${esc(err.message)}</p></div>`;
  } finally {
    btn.disabled = false;
  }
}

$('#trip-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!state.from) return fromBox.input.focus(), alert('Pick a start from the suggestions (or use ◎ for your location).');
  if (!state.to) return toBox.input.focus(), alert('Pick a destination from the suggestions.');
  const later = $('input[name=when]:checked').value === 'later';
  const departAt = later && timeInput.value ? nextOccurrence(timeInput.value) : Date.now();
  check(state.from, state.to, departAt);
});

const EMOJI = { fine: '🌤️', light: '🌦️', heavy: '⛈️', unknown: '❔' };
const LEVEL_WORD = { fine: 'Dry', light: 'Light rain', heavy: 'Heavy rain', unknown: 'No forecast', trivial: 'Short', sheltered: 'Sheltered' };

function renderResult(r, title) {
  const when = Math.abs(r.departAt - Date.now()) < 5 * 60 * 1000 ? 'leaving now' : `leaving ${fmtTime(r.departAt)} ${dayWord(r.departAt)}`;
  const alts = r.alternatives.map((a) => `<li><strong>${esc(a.title)}</strong><span>${esc(a.detail)}</span>${a.link ? ` <a href="${esc(a.link)}" target="_blank" rel="noopener">Open in Google Maps</a>` : ''}</li>`).join('');

  const itins = r.itineraries.map((it, i) => `
    <details class="itin" ${i === r.primaryIndex ? 'open' : ''}>
      <summary><span class="badge ${it.level}">${LEVEL_WORD[it.level]}</span> <span>${esc(it.label)}</span></summary>
      <p class="hint">${it.durationMin} min total · ${it.walkMin} min walking${it.wetMin ? ` · ${it.wetMin} min of it in rain` : ''}${i === r.primaryIndex ? ' · fastest' : ''}</p>
      <ol class="legs">${it.legs.map((l) => `
        <li class="${l.level}">
          <strong>${esc(l.label)}</strong> · ${l.durationMin} min${l.mode === 'WALK' ? '' : ' (sheltered)'}
          ${l.from || l.to ? `<small>${esc(l.from)}${l.to ? ` → ${esc(l.to)}` : ''} · ${fmtTime(l.startTime)}</small>` : ''}
          ${l.mode === 'WALK' && !['trivial'].includes(l.level) ? l.forecasts.map((f) => `<small>${esc(f.place)}: ${esc(f.text ?? 'no forecast')}${f.source === '24h' ? ' (24-h outlook)' : ''}</small>`).join('') : ''}
        </li>`).join('')}
      </ol>
    </details>`).join('');

  $('#result').innerHTML = `
    <div class="verdict ${r.level}">
      <div class="emoji" aria-hidden="true">${EMOJI[r.level]}</div>
      <h2>${esc(r.headline)}</h2>
      <p>${esc(r.reason)}</p>
      ${r.rightNow ? `<p class="now">📡 ${esc(r.rightNow.text)}</p>` : ''}
      <p class="conf">${esc(r.confidenceText)}</p>
    </div>
    ${alts ? `<section class="card"><h2>What you could do</h2><ul class="alts">${alts}</ul></section>` : ''}
    <section class="card">
      <div class="trip-head"><h2>${esc(title || `${r.from.label} → ${r.to.label}`)}</h2><span>${esc(when)}</span></div>
      ${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}
      ${itins}
      <a class="primary maps" href="${esc(r.mapsLink)}" target="_blank" rel="noopener">Navigate in Google Maps</a>
      <button type="button" class="link-btn" id="save-trip">☆ Save this trip</button>
      <div id="save-slot"></div>
    </section>
    <p class="hint">Forecast window ${esc(r.sources.twoHour?.window ?? '–')}. Rain gauges as of ${r.sources.rainfall?.timestamp ? fmtTime(Date.parse(r.sources.rainfall.timestamp)) : '–'}.</p>`;

  $('#save-trip').addEventListener('click', () => openSave(r));
}

function openSave(r) {
  const slot = $('#save-slot');
  if (slot.firstChild) return;
  slot.append($('#save-dialog').content.cloneNode(true));
  const form = $('form', slot);
  form.name.value = `${r.from.label} → ${r.to.label}`.slice(0, 40);
  const sg = new Date(r.departAt + SGT);
  form.time.value = `${String(sg.getUTCHours()).padStart(2, '0')}:${String(sg.getUTCMinutes()).padStart(2, '0')}`;
  $('.cancel', form).addEventListener('click', () => (slot.innerHTML = ''));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const trips = loadTrips();
    trips.push({ id: crypto.randomUUID?.() ?? String(Date.now()), name: form.name.value.trim(), time: form.time.value, from: r.from, to: r.to });
    saveTrips(trips);
    slot.innerHTML = '<p class="hint">Saved. It’s at the top of the page now.</p>';
    renderSaved();
  });
}

function renderSaved() {
  const trips = loadTrips();
  $('#saved-section').hidden = trips.length === 0;
  $('#saved').innerHTML = trips.map((t) => `
    <li data-id="${esc(t.id)}">
      <div class="info"><strong>${esc(t.name)}</strong><span>${esc(t.time)} · ${esc(t.from.label)} → ${esc(t.to.label)}</span></div>
      <button class="go" data-act="now">Now</button>
      <button class="go" data-act="usual">${esc(t.time)}</button>
      <button class="link-btn" data-act="del" aria-label="Delete trip">✕</button>
    </li>`).join('');
}

$('#saved').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  const trips = loadTrips();
  const t = trips.find((x) => x.id === id);
  if (!t) return;
  if (btn.dataset.act === 'del') {
    if (confirm(`Delete “${t.name}”?`)) saveTrips(trips.filter((x) => x.id !== id));
    return renderSaved();
  }
  const departAt = btn.dataset.act === 'now' ? Date.now() : nextOccurrence(t.time);
  check(t.from, t.to, departAt, t.name);
});

renderSaved();
updateWhen();
fetch('/api/status').then((r) => r.json()).then((s) => {
  if (s.routing === 'osrm') $('#routing-credit').innerHTML = ' · Walking routes: <a href="https://routing.openstreetmap.de" target="_blank" rel="noopener">FOSSGIS OSRM</a>, © OpenStreetMap contributors';
  if (s.routing === 'ors') $('#routing-credit').innerHTML = ' · Walking routes: <a href="https://openrouteservice.org" target="_blank" rel="noopener">openrouteservice</a>, © OpenStreetMap contributors';
}).catch(() => {});
