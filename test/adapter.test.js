import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceNm, bearingDeg, normalizeRecord, parseFeed, filterAircraft, parseRoute, isPrivateFlight, modelName } from '../web/adapter.js';

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
  assert.deepEqual(r.origin, { code: 'JFK', city: 'New York', name: 'John F Kennedy International Airport' });
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
