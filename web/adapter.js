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
    distanceNm: distanceNm(home.lat, home.lon, lat, lon),
    bearingDeg: bearingDeg(home.lat, home.lon, lat, lon),
  };
}

// Whole feed -> display aircraft, sorted by distance from home.
export function parseFeed(json, home) {
  const records = Array.isArray(json?.ac) ? json.ac : Array.isArray(json?.aircraft) ? json.aircraft : null;
  if (!records) throw new Error('Feed has neither ac[] nor aircraft[]');
  return records
    .map((r) => normalizeRecord(r, home))
    .filter(Boolean)
    .sort((a, b) => a.distanceNm - b.distanceNm);
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
  return {
    airline: str(fr.airline?.name),
    flightNumber: str(fr.callsign_iata),
    origin: airport(fr.origin),
    destination: airport(fr.destination),
  };
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
