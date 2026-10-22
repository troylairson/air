// Turns ADSBExchange-v2-style feeds into the display's own aircraft shape.
// Accepts a /v2/point response ({ ac: [...] }) or a readsb aircraft.json ({ aircraft: [...] }),
// so a local receiver (Phase 4) is a config change, not a code change.

const EARTH_RADIUS_NM = 3440.065;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function distanceNm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Initial bearing from point 1 to point 2, degrees clockwise from true north.
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// One feed record -> display aircraft, or null if it has no usable position.
export function normalizeRecord(rec, home) {
  if (!rec || typeof rec !== 'object') return null;
  const lat = num(rec.lat);
  const lon = num(rec.lon);
  const hex = str(rec.hex);
  if (lat === null || lon === null || !hex) return null;

  const onGround = rec.alt_baro === 'ground';
  const altitudeFt = onGround ? 0 : num(rec.alt_baro) ?? num(rec.alt_geom);

  return {
    hex: hex.toLowerCase(),
    callsign: str(rec.flight),
    registration: str(rec.r),
    type: str(rec.t),
    description: str(rec.desc),
    lat,
    lon,
    onGround,
    altitudeFt,
    speedKt: num(rec.gs),
    track: num(rec.track) ?? num(rec.true_heading),
    verticalRate: num(rec.baro_rate) ?? num(rec.geom_rate),
    seenPosS: num(rec.seen_pos),
    category: str(rec.category),
    distanceNm: distanceNm(home.lat, home.lon, lat, lon),
    bearingDeg: bearingDeg(home.lat, home.lon, lat, lon),
  };
}

// When the feed was generated, in ms: v2 sends `now` in ms, readsb in seconds. A cached answer
// keeps its original `now`, so this is when the positions were current, not when they arrived.
// Falls back to receivedAt if `now` is missing or the clocks disagree by more than a minute.
export function feedTime(json, receivedAt) {
  let now = num(json?.now);
  if (now !== null && now < 1e11) now *= 1000;
  return now !== null && Math.abs(now - receivedAt) < 60_000 ? now : receivedAt;
}

// Whole feed -> display aircraft, sorted by distance from home. Each one gets positionTime:
// when its lat/lon were true (feed time minus the position's age).
export function parseFeed(json, home, receivedAt = Date.now()) {
  const records = Array.isArray(json?.ac) ? json.ac : Array.isArray(json?.aircraft) ? json.aircraft : null;
  if (!records) throw new Error('Feed has neither ac[] nor aircraft[]');
  const generated = feedTime(json, receivedAt);
  return records
    .map((r) => normalizeRecord(r, home))
    .filter(Boolean)
    .map((a) => ({ ...a, positionTime: generated - (a.seenPosS ?? 0) * 1000 }))
    .sort((a, b) => a.distanceNm - b.distanceNm);
}

// Where an aircraft will be after `seconds` at its speed and track. A flat-earth step is
// accurate to metres over the few seconds this is used for.
export function projectPosition(lat, lon, trackDeg, speedKt, seconds) {
  const nm = (speedKt * seconds) / 3600;
  return [
    lat + (nm / 60) * Math.cos(toRad(trackDeg)),
    lon + ((nm / 60) * Math.sin(toRad(trackDeg))) / Math.cos(toRad(lat)),
  ];
}

// Keeps airborne aircraft inside the altitude band with a fresh position.
export function filterAircraft(list, { minAltitudeFt, maxAltitudeFt, maxPositionAgeS = 60 }) {
  return list.filter(
    (a) =>
      !a.onGround &&
      a.altitudeFt !== null &&
      a.altitudeFt >= minAltitudeFt &&
      a.altitudeFt <= maxAltitudeFt &&
      (a.seenPosS === null || a.seenPosS <= maxPositionAgeS),
  );
}

// A route is { airline, flightNumber, airports: [...] }: two or more airports in flying order
// (multi-leg flights have more), each { code, city, name, lat, lon }. pickLeg() below decides
// which leg, if any, the aircraft is actually on.

// adsbdb /v0/callsign/<cs> body -> route, or null when the callsign is unknown.
export function parseRoute(json) {
  const fr = json?.response?.flightroute;
  if (!fr || typeof fr !== 'object') return null;
  const airport = (a) =>
    a
      ? {
          code: str(a.iata_code) ?? str(a.icao_code),
          city: str(a.municipality),
          name: str(a.name),
          lat: num(a.latitude),
          lon: num(a.longitude),
        }
      : null;
  const airports = [fr.origin, fr.midpoint, fr.destination].map(airport).filter(Boolean);
  if (airports.length < 2) return null;
  return { airline: str(fr.airline?.name), flightNumber: str(fr.callsign_iata), airports, source: 'adsbdb' };
}

// adsb.lol /api/0/routeset answer (a list, one entry per callsign asked) -> route, or null when
// it doesn't know the callsign. Its data is the community standing-data route list, which keeps
// multi-leg flights (e.g. JFK-CVG-JFK) and is updated daily. It has no airline name or IATA number.
export function parseRouteSet(json, callsign) {
  const list = Array.isArray(json) ? json : [];
  const entry = list.find((e) => e?.callsign === callsign) ?? list[0];
  const raw = Array.isArray(entry?._airports) ? entry._airports : [];
  const airports = raw.map((a) => ({
    code: str(a?.iata) ?? str(a?.icao),
    city: str(a?.location),
    name: str(a?.name),
    lat: num(a?.lat),
    lon: num(a?.lon),
  }));
  if (airports.length < 2 || airports.some((a) => !a.code)) return null;
  return { airline: null, flightNumber: null, airports, source: 'adsb.lol' };
}

// Signed distance (nm) of point p from the great circle o->d (cross-track), and how far along
// o->d its foot lies (along-track, nm; negative = behind o).
function trackDistances(o, d, p) {
  const r = 3440.065;
  const d13 = distanceNm(o.lat, o.lon, p.lat, p.lon) / r;
  const t13 = toRad(bearingDeg(o.lat, o.lon, p.lat, p.lon));
  const t12 = toRad(bearingDeg(o.lat, o.lon, d.lat, d.lon));
  const xt = Math.asin(Math.sin(d13) * Math.sin(t13 - t12));
  const at = Math.acos(Math.min(1, Math.max(-1, Math.cos(d13) / Math.cos(xt))));
  return { cross: xt * r, along: (Math.cos(t13 - t12) < 0 ? -at : at) * r };
}

const angleBetween = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// The leg of `route` the aircraft is plausibly flying, as { origin, destination }, or null when no
// leg fits (a stale or wrong route). A leg fits when the aircraft is
// - within max(100 nm, 20% of the leg) of the straight great-circle line (real paths wander),
// - between the two airports (50 nm slack at each end), and
// - heading towards the destination (within 90°; not required within 40 nm of either airport,
//   where departures and approaches turn).
// Of the legs that fit, one whose direction matches the heading wins (it matters next to an
// airport a multi-leg route both reaches and leaves), then the one closest to its line.
// Airports without coordinates can't be checked; such a leg is accepted only if it's the whole route.
export function pickLeg(route, a) {
  const airports = route?.airports ?? [];
  let best = null;
  for (let i = 0; i + 1 < airports.length; i++) {
    const o = airports[i];
    const d = airports[i + 1];
    if ([o.lat, o.lon, d.lat, d.lon].some((v) => v === null || v === undefined)) {
      if (airports.length === 2) return { origin: o, destination: d, checked: false };
      continue;
    }
    const length = distanceNm(o.lat, o.lon, d.lat, d.lon);
    const { cross, along } = trackDistances(o, d, a);
    const nearAirport = Math.min(distanceNm(a.lat, a.lon, o.lat, o.lon), distanceNm(a.lat, a.lon, d.lat, d.lon)) < 40;
    const offLine = Math.abs(cross);
    const noTrack = a.track === null || a.track === undefined;
    const headingOk = !noTrack && angleBetween(a.track, bearingDeg(a.lat, a.lon, d.lat, d.lon)) <= 90;
    const fits = offLine <= Math.max(100, 0.2 * length) && along >= -50 && along <= length + 50 && (noTrack || headingOk || nearAirport);
    const better = !best || (headingOk !== best.headingOk ? headingOk : offLine < best.offLine);
    if (fits && better) best = { origin: o, destination: d, checked: true, offLine, headingOk };
  }
  return best && { origin: best.origin, destination: best.destination, checked: best.checked };
}

// A private/GA flight broadcasts its registration as its callsign (N333FA, or GABCD for G-ABCD).
// Those never have an airline or a route.
export function isPrivateFlight(a) {
  if (!a.callsign || !a.registration) return false;
  const plain = (s) => s.replace(/-/g, '').toUpperCase();
  return plain(a.callsign) === plain(a.registration);
}

// "PIPER PA-28-140/150/160/180" -> "Piper PA-28-140/150/160/180"; falls back to the type code.
export function modelName(a) {
  if (!a.description) return a.type;
  return a.description.replace(/\b[A-Z]{4,}\b/g, (w) => w[0] + w.slice(1).toLowerCase());
}

// Points along the great circle from point 1 to point 2 (the path a planned route follows),
// for drawing as a line. Returns [[lat, lon], ...] with `segments` + 1 points.
export function greatCirclePoints(lat1, lon1, lat2, lon2, segments = 64) {
  const p1 = [toRad(lat1), toRad(lon1)];
  const p2 = [toRad(lat2), toRad(lon2)];
  const d =
    2 *
    Math.asin(
      Math.sqrt(Math.sin((p2[0] - p1[0]) / 2) ** 2 + Math.cos(p1[0]) * Math.cos(p2[0]) * Math.sin((p2[1] - p1[1]) / 2) ** 2),
    );
  if (d === 0) return [[lat1, lon1], [lat2, lon2]];
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1[0]) * Math.cos(p1[1]) + B * Math.cos(p2[0]) * Math.cos(p2[1]);
    const y = A * Math.cos(p1[0]) * Math.sin(p1[1]) + B * Math.cos(p2[0]) * Math.sin(p2[1]);
    const z = A * Math.sin(p1[0]) + B * Math.sin(p2[0]);
    points.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))]);
  }
  return points;
}

// Airline ICAO code from an airline-style callsign: three letters then a digit (DAL1605 -> DAL,
// KSF44 -> KSF). Registrations used as callsigns (N333FA, GABCD) don't match.
export function airlineCode(callsign) {
  const m = /^([A-Z]{3})\d[0-9A-Z]*$/.exec(callsign ?? '');
  return m ? m[1] : null;
}

// adsbdb /v0/airline/<icao> body -> airline name, or null. The response is a list of matches
// (an object on some versions); prefer the one whose ICAO code is the one asked for.
export function parseAirline(json, icao) {
  const resp = json?.response;
  const list = Array.isArray(resp) ? resp : resp && typeof resp === 'object' ? [resp] : [];
  const match = list.find((a) => a?.icao === icao) ?? list[0];
  return str(match?.name);
}

// Common light-aircraft type codes, for aircraft that don't broadcast an emitter category:
// Cessna 150-210, Piper PA-xx, Cirrus SR20/22, Diamond DA20/40/42/62, Beech Bonanza/Baron,
// Mooney, Vans RV, Grumman AA-5, Robin, Tecnam.
const LIGHT_TYPES = /^(C1\d\d|C2[01]\d|P28|P32|PA\d|SR2|DA\d|BE3\d|BE5\d|BE9|M20|RV\d|AA5|DR4|P92|P2008)/;

// Rough size for the map symbol, from the ADS-B emitter category (A1 light, A2 small, A3/A4 large,
// A5 heavy, A7 rotorcraft, B1 glider, B4 ultralight), else from the type code.
export function sizeClass(a) {
  switch (a.category) {
    case 'A1': case 'A7': case 'B1': case 'B4': return 'light';
    case 'A2': return 'small';
    case 'A3': case 'A4': case 'A6': return 'large';
    case 'A5': return 'heavy';
  }
  return a.type && LIGHT_TYPES.test(a.type) ? 'light' : 'large';
}
