// Local preview with fake aircraft: no Docker, no network.
//   npm run dev            -> http://localhost:8090
//   curl localhost:8090/__dev/down   toggles a simulated FreeFlight outage (stale marker test)
//   curl localhost:8090/__dev/empty  toggles an empty sky ("Clear skies" test)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT || 8090);
const configPath = fs.existsSync(path.join(root, 'config.json')) ? 'config.json' : 'config.example.json';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

let down = false;
let empty = false;

const FLIGHTS = [
  { hex: '406b0f', cat: 'A5', flight: 'BAW117  ', r: 'G-XWBA', t: 'A35K', desc: 'AIRBUS A-350-1000', alt: 3200, gs: 160, rate: -700, d: 0.6 },
  { hex: '4ca7b4', cat: 'A3', flight: 'EIN154  ', r: 'EI-DEO', t: 'A320', desc: 'AIRBUS A-320', alt: 6500, gs: 250, rate: 1800, d: 2.4 },
  { hex: 'a8c2f1', cat: 'A5', flight: 'UAL901  ', r: 'N2645U', t: 'B77W', desc: 'BOEING 777-300ER', alt: 11000, gs: 300, rate: 0, d: 3.8 },
  { hex: '3c6dd0', cat: 'A3', flight: 'DLH4UN  ', r: 'D-AIZR', t: 'A20N', alt: 24000, gs: 420, rate: 0, d: 4.7 },
  { hex: '43c6f2', cat: 'A5', flight: null, r: 'ZZ336', t: 'A332', alt: 18000, gs: 380, rate: 0, d: 5.4 },
  { hex: '485f33', cat: 'A3', flight: 'AAL2401 ', r: 'N953UW', t: 'E190', alt: 9000, gs: 280, rate: -1200, d: 5.9 }, // airline known, route not
  { hex: 'a6e7ba', flight: 'N544KS  ', r: 'N544KS', t: 'C172', alt: 2300, gs: 92, rate: 0, d: 2.9 }, // no category: size from type
  { hex: 'a1b2c3', cat: 'A7', flight: 'N911LF  ', r: 'N911LF', t: 'EC35', desc: 'EUROCOPTER EC-135', alt: 1200, gs: 120, rate: 0, d: 2.0 },
  { hex: 'a4d5e6', flight: 'N44RH   ', r: 'N44RH', t: 'R44', alt: 900, gs: 85, rate: 0, d: 3.3 }, // no category: helicopter from type
  { hex: 'a3a172', cat: 'A1', flight: 'N333FA  ', r: 'N333FA', t: 'P28A', desc: 'PIPER PA-28-140/150/160/180', alt: 1800, gs: 93, rate: 0, d: 1.4 },
  { hex: '000001', cat: 'A3', flight: 'GND1    ', t: 'A320', alt: 'ground', gs: 10, d: 0.3 },
];

const AIRPORTS = {
  DFW: ['Dallas-Fort Worth', 32.8998, -97.0403],
  PHL: ['Philadelphia', 39.8744, -75.2424],
  JFK: ['New York', 40.6413, -73.7781],
  LHR: ['London', 51.47, -0.4543],
  DUB: ['Dublin', 53.4213, -6.2701],
  SFO: ['San Francisco', 37.6213, -122.379],
  FRA: ['Frankfurt', 50.0379, 8.5622],
};

const AIRLINES = { BAW: 'British Airways', EIN: 'Aer Lingus', UAL: 'United Airlines', DLH: 'Lufthansa', AAL: 'American Airlines' };

// Standing-data routes (tried first): multi-leg for EI154, and a stale one for AAL2401 that the
// display should reject ("Route unconfirmed") since the plane is nowhere near Dallas-Philadelphia.
const STANDING_ROUTES = { EIN154: ['DUB', 'LHR', 'DUB'], AAL2401: ['DFW', 'PHL'] };
const ICAO = { DFW: 'KDFW', PHL: 'KPHL', JFK: 'KJFK', LHR: 'EGLL', DUB: 'EIDW', SFO: 'KSFO', FRA: 'EDDF' };

// The community standing-data CSV files (/api/sd/...), built from the tables above.
function standingDataFile(path) {
  let m = path.match(/^routes\/schema-01\/[A-Z0-9]\/([A-Z0-9]+)-all\.csv$/);
  if (m) {
    const rows = Object.entries(STANDING_ROUTES).filter(([cs]) => cs.startsWith(m[1]));
    if (!rows.length) return null;
    return '\uFEFFCallsign,Code,Number,AirlineCode,AirportCodes\r\n' +
      rows.map(([cs, codes]) => `${cs},${m[1]},${cs.slice(3)},${m[1]},${codes.map((c) => ICAO[c]).join('-')}\r\n`).join('');
  }
  m = path.match(/^airports\/schema-01\/[A-Z0-9]\/([A-Z0-9]{2})\.csv$/);
  if (m) {
    const rows = Object.entries(ICAO).filter(([, icao]) => icao.startsWith(m[1]));
    return '\uFEFFCode,Name,ICAO,IATA,Location,CountryISO2,Latitude,Longitude,AltitudeFeet\r\n' +
      rows.map(([iata, icao]) => { const [city, lat, lon] = AIRPORTS[iata]; return `${icao},"${city} Airport, Main",${icao},${iata},${city},XX,${lat},${lon},0\r\n`; }).join('');
  }
  return null;
}

// hexdb.io-style routes: DLH4UN is known only here, so its card exercises the third source.
const HEXDB = { DLH4UN: 'EDDF-EGLL' };

const ROUTES = {
  BAW117: { airline: 'British Airways', iata: 'BA117', o: 'JFK', d: 'LHR' },
  EIN154: { airline: 'Aer Lingus', iata: 'EI154', o: 'LHR', d: 'DUB' },
  UAL901: { airline: 'United Airlines', iata: 'UA901', o: 'LHR', d: 'SFO' },
  AAL2401: { airline: 'American Airlines', iata: 'AA2401', o: 'JFK', d: 'LHR' }, // right, where standing data is stale
};

function aircraft(home) {
  const t = Date.now() / 1000;
  return FLIGHTS.map((f, i) => {
    const angle = (t / 20 + i * 1.3) % (2 * Math.PI);
    const dLat = (f.d / 60) * Math.cos(angle);
    const dLon = ((f.d / 60) * Math.sin(angle)) / Math.cos((home.lat * Math.PI) / 180);
    const track = ((angle * 180) / Math.PI + 90) % 360;
    return { hex: f.hex, category: f.cat, flight: f.flight ?? undefined, r: f.r, t: f.t, desc: f.desc, alt_baro: f.alt, gs: f.gs,
      baro_rate: f.rate, track, lat: home.lat + dLat, lon: home.lon + dLon, seen_pos: 0.5 };
  });
}

// Wider traffic for zooming out: ~1,500 aircraft spread over 250 nm around home, each flying a
// straight line that restarts every 10 minutes. Deterministic, so reloads look the same.
const HOME = JSON.parse(fs.readFileSync(path.join(root, configPath), 'utf8')).home;
const rand = (i, k) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
const PREFIXES = ['DAL', 'AAL', 'UAL', 'SWA', 'JBU', 'RPA', 'SKW', 'EDV', 'FDX', 'UPS', 'ENY', 'NKS'];
const TRAFFIC = Array.from({ length: 1500 }, (_, i) => {
  const dist = 12 + 238 * Math.sqrt(rand(i, 1)); // even spread over the disc, outside the home area
  const bearing = rand(i, 2) * 2 * Math.PI;
  const kind = rand(i, 3);
  const [cat, t, gs, alt] =
    kind < 0.08 ? ['A1', 'C172', 100, 3500] : kind < 0.11 ? ['A7', 'EC35', 120, 1500] : kind < 0.2 ? ['A5', 'B77W', 480, 37000] : ['A3', 'A321', 440, 33000];
  return {
    hex: `f${i.toString(16).padStart(5, '0')}`,
    category: cat,
    flight: cat === 'A1' || cat === 'A7' ? `N${100 + i}` : `${PREFIXES[i % PREFIXES.length]}${100 + i}`,
    t,
    gs,
    alt: Math.round(alt * (0.6 + 0.4 * rand(i, 4))),
    lat0: HOME.lat + (dist / 60) * Math.cos(bearing),
    lon0: HOME.lon + ((dist / 60) * Math.sin(bearing)) / Math.cos((HOME.lat * Math.PI) / 180),
    track: rand(i, 5) * 360,
    phase: rand(i, 6) * 600,
  };
});

function traffic(center, radiusNm) {
  const now = Date.now() / 1000;
  const toRad = (d) => (d * Math.PI) / 180;
  const out = [];
  for (const p of TRAFFIC) {
    const nm = (p.gs * ((now + p.phase) % 600)) / 3600;
    const lat = p.lat0 + (nm / 60) * Math.cos(toRad(p.track));
    const lon = p.lon0 + ((nm / 60) * Math.sin(toRad(p.track))) / Math.cos(toRad(p.lat0));
    const dLat = (lat - center.lat) * 60;
    const dLon = (lon - center.lon) * 60 * Math.cos(toRad(center.lat));
    if (dLat * dLat + dLon * dLon > radiusNm * radiusNm) continue;
    out.push({ hex: p.hex, category: p.category, flight: p.flight.padEnd(8), r: p.flight.startsWith('N') ? p.flight : `N${p.hex.slice(2)}AX`, t: p.t, alt_baro: p.alt, gs: p.gs, track: p.track, lat, lon, seen_pos: 0.4 });
  }
  return out;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/__dev/down') return send(res, 200, { down: (down = !down) });
    if (p === '/__dev/empty') return send(res, 200, { empty: (empty = !empty) });
    if (p === '/config.json') return send(res, 200, fs.readFileSync(path.join(root, configPath)));

    if (p.startsWith('/api/sd/')) {
      const csv = standingDataFile(p.slice('/api/sd/'.length));
      return csv === null ? send(res, 404, 'not found', 'text/plain') : send(res, 200, csv, 'text/plain');
    }

    let m = p.match(/^\/api\/aircraft\/(-?[\d.]+)\/(-?[\d.]+)\/([\d.]+)$/);
    if (m) {
      if (down) return send(res, 502, { error: 'simulated outage' });
      const center = { lat: Number(m[1]), lon: Number(m[2]) };
      const radius = Math.min(250, Number(m[3]));
      const near = aircraft(HOME).filter((a) => Math.hypot((a.lat - center.lat) * 60, (a.lon - center.lon) * 60 * Math.cos((center.lat * Math.PI) / 180)) <= radius);
      const ac = empty ? [] : [...near, ...traffic(center, radius)];
      return send(res, 200, { ac, msg: 'No error', now: Date.now(), total: ac.length });
    }
    m = p.match(/^\/api\/hexdb\/route\/(.+)$/);
    if (m) {
      const cs = decodeURIComponent(m[1]).toUpperCase();
      return HEXDB[cs] ? send(res, 200, { flight: cs, route: HEXDB[cs], updatetime: 1700000000 }) : send(res, 404, { status: '404', error: 'Route not found.' });
    }
    m = p.match(/^\/api\/airline\/(.+)$/);
    if (m) {
      const icao = decodeURIComponent(m[1]).toUpperCase();
      if (!AIRLINES[icao]) return send(res, 404, { response: 'unknown airline' });
      return send(res, 200, { response: [{ name: AIRLINES[icao], icao, iata: null, country: null }] });
    }
    m = p.match(/^\/api\/route\/(.+)$/);
    if (m) {
      const r = ROUTES[decodeURIComponent(m[1]).toUpperCase()];
      if (!r) return send(res, 404, { response: 'unknown callsign' });
      const ap = (code) => {
        const [city, latitude, longitude] = AIRPORTS[code];
        return { municipality: city, iata_code: code, name: `${city} airport`, latitude, longitude };
      };
      return send(res, 200, { response: { flightroute: { callsign_iata: r.iata, airline: { name: r.airline }, origin: ap(r.o), destination: ap(r.d) } } });
    }

    const file = path.join(root, 'web', p === '/' ? 'index.html' : p);
    if (!file.startsWith(path.join(root, 'web')) || !fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, fs.readFileSync(file), types[path.extname(file)] || 'application/octet-stream');
  })
  .listen(port, () => console.log(`Preview with fake aircraft (${configPath}): http://localhost:${port}`));
