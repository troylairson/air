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
  { hex: '406b0f', flight: 'BAW117  ', r: 'G-XWBA', t: 'A35K', desc: 'AIRBUS A-350-1000', alt: 3200, gs: 160, rate: -700, d: 0.6 },
  { hex: '4ca7b4', flight: 'EIN154  ', r: 'EI-DEO', t: 'A320', desc: 'AIRBUS A-320', alt: 6500, gs: 250, rate: 1800, d: 2.4 },
  { hex: 'a8c2f1', flight: 'UAL901  ', r: 'N2645U', t: 'B77W', desc: 'BOEING 777-300ER', alt: 11000, gs: 300, rate: 0, d: 3.8 },
  { hex: '3c6dd0', flight: 'DLH4UN  ', r: 'D-AIZR', t: 'A20N', alt: 24000, gs: 420, rate: 0, d: 4.7 },
  { hex: '43c6f2', flight: null, r: 'ZZ336', t: 'A332', alt: 18000, gs: 380, rate: 0, d: 5.4 },
  { hex: '485f33', flight: 'XYZ999  ', t: 'E190', alt: 9000, gs: 280, rate: -1200, d: 5.9 },
  { hex: 'a3a172', flight: 'N333FA  ', r: 'N333FA', t: 'P28A', desc: 'PIPER PA-28-140/150/160/180', alt: 1800, gs: 93, rate: 0, d: 1.4 },
  { hex: '000001', flight: 'GND1    ', t: 'A320', alt: 'ground', gs: 10, d: 0.3 },
];

const ROUTES = {
  BAW117: { airline: 'British Airways', iata: 'BA117', o: ['New York', 'JFK'], d: ['London', 'LHR'] },
  EIN154: { airline: 'Aer Lingus', iata: 'EI154', o: ['London', 'LHR'], d: ['Dublin', 'DUB'] },
  UAL901: { airline: 'United Airlines', iata: 'UA901', o: ['London', 'LHR'], d: ['San Francisco', 'SFO'] },
  DLH4UN: { airline: 'Lufthansa', iata: 'LH903', o: ['Frankfurt', 'FRA'], d: ['London', 'LHR'] },
};

function aircraft(home) {
  const t = Date.now() / 1000;
  return FLIGHTS.map((f, i) => {
    const angle = (t / 20 + i * 1.3) % (2 * Math.PI);
    const dLat = (f.d / 60) * Math.cos(angle);
    const dLon = ((f.d / 60) * Math.sin(angle)) / Math.cos((home.lat * Math.PI) / 180);
    const track = ((angle * 180) / Math.PI + 90) % 360;
    return { hex: f.hex, flight: f.flight ?? undefined, r: f.r, t: f.t, desc: f.desc, alt_baro: f.alt, gs: f.gs,
      baro_rate: f.rate, track, lat: home.lat + dLat, lon: home.lon + dLon, seen_pos: 0.5 };
  });
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

    let m = p.match(/^\/api\/aircraft\/(-?[\d.]+)\/(-?[\d.]+)\/([\d.]+)$/);
    if (m) {
      if (down) return send(res, 502, { error: 'simulated outage' });
      const ac = empty ? [] : aircraft({ lat: Number(m[1]), lon: Number(m[2]) });
      return send(res, 200, { ac, msg: 'No error', now: Date.now(), total: ac.length });
    }
    m = p.match(/^\/api\/route\/(.+)$/);
    if (m) {
      const r = ROUTES[decodeURIComponent(m[1]).toUpperCase()];
      if (!r) return send(res, 404, { response: 'unknown callsign' });
      const ap = ([city, code]) => ({ municipality: city, iata_code: code, name: `${city} airport` });
      return send(res, 200, { response: { flightroute: { callsign_iata: r.iata, airline: { name: r.airline }, origin: ap(r.o), destination: ap(r.d) } } });
    }

    const file = path.join(root, 'web', p === '/' ? 'index.html' : p);
    if (!file.startsWith(path.join(root, 'web')) || !fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, fs.readFileSync(file), types[path.extname(file)] || 'application/octet-stream');
  })
  .listen(port, () => console.log(`Preview with fake aircraft (${configPath}): http://localhost:${port}`));
