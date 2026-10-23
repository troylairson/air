import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceNm, bearingDeg, normalizeRecord, parseFeed, filterAircraft, parseRoute, isPrivateFlight, modelName, greatCirclePoints, feedTime, projectPosition, airlineCode, parseAirline, sizeClass, pickLeg, normalizeCallsign, routeFiles, airportFile, findRouteCodes, parseAirports, parseHexdbRoute } from '../web/adapter.js';

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
  assert.deepEqual(r.airports[0], { code: 'JFK', city: 'New York', name: 'John F Kennedy International Airport', lat: null, lon: null });
  assert.equal(r.airports[1].code, 'EGLL');
  assert.equal(r.source, 'adsbdb');
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
  assert.equal(r.airports[0].lat, 40.6413);
  assert.equal(r.airports[1].lon, -0.4543);
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

test('airline code from callsign', () => {
  assert.equal(airlineCode('DAL1605'), 'DAL');
  assert.equal(airlineCode('KSF44'), 'KSF');
  assert.equal(airlineCode('BAW9AP'), 'BAW');
  assert.equal(airlineCode('N333FA'), null);
  assert.equal(airlineCode('GABCD'), null);
  assert.equal(airlineCode(null), null);
});

test('airline name from an adsbdb airline response (list or object)', () => {
  assert.equal(parseAirline({ response: [{ name: 'Other', icao: 'XXX' }, { name: 'Delta Air Lines', icao: 'DAL' }] }, 'DAL'), 'Delta Air Lines');
  assert.equal(parseAirline({ response: { name: 'Breeze Airways', icao: 'MXY' } }, 'MXY'), 'Breeze Airways');
  assert.equal(parseAirline({ response: 'unknown airline' }, 'ZZZ'), null);
});

test('size class from emitter category, else type code', () => {
  assert.equal(sizeClass({ category: 'A1', type: 'SR22' }), 'light');
  assert.equal(sizeClass({ category: 'A2', type: 'E135' }), 'small');
  assert.equal(sizeClass({ category: 'A3', type: 'BCS3' }), 'large');
  assert.equal(sizeClass({ category: 'A5', type: 'B77W' }), 'heavy');
  assert.equal(sizeClass({ category: 'A7', type: 'EC35' }), 'heli');
  assert.equal(sizeClass({ category: null, type: 'C172' }), 'light');
  assert.equal(sizeClass({ category: null, type: 'P28A' }), 'light');
  assert.equal(sizeClass({ category: null, type: 'A320' }), 'large');
  assert.equal(sizeClass({ category: null, type: null }), 'large');
});

test('normalizeRecord keeps the emitter category', () => {
  assert.equal(normalizeRecord({ hex: 'a', lat: 51, lon: 0, category: 'A1' }, home).category, 'A1');
});

// RPA4388 seen near Akron, Ohio, flying east: really Cincinnati -> New York (JFK-CVG-JFK in the
// community data), while adsbdb said Raleigh/Durham -> New York.
const JFK = { code: 'JFK', city: 'New York', lat: 40.6413, lon: -73.7781 };
const CVG = { code: 'CVG', city: 'Cincinnati', lat: 39.0488, lon: -84.6678 };
const RDU = { code: 'RDU', city: 'Raleigh/Durham', lat: 35.8776, lon: -78.7875 };
const nearAkron = { lat: 40.96, lon: -81.52, track: 85 };

test('standing data: callsign normalisation, as in its README', () => {
  assert.equal(normalizeCallsign('EZY1200').callsign, 'EZY1200');
  assert.equal(normalizeCallsign('EZY0001').callsign, 'EZY1');
  assert.equal(normalizeCallsign('EZY0000').callsign, 'EZY0');
  assert.equal(normalizeCallsign('EZY00AB').callsign, 'EZY0AB');
  assert.equal(normalizeCallsign('RPA4388').callsign, 'RPA4388');
  assert.equal(normalizeCallsign('N333FA'), null);
  assert.equal(normalizeCallsign('DAL12345'), null); // number too long
});

test('standing data: route files and airport files', () => {
  assert.deepEqual(routeFiles(normalizeCallsign('RPA4388')), ['routes/schema-01/R/RPA-all.csv', 'routes/schema-01/R/RPA-4.csv']);
  assert.equal(airportFile('EGLL'), 'airports/schema-01/E/EG.csv');
});

test('standing data: route codes and airports from the real CSV rows', () => {
  const routes = '\uFEFFCallsign,Code,Number,AirlineCode,AirportCodes\r\nRPA1012,RPA,1012,RPA,KLGB-KDEN\r\nRPA4388,RPA,4388,RPA,KJFK-KCVG-KJFK\r\n';
  assert.deepEqual(findRouteCodes(routes, 'RPA4388'), ['KJFK', 'KCVG', 'KJFK']);
  assert.equal(findRouteCodes(routes, 'RPA9999'), null);
  const airports = parseAirports(
    'Code,Name,ICAO,IATA,Location,CountryISO2,Latitude,Longitude,AltitudeFeet\n' +
      'KJFK,John F Kennedy International Airport,KJFK,JFK,New York,US,40.639801,-73.778900,13\n' +
      'KXYZ,"Field, Private",KXYZ,,Somewhere,US,,,0\n',
  );
  assert.deepEqual(airports.get('KJFK'), { code: 'JFK', city: 'New York', name: 'John F Kennedy International Airport', lat: 40.639801, lon: -73.7789 });
  assert.equal(airports.get('KXYZ').name, 'Field, Private'); // quoted comma
  assert.equal(airports.get('KXYZ').code, 'KXYZ'); // no IATA code
  assert.equal(airports.get('KXYZ').lat, null);
});

test('pickLeg: the leg the plane is flying, from a multi-leg route', () => {
  const leg = pickLeg({ airports: [JFK, CVG, JFK] }, nearAkron);
  assert.equal(leg.origin.code, 'CVG');
  assert.equal(leg.destination.code, 'JFK');
  // the same plane flying west would be on the JFK -> CVG leg
  assert.equal(pickLeg({ airports: [JFK, CVG, JFK] }, { ...nearAkron, track: 265 }).destination.code, 'CVG');
});

test('pickLeg: rejects a stale route the plane is nowhere near', () => {
  assert.equal(pickLeg({ airports: [RDU, JFK] }, nearAkron), null); // ~287 nm off the RDU-JFK line
});

test('pickLeg: rejects a route flown the wrong way, but not on approach', () => {
  assert.equal(pickLeg({ airports: [CVG, JFK] }, { ...nearAkron, track: 265 }), null);
  const nearJfk = { lat: 40.75, lon: -74.2, track: 250 }; // turning onto final, 20 nm out
  assert.equal(pickLeg({ airports: [CVG, JFK] }, nearJfk).destination.code, 'JFK');
});

test('pickLeg: airports without coordinates are shown unchecked', () => {
  const leg = pickLeg({ airports: [{ code: 'AAA', lat: null, lon: null }, { code: 'BBB', lat: null, lon: null }] }, nearAkron);
  assert.equal(leg.checked, false);
});

test('pickLeg: next to an airport a route both reaches and leaves, the heading decides', () => {
  const leavingJfk = { lat: 40.7, lon: -74.1, track: 270 }; // ~20 nm west of JFK, heading west
  assert.equal(pickLeg({ airports: [JFK, CVG, JFK] }, leavingJfk).destination.code, 'CVG');
  const arrivingJfk = { lat: 40.7, lon: -74.1, track: 90 };
  assert.equal(pickLeg({ airports: [JFK, CVG, JFK] }, arrivingJfk).destination.code, 'JFK');
  const climbingOut = { lat: 39.2, lon: -84.5, track: 200 }; // just after take-off from CVG, still turning
  assert.equal(pickLeg({ airports: [CVG, JFK] }, climbingOut).destination.code, 'JFK');
});

test('helicopters: category A7, else type code or description', () => {
  assert.equal(sizeClass({ category: 'A7', type: null }), 'heli');
  assert.equal(sizeClass({ category: null, type: 'R44' }), 'heli');
  assert.equal(sizeClass({ category: null, type: 'EC35' }), 'heli');
  assert.equal(sizeClass({ category: null, type: 'B407' }), 'heli');
  assert.equal(sizeClass({ category: null, type: 'A139' }), 'heli');
  assert.equal(sizeClass({ category: null, type: 'XXXX', description: 'EUROCOPTER EC-145' }), 'heli');
  assert.equal(sizeClass({ category: null, type: 'A320' }), 'large'); // A3xx airliners aren't A1x9 helicopters
  assert.equal(sizeClass({ category: null, type: 'C172' }), 'light');
  assert.equal(sizeClass({ category: 'A3', type: 'EC35' }), 'large'); // a broadcast category wins
});

// ENY4077 (Envoy) was flying Chicago -> Akron-Canton, but the community data lists ORD-YHZ-ORD
// (Halifax). Near Akron it's ~135 nm off the ORD-YHZ line, low and ~280 nm from either airport.
const ORD = { code: 'ORD', lat: 41.9786, lon: -87.9048 };
const YHZ = { code: 'YHZ', lat: 44.8808, lon: -63.5086 };
const CAK = { code: 'CAK', lat: 40.9161, lon: -81.4422 };

test('pickLeg: rejects a long leg the plane is far below cruise on (ENY4077 ORD-YHZ near Akron)', () => {
  const descendingIntoCak = { lat: 40.95, lon: -81.9, track: 95, altitudeFt: 6000 };
  assert.equal(pickLeg({ airports: [ORD, YHZ, ORD] }, descendingIntoCak), null);
  assert.equal(pickLeg({ airports: [ORD, YHZ, ORD] }, { ...descendingIntoCak, track: 275 }), null); // either direction
  assert.equal(pickLeg({ airports: [ORD, CAK] }, descendingIntoCak).destination.code, 'CAK'); // the real route fits
});

test('pickLeg: 135 nm off a 1,074 nm leg is too far even at cruise', () => {
  assert.equal(pickLeg({ airports: [ORD, YHZ] }, { lat: 40.96, lon: -81.52, track: 75, altitudeFt: 35000 }), null);
});

test('pickLeg: low-altitude rule spares short hops and climb-outs', () => {
  const DTW = { code: 'DTW', lat: 42.2124, lon: -83.3534 };
  assert.equal(pickLeg({ airports: [DTW, CAK] }, { lat: 41.6, lon: -82.4, track: 120, altitudeFt: 9000 }).destination.code, 'CAK'); // 120 nm leg
  assert.equal(pickLeg({ airports: [ORD, YHZ] }, { lat: 42.1, lon: -86.9, track: 80, altitudeFt: 8000 }).destination.code, 'YHZ'); // just out of ORD
});

test('pickLeg: keeps the preferred leg while it fits, so the card does not flip', () => {
  const nearJfk = { lat: 40.7, lon: -74.1, track: 180 }; // circling 20 nm west of JFK: heading fits neither leg
  assert.equal(pickLeg({ airports: [JFK, CVG, JFK] }, nearJfk, { origin: 'CVG', destination: 'JFK' }).origin.code, 'CVG');
  assert.equal(pickLeg({ airports: [JFK, CVG, JFK] }, nearJfk, { origin: 'JFK', destination: 'CVG' }).origin.code, 'JFK');
});

test('hexdb route: ICAO codes from "EIDW-EGLL", null when missing', () => {
  assert.deepEqual(parseHexdbRoute({ flight: 'EIN17A', route: 'EIDW-EGLL', updatetime: 1397991739 }), ['EIDW', 'EGLL']);
  assert.deepEqual(parseHexdbRoute({ flight: 'X1', route: 'KORD-KCAK-KORD' }), ['KORD', 'KCAK', 'KORD']);
  assert.equal(parseHexdbRoute({ status: '404', error: 'Route not found.' }), null);
  assert.equal(parseHexdbRoute({ route: 'KORD' }), null);
});
