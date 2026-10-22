// Live map behind the cards: home, the overhead radius, every aircraft with its heading,
// a fading trail of where each one has been since the page saw it, and the planned route
// of the closest aircraft. Uses Leaflet (web/vendor/leaflet), loaded as the global `L`.
//
// Two kinds of plane: the few near home (and a picked one) are full markers with labels and
// trails; everything else in view, up to ~1,500 when zoomed out to 250 nm, is drawn on one
// canvas ("bulk"), which stays smooth where 1,500 HTML markers would not.
import { greatCirclePoints, projectPosition, sizeClass } from './adapter.js';

const NM_TO_M = 1852;
const FORGET_AFTER_MS = 60 * 1000; // drop an aircraft's marker and trail when unseen this long
const TRAIL_BANDS = 5; // the trail is drawn in bands, fading towards its oldest end
const MAX_PREDICT_S = 20; // stop moving a plane forward when its data is this old (e.g. an outage)
const CORRECT_MS = 1500; // when fresh data disagrees with the prediction, ease into it over this long
const FRAME_MS = 50; // move planes at most 20 times a second
const MAX_VIEW_RADIUS_NM = 250; // FreeFlight's largest area query; the map can't zoom out past it
const BULK_LABEL_ZOOM = 9; // canvas planes get labels from this zoom in...
const BULK_LABEL_MAX = 150; // ...and only while this few are on screen
const HIT_PX = 14; // a click this close to a canvas plane picks it

// Symbols on a 24x24 grid, nose up. Airliner: swept wings. Light aircraft: straight wings, small
// tail. Helicopter: cabin, tail boom and tail rotor, plus a two-blade main rotor that spins.
const JET_PATH =
  'M12 1.5c.8 0 1.4.9 1.4 2.2v5.4l8.1 4.6v2.1l-8.1-2.4v4.8l2.3 1.7V21l-3.7-1.1L8.3 21v-1.1l2.3-1.7v-4.8l-8.1 2.4v-2.1l8.1-4.6V3.7c0-1.3.6-2.2 1.4-2.2z';
const LIGHT_PATH = 'M11 2.5c0-.6.4-1 1-1s1 .4 1 1V8h9v2.5h-9v7h3.5v2H13v1.5h-2v-1.5H7.5v-2H11v-7H2V8h9z';
const HELI_PATH =
  'M12 3.6c2 0 3.4 2.4 3.4 5.3 0 2.1-1 3.6-2.4 4.2V19h2.6v1.4H9.4V19H12v-5.9c-1.4-.6-2.4-2.1-2.4-4.2 0-2.9 1.4-5.3 3.4-5.3z';
const ROTOR_CENTER = [12, 8.95];

const JET_SVG = `<svg viewBox="0 0 24 24"><path d="${JET_PATH}"/></svg>`;
const LIGHT_SVG = `<svg viewBox="0 0 24 24"><path d="${LIGHT_PATH}"/></svg>`;
const HELI_SVG =
  `<svg viewBox="0 0 24 24" style="overflow: visible"><path d="${HELI_PATH}"/>` +
  '<g class="rotor"><rect x="0.5" y="8.3" width="23" height="1.3" rx=".65"/><rect x="11.35" y="-2.6" width="1.3" height="23" rx=".65"/></g></svg>';

// Canvas symbols: shape and scale per size class (same proportions as the CSS for markers).
const BULK_SHAPES = {};
const BULK_SCALE = { light: 0.7, small: 0.8, large: 1, heavy: 1.15, heli: 0.75 };
const BULK_PX = 20; // a 'large' canvas plane is this many pixels across (markers are 32)

// onSelect(hex) is called when a plane is clicked, and onSelect(null) for a click on the map.
// onViewChange({ lat, lon, radiusNm }) is called after the map is moved or zoomed.
export function createMap(element, config, { onSelect, onViewChange } = {}) {
  if (!BULK_SHAPES.large) {
    BULK_SHAPES.large = new Path2D(JET_PATH);
    BULK_SHAPES.light = new Path2D(LIGHT_PATH);
    BULK_SHAPES.heli = new Path2D(HELI_PATH);
  }
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
  map.on('click', (e) => onSelect?.(bulkHit(e.containerPoint)?.hex ?? null));
  map.on('mousemove', (e) => {
    element.classList.toggle('over-plane', Boolean(bulkHit(e.containerPoint)));
  });
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
    atHome = true;
    const bounds = L.latLng(home.lat, home.lon).toBounds(2 * (opts.viewRadiusNm ?? radiusNm * fetchRadiusMultiplier) * NM_TO_M);
    map.fitBounds(bounds, { paddingTopLeft: padding.topLeft, paddingBottomRight: padding.bottomRight, animate: false });
    limitZoom();
  }

  // Distance (nm) from the view's centre to its farthest corner.
  function viewReachNm() {
    const c = map.getCenter();
    const b = map.getBounds();
    return Math.max(map.distance(c, b.getNorthEast()), map.distance(c, b.getSouthWest())) / NM_TO_M;
  }

  // The view the map shows. atHome: it's the home view fit() set, not one someone dragged or zoomed to.
  let atHome = false;
  function view() {
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lng, radiusNm: Math.min(MAX_VIEW_RADIUS_NM, viewReachNm()), atHome };
  }
  map.on('moveend', () => onViewChange?.(view()));
  // Zoomed far out, the home-area markers sit on top of each other: keep only the hero's label.
  const labelZoom = () => element.classList.toggle('few-labels', map.getZoom() < BULK_LABEL_ZOOM);
  map.on('zoomend', labelZoom);

  // Zooming out stops where the view's corners would be MAX_VIEW_RADIUS_NM from its centre.
  // Each zoom level halves distances, so that zoom is a log2 step from the current one.
  function limitZoom() {
    map.setMinZoom(Math.max(0, map.getZoom() - Math.log2(MAX_VIEW_RADIUS_NM / viewReachNm())));
  }

  // You can drag and zoom; the view returns home after map.recenterSeconds without touching it.
  let recenterTimer;
  const touched = () => {
    atHome = false;
    clearTimeout(recenterTimer);
    if (opts.recenterSeconds > 0) recenterTimer = setTimeout(() => fit(), opts.recenterSeconds * 1000);
  };
  for (const type of ['wheel', 'mousedown', 'touchstart']) element.addEventListener(type, touched, { passive: true });

  const planeIcon = L.divIcon({
    className: 'map-plane',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    html: `<div class="map-plane-body">${JET_SVG}</div><div class="map-plane-label"></div>`,
  });

  // Updates the marker's own element: hero highlight, heading, label.
  function stylePlane(p, a, label, isHero) {
    const { marker } = p;
    const el = marker.getElement();
    if (!el) return;
    el.classList.toggle('is-hero', isHero);
    const size = sizeClass(a);
    if (el.dataset.size !== size) {
      el.dataset.size = size;
      el.querySelector('.map-plane-body').innerHTML = size === 'heli' ? HELI_SVG : size === 'light' ? LIGHT_SVG : JET_SVG;
    }
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

  // ---- Bulk planes on a canvas, in a pane between the trails (400) and the markers (600).
  map.createPane('bulk').style.zIndex = '450';
  const canvas = L.DomUtil.create('canvas', 'map-bulk', map.getPane('bulk'));
  const ctx = canvas.getContext('2d');
  let bulk = new Map(); // hex -> { base, size, label }
  let drawn = []; // [{ hex, x, y }] where the last frame drew each canvas plane, for clicks

  function bulkHit(point) {
    let best = null;
    let bestD = HIT_PX * HIT_PX;
    for (const d of drawn) {
      const dd = (d.x - point.x) ** 2 + (d.y - point.y) ** 2;
      if (dd < bestD) [best, bestD] = [d, dd];
    }
    return best;
  }

  function drawBulk(now) {
    const size = map.getSize();
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== size.x * ratio || canvas.height !== size.y * ratio) {
      canvas.width = size.x * ratio;
      canvas.height = size.y * ratio;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
    }
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0])); // follow panning
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    drawn = [];
    const onScreen = [];
    for (const [hex, b] of bulk) {
      const [lat, lon] = predict(b.base, now);
      const pt = map.latLngToContainerPoint([lat, lon]);
      if (pt.x < -20 || pt.y < -20 || pt.x > size.x + 20 || pt.y > size.y + 20) continue;
      onScreen.push([hex, b, pt]);
    }
    const labels = map.getZoom() >= BULK_LABEL_ZOOM && onScreen.length <= BULK_LABEL_MAX;
    ctx.fillStyle = 'rgba(178, 192, 210, 0.85)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = 2;
    for (const [hex, b, pt] of onScreen) {
      const scale = (BULK_PX / 24) * (BULK_SCALE[b.size] ?? 1);
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(((b.base.track ?? 0) * Math.PI) / 180);
      ctx.scale(scale, scale);
      ctx.translate(-12, -12);
      ctx.fill(BULK_SHAPES[b.size] ?? BULK_SHAPES.large);
      if (b.size === 'heli') {
        ctx.translate(...ROTOR_CENTER);
        ctx.rotate((now / 600) * 2 * Math.PI); // same speed as the markers' CSS rotor
        ctx.fillRect(-11.5, -0.65, 23, 1.3);
        ctx.fillRect(-0.65, -11.5, 1.3, 23);
      }
      ctx.restore();
      drawn.push({ hex, x: pt.x, y: pt.y });
    }
    if (labels) {
      ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.shadowBlur = 3;
      for (const [, b, pt] of onScreen) ctx.fillText(b.label, pt.x, pt.y + 20);
    }
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
    drawBulk(now);
  }
  requestAnimationFrame(frame);

  // Everything else in view: plain list, drawn on the canvas. labelFor(a) gives plain text.
  function updateBulk(aircraft, labelFor) {
    const now = Date.now();
    bulk = new Map(
      aircraft.map((a) => [
        a.hex,
        {
          base: { lat: a.lat, lon: a.lon, time: a.positionTime ?? now, speedKt: a.speedKt, track: a.track },
          size: sizeClass(a),
          label: labelFor(a),
        },
      ]),
    );
  }

  // aircraft: filtered list from the latest fetch; hero: the closest one (or null);
  // labelFor(a): text under each plane; heroRoute: the leg the hero is on ({ origin, destination }), if known.
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
      if (now - p.lastSeen > FORGET_AFTER_MS || (p.lastSeen !== now && bulk.has(hex))) {
        // gone for a while, or now drawn on the canvas instead (e.g. no longer picked)
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

  if (location.hash === '#debug') window.overheadDebug = { map, drawnPlanes: () => drawn, bulkCount: () => bulk.size };

  return {
    fit,
    update,
    updateBulk,
    view,
    invalidate: () => {
      map.invalidateSize();
      if (homePadding) limitZoom(); // only once fit() has given the map a view
    },
  };
}
