const express = require("express");
const sharp = require("sharp");

const app = express();
const PORT = process.env.PORT || 3000;

// Pilot-only: store last webhook events in memory (easy debugging)
const recentWebhookHits = [];

// Simple in-memory cache for geocoding (saves $$ + avoids jitter)
const geocodeCache = new Map();

app.use(express.json({ limit: "4mb" }));

app.get("/", (req, res) => res.send("Savvy Cruiser Map Generator is running"));

app.get("/debug/webhooks", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(recentWebhookHits, null, 2));
});

/* -------------------- SHOPIFY LINE ITEM PROPERTY PARSING -------------------- */

function extractLineItemProperties(lineItem) {
  const props = [];

  if (Array.isArray(lineItem?.properties)) {
    for (const p of lineItem.properties) {
      const name = p?.name ?? p?.key;
      const value = p?.value;
      if (name && value != null && String(value).trim() !== "") {
        props.push({ name: String(name), value: String(value) });
      }
    }
  }

  if (Array.isArray(lineItem?.customAttributes)) {
    for (const p of lineItem.customAttributes) {
      const name = p?.key ?? p?.name;
      const value = p?.value;
      if (name && value != null && String(value).trim() !== "") {
        props.push({ name: String(name), value: String(value) });
      }
    }
  }

  return props;
}

function getField(fields, labelContains) {
  const hit = fields.find((f) =>
    (f.name || "").toLowerCase().includes(labelContains.toLowerCase())
  );
  return hit ? hit.value : null;
}

function getActualPorts(fields) {
  return fields
    .filter((f) => (f.name || "").toLowerCase().includes("actual port"))
    .map((f) => {
      const m = String(f.name).match(/(\d+)/);
      const n = m ? parseInt(m[1], 10) : 9999;
      return { n, value: String(f.value || "").trim() };
    })
    .filter((x) => x.value.length > 0)
    .sort((a, b) => a.n - b.n)
    .map((x) => x.value);
}

function normalizeDateToYyyyMmDd(value) {
  if (!value) return value;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mm = String(parseInt(m[1], 10)).padStart(2, "0");
    const dd = String(parseInt(m[2], 10)).padStart(2, "0");
    const yyyy = m[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  return s;
}

function toCruiseDateString(yyyyMmDd) {
  if (!yyyyMmDd || typeof yyyyMmDd !== "string") return "";
  const parts = yyyyMmDd.split("-");
  if (parts.length !== 3) return "";

  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);

  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mon = months[(m || 1) - 1] || "Jan";
  const dd = String(d || 1).padStart(2, "0");
  return `${y} ${mon} ${dd}`;
}

function extractPortsFromStops(obj) {
  const keys = Object.keys(obj).filter(
    (k) => k.startsWith("stop_") && k.endsWith("_text")
  );

  keys.sort((a, b) => {
    const na = parseInt(a.split("_")[1], 10);
    const nb = parseInt(b.split("_")[1], 10);
    return na - nb;
  });

  const ports = [];
  for (const k of keys) {
    const text = String(obj[k] || "").trim();
    if (!text) continue;

    if (text.toLowerCase().startsWith("departing from ")) {
      ports.push(text.replace(/^Departing from\s+/i, "").trim());
    } else {
      ports.push(text);
    }
  }
  return ports;
}

/* -------------------- PORT NORMALIZATION / GEOCODE -------------------- */

const PINNED_PORT_COORDS = {
  "Port Canaveral, Florida": [-80.6056, 28.41],
  "Grand Turk Cruise Center, Turks and Caicos": [-71.142, 21.4643],
  "Amber Cove, Dominican Republic": [-70.15, 19.833],
  "Nassau, Bahamas": [-77.355, 25.078],
  "Grand Bahama Island, Bahamas": [-78.65, 26.533],
  "Celebration Key, Bahamas": [-78.498, 26.57]
};

function normalizePortText(raw) {
  if (!raw) return "";
  let s = String(raw).trim();

  s = s.replace(/^Arriving in\s+/i, "").trim();
  s = s.replace(/^Arriving at\s+/i, "").trim();
  s = s.replace(/^Departing from\s+/i, "").trim();

  const lower = s.toLowerCase();

  if (lower.includes("celebration key") || lower.includes("celebration cay")) {
    return "Celebration Key, Bahamas";
  }

  if (lower.includes("port canaveral")) return "Port Canaveral, Florida";
  if (lower.includes("grand turk")) return "Grand Turk Cruise Center, Turks and Caicos";
  if (lower.includes("amber cove") || lower.includes("puerto plata-amber cove")) return "Amber Cove, Dominican Republic";
  if (lower.includes("nassau")) return "Nassau, Bahamas";
  if (lower.includes("grand bahama")) return "Grand Bahama Island, Bahamas";

  return s.replace(/\s+/g, " ").trim();
}

async function geocodePortFallback(portQuery) {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error("Missing MAPBOX_TOKEN in Render environment variables.");

  const cacheKey = `bbox:${portQuery.toLowerCase().trim()}`;
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);

  // Caribbean-ish bbox/proximity for cruise routes
  const bbox = "-90,17,-55,32";
  const proximity = "-75,23.5";

  const query = encodeURIComponent(portQuery);
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json` +
    `?access_token=${token}` +
    `&limit=1` +
    `&types=poi,place,locality` +
    `&bbox=${bbox}` +
    `&proximity=${proximity}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Mapbox geocoding failed: ${resp.status} ${t}`);
  }

  const data = await resp.json();
  const feature = data?.features?.[0];
  const center = feature?.center;

  if (!Array.isArray(center) || center.length !== 2) {
    throw new Error(`No geocoding result (bbox) for: ${portQuery}`);
  }

  const result = {
    portQuery,
    placeName: feature.place_name || portQuery,
    coordinates: center
  };

  geocodeCache.set(cacheKey, result);
  return result;
}

async function resolvePort(portQuery) {
  if (PINNED_PORT_COORDS[portQuery]) {
    return { portQuery, placeName: portQuery, coordinates: PINNED_PORT_COORDS[portQuery] };
  }
  return geocodePortFallback(portQuery);
}

function cleanCoordinates(coords) {
  const cleaned = [];
  for (const c of coords) {
    if (!Array.isArray(c) || c.length !== 2) continue;
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    if (lng < -180 || lng > 180) continue;
    if (lat < -90 || lat > 90) continue;
    cleaned.push([lng, lat]);
  }
  return cleaned;
}

function nearlySameCoord(a, b) {
  const dlng = Math.abs(a[0] - b[0]);
  const dlat = Math.abs(a[1] - b[1]);
  return dlng < 0.03 && dlat < 0.03;
}

/* -------------------- ROUTE “ARTSY” PATH (SMOOTH + JITTER) -------------------- */

function deg2rad(d) { return (d * Math.PI) / 180; }
function rad2deg(r) { return (r * 180) / Math.PI; }

function slerpGreatCircle(a, b, t) {
  const [lng1, lat1] = a.map(deg2rad);
  const [lng2, lat2] = b.map(deg2rad);

  const x1 = Math.cos(lat1) * Math.cos(lng1);
  const y1 = Math.cos(lat1) * Math.sin(lng1);
  const z1 = Math.sin(lat1);

  const x2 = Math.cos(lat2) * Math.cos(lng2);
  const y2 = Math.cos(lat2) * Math.sin(lng2);
  const z2 = Math.sin(lat2);

  let dot = x1*x2 + y1*y2 + z1*z2;
  dot = Math.max(-1, Math.min(1, dot));

  const omega = Math.acos(dot);
  if (!Number.isFinite(omega) || omega === 0) return a;

  const sinOmega = Math.sin(omega);
  const k1 = Math.sin((1 - t) * omega) / sinOmega;
  const k2 = Math.sin(t * omega) / sinOmega;

  const x = k1*x1 + k2*x2;
  const y = k1*y1 + k2*y2;
  const z = k1*z1 + k2*z2;

  const lat = Math.atan2(z, Math.sqrt(x*x + y*y));
  const lng = Math.atan2(y, x);

  return [rad2deg(lng), rad2deg(lat)];
}

function densifyRoute(coords, pointsPerLeg = 18) {
  const c = cleanCoordinates(coords);
  if (c.length < 2) return c;

  const out = [];
  for (let i = 0; i < c.length - 1; i++) {
    const a = c[i];
    const b = c[i + 1];
    if (i === 0) out.push(a);
    for (let j = 1; j <= pointsPerLeg; j++) {
      const t = j / (pointsPerLeg + 1);
      out.push(slerpGreatCircle(a, b, t));
    }
    out.push(b);
  }
  return out;
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function jitterRoute(routeCoords, seedKey, amplitudeKm = 9) {
  const coords = cleanCoordinates(routeCoords);
  if (coords.length < 3) return coords;

  const seed = hashString(seedKey || JSON.stringify(coords.slice(0, 5)));
  const rnd = makeRng(seed);

  const out = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const prev = coords[i - 1];
    const curr = coords[i];
    const next = coords[i + 1];

    const lng = curr[0];
    const lat = curr[1];

    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.sqrt(dx*dx + dy*dy) || 1e-6;
    const nx = -dy / len;
    const ny = dx / len;

    const r = (rnd() - 0.5) * 2;
    const localAmpKm = amplitudeKm * (0.25 + 0.75 * Math.abs(rnd() - 0.5) * 2);

    const dLat = (localAmpKm / 111) * r;
    const dLng = (localAmpKm / (111 * Math.cos(deg2rad(lat)) || 1)) * r;

    out.push([lng + nx * dLng, lat + ny * dLat]);
  }
  out.push(coords[coords.length - 1]);
  return out;
}

/* -------------------- MAP PROJECTION + VIEW -------------------- */

function lngLatToWorld(lng, lat) {
  const x = (lng + 180) / 360;
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return { x, y };
}

function computeBounds(coords) {
  let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90;
  for (const [lng, lat] of coords) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return { minLng, maxLng, minLat, maxLat };
}

function computeCenterZoom(coords, width, height, padding = 140) {
  const { minLng, maxLng, minLat, maxLat } = computeBounds(coords);
  const centerLng = (minLng + maxLng) / 2;
  const centerLat = (minLat + maxLat) / 2;

  const a = lngLatToWorld(minLng, maxLat);
  const b = lngLatToWorld(maxLng, minLat);

  const worldWidth = Math.abs(b.x - a.x) || 1e-9;
  const worldHeight = Math.abs(b.y - a.y) || 1e-9;

  const usableW = Math.max(1, width - padding * 2);
  const usableH = Math.max(1, height - padding * 2);

  const tileSize = 512;
  const zoomX = Math.log2(usableW / (worldWidth * tileSize));
  const zoomY = Math.log2(usableH / (worldHeight * tileSize));

  let zoom = Math.min(zoomX, zoomY);
  if (!Number.isFinite(zoom)) zoom = 3;

  zoom = Math.max(1, Math.min(zoom, 8));
  return { centerLng, centerLat, zoom: Number(zoom.toFixed(2)) };
}

function lngLatToPixel({ lng, lat, view, tileSize }) {
  const scale = tileSize * Math.pow(2, view.zoom) * (view.pixelRatio || 1);

  const p = lngLatToWorld(lng, lat);
  const c = lngLatToWorld(view.centerLng, view.centerLat);

  let dxWorld = p.x - c.x;
  if (dxWorld > 0.5) dxWorld -= 1;
  if (dxWorld < -0.5) dxWorld += 1;

  const dx = dxWorld * scale;
  const dy = (p.y - c.y) * scale;

  return { x: view.pixelWidth / 2 + dx, y: view.pixelHeight / 2 + dy };
}

function computePositions({ coords, view, tileSize }) {
  return coords.map(([lng, lat]) => {
    const { x, y } = lngLatToPixel({ lng, lat, view, tileSize });
    return { lng, lat, x, y };
  });
}

function countInBounds(positions, view) {
  let n = 0;
  for (const p of positions) {
    if (p.x >= 0 && p.y >= 0 && p.x <= view.pixelWidth && p.y <= view.pixelHeight) n++;
  }
  return n;
}

/* -------------------- MAPBOX BASE MAP URL (NO ROUTE OVERLAY) -------------------- */

const MAPBOX_STYLE_ID = "mapbox/light-v11";
const ROUTE_TEAL = "0aa6a6";
const SLATE = "2f3b45";

function buildBaseOnlyMapUrl({ fitCoords, width = 1200, height = 800, retina = false }) {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error("Missing MAPBOX_TOKEN in Render environment variables.");
  if (width < 1 || width > 1280) throw new Error("Width must be between 1-1280.");
  if (height < 1 || height > 1280) throw new Error("Height must be between 1-1280.");

  const fit = cleanCoordinates(fitCoords);
  if (fit.length < 2) throw new Error("Not enough valid coordinates to fit map.");

  const { centerLng, centerLat, zoom } = computeCenterZoom(fit, width, height, 155);

  const sizePart = retina ? `${width}x${height}@2x` : `${width}x${height}`;
  const url = `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE_ID}/static/${centerLng},${centerLat},${zoom}/${sizePart}?access_token=${token}`;

  const pixelRatio = retina ? 2 : 1;
  return {
    url,
    view: {
      centerLng,
      centerLat,
      zoom,
      pixelRatio,
      requestedPixelWidth: width * pixelRatio,
      requestedPixelHeight: height * pixelRatio
    }
  };
}

/* -------------------- ART LAYERS: ROUTE + CHEVRONS + LABELS/DOTS -------------------- */

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function countryFromPlaceName(placeName) {
  if (!placeName) return "";
  const parts = String(placeName).split(",").map((p) => p.trim()).filter(Boolean);
  const last = parts[parts.length - 1] || "";
  if (last === "United States") return "USA";
  return last;
}

function portLabelText(resolvedPort) {
  const portQuery = resolvedPort?.portQuery || "";
  const placeName = resolvedPort?.placeName || "";
  if (portQuery.includes(",")) return portQuery;
  const country = countryFromPlaceName(placeName);
  return country ? `${portQuery}, ${country}` : portQuery;
}

/* ---------- Collision-avoid label placement ---------- */

function approxTextWidthPx(text, fontSize) {
  return Math.round(Math.max(80, Math.min(980, text.length * fontSize * 0.55)));
}

function labelCandidates({ x, y, view, w, h }) {
  const pad = 14;
  const gap = 18;

  const candidates = [
    { left: Math.round(x + gap), top: Math.round(y - gap - h) },        // UR
    { left: Math.round(x - gap - w), top: Math.round(y - gap - h) },    // UL
    { left: Math.round(x + gap), top: Math.round(y + gap) },            // DR
    { left: Math.round(x - gap - w), top: Math.round(y + gap) },        // DL
    { left: Math.round(x + gap), top: Math.round(y - h / 2) },          // R
    { left: Math.round(x - gap - w), top: Math.round(y - h / 2) },      // L
    { left: Math.round(x - w / 2), top: Math.round(y + gap) },          // D
    { left: Math.round(x - w / 2), top: Math.round(y - gap - h) },      // U
  ];

  return candidates.map((c) => ({
    left: Math.max(pad, Math.min(c.left, view.pixelWidth - w - pad)),
    top: Math.max(pad, Math.min(c.top, view.pixelHeight - h - pad)),
  }));
}

function rectsOverlap(a, b, pad = 6) {
  return !(
    a.left + a.w + pad < b.left ||
    b.left + b.w + pad < a.left ||
    a.top + a.h + pad < b.top ||
    b.top + b.h + pad < a.top
  );
}

function placeLabelsNoOverlap({ points, labels, view, fontSize }) {
  const placed = [];
  const result = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const text = labels[i] || "";
    if (!text) {
      result.push(null);
      continue;
    }

    const w = approxTextWidthPx(text, fontSize);
    const h = Math.round(fontSize * 1.35);

    const candidates = labelCandidates({ x: p.x, y: p.y, view, w, h });

    let chosen = null;
    for (const c of candidates) {
      const rect = { left: c.left, top: c.top, w, h };
      const collides = placed.some((r) => rectsOverlap(rect, r, 10));
      if (!collides) {
        chosen = rect;
        break;
      }
    }

    if (!chosen) {
      const pad = 14;
      chosen = {
        left: Math.max(pad, Math.min(Math.round(p.x + 18), view.pixelWidth - w - pad)),
        top: Math.max(pad, Math.min(Math.round(p.y - 18 - h), view.pixelHeight - h - pad)),
        w,
        h
      };
    }

    placed.push(chosen);
    result.push({ ...chosen, text });
  }

  return result;
}

/* ---------- Stop numbers ---------- */
/**
 * No number for start (index 0).
 * Number every stop AFTER start: 1..(count-1)
 * This matches your example: start is Port Canaveral (no number),
 * then Grand Turk=1, Amber Cove=2, Nassau=3, Celebration Key=4.
 */
function makeStopNumbers(count) {
  const nums = new Array(count).fill("");
  if (count <= 1) return nums;
  for (let i = 1; i < count; i++) nums[i] = String(i);
  return nums;
}

/* ---------- White chevrons ---------- */
function chevronSvg({ angleDeg, size = 30, opacity = 0.70, colorHex = "ffffff" }) {
  const w = size * 2;
  const h = size * 2;
  const cx = size;
  const cy = size;

  const len = size * 0.95;
  const wing = size * 0.40;

  const x1 = cx - len * 0.45;
  const x2 = cx + len * 0.45;
  const yUp = cy - wing;
  const yDn = cy + wing;

  return Buffer.from(`
    <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <g transform="rotate(${angleDeg.toFixed(2)} ${cx} ${cy})">
        <line x1="${x1}" y1="${yUp}" x2="${x2}" y2="${cy}"
          stroke="#${colorHex}" stroke-opacity="${opacity}" stroke-width="5" stroke-linecap="round"/>
        <line x1="${x1}" y1="${yDn}" x2="${x2}" y2="${cy}"
          stroke="#${colorHex}" stroke-opacity="${opacity}" stroke-width="5" stroke-linecap="round"/>
      </g>
    </svg>
  `.trim());
}

/* ---------- Artsy route SVGs (wash + main) ---------- */
function routeSvgsFromPixelPoints({ width, height, points, seedKey }) {
  const seed = hashString(seedKey || JSON.stringify(points.slice(0, 10)));
  const rnd = makeRng(seed);

  const jittered = points.map((p, idx) => {
    if (idx === 0 || idx === points.length - 1) return p;
    const j = (rnd() - 0.5) * 2;
    const k = (rnd() - 0.5) * 2;
    return { x: p.x + j * 2.0, y: p.y + k * 2.0 };
  });

  const toPts = (arr) => arr.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  const ptsMain = toPts(points);
  const ptsSketch = toPts(jittered);

  const washSvg = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <polyline points="${ptsSketch}" fill="none"
        stroke="#${ROUTE_TEAL}" stroke-opacity="0.14" stroke-width="26"
        stroke-linecap="round" stroke-linejoin="round"/>
      <polyline points="${ptsSketch}" fill="none"
        stroke="#${ROUTE_TEAL}" stroke-opacity="0.08" stroke-width="40"
        stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `.trim());

  const mainSvg = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <polyline points="${ptsMain}" fill="none"
        stroke="#${SLATE}" stroke-opacity="0.18" stroke-width="12"
        stroke-linecap="round" stroke-linejoin="round"/>
      <polyline points="${ptsMain}" fill="none"
        stroke="#${ROUTE_TEAL}" stroke-opacity="0.88" stroke-width="6"
        stroke-linecap="round" stroke-linejoin="round"/>
      <polyline points="${ptsSketch}" fill="none"
        stroke="#${ROUTE_TEAL}" stroke-opacity="0.55" stroke-width="3.5"
        stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `.trim());

  return { washSvg, mainSvg };
}

/**
 * Water mask heuristic for mapbox/light-v11.
 * IMPORTANT: We also compute a coverage ratio and provide a fallback to avoid masking EVERYTHING.
 */
function buildWaterMaskFromBaseMapRGBA(rgba, width, height) {
  const out = Buffer.alloc(width * height * 4, 0);

  let waterCount = 0;

  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4 + 0];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];

    // brightness
    const y = (r * 0.2126 + g * 0.7152 + b * 0.0722);

    // water-ish tends to have a slight blue/cyan bias in light-v11
    const blueBias = (b - r) + (b - g);
    const bOverRG = (b > r + 6) && (b > g + 4);

    // Slightly looser rules than before (prevents full wipeout)
    const isWater =
      (y > 105 && blueBias > 10) ||
      (y > 130 && bOverRG) ||
      (y > 155 && blueBias > 6);

    const alpha = isWater ? 255 : 0;

    out[i * 4 + 0] = 255;
    out[i * 4 + 1] = 255;
    out[i * 4 + 2] = 255;
    out[i * 4 + 3] = alpha;

    if (isWater) waterCount++;
  }

  const coverage = waterCount / (width * height);
  return { maskRgba: out, coverage };
}

async function addRouteMaskedDotsLabelsChevrons({
  pngBuffer,
  displayCoords,
  routeCoordsForArrows,
  routeCoordsForLine,
  resolvedPorts,
  view,
  isRoundTrip,
  seedKey
}) {
  const meta = await sharp(pngBuffer).metadata();
  const actualW = meta?.width || view.requestedPixelWidth;
  const actualH = meta?.height || view.requestedPixelHeight;

  const actualView = { ...view, pixelWidth: actualW, pixelHeight: actualH };

  // Decide tile size projection (256 vs 512)
  const pos512 = computePositions({ coords: displayCoords, view: actualView, tileSize: 512 });
  const pos256 = computePositions({ coords: displayCoords, view: actualView, tileSize: 256 });

  const in512 = countInBounds(pos512, actualView);
  const in256 = countInBounds(pos256, actualView);
  const tileSizeChosen = in256 > in512 ? 256 : 512;

  const displayPositions = tileSizeChosen === 256 ? pos256 : pos512;

  const arrowPos512 = computePositions({ coords: routeCoordsForArrows, view: actualView, tileSize: 512 });
  const arrowPos256 = computePositions({ coords: routeCoordsForArrows, view: actualView, tileSize: 256 });
  const arrowPositions = tileSizeChosen === 256 ? arrowPos256 : arrowPos512;

  // ---- 1) Build water mask from base map pixels, with coverage ----
  const { data: rgba } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const { maskRgba: waterMaskRGBA, coverage: waterCoverage } =
    buildWaterMaskFromBaseMapRGBA(rgba, actualW, actualH);

  const waterMaskPng = await sharp(waterMaskRGBA, {
    raw: { width: actualW, height: actualH, channels: 4 }
  }).png().toBuffer();

  // ---- 2) Build artsy route layer (wash + main) ----
  const dense = densifyRoute(routeCoordsForLine, 22);
  const jittered = jitterRoute(dense, seedKey, 9);

  const linePos512 = computePositions({ coords: jittered, view: actualView, tileSize: 512 });
  const linePos256 = computePositions({ coords: jittered, view: actualView, tileSize: 256 });
  const linePositions = tileSizeChosen === 256 ? linePos256 : linePos512;

  const { washSvg, mainSvg } = routeSvgsFromPixelPoints({
    width: actualW,
    height: actualH,
    points: linePositions.map((p) => ({ x: p.x, y: p.y })),
    seedKey
  });

  const washLayer = await sharp({
    create: { width: actualW, height: actualH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{ input: washSvg, left: 0, top: 0 }])
    .png()
    .toBuffer();

  const washBlurred = await sharp(washLayer).blur(2.4).png().toBuffer();

  const mainLayer = await sharp({
    create: { width: actualW, height: actualH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{ input: mainSvg, left: 0, top: 0 }])
    .png()
    .toBuffer();

  const routeLayer = await sharp({
    create: { width: actualW, height: actualH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([
      { input: washBlurred, left: 0, top: 0 },
      { input: mainLayer, left: 0, top: 0 }
    ])
    .png()
    .toBuffer();

  // ---- 3) Mask route so it "goes behind land", BUT add fallback if mask is too aggressive ----
  // If coverage is suspiciously low, do NOT mask (prevents missing line).
  const shouldMask = waterCoverage > 0.10; // loose guard; Caribbean maps typically have plenty of water

  const routeMasked = shouldMask
    ? await sharp(routeLayer)
        .composite([{ input: waterMaskPng, left: 0, top: 0, blend: "dest-in" }])
        .png()
        .toBuffer()
    : routeLayer;

  // ---- 4) Composite route + chevrons + labels + dots ----
  const overlays = [];
  overlays.push({ input: routeMasked, left: 0, top: 0 });

  // Chevrons (white)
  let drawnChevrons = 0;
  for (let i = 0; i < arrowPositions.length - 1; i++) {
    const a = arrowPositions[i];
    const b = arrowPositions[i + 1];

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (!Number.isFinite(dist) || dist < 60) continue;

    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const placements = dist > 380 ? [0.45, 0.70] : [0.60];

    for (const t of placements) {
      const cx = a.x + dx * t;
      const cy = a.y + dy * t;

      overlays.push({
        input: chevronSvg({ angleDeg, size: 30, opacity: 0.72, colorHex: "ffffff" }),
        left: Math.round(cx - 30),
        top: Math.round(cy - 30)
      });
      drawnChevrons++;
    }
  }

  // Labels (smaller + collision avoidance)
  const fontFamily = "Arial, Helvetica, sans-serif";
  const labelFontSize = 16;
  const labelOpacity = 0.72;

  let drawnLabels = 0;
  const labels = (resolvedPorts || []).map(portLabelText);

  const placements = placeLabelsNoOverlap({
    points: displayPositions,
    labels,
    view: actualView,
    fontSize: labelFontSize
  });

  for (let i = 0; i < placements.length; i++) {
    const pl = placements[i];
    if (!pl) continue;

    overlays.push({
      input: Buffer.from(`
        <svg width="${pl.w}" height="${pl.h}" xmlns="http://www.w3.org/2000/svg">
          <text x="0" y="${Math.round(pl.h * 0.86)}"
            font-family="${fontFamily}"
            font-weight="600"
            font-size="${labelFontSize}"
            letter-spacing="0.2"
            fill="#${SLATE}"
            fill-opacity="${labelOpacity}"
            paint-order="stroke"
            stroke="white"
            stroke-width="3.5"
            stroke-opacity="0.82"
            stroke-linejoin="round">${escapeXml(pl.text)}</text>
        </svg>
      `.trim()),
      left: pl.left,
      top: pl.top
    });

    drawnLabels++;
  }

  // Dots + stop numbers (no number for start, numbers for all ports after start)
  const haloR = 20;
  const dotR = 13;
  const numFontSize = 16;

  const stopNums = makeStopNumbers(displayPositions.length);

  let drawnDots = 0;
  for (let i = 0; i < displayPositions.length; i++) {
    const p = displayPositions[i];
    const num = stopNums[i];
    const showNum = Boolean(num);

    overlays.push({
      input: Buffer.from(`
        <svg width="${haloR * 2}" height="${haloR * 2}" xmlns="http://www.w3.org/2000/svg">
          <circle cx="${haloR}" cy="${haloR}" r="${haloR}" fill="white" fill-opacity="0.70"/>
          <circle cx="${haloR}" cy="${haloR}" r="${dotR}" fill="#${SLATE}" fill-opacity="0.92"/>
          ${showNum ? `
            <text x="${haloR}" y="${haloR}"
              text-anchor="middle"
              dominant-baseline="middle"
              font-family="${fontFamily}"
              font-weight="800"
              font-size="${numFontSize}"
              fill="#ffffff" fill-opacity="0.95"
              paint-order="stroke"
              stroke="#${SLATE}"
              stroke-opacity="0.35"
              stroke-width="1.2">${escapeXml(num)}</text>
          ` : ``}
        </svg>
      `.trim()),
      left: Math.round(p.x - haloR),
      top: Math.round(p.y - haloR)
    });

    drawnDots++;
  }

  const out = await sharp(pngBuffer).composite(overlays).png().toBuffer();

  return {
    buffer: out,
    debug: {
      isRoundTrip,
      tileSizeChosen,
      drawnChevrons,
      drawnLabels,
      drawnDots,
      displayStopCount: displayPositions.length,
      waterMask: {
        coverage: Number(waterCoverage.toFixed(4)),
        maskedEnabled: shouldMask
      }
    }
  };
}

/* -------------------- SHOPIFY HELPERS -------------------- */

function requireShopifyConfig() {
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const adminToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shopDomain) throw new Error("Missing SHOPIFY_SHOP_DOMAIN in Render environment variables.");
  if (!adminToken) throw new Error("Missing SHOPIFY_ADMIN_TOKEN in Render environment variables.");
  return { shopDomain, adminToken };
}

async function shopifyGraphQL(query, variables) {
  const { shopDomain, adminToken } = requireShopifyConfig();

  const resp = await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": adminToken
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`Shopify GraphQL HTTP ${resp.status}: ${JSON.stringify(json)}`);
  if (json.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function downloadImageToBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Failed to download image: ${resp.status} ${t}`);
  }
  const arr = await resp.arrayBuffer();
  return Buffer.from(arr);
}

async function uploadPngToShopifyFiles({ buffer, filename }) {
  const stagedQuery = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }
  `;

  const stagedInput = [{ resource: "FILE", filename, mimeType: "image/png", httpMethod: "POST" }];

  const stagedData = await shopifyGraphQL(stagedQuery, { input: stagedInput });
  const staged = stagedData?.stagedUploadsCreate;
  if (staged?.userErrors?.length) throw new Error(`stagedUploadsCreate userErrors: ${JSON.stringify(staged.userErrors)}`);

  const target = staged?.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl || !Array.isArray(target.parameters)) {
    throw new Error("Invalid staged upload target returned from Shopify.");
  }

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([buffer], { type: "image/png" }), filename);

  const uploadResp = await fetch(target.url, { method: "POST", body: form });
  if (!uploadResp.ok) {
    const t = await uploadResp.text();
    throw new Error(`Staged upload failed: ${uploadResp.status} ${t}`);
  }

  const fileCreateQuery = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { ... on MediaImage { id status image { url } } }
        userErrors { field message }
      }
    }
  `;

  const fileCreateVars = {
    files: [{ contentType: "IMAGE", originalSource: target.resourceUrl, alt: "Cruise route map" }]
  };

  const fileCreateData = await shopifyGraphQL(fileCreateQuery, fileCreateVars);
  const fc = fileCreateData?.fileCreate;
  if (fc?.userErrors?.length) throw new Error(`fileCreate userErrors: ${JSON.stringify(fc.userErrors)}`);

  const file = fc?.files?.[0];
  const fileId = file?.id || null;
  let url = file?.image?.url || null;
  let status = file?.status || null;

  if (fileId && !url) {
    const fileQuery = `
      query fileNode($id: ID!) {
        node(id: $id) {
          ... on MediaImage { id status image { url } }
        }
      }
    `;
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 800));
      const data = await shopifyGraphQL(fileQuery, { id: fileId });
      const node = data?.node;
      status = node?.status || status;
      url = node?.image?.url || url;
      if (url) break;
    }
  }

  return { fileId, url, status };
}

function orderGidFromNumeric(orderId) {
  if (!orderId) return null;
  return `gid://shopify/Order/${orderId}`;
}

async function addMapLinkToOrderNote({ orderId, mapUrl }) {
  const gid = orderGidFromNumeric(orderId);
  if (!gid) throw new Error("Missing orderId; cannot update order.");

  const query = `
    mutation orderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id note }
        userErrors { field message }
      }
    }
  `;

  const noteBlock = `Port to Port — Map Generated\nDownload: ${mapUrl}`;

  const data = await shopifyGraphQL(query, { input: { id: gid, note: noteBlock } });
  const ue = data?.orderUpdate?.userErrors || [];
  if (ue.length) throw new Error(`orderUpdate userErrors: ${JSON.stringify(ue)}`);
  return data?.orderUpdate?.order?.note || null;
}

async function setOrderMetafieldMapUrl({ orderId, mapUrl }) {
  const gid = orderGidFromNumeric(orderId);
  if (!gid) throw new Error("Missing orderId; cannot set metafield.");

  const query = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key value type }
        userErrors { field message }
      }
    }
  `;

  const vars = {
    metafields: [{
      ownerId: gid,
      namespace: "port_to_port",
      key: "map_url",
      type: "single_line_text_field",
      value: String(mapUrl || "")
    }]
  };

  const data = await shopifyGraphQL(query, vars);
  const ue = data?.metafieldsSet?.userErrors || [];
  if (ue.length) throw new Error(`metafieldsSet userErrors: ${JSON.stringify(ue)}`);
  return data?.metafieldsSet?.metafields?.[0] || null;
}

/* -------------------- EMAIL (RESEND) -------------------- */

async function sendEmailViaResend({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const bcc = process.env.EMAIL_BCC;

  if (!apiKey || !from) return { sent: false, skipped: true, reason: "Email paused (missing RESEND_API_KEY or EMAIL_FROM)" };
  if (!to) return { sent: false, skipped: true, reason: "Missing recipient email" };

  const payload = { from, to, subject, html, text };
  if (bcc) payload.bcc = bcc;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) return { sent: false, skipped: false, error: `Resend ${resp.status}: ${JSON.stringify(json)}` };
  return { sent: true, id: json?.id || null };
}

/* -------------------- APIFY SCRAPE -------------------- */

async function runApifyTaskAndGetPorts({ cruiseLine, shipName, sailDate }) {
  const token = process.env.APIFY_TOKEN;
  const taskId = process.env.APIFY_TASK_ID;
  if (!token || !taskId) throw new Error("Missing APIFY_TOKEN or APIFY_TASK_ID in Render environment variables.");

  const input = {
    cruise_line: cruiseLine || "",
    end_date: sailDate,
    max_number_of_pages: 1,
    ship_name: shipName,
    start_date: sailDate,
    cruise_length: "0",
    departure_port: "",
    destination: "0",
    ship_type: "0",
    port_of_call: ""
  };

  const runUrl = `https://api.apify.com/v2/actor-tasks/${taskId}/runs?token=${token}&waitForFinish=120`;
  const runResp = await fetch(runUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  if (!runResp.ok) {
    const t = await runResp.text();
    throw new Error(`Apify run failed: ${runResp.status} ${t}`);
  }

  const runData = await runResp.json();
  const datasetId = runData?.data?.defaultDatasetId;
  if (!datasetId) throw new Error("Apify run did not return defaultDatasetId.");

  const itemsUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true&format=json`;
  const itemsResp = await fetch(itemsUrl);

  if (!itemsResp.ok) {
    const t = await itemsResp.text();
    throw new Error(`Apify dataset fetch failed: ${itemsResp.status} ${t}`);
  }

  const items = await itemsResp.json();
  if (!Array.isArray(items) || items.length === 0) throw new Error("Apify returned no items.");

  const targetCruiseDate = toCruiseDateString(sailDate);
  const targetShip = String(shipName || "").trim().toLowerCase();

  const candidates = items.filter((it) => {
    const ship = String(it.ship_name || "").trim().toLowerCase();
    const cd = String(it.cruise_date || "").trim();
    return ship === targetShip && cd === targetCruiseDate;
  });

  const chosen = candidates[0] || items[0];
  const ports = extractPortsFromStops(chosen);
  if (!ports.length) throw new Error(`Could not extract ports. Keys: ${Object.keys(chosen).join(", ")}`);

  return {
    ports,
    chosenMeta: {
      id: chosen.id || null,
      cruise_date: chosen.cruise_date || null,
      cruise_title: chosen.cruise_title || null
    }
  };
}

/* -------------------- WEBHOOK -------------------- */

app.post("/webhooks/order-paid", async (req, res) => {
  const body = req.body || {};
  const lineItems = Array.isArray(body.line_items) ? body.line_items : [];
  const firstItem = lineItems[0] || {};
  const fields = extractLineItemProperties(firstItem);

  const cruiseLine = getField(fields, "cruise line");
  const shipName = getField(fields, "ship") || getField(fields, "ships");

  let sailDate = getField(fields, "sail date");
  sailDate = normalizeDateToYyyyMmDd(sailDate);

  const portsChanged =
    !!getField(fields, "ports of call changed") ||
    !!getField(fields, "ports changed") ||
    !!getField(fields, "my ports of call changed");

  const overridePorts = getActualPorts(fields);

  let finalPorts = [];
  let portsSource = null;
  let chosenMeta = null;

  let cleanedPortQueries = [];
  let resolvedAll = [];
  let resolvedDisplay = [];

  let previewBaseUrl = null;
  let finalBaseUrl = null;

  let renderDebug = null;

  let shopifyFileUrl = null;

  let orderNoteWritten = false;
  let metafieldWritten = false;

  let emailSent = false;
  let emailResult = null;

  try {
    if (portsChanged && overridePorts.length >= 2) {
      finalPorts = overridePorts;
      portsSource = "customer_override";
    } else {
      const apifyResult = await runApifyTaskAndGetPorts({ cruiseLine, shipName, sailDate });
      finalPorts = apifyResult.ports;
      chosenMeta = apifyResult.chosenMeta;
      portsSource = "apify_scrape";
    }

    cleanedPortQueries = finalPorts.map(normalizePortText);

    resolvedAll = [];
    for (const q of cleanedPortQueries) resolvedAll.push(await resolvePort(q));

    const coordsAll = resolvedAll.map((r) => r.coordinates);
    const isRoundTrip =
      (resolvedAll[0]?.portQuery && resolvedAll[resolvedAll.length - 1]?.portQuery &&
        resolvedAll[0].portQuery === resolvedAll[resolvedAll.length - 1].portQuery) ||
      (coordsAll.length >= 2 && nearlySameCoord(coordsAll[0], coordsAll[coordsAll.length - 1]));

    // DISPLAY stops: remove duplicated final stop if round trip
    resolvedDisplay = resolvedAll.slice();
    if (isRoundTrip && resolvedDisplay.length >= 2) {
      const last = resolvedDisplay[resolvedDisplay.length - 1];
      const first = resolvedDisplay[0];
      if (last.portQuery === first.portQuery || nearlySameCoord(last.coordinates, first.coordinates)) {
        resolvedDisplay = resolvedDisplay.slice(0, -1);
      }
    }

    const displayCoords = resolvedDisplay.map((r) => r.coordinates);

    // Route coords for arrows & line (close loop in geometry only)
    const routeCoords = (() => {
      const base = displayCoords.slice();
      if (isRoundTrip && base.length >= 2) base.push(base[0]);
      return base;
    })();

    const seedKey = `${shipName || ""}|${sailDate || ""}|${cleanedPortQueries.join(" > ")}`;

    // Base map only (no route overlay)
    const preview = buildBaseOnlyMapUrl({ fitCoords: displayCoords, width: 1200, height: 800, retina: false });
    previewBaseUrl = preview.url;

    const final = buildBaseOnlyMapUrl({ fitCoords: displayCoords, width: 1280, height: 853, retina: true });
    finalBaseUrl = final.url;

    const basePng = await downloadImageToBuffer(final.url);

    const rendered = await addRouteMaskedDotsLabelsChevrons({
      pngBuffer: basePng,
      displayCoords,
      routeCoordsForArrows: routeCoords,
      routeCoordsForLine: routeCoords,
      resolvedPorts: resolvedDisplay,
      view: final.view,
      isRoundTrip,
      seedKey
    });
    renderDebug = rendered.debug;

    const safeShip = (shipName || "ship").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
    const safeDate = (sailDate || "date").replace(/[^0-9-]+/g, "");
    const uniq = Date.now();
    const filename = `cruise-map-${safeShip}-${safeDate}-${uniq}.png`;

    const uploaded = await uploadPngToShopifyFiles({ buffer: rendered.buffer, filename });
    shopifyFileUrl = uploaded.url;

    if (shopifyFileUrl && body.id) {
      await addMapLinkToOrderNote({ orderId: body.id, mapUrl: shopifyFileUrl });
      orderNoteWritten = true;

      await setOrderMetafieldMapUrl({ orderId: body.id, mapUrl: shopifyFileUrl });
      metafieldWritten = true;
    }

    const customerEmail = body.email || body?.customer?.email || null;
    if (shopifyFileUrl && customerEmail) {
      const subject = `Your Cruise Route Map (${shipName || "Port to Port"})`;
      const text = `Hi!\n\nYour Port to Port cruise route map is ready.\n\nDownload here:\n${shopifyFileUrl}\n\n— Port to Port`;

      const html = `
        <div style="font-family: Arial, sans-serif; line-height: 1.5;">
          <p>Hi!</p>
          <p>Your <strong>Port to Port</strong> cruise route map is ready.</p>
          <p><a href="${shopifyFileUrl}">Download your map</a></p>
          <p>— Port to Port</p>
        </div>
      `.trim();

      emailResult = await sendEmailViaResend({ to: customerEmail, subject, html, text });
      emailSent = Boolean(emailResult?.sent);
    } else {
      emailResult = { sent: false, skipped: true, reason: !shopifyFileUrl ? "No shopifyFileUrl" : "No customer email" };
    }

    const entry = {
      at: new Date().toISOString(),
      inputs: { cruiseLine, shipName, sailDate, portsChanged },
      ports: { source: portsSource, list: finalPorts, chosenMeta },
      map: {
        isRoundTrip,
        cleanedPortQueries,
        displayStops: resolvedDisplay.map((r) => r.portQuery),
        previewBaseUrl,
        finalBaseUrl,
        render: renderDebug,
        shopifyFileUrl
      },
      delivery: { wroteOrderNote: orderNoteWritten, wroteMetafield: metafieldWritten, emailSent, emailResult }
    };

    recentWebhookHits.unshift(entry);
    if (recentWebhookHits.length > 20) recentWebhookHits.pop();

    res.status(200).send("OK");
  } catch (err) {
    recentWebhookHits.unshift({
      at: new Date().toISOString(),
      error: String(err?.message || err),
      map: { previewBaseUrl, finalBaseUrl, render: renderDebug, shopifyFileUrl }
    });
    if (recentWebhookHits.length > 20) recentWebhookHits.pop();

    res.status(200).send("OK");
  }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
