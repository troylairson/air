import {
  parseFeed, filterAircraft, parseRoute, pickLeg, isPrivateFlight, modelName, airlineCode, parseAirline,
  normalizeCallsign, routeFiles, airportFile, findRouteCodes, parseAirports, distanceNm,
} from './adapter.js';
import { createMap } from './map.js';

const DEFAULTS = {
  radiusNm: 3,
  fetchRadiusMultiplier: 2,
  altitudeFt: { min: 0, max: 45000 },
  units: { altitude: 'ft', speed: 'kt', distance: 'nm' },
  refreshSeconds: 5,
  listCount: 5,
  sources: ['/api/aircraft/{lat}/{lon}/{radius}'],
  standingDataUrl: '/api/sd', // community route data (GitHub, via nginx); '' to use adsbdb only
  routeUrl: '/api/route/{callsign}',
  airlineUrl: '/api/airline/{code}',
  clock24h: true,
  night: { enabled: false, start: '23:00', end: '06:30', brightness: 0.25 },
  map: {
    enabled: true,
    // OpenStreetMap's own tiles: free, no API key. They're light, so darkTiles inverts them
    // to match the page; turn it off for tiles that are already dark.
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    darkTiles: true,
    tileBrightness: 0.9, // with darkTiles: higher is a lighter map
    planeColor: '#ffd23f', // gold: a hue the map itself never uses
    viewRadiusNm: 4, // how far from home the map shows at rest
    recenterSeconds: 60, // after you drag or zoom, return to the home view this long after
    trailMinutes: 15,
  },
};

const FETCH_TIMEOUT_MS = 8000;
const ROUTE_RETRY_MS = 5 * 60 * 1000;

const state = {
  config: null,
  aircraft: null, // last good list, filtered and sorted
  lastUpdate: null,
  stale: false,
  error: null,
  routes: new Map(), // callsign -> { route, retryAt }
  airlines: new Map(), // ICAO code -> { name, retryAt }
  selected: null, // hex of the plane clicked on the map, shown in the card instead of the closest
  map: null, // see map.js; null when disabled
  view: null, // { lat, lon, radiusNm } of the map when it shows more than the home area, else null
  viewAircraft: [], // everything in that view (filtered like state.aircraft), for the map only
};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------------------------------------------------------- config

async function loadConfig() {
  const res = await fetch('config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`config.json: HTTP ${res.status}`);
  const user = await res.json();
  const config = {
    ...DEFAULTS,
    ...user,
    altitudeFt: { ...DEFAULTS.altitudeFt, ...user.altitudeFt },
    units: { ...DEFAULTS.units, ...user.units },
    night: { ...DEFAULTS.night, ...user.night },
    map: { ...DEFAULTS.map, ...user.map },
  };
  if (typeof config.home?.lat !== 'number' || typeof config.home?.lon !== 'number') {
    throw new Error('config.json needs home.lat and home.lon');
  }
  return config;
}

// ---------------------------------------------------------------- units

const UNIT = {
  altitude: { ft: [1, 'ft'], m: [0.3048, 'm'] },
  speed: { kt: [1, 'kt'], mph: [1.15078, 'mph'], kmh: [1.852, 'km/h'] },
  distance: { nm: [1, 'nm'], mi: [1.15078, 'mi'], km: [1.852, 'km'] },
};

function fmt(kind, value, digits = 0) {
  if (value === null || value === undefined) return '–';
  const [factor, label] = UNIT[kind][state.config.units[kind]] ?? UNIT[kind][DEFAULTS.units[kind]];
  const v = value * factor;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${label}`;
}

// ---------------------------------------------------------------- data

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    return { status: res.status, ok: res.ok, json: res.ok || res.status === 404 ? await res.json().catch(() => null) : null };
  } finally {
    clearTimeout(timer);
  }
}

const homeArea = () => {
  const { home, radiusNm, fetchRadiusMultiplier } = state.config;
  return { lat: home.lat, lon: home.lon, radiusNm: radiusNm * fetchRadiusMultiplier };
};

function sourceUrl(template, area) {
  return template
    .replace('{lat}', area.lat.toFixed(4))
    .replace('{lon}', area.lon.toFixed(4))
    .replace('{radius}', String(Math.ceil(area.radiusNm)));
}

// Tries each source in order; the first one that answers wins.
async function fetchAircraft(area = homeArea(), templates = state.config.sources) {
  let lastError;
  for (const template of templates) {
    try {
      const { ok, status, json } = await fetchJson(sourceUrl(template, area));
      if (!ok) throw new Error(`HTTP ${status}`);
      return parseFeed(json, state.config.home);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('No data sources configured');
}

// A standing-data CSV file, fetched once per page load and shared: its text, or null if it
// doesn't exist (404). Network errors throw and aren't remembered, so they're retried later.
const sdFiles = new Map();
function sdFile(path) {
  if (!sdFiles.has(path)) {
    const load = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(`${state.config.standingDataUrl}/${path}`, { signal: ctrl.signal });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    })();
    load.catch(() => sdFiles.delete(path));
    sdFiles.set(path, load);
  }
  return sdFiles.get(path);
}

// Route from the standing data: { route } (route null if it isn't listed). Throws on network errors.
async function standingDataRoute(callsign) {
  const norm = normalizeCallsign(callsign);
  if (!norm) return { route: null };
  let codes = null;
  for (const file of routeFiles(norm)) {
    const text = await sdFile(file);
    if (text !== null) {
      codes = findRouteCodes(text, norm.callsign);
      break; // the airline's routes are all in the first file that exists
    }
  }
  if (!codes) return { route: null };
  const files = [...new Set(codes.map(airportFile))];
  const tables = await Promise.all(files.map(async (f) => parseAirports((await sdFile(f)) ?? '')));
  const lookup = (code) => tables.map((t) => t.get(code)).find(Boolean) ?? { code, city: null, name: null, lat: null, lon: null };
  return { route: { airline: null, flightNumber: null, airports: codes.map(lookup), source: 'standing-data' } };
}

// Route for a callsign: the community standing data first (updated daily, multi-leg), then
// adsbdb. Either can be stale; pickLeg() checks the result against where the plane actually is.
async function lookupRoute(a) {
  const { callsign } = a;
  const cached = state.routes.get(callsign);
  if (cached && (cached.route !== undefined || Date.now() < cached.retryAt)) return;
  state.routes.set(callsign, { route: undefined, retryAt: Date.now() + ROUTE_RETRY_MS });
  let route = null;
  let answered = false; // a source said "unknown" (rather than failing): don't ask again
  if (state.config.standingDataUrl) {
    try {
      ({ route } = await standingDataRoute(callsign));
      answered = true;
    } catch {
      // try adsbdb
    }
  }
  if (!route) {
    try {
      const { ok, status, json } = await fetchJson(state.config.routeUrl.replace('{callsign}', encodeURIComponent(callsign)));
      if (ok) route = parseRoute(json);
      answered ||= ok || status === 404;
    } catch {
      // network error
    }
  }
  if (route || answered) state.routes.set(callsign, { route }); // else retried after ROUTE_RETRY_MS
  // No route, or a route without an airline: name the airline from the callsign's prefix instead.
  const code = airlineCode(callsign);
  if (code && !route?.airline) await lookupAirline(code);
  render();
}

async function lookupAirline(code) {
  const cached = state.airlines.get(code);
  if (cached && (cached.name !== undefined || Date.now() < cached.retryAt)) return;
  state.airlines.set(code, { name: undefined, retryAt: Date.now() + ROUTE_RETRY_MS });
  try {
    const { ok, status, json } = await fetchJson(state.config.airlineUrl.replace('{code}', encodeURIComponent(code)));
    if (ok) state.airlines.set(code, { name: parseAirline(json, code) });
    else if (status === 404) state.airlines.set(code, { name: null });
  } catch {
    // network error: retried after ROUTE_RETRY_MS
  }
}

const routeFor = (a) => (a.callsign ? state.routes.get(a.callsign)?.route ?? null : null);
// The leg the plane is on right now, or null if its route doesn't fit where it is (stale data).
const legFor = (a) => pickLeg(routeFor(a), a);
const airlineFor = (a) => routeFor(a)?.airline ?? state.airlines.get(airlineCode(a.callsign))?.name ?? null;

const lookupFor = (a) => a.callsign && !isPrivateFlight(a) && lookupRoute(a);

async function refresh() {
  const { altitudeFt } = state.config;
  try {
    const all = await fetchAircraft();
    state.aircraft = filterAircraft(all, { minAltitudeFt: altitudeFt.min, maxAltitudeFt: altitudeFt.max });
    state.lastUpdate = new Date();
    state.stale = false;
    state.error = null;
  } catch (err) {
    state.stale = true;
    state.error = err.message || String(err);
  }
  await fetchView();
  if (state.selected && !findAircraft(state.selected)) state.selected = null; // gone
  const { hero, rest } = cardAircraft();
  [hero, ...rest].forEach((a) => a && lookupFor(a));
  render();
  setTimeout(refresh, state.config.refreshSeconds * 1000);
}

// ---- Wider map view: when the map is zoomed or panned past the home area, also fetch everything
// in view (FreeFlight answers up to 250 nm around any point). Only area sources ({lat}/{lon}
// templates) can do this; a receiver's aircraft.json is what it is.
let viewRequest = 0;
async function fetchView() {
  const view = state.view;
  const templates = state.config.sources.filter((t) => t.includes('{lat}'));
  if (!view || !templates.length) return;
  const id = ++viewRequest;
  try {
    const { altitudeFt } = state.config;
    const list = filterAircraft(await fetchAircraft(view, templates), { minAltitudeFt: altitudeFt.min, maxAltitudeFt: altitudeFt.max });
    if (id === viewRequest && state.view === view) state.viewAircraft = list; // ignore answers overtaken by a newer view
  } catch {
    // keep the last view's aircraft; the home area is what matters
  }
}

function viewChanged(v) {
  const home = homeArea();
  const reach = distanceNm(home.lat, home.lon, v.lat, v.lon) + v.radiusNm;
  if (v.atHome || reach <= home.radiusNm * 2) {
    // back at (or near) the home view: the home fetch covers it
    state.view = null;
    state.viewAircraft = [];
  } else {
    // round, so small moves reuse nginx's and FreeFlight's caches
    state.view = { lat: Math.round(v.lat * 20) / 20, lon: Math.round(v.lon * 20) / 20, radiusNm: Math.min(250, Math.ceil(v.radiusNm / 5) * 5 + 5) };
    fetchView().then(render);
  }
}

const findAircraft = (hex) => state.aircraft?.find((a) => a.hex === hex) ?? state.viewAircraft.find((a) => a.hex === hex);

// Card = the plane clicked on the map, else the closest one inside the display radius;
// list = the next ones inside the wider fetch radius.
function cardAircraft() {
  if (!state.aircraft) return { hero: null, rest: [] };
  const { radiusNm, fetchRadiusMultiplier, listCount } = state.config;
  const wide = state.aircraft.filter((a) => a.distanceNm <= radiusNm * fetchRadiusMultiplier);
  const picked = state.selected && findAircraft(state.selected);
  const hero = picked || (wide[0] && wide[0].distanceNm <= radiusNm ? wide[0] : null);
  return { hero, rest: wide.filter((a) => a !== hero).slice(0, listCount) };
}

// Clicking a plane on the map shows it in the card; clicking the map, the same plane again, or
// map.recenterSeconds without touching anything goes back to the closest one.
let selectTimer;
function selectPlane(hex) {
  state.selected = hex && hex !== state.selected ? hex : null;
  clearTimeout(selectTimer);
  const { recenterSeconds } = state.config.map;
  if (state.selected && recenterSeconds > 0) {
    selectTimer = setTimeout(() => selectPlane(null), recenterSeconds * 1000);
  }
  const picked = state.selected && findAircraft(state.selected);
  if (picked) lookupFor(picked);
  render();
}

// ---------------------------------------------------------------- render

function placeName(p) {
  if (!p) return '';
  return `<span class="city">${esc(p.city || p.name || '')}</span> <span class="code">${esc(p.code || '')}</span>`;
}

function arrow(track) {
  if (track === null) return '';
  return `<svg class="arrow" viewBox="0 0 24 24" style="transform: rotate(${track}deg)" aria-label="heading ${Math.round(track)}°">
    <path d="M12 2 L19 21 L12 17 L5 21 Z" /></svg>`;
}

function climb(rate) {
  if (rate === null || Math.abs(rate) < 300) return '';
  return rate > 0 ? '<span class="climb" title="climbing">▲</span>' : '<span class="climb" title="descending">▼</span>';
}

function renderHero(a) {
  const priv = isPrivateFlight(a);
  const r = priv ? null : routeFor(a);
  // Private flights: model as the title, registration once below it, no route lookup.
  const title = priv ? modelName(a) || a.registration || 'Private aircraft' : airlineFor(a) || a.registration || 'Unknown operator';
  const flight = priv ? a.registration || a.hex.toUpperCase() : r?.flightNumber || a.callsign;
  const subtitle = !priv && a.callsign !== flight ? a.callsign : null;
  const leg = priv ? null : legFor(a);
  const route = priv
    ? '<span class="muted">Private flight</span>'
    : leg
      ? `${placeName(leg.origin)} <span class="to">→</span> ${placeName(leg.destination)}`
      : r
        ? '<span class="muted">Route unconfirmed</span>' // listed route doesn't fit where the plane is
        : '<span class="muted">Route unknown</span>';
  const picked = a.hex === state.selected ? '<div class="picked">Selected · click the map to go back</div>' : '';
  return `${picked}
    <div class="hero-top">
      <div>
        <div class="airline">${esc(title)}</div>
        <div class="flight">${esc(flight)}${subtitle ? ` <span class="muted">${esc(subtitle)}</span>` : ''}</div>
      </div>
      ${arrow(a.track)}
    </div>
    <div class="route">${route}</div>
    <div class="stats">
      <div><label>Aircraft</label><span>${esc(a.type || '–')}</span>${a.description && !priv ? `<small>${esc(a.description)}</small>` : ''}</div>
      <div><label>Altitude</label><span>${fmt('altitude', a.altitudeFt)} ${climb(a.verticalRate)}</span></div>
      <div><label>Speed</label><span>${fmt('speed', a.speedKt)}</span></div>
      <div><label>Distance</label><span>${fmt('distance', a.distanceNm, 1)}</span></div>
    </div>`;
}

function renderRow(a) {
  const priv = isPrivateFlight(a);
  const r = priv ? null : routeFor(a);
  const leg = priv ? null : legFor(a);
  const route = priv ? 'Private' : leg ? `${esc(leg.origin.code)} → ${esc(leg.destination.code)}` : r ? 'Unconfirmed' : '';
  return `<li>
    <span class="cs">${esc(r?.flightNumber || a.callsign || a.registration || a.hex.toUpperCase())}</span>
    <span class="rt">${route}</span>
    <span class="ty">${esc(a.type || '')}</span>
    <span class="al">${fmt('altitude', a.altitudeFt)}</span>
    <span class="di">${fmt('distance', a.distanceNm, 1)}</span>
  </li>`;
}

function render() {
  const hero = $('hero');
  const list = $('list');
  const status = $('status');

  if (!state.aircraft) {
    hero.className = 'hero idle';
    hero.innerHTML = state.error
      ? `<div class="idle-title">Waiting for data</div><div class="muted">${esc(state.error)}</div>`
      : '<div class="idle-title">Loading…</div>';
    list.innerHTML = '';
  } else {
    const { radiusNm, fetchRadiusMultiplier } = state.config;
    const { hero: heroAc, rest } = cardAircraft();
    document.body.classList.toggle('has-selection', Boolean(state.selected));
    if (heroAc) {
      hero.className = 'hero';
      hero.innerHTML = renderHero(heroAc);
    } else {
      const wideCount = state.aircraft.filter((a) => a.distanceNm <= radiusNm * fetchRadiusMultiplier).length;
      hero.className = 'hero idle';
      hero.innerHTML = `<div class="idle-title">Clear skies overhead</div>
        <div class="muted">${wideCount} aircraft within ${fmt('distance', radiusNm * fetchRadiusMultiplier)}</div>`;
    }
    list.innerHTML = rest.map(renderRow).join('');
    trimList(list);
    updateMap(heroAc);
  }

  const time = state.lastUpdate ? state.lastUpdate.toLocaleTimeString([], { hour12: !state.config.clock24h }) : '–';
  status.className = state.stale ? 'status stale' : 'status';
  status.textContent = state.stale ? `Stale · last update ${time}` : `Updated ${time}`;
}

// Short name under each plane on the map.
function plainLabel(a) {
  if (isPrivateFlight(a)) return a.registration;
  return routeFor(a)?.flightNumber || a.callsign || a.registration || a.hex.toUpperCase();
}
const mapLabel = (a) => esc(plainLabel(a));

// Markers (labels, trails) for the home area and the picked plane; the canvas for everything else.
function updateMap(heroAc) {
  if (!state.map) return;
  const { radiusNm, fetchRadiusMultiplier } = state.config;
  const featured = state.aircraft.filter((a) => a.distanceNm <= radiusNm * fetchRadiusMultiplier);
  if (heroAc && !featured.includes(heroAc)) featured.push(heroAc);
  const shown = new Set(featured.map((a) => a.hex));
  state.map.updateBulk(state.viewAircraft.filter((a) => !shown.has(a.hex)), plainLabel);
  const heroRoute = heroAc && !isPrivateFlight(heroAc) ? legFor(heroAc) : null;
  state.map.update(featured, heroAc, mapLabel, heroRoute);
}

// Frames the map in the part of the screen the cards don't cover.
function fitMap() {
  if (!state.map) return;
  const header = document.querySelector('header').getBoundingClientRect();
  const panel = document.querySelector('main').getBoundingClientRect();
  const gap = 24;
  const portrait = window.innerHeight > window.innerWidth;
  const cardsHidden = document.body.classList.contains('cards-hidden');
  state.map.invalidate();
  state.map.fit(
    cardsHidden
      ? { topLeft: [gap, header.bottom + gap], bottomRight: [gap, gap] }
      : portrait
      ? { topLeft: [gap, header.bottom + gap], bottomRight: [gap, window.innerHeight * 0.52 + gap] }
      : { topLeft: [panel.right + gap, header.bottom + gap], bottomRight: [gap, gap] },
  );
}

function setupMap() {
  if (!state.config.map.enabled || typeof L === 'undefined') return; // map off, or Leaflet failed to load
  document.body.classList.add('with-map');
  state.map = createMap($('map'), state.config, { onSelect: selectPlane, onViewChange: viewChanged });
  setCardsHidden(readSetting('cardsHidden') === '1');
  $('cards-toggle').addEventListener('click', () => setCardsHidden(!document.body.classList.contains('cards-hidden')));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'c' || e.key === 'C') setCardsHidden(!document.body.classList.contains('cards-hidden'));
  });
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(fitMap, 200);
  });
}

// Map-only view: hides the card and list (button or the C key), remembered in this browser.
function setCardsHidden(hidden) {
  document.body.classList.toggle('cards-hidden', hidden);
  const button = $('cards-toggle');
  button.textContent = hidden ? 'Show info' : 'Map only';
  button.setAttribute('aria-pressed', String(hidden));
  writeSetting('cardsHidden', hidden ? '1' : '0');
  fitMap();
}

// Per-browser preferences; storage can be unavailable (private windows), so never rely on it.
function readSetting(key) {
  try {
    return localStorage.getItem(`overhead.${key}`);
  } catch {
    return null;
  }
}

function writeSetting(key, value) {
  try {
    localStorage.setItem(`overhead.${key}`, value);
  } catch {
    // not saved; the toggle still works for this visit
  }
}

// Drops list rows that would be cut off at the bottom of the screen.
function trimList(list) {
  const bottom = list.parentElement.getBoundingClientRect().bottom;
  [...list.children].reverse().forEach((li) => {
    if (li.getBoundingClientRect().bottom > bottom + 1) li.remove();
  });
}

function tickClock() {
  const now = new Date();
  $('clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: !state.config.clock24h });
  applyNight(now);
}

const minutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

function applyNight(now) {
  const { enabled, start, end, brightness } = state.config.night;
  let dim = false;
  if (enabled) {
    const t = now.getHours() * 60 + now.getMinutes();
    const s = minutes(start);
    const e = minutes(end);
    dim = s <= e ? t >= s && t < e : t >= s || t < e; // window may cross midnight
  }
  document.documentElement.style.setProperty('--dim', dim ? String(1 - brightness) : '0');
}

// Reloads the page when a deploy changes config.json or the app files, so the kiosk
// picks up changes without anyone touching the screen.
const WATCHED = ['config.json', 'index.html', 'app.js', 'adapter.js', 'map.js', 'style.css'];
let deployedVersion = null;

async function checkForUpdate() {
  try {
    const bodies = await Promise.all(WATCHED.map((f) => fetch(f, { cache: 'no-store' }).then((r) => {
        if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); // mid-deploy or server trouble: don't reload
        return r.text();
      })));
    const version = bodies.join('\u0000');
    if (deployedVersion !== null && version !== deployedVersion) location.reload();
    deployedVersion = version;
  } catch {
    // server unreachable: try again next time
  }
}

// ---------------------------------------------------------------- start

// Desktop browser comfort: hide the pointer after a few idle seconds, and toggle
// full screen with a double-click or the F key.
function setupBrowserControls() {
  let timer;
  const wake = () => {
    document.body.classList.remove('idle-cursor');
    clearTimeout(timer);
    timer = setTimeout(() => document.body.classList.add('idle-cursor'), 3000);
  };
  window.addEventListener('mousemove', wake);
  wake();

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };
  window.addEventListener('dblclick', toggleFullscreen);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  });
}

async function start() {
  try {
    state.config = await loadConfig();
  } catch (err) {
    $('hero').className = 'hero idle';
    $('hero').innerHTML = `<div class="idle-title">Config error</div><div class="muted">${esc(err.message)}</div>`;
    setTimeout(start, 30000);
    return;
  }
  setupMap();
  tickClock();
  setInterval(tickClock, 1000);
  checkForUpdate();
  setInterval(checkForUpdate, 60 * 1000);
  refresh();
}

setupBrowserControls();
start();
