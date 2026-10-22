// Live map behind the cards: home, the overhead radius, every aircraft with its heading,
// a fading trail of where each one has been since the page saw it, and the planned route
// of the closest aircraft. Uses Leaflet (web/vendor/leaflet), loaded as the global `L`.
import { greatCirclePoints, projectPosition } from './adapter.js';

const NM_TO_M = 1852;
const FORGET_AFTER_MS = 60 * 1000; // drop an aircraft's marker and trail when unseen this long
const TRAIL_BANDS = 5; // the trail is drawn in bands, fading towards its oldest end
const MAX_PREDICT_S = 20; // stop moving a plane forward when its data is this old (e.g. an outage)
const CORRECT_MS = 1500; // when fresh data disagrees with the prediction, ease into it over this long
const FRAME_MS = 50; // move planes at most 20 times a second

const PLANE_SVG =
  '<svg viewBox="0 0 24 24"><path d="M12 1.5c.8 0 1.4.9 1.4 2.2v5.4l8.1 4.6v2.1l-8.1-2.4v4.8l2.3 1.7V21l-3.7-1.1L8.3 21v-1.1l2.3-1.7v-4.8l-8.1 2.4v-2.1l8.1-4.6V3.7c0-1.3.6-2.2 1.4-2.2z"/></svg>';

// onSelect(hex) is called when a plane is clicked, and onSelect(null) for a click on the map.
export function createMap(element, config, { onSelect } = {}) {
  const { home, radiusNm, fetchRadiusMultiplier, map: opts } = config;
  const map = L.map(element, {
    zoomControl: false,
    doubleClickZoom: false, // double-click toggles full screen instead
    boxZoom: false,
    keyboard: false,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 120,
  });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.on('click', () => onSelect?.(null));
  L.tileLayer(opts.tileUrl, { attribution: opts.attribution, subdomains: 'abcd', maxZoom: 19 }).addTo(map);
  element.classList.toggle('dark-tiles', Boolean(opts.darkTiles));
  element.style.setProperty('--tile-brightness', String(opts.tileBrightness));

  L.circle([home.lat, home.lon], {
    radius: radiusNm * NM_TO_M,
    className: 'map-radius',
    interactive: false,
  }).addTo(map);
  L.marker([home.lat, home.lon], {
    icon: L.divIcon({ className: 'map-home', iconSize: [14, 14] }),
    interactive: false,
    keyboard: false,
  }).addTo(map);

  const trailLayer = L.layerGroup().addTo(map);
  const tailLayer = L.layerGroup().addTo(map); // joins each trail's last point to the moving plane
  const routeLayer = L.layerGroup().addTo(map);
  // hex -> { marker, tail, trail: [[lat, lon, t]], lastSeen, base, error, shown }
  const planes = new Map();

  // Frames map.viewRadiusNm around home in the part of the screen the cards don't cover.
  let homePadding = null;
  function fit(padding = homePadding) {
    if (!padding) return;
    homePadding = padding;
    const bounds = L.latLng(home.lat, home.lon).toBounds(2 * (opts.viewRadiusNm ?? radiusNm * fetchRadiusMultiplier) * NM_TO_M);
    map.fitBounds(bounds, { paddingTopLeft: padding.topLeft, paddingBottomRight: padding.bottomRight, animate: false });
  }

  // You can drag and zoom; the view returns home after map.recenterSeconds without touching it.
  let recenterTimer;
  const touched = () => {
    clearTimeout(recenterTimer);
    if (opts.recenterSeconds > 0) recenterTimer = setTimeout(() => fit(), opts.recenterSeconds * 1000);
  };
  for (const type of ['wheel', 'mousedown', 'touchstart']) element.addEventListener(type, touched, { passive: true });

  const planeIcon = L.divIcon({
    className: 'map-plane',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    html: `<div class="map-plane-body">${PLANE_SVG}</div><div class="map-plane-label"></div>`,
  });

  // Updates the marker's own element: hero highlight, heading, label.
  function stylePlane(p, a, label, isHero) {
    const { marker } = p;
    const el = marker.getElement();
    if (!el) return;
    el.classList.toggle('is-hero', isHero);
    p.tail.getElement()?.classList.toggle('is-hero', isHero);
    // Turn the short way round (350° -> 10° is +20°, not -340°), keeping a running angle for CSS.
    const target = a.track ?? 0;
    const current = marker.rotation ?? target;
    marker.rotation = current + ((((target - current) % 360) + 540) % 360) - 180;
    el.querySelector('.map-plane-body').style.transform = `rotate(${marker.rotation}deg)`;
    const labelEl = el.querySelector('.map-plane-label');
    if (labelEl.innerHTML !== label) labelEl.innerHTML = label;
  }

  function drawTrails(heroHex) {
    trailLayer.clearLayers();
    const cutoff = Date.now() - opts.trailMinutes * 60 * 1000;
    for (const [hex, p] of planes) {
      p.trail = p.trail.filter((pt) => pt[2] >= cutoff);
      if (p.trail.length < 2) continue;
      const pts = p.trail.map(([lat, lon]) => [lat, lon]);
      const segments = pts.length - 1;
      const bands = Math.min(TRAIL_BANDS, segments);
      for (let b = 0; b < bands; b++) {
        const start = Math.floor((b * segments) / bands);
        const end = Math.floor(((b + 1) * segments) / bands);
        L.polyline(pts.slice(start, end + 1), {
          className: hex === heroHex ? 'map-trail is-hero' : 'map-trail',
          opacity: 0.15 + (0.75 * (b + 1)) / bands, // oldest band faintest
          interactive: false,
        }).addTo(trailLayer);
      }
    }
  }

  function drawRoute(hero, route) {
    routeLayer.clearLayers();
    const o = route?.origin;
    const d = route?.destination;
    if (!hero || o?.lat == null || o?.lon == null || d?.lat == null || d?.lon == null) return;
    L.polyline(greatCirclePoints(o.lat, o.lon, d.lat, d.lon, 128), { className: 'map-route', interactive: false }).addTo(routeLayer);
  }

  // Dead reckoning: where the plane is now, from its last known position, speed and track.
  function predict(base, t) {
    if (base.speedKt === null || base.track === null) return [base.lat, base.lon];
    const seconds = Math.min(MAX_PREDICT_S, Math.max(0, (t - base.time) / 1000));
    return projectPosition(base.lat, base.lon, base.track, base.speedKt, seconds);
  }

  function positionAt(p, t) {
    const [lat, lon] = predict(p.base, t);
    if (!p.error) return [lat, lon];
    const left = 1 - (t - p.error.time) / CORRECT_MS; // the old prediction's error, fading out
    return left > 0 ? [lat + p.error.dLat * left, lon + p.error.dLon * left] : [lat, lon];
  }

  // Moves every plane along its predicted path, a few times a second.
  let lastFrame = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    if (t - lastFrame < FRAME_MS) return;
    lastFrame = t;
    const now = Date.now();
    for (const p of planes.values()) {
      p.shown = positionAt(p, now);
      p.marker.setLatLng(p.shown);
      const last = p.trail[p.trail.length - 1];
      p.tail.setLatLngs(last ? [[last[0], last[1]], p.shown] : []);
    }
  }
  requestAnimationFrame(frame);

  // aircraft: filtered list from the latest fetch; hero: the closest one (or null);
  // labelFor(a): text under each plane; heroRoute: the hero's route, if known.
  function update(aircraft, hero, labelFor, heroRoute) {
    const now = Date.now();
    for (const a of aircraft) {
      let p = planes.get(a.hex);
      const base = { lat: a.lat, lon: a.lon, time: a.positionTime ?? now, speedKt: a.speedKt, track: a.track };
      if (!p) {
        const marker = L.marker([a.lat, a.lon], { icon: planeIcon, keyboard: false }).addTo(map);
        const hex = a.hex;
        marker.on('click', () => onSelect?.(hex));
        const tail = L.polyline([], { className: 'map-trail', opacity: 0.9, interactive: false }).addTo(tailLayer);
        p = { marker, tail, trail: [], base, error: null };
        planes.set(a.hex, p);
      } else if (p.base.time !== base.time || p.base.lat !== base.lat || p.base.lon !== base.lon) {
        // New data: keep the plane where it's drawn and ease the difference out, so it never jumps.
        const shown = p.shown ?? positionAt(p, now);
        const next = predict(base, now);
        p.error = { dLat: shown[0] - next[0], dLon: shown[1] - next[1], time: now };
        p.base = base;
      }
      stylePlane(p, a, labelFor(a), a === hero);
      p.marker.setZIndexOffset(a === hero ? 1000 : 0);
      const last = p.trail[p.trail.length - 1];
      if (!last || last[0] !== a.lat || last[1] !== a.lon) p.trail.push([a.lat, a.lon, now]);
      p.lastSeen = now;
    }
    for (const [hex, p] of planes) {
      if (now - p.lastSeen > FORGET_AFTER_MS) {
        p.marker.remove();
        p.tail.remove();
        planes.delete(hex);
      } else {
        // Out of range or filtered out this time: fade it until it's forgotten or comes back.
        const el = p.marker.getElement();
        el?.classList.toggle('lost', p.lastSeen !== now);
        if (p.lastSeen !== now) el?.classList.remove('is-hero');
      }
    }
    drawTrails(hero?.hex);
    drawRoute(hero, heroRoute);
  }

  return { fit, update, invalidate: () => map.invalidateSize() };
}
