// Live map behind the cards: home, the overhead radius, every aircraft with its heading,
// a fading trail of where each one has been since the page saw it, and the planned route
// of the closest aircraft. Uses Leaflet (web/vendor/leaflet), loaded as the global `L`.
//
// Two kinds of plane: the few near home (and a picked one) are full markers with labels and
// trails; everything else in view, up to ~1,500 when zoomed out to 250 nm, is drawn on one
// canvas ("bulk"), which stays smooth where 1,500 HTML markers would not.
import { greatCirclePoints, projectPosition, sizeClass, distanceNm } from './adapter.js';

const NM_TO_M = 1852;
const FORGET_AFTER_MS = 60 * 1000; // drop an aircraft's marker and trail when unseen this long
const TRAIL_BANDS = 5; // the trail is drawn in bands, fading towards its oldest end
const MAX_PREDICT_S = 20; // stop moving a plane forward when its data is this old (e.g. an outage)
const CORRECT_MS = 1500; // when fresh data disagrees with the prediction, ease into it over this long
const FRAME_MS = 50; // move planes at most 20 times a second
const MAX_VIEW_RADIUS_NM = 250; // FreeFlight's largest area query; the map can't zoom out past it
const MARKER_LABEL_ZOOM = 10; // below this, home-area markers (packed within a few nm) keep only the hero's label
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
  element.style.setProperty('--plane-color', opts.planeColor);

  if (opts.showRadius) {
    L.circle([home.lat, home.lon], {
      radius: radiusNm * NM_TO_M,
      className: 'map-radius',
      interactive: false,
    }).addTo(map);
  }
  L.marker([home.lat, home.lon], {
    icon: L.divIcon({ className: 'map-home', iconSize: [14, 14] }),
    interactive: false,
    keyboard: false,
  }).addTo(map);

  const trailLayer = L.layerGroup().addTo(map);
  const tailLayer = L.layerGroup().addTo(map); // joins each trail's last point to the moving plane
  const routeLayer = L.layerGroup().addTo(map);
  // hex -> { marker, tail, lastSeen, base, error, shown }: planes drawn as markers
  const planes = new Map();
  // hex -> { points: [[lat, lon, t]], lastSeen }: every plane's trail, marker or canvas, so a trail
  // carries on when a plane moves out of the home area onto the canvas (or is picked back off it)
  const trails = new Map();
  function record(a, now) {
    let t = trails.get(a.hex);
    if (!t) trails.set(a.hex, (t = { points: [] }));
    const last = t.points[t.points.length - 1];
    if (!last || last[0] !== a.lat || last[1] !== a.lon) {
      // A long gap or an impossible jump (a glitch, or a plane back after a while): start the trail
      // again rather than draw a straight line across the map.
      if (last) {
        const hours = (now - last[2]) / 3_600_000;
        if (hours > 2 / 60 || distanceNm(last[0], last[1], a.lat, a.lon) / Math.max(hours, 1 / 3600) > 800) t.points = [];
      }
      t.points.push([a.lat, a.lon, now]);
    }
    t.lastSeen = now;
  }
  function pruneTrails(now) {
    const cutoff = now - opts.trailMinutes * 60 * 1000;
    for (const [hex, t] of trails) {
      if (now - t.lastSeen > FORGET_AFTER_MS) trails.delete(hex);
      else if (t.points.length && t.points[0][2] < cutoff) t.points = t.points.filter((pt) => pt[2] >= cutoff);
    }
  }
  const trailPoints = (hex) => trails.get(hex)?.points ?? [];

  // Frames map.viewRadiusNm around home, with home in the middle of the screen.
  let homePadding = null;
  let atHome = false; // showing the home view fit() set, not one someone moved to
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

  // The view the map shows.
  function view() {
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lng, radiusNm: Math.min(maxReach, viewReachNm()) };
  }
  map.on('moveend', () => onViewChange?.(view()));
  // Zoomed far out, the home-area markers sit on top of each other: keep only the hero's label.
  const labelZoom = () => element.classList.toggle('few-labels', map.getZoom() < MARKER_LABEL_ZOOM);
  map.on('zoomend', labelZoom);

  // Zooming out stops where the view's corners would be maxReach from its centre (250 nm at most,
  // FreeFlight's limit; less where map.maxViewRadiusNm says so, e.g. on a TV). Each zoom level
  // halves distances, so that zoom is a log2 step from the current one.
  const maxReach = Math.min(MAX_VIEW_RADIUS_NM, opts.maxViewRadiusNm ?? MAX_VIEW_RADIUS_NM);
  function limitZoom() {
    map.setMinZoom(Math.max(0, map.getZoom() - Math.log2(maxReach / viewReachNm())));
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
    // The hero's label is a tag (logo, name, route) beside the plane, on its left near the right edge.
    const labelEl = el.querySelector('.map-plane-label');
    if (labelEl.dataset.html !== label) {
      labelEl.dataset.html = label; // compared as sent: innerHTML reads back normalised
      labelEl.innerHTML = label;
    }
    labelEl.classList.toggle('map-tag', isHero);
    if (isHero) labelEl.classList.toggle('tag-left', map.latLngToContainerPoint(marker.getLatLng()).x > map.getSize().x * 0.66);
  }

  function drawTrails(heroHex) {
    trailLayer.clearLayers();
    for (const hex of planes.keys()) {
      const trail = trailPoints(hex);
      if (trail.length < 2) continue;
      const pts = trail.map(([lat, lon]) => [lat, lon]);
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

  // ---- Canvas planes' trails: their own canvas under the canvas planes, redrawn only when data
  // arrives or the map is zoomed or moved (it pans along with the map in between). Each frame only
  // adds the short line from a trail's last point to its moving plane, on the planes' canvas.
  map.createPane('bulkTrails').style.zIndex = '440';
  const trailCanvas = L.DomUtil.create('canvas', 'map-bulk', map.getPane('bulkTrails'));
  const trailCtx = trailCanvas.getContext('2d');
  const TRAIL_ALPHAS = [0.12, 0.25, 0.45, 0.7]; // by age, oldest quarter faintest

  function sizeCanvas(c, size, ratio) {
    if (c.width !== size.x * ratio || c.height !== size.y * ratio) {
      c.width = size.x * ratio;
      c.height = size.y * ratio;
      c.style.width = `${size.x}px`;
      c.style.height = `${size.y}px`;
    }
  }

  function drawBulkTrails() {
    const size = map.getSize();
    const ratio = window.devicePixelRatio || 1;
    sizeCanvas(trailCanvas, size, ratio);
    L.DomUtil.setPosition(trailCanvas, map.containerPointToLayerPoint([0, 0]));
    trailCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
    trailCtx.clearRect(0, 0, size.x, size.y);
    if (!bulk.size) return;
    const now = Date.now();
    // with many planes on screen, keep trails shorter so the map stays readable
    const maxAge = (bulk.size > 600 ? Math.min(5, opts.trailMinutes) : opts.trailMinutes) * 60 * 1000;
    const bands = TRAIL_ALPHAS.map(() => new Path2D());
    for (const hex of bulk.keys()) {
      const points = trailPoints(hex);
      for (let i = 1; i < points.length; i++) {
        const age = now - points[i][2];
        if (age > maxAge) continue;
        const a = map.latLngToContainerPoint([points[i - 1][0], points[i - 1][1]]);
        const b = map.latLngToContainerPoint([points[i][0], points[i][1]]);
        const band = bands[Math.min(TRAIL_ALPHAS.length - 1, Math.floor((1 - age / maxAge) * TRAIL_ALPHAS.length))];
        band.moveTo(a.x, a.y);
        band.lineTo(b.x, b.y);
      }
    }
    trailCtx.strokeStyle = opts.planeColor;
    trailCtx.lineWidth = 1.5;
    trailCtx.lineCap = 'round';
    bands.forEach((path, i) => {
      trailCtx.globalAlpha = TRAIL_ALPHAS[i];
      trailCtx.stroke(path);
    });
    trailCtx.globalAlpha = 1;
  }
  map.on('zoomend moveend resize', drawBulkTrails);

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

  // Each canvas symbol, gold with its dark outline, drawn once per size class and screen density.
  const sprites = new Map();
  function sprite(size, ratio) {
    const key = `${size}@${ratio}`;
    if (!sprites.has(key)) {
      const unit = (BULK_PX * (BULK_SCALE[size] ?? 1)) / 24; // CSS px per symbol-grid unit
      const pad = 2;
      const css = 24 * unit + pad * 2;
      const c = document.createElement('canvas');
      c.width = c.height = Math.ceil(css * ratio);
      const g = c.getContext('2d');
      g.scale(ratio, ratio);
      g.translate(pad, pad);
      g.scale(unit, unit);
      g.fillStyle = opts.planeColor;
      g.strokeStyle = 'rgba(0, 0, 0, 0.85)'; // same dark outline as the markers
      g.lineWidth = 1.4;
      g.lineJoin = 'round';
      const shape = BULK_SHAPES[size] ?? BULK_SHAPES.large;
      g.stroke(shape);
      g.fill(shape);
      sprites.set(key, { canvas: c, size: c.width / ratio, unit });
    }
    return sprites.get(key);
  }

  function drawBulk(now) {
    const size = map.getSize();
    const ratio = window.devicePixelRatio || 1;
    sizeCanvas(canvas, size, ratio);
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
    // join each trail's last recorded point to where its plane is drawn now (zoomed out, that gap
    // is a pixel or two, so it's skipped there, where most planes are)
    ctx.strokeStyle = opts.planeColor;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    for (const [hex, , pt] of map.getZoom() >= BULK_LABEL_ZOOM ? onScreen : []) {
      const points = trailPoints(hex);
      const last = points[points.length - 1];
      if (!last) continue;
      const from = map.latLngToContainerPoint([last[0], last[1]]);
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = opts.planeColor;
    for (const [hex, b, pt] of onScreen) {
      // stamp the pre-drawn symbol, rotated to the heading (no per-plane path filling or outlining)
      const s = sprite(b.size, ratio);
      const r = ((b.base.track ?? 0) * Math.PI) / 180;
      const cos = Math.cos(r) * ratio;
      const sin = Math.sin(r) * ratio;
      ctx.setTransform(cos, sin, -sin, cos, pt.x * ratio, pt.y * ratio);
      ctx.drawImage(s.canvas, -s.size / 2, -s.size / 2, s.size, s.size);
      if (b.size === 'heli') {
        const k = s.unit;
        ctx.translate((ROTOR_CENTER[0] - 12) * k, (ROTOR_CENTER[1] - 12) * k);
        ctx.rotate((now / 600) * 2 * Math.PI); // same speed as the markers' CSS rotor
        ctx.fillRect(-11.5 * k, -0.65 * k, 23 * k, 1.3 * k);
        ctx.fillRect(-0.65 * k, -11.5 * k, 1.3 * k, 23 * k);
      }
      drawn.push({ hex, x: pt.x, y: pt.y });
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (labels) {
      ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#eef1f5';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
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
    for (const [hex, p] of planes) {
      p.shown = positionAt(p, now);
      p.marker.setLatLng(p.shown);
      const trail = trailPoints(hex);
      const last = trail[trail.length - 1];
      p.tail.setLatLngs(last ? [[last[0], last[1]], p.shown] : []);
    }
    drawBulk(now);
  }
  requestAnimationFrame(frame);

  // Everything else in view: plain list, drawn on the canvas. labelFor(a) gives plain text.
  function updateBulk(aircraft, labelFor) {
    const now = Date.now();
    for (const a of aircraft) record(a, now);
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
  // labelFor(a): HTML for each plane's label (the hero's is its tag); heroRoute: the leg the hero is
  // on ({ origin, destination }), if known.
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
        p = { marker, tail, base, error: null };
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
      record(a, now);
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
    pruneTrails(now);
    drawTrails(hero?.hex);
    drawBulkTrails();
    drawRoute(hero, heroRoute);
  }

  if (location.hash === '#debug') window.overheadDebug = { map, drawnPlanes: () => drawn, bulkCount: () => bulk.size, trails };

  // Remote-control and keyboard moves: pan by a quarter of the screen, zoom by half a level.
  function command(name) {
    const { x, y } = map.getSize();
    const moves = { panUp: [0, -y / 4], panDown: [0, y / 4], panLeft: [-x / 4, 0], panRight: [x / 4, 0] };
    if (moves[name]) map.panBy(moves[name]);
    else if (name === 'zoomIn') map.zoomIn(0.5);
    else if (name === 'zoomOut') map.zoomOut(0.5);
    else return false;
    touched();
    return true;
  }

  return {
    fit,
    command,
    atHome: () => atHome,
    update,
    updateBulk,
    view,
    invalidate: () => {
      map.invalidateSize();
      if (homePadding) limitZoom(); // only once fit() has given the map a view
    },
  };
}
