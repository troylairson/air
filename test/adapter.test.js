import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceNm, bearingDeg, normalizeRecord, parseFeed, filterAircraft, parseRoute, isPrivateFlight, modelName, greatCirclePoints, feedTime, projectPosition } from '../web/adapter.js';

const home = { lat: 51.47, lon: -0.4543 };

test('distance: one minute of latitude is about 1 nm', () => {
  assert.ok(Math.abs(distanceNm(51, 0, 51 + 1 / 60, 0) - 1) < 0.01);
});

test('bearing: due north, east, south, west', () => {
  assert.ok(Math.abs(bearingDeg(51, 0, 52, 0) - 0) < 0.01);
  assert.ok(Math.abs(bearingDeg(0, 0, 0, 1) - 90) < 0.01);
  assert.ok(Math.abs(bearingDeg(52, 0, 51, 0) - 180) < 0.01);
  assert.ok(Math.abs(bearingDeg(0, 1, 0, 0) - 270) < 0.01);
});

test('normalizes a v2 record and trims the callsign', () => {
  const a = normalizeRecord(
    { hex: '406B0F', flight: 'BAW117  ', r: 'G-XWBA', t: 'A35K', alt_baro: 12025, gs: 311, track: 265.1, baro_rate: 1984, lat: 51.5, lon: -0.45 },
    home,
  );
  assert.equal(a.hex, '406b0f');
  assert.equal(a.callsign, 'BAW117');
  assert.equal(a.registration, 'G-XWBA');
  assert.equal(a.type, 'A35K');
  assert.equal(a.altitudeFt, 12025);
  assert.equal(a.speedKt, 311);
  assert.equal(a.verticalRate, 1984);
  assert.ok(Math.abs(a.distanceNm - 1.8) < 0.05);
});

test('"ground" altitude marks the aircraft on the ground', () => {
  const a = normalizeRecord({ hex: 'abc', alt_baro: 'ground', lat: 51.47, lon: -0.45 }, home);
  assert.equal(a.onGround, true);
  assert.equal(filterAircraft([a], { minAltitudeFt: 0, maxAltitudeFt: 45000 }).length, 0);
});

test('records without a position are dropped', () => {
  assert.equal(normalizeRecord({ hex: 'abc', alt_baro: 5000 }, home), null);
});

test('accepts both /v2/point (ac[]) and readsb aircraft.json (aircraft[]), sorted by distance', () => {
  const far = { hex: 'b', lat: 51.6, lon: -0.45, alt_baro: 9000 };
  const near = { hex: 'a', lat: 51.48, lon: -0.45, alt_baro: 3000 };
  assert.deepEqual(parseFeed({ ac: [far, near] }, home).map((a) => a.hex), ['a', 'b']);
  assert.deepEqual(parseFeed({ now: 1, aircraft: [far, near] }, home).map((a) => a.hex), ['a', 'b']);
  assert.throws(() => parseFeed({ nope: [] }, home));
});

test('altitude band and stale positions are filtered', () => {
  const list = parseFeed(
    { ac: [
      { hex: 'low', lat: 51.47, lon: -0.45, alt_baro: 800 },
      { hex: 'ok', lat: 51.47, lon: -0.45, alt_baro: 5000 },
      { hex: 'high', lat: 51.47, lon: -0.45, alt_baro: 50000 },
      { hex: 'old', lat: 51.47, lon: -0.45, alt_baro: 5000, seen_pos: 120 },
      { hex: 'noalt', lat: 51.47, lon: -0.45 },
    ] },
    home,
  );
  assert.deepEqual(filterAircraft(list, { minAltitudeFt: 1000, maxAltitudeFt: 45000 }).map((a) => a.hex), ['ok']);
});

test('parses an adsbdb route, and returns null for an unknown callsign', () => {
  const r = parseRoute({
    response: { flightroute: {
      callsign_iata: 'BA117',
      airline: { name: 'British Airways' },
      origin: { iata_code: 'JFK', icao_code: 'KJFK', municipality: 'New York', name: 'John F Kennedy International Airport' },
      destination: { iata_code: null, icao_code: 'EGLL', municipality: 'London', name: 'London Heathrow Airport' },
    } },
  });
  assert.equal(r.airline, 'British Airways');
  assert.equal(r.flightNumber, 'BA117');
  assert.deepEqual(r.origin, { code: 'JFK', city: 'New York', name: 'John F Kennedy International Airport', lat: null, lon: null });
  assert.equal(r.destination.code, 'EGLL');
  assert.equal(parseRoute({ response: 'unknown callsign' }), null);
});

test('private flights: callsign is the registration', () => {
  assert.equal(isPrivateFlight({ callsign: 'N333FA', registration: 'N333FA' }), true);
  assert.equal(isPrivateFlight({ callsign: 'GABCD', registration: 'G-ABCD' }), true);
  assert.equal(isPrivateFlight({ callsign: 'DAL1605', registration: 'N963AT' }), false);
  assert.equal(isPrivateFlight({ callsign: null, registration: 'ZZ336' }), false);
  assert.equal(isPrivateFlight({ callsign: 'N123', registration: null }), false);
});

test('model name: title-cases maker words, keeps model codes', () => {
  assert.equal(modelName({ description: 'PIPER PA-28-140/150/160/180', type: 'P28A' }), 'Piper PA-28-140/150/160/180');
  assert.equal(modelName({ description: 'CESSNA 172 SKYHAWK', type: 'C172' }), 'Cessna 172 Skyhawk');
  assert.equal(modelName({ description: 'AIRBUS A220-300', type: 'BCS3' }), 'Airbus A220-300');
  assert.equal(modelName({ description: null, type: 'SR22' }), 'SR22');
});

test('great circle: ends at both airports and arcs north between JFK and LHR', () => {
  const pts = greatCirclePoints(40.6413, -73.7781, 51.47, -0.4543, 64);
  assert.equal(pts.length, 65);
  assert.ok(Math.abs(pts[0][0] - 40.6413) < 1e-6 && Math.abs(pts[0][1] + 73.7781) < 1e-6);
  assert.ok(Math.abs(pts[64][0] - 51.47) < 1e-6 && Math.abs(pts[64][1] + 0.4543) < 1e-6);
  assert.ok(Math.max(...pts.map((p) => p[0])) > 53); // the great circle bulges north of both ends
});

test('route keeps airport coordinates for the map', () => {
  const r = parseRoute({ response: { flightroute: {
    origin: { iata_code: 'JFK', latitude: 40.6413, longitude: -73.7781 },
    destination: { iata_code: 'LHR', latitude: 51.47, longitude: -0.4543 },
  } } });
  assert.equal(r.origin.lat, 40.6413);
  assert.equal(r.destination.lon, -0.4543);
});

test('feed time: v2 ms, readsb seconds, and a fallback for missing or skewed clocks', () => {
  const t = 1_800_000_000_000;
  assert.equal(feedTime({ now: t - 4000 }, t), t - 4000);
  assert.equal(feedTime({ now: (t - 2000) / 1000 }, t), t - 2000);
  assert.equal(feedTime({}, t), t);
  assert.equal(feedTime({ now: t - 5 * 60_000 }, t), t);
});

test('positionTime subtracts the position age from the feed time', () => {
  const t = 1_800_000_000_000;
  const [a] = parseFeed({ now: t - 3000, ac: [{ hex: 'a', lat: 51.47, lon: -0.45, alt_baro: 3000, seen_pos: 1.5 }] }, home, t);
  assert.equal(a.positionTime, t - 4500);
});

test('project position: 360 kt for 10 s is 1 nm', () => {
  const [lat, lon] = projectPosition(51, 0, 0, 360, 10); // due north
  assert.ok(Math.abs(distanceNm(51, 0, lat, lon) - 1) < 0.001 && lon === 0);
  const [lat2, lon2] = projectPosition(51, 0, 90, 360, 10); // due east
  assert.ok(Math.abs(distanceNm(51, 0, lat2, lon2) - 1) < 0.001 && Math.abs(lat2 - 51) < 1e-9);
});
