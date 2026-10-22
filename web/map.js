// Live map behind the cards: home, the overhead radius, every aircraft with its heading,
// a fading trail of where each one has been since the page saw it, and the planned route
// of the closest aircraft. Uses Leaflet (web/vendor/leaflet), loaded as the global `L`.
import { greatCirclePoints } from './adapter.js';

const NM_TO_M = 1852;
const FORGET_AFTER_MS = 60 * 1000; // drop an aircraft's marker and trail when unseen this long
const TRAIL_BANDS = 5; // the trail is drawn in bands, fading towards its oldest end

const PLANE_SVG =
  '<svg viewBox="0 0 24 24"><path d="M12 1.5c.8 0 1.4.9 1.4 2.2v5.4l8.1 4.6v2.1l-8.1-2.4v4.8l2.3 1.7V21l-3.7-1.1L8.3 21v-1.1l2.3-1.7v-4.8l-8.1 2.4v-2.1l8.1-4.6V3.7c0-1.3.6-2.2 1.4-2.2z"/></svg>';

export function createMap(element, config) {
  const { home, radiusNm, fetchRadiusMultiplier, map: opts } = config;
  const map = L.map(element, {
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false, // double-click toggles full screen instead
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
    zoomSnap: 0.25,
    fadeAnimation: false,
    zoomAnimation: false,
  });
  L.tileLayer(opts.tileUrl, { attribution: opts.attribution, subdomains: 'abcd', maxZoom: 19 }).addTo(map);
  element.classList.toggle('dark-tiles', Boolean(opts.darkTiles));

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
  const routeLayer = L.layerGroup().addTo(map);
  const planes = new Map(); // hex -> { marker, trail: [[lat, lon, t]], lastSeen }

  // Frames the fetch radius in the part of the screen the cards don't cover.
  function fit(padding) {
    const bounds = L.latLng(home.lat, home.lon).toBounds(2 * radiusNm * fetchRadiusMultiplier * NM_TO_M);
    map.fitBounds(bounds, { paddingTopLeft: padding.topLeft, paddingBottomRight: padding.bottomRight, animate: false });
  }

  const planeIcon = L.divIcon({
    className: 'map-plane',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    html: `<div class="map-plane-body">${PLANE_SVG}</div><div class="map-plane-label"></div>`,
  });

  // Updates the marker's own element, so CSS can glide it to the new position.
  function stylePlane(marker, a, label, isHero) {
    const el = marker.getElement();
    if (!el) return;
    el.classList.toggle('is-hero', isHero);
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

  // aircraft: filtered list from the latest fetch; hero: the closest one (or null);
  // labelFor(a): text under each plane; heroRoute: the hero's route, if known.
  function update(aircraft, hero, labelFor, heroRoute) {
    const now = Date.now();
    for (const a of aircraft) {
      let p = planes.get(a.hex);
      if (!p) {
        const marker = L.marker([a.lat, a.lon], { icon: planeIcon, interactive: false, keyboard: false }).addTo(map);
        p = { marker, trail: [] };
        planes.set(a.hex, p);
      } else {
        p.marker.setLatLng([a.lat, a.lon]);
      }
      stylePlane(p.marker, a, labelFor(a), a === hero);
      p.marker.setZIndexOffset(a === hero ? 1000 : 0);
      const last = p.trail[p.trail.length - 1];
      if (!last || last[0] !== a.lat || last[1] !== a.lon) p.trail.push([a.lat, a.lon, now]);
      p.lastSeen = now;
    }
    for (const [hex, p] of planes) {
      if (now - p.lastSeen > FORGET_AFTER_MS) {
        p.marker.remove();
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
