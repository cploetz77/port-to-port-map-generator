const express = require("express");
const sharp = require("sharp");

const app = express();
const PORT = process.env.PORT || 3000;

// Pilot-only: store last webhook events in memory (easy debugging)
const recentWebhookHits = [];

// Simple in-memory cache for geocoding (saves $$ + avoids jitter)
const geocodeCache = new Map();

// Shopify payloads can be large
app.use(express.json({ limit: "4mb" }));

app.get("/", (req, res) => {
  res.send("Savvy Cruiser Map Generator is running");
});

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

// Pin known ports (and fix Celebration Key explicitly)
const PINNED_PORT_COORDS = {
  "Port Canaveral, Florida": [-80.6056, 28.41],
  "Grand Turk Cruise Center, Turks and Caicos": [-71.142, 21.4643],
  "Amber Cove, Dominican Republic": [-70.15, 19.833],
  "Nassau, Bahamas": [-77.355, 25.078],
  "Grand Bahama Island, Bahamas": [-78.65, 26.533],

  // Celebration Key coordinates from port listings
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
    // Keep the itinerary name; do NOT rename to Grand Bahama
    return "Celebration Key, Bahamas";
  }

  if (lower.includes("port canaveral")) return "Port Canaveral, Florida";
  if (lower.includes("grand turk")) return "Grand Turk Cruise Center, Turks and Caicos";
  if (lower.includes("amber cove") || lower.includes("puerto plata-amber cove"))
    return "Amber Cove, Dominican Republic";
  if (lower.includes("nassau")) return "Nassau, Bahamas";

  // still keep "Grand Bahama..." if itinerary explicitly says it (not Celebration Key)
  if (lower.includes("grand bahama")) return "Grand Bahama Island, Bahamas";

  s = s.replace(/\s+/g, " ").trim();
  return s;
}

async function geocodePortFallback(portQuery) {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error("Missing MAPBOX_TOKEN in Render environment variables.");

  const cacheKey = `bbox:${portQuery.toLowerCase().trim()}`;
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);

  // Caribbean-ish bbox to reduce wrong hemisphere matches
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
    return {
      portQuery,
      placeName: portQuery,
      coordinates: PINNED_PORT_COORDS[portQuery]
    };
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

/* -------------------- ROUTE SMOOTHING (LESS RIGID LINE) -------------------- */

function deg2rad(d) { return (d * Math.PI) / 180; }
function rad2deg(r) { return (r * 180) / Math.PI; }

function slerpGreatCircle(a, b, t) {
  // a,b in [lng,lat]
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

/* -------------------- MAPBOX STATIC IMAGE URL BUILD -------------------- */

function encodePolylineLngLat(coords) {
  function encodeSigned(num) {
    let sgnNum = num << 1;
    if (num < 0) sgnNum = ~sgnNum;
    let encoded = "";
    while (sgnNum >= 0x20) {
      encoded += String.fromCharCode((0x20 | (sgnNum & 0x1f)) + 63);
      sgnNum >>= 5;
    }
    encoded += String.fromCharCode(sgnNum + 63);
    return encoded;
  }

  let lastLat = 0;
  let lastLng = 0;
  let result = "";

  for (const [lng, lat] of coords) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);

    const dLat = latE5 - lastLat;
    const dLng = lngE5 - lastLng;

    lastLat = latE5;
    lastLng = lngE5;

    result += encodeSigned(dLat);
    result += encodeSigned(dLng);
  }

  return result;
}

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

/**
 * Theme
 */
const MAPBOX_STYLE_ID = "mapbox/light-v11";
const ROUTE_TEAL = "0aa6a6";
const SLATE = "2f3b45";

function buildBaseMapUrl({ coords, width = 1200, height = 800, retina = false }) {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error("Missing MAPBOX_TOKEN in Render environment variables.");

  if (width < 1 || width > 1280) throw new Error("Width must be between 1-1280.");
  if (height < 1 || height > 1280) throw new Error("Height must be between 1-1280.");

  const cleaned = cleanCoordinates(coords);
  if (cleaned.length < 2) throw new Error("Not enough valid coordinates to draw route.");

  // Smooth path points (visual only)
  const routeCoords = densifyRoute(cleaned, 18);
  const poly = encodePolylineLngLat(routeCoords);
  const polyEnc = encodeURIComponent(poly);

  // two-layer route: soft halo + main
  const routeHalo = `path-10+${SLATE}-0.14(${polyEnc})`;
  const routeMain = `path-5+${ROUTE_TEAL}-0.80(${polyEnc})`;

  // Fit map based on *actual port stops*
  const { centerLng, centerLat, zoom } = computeCenterZoom(cleaned, width, height, 150);

  const overlay = `${routeHalo},${routeMain}`;
  const sizePart = retina ? `${width}x${height}@2x` : `${width}x${height}`;

  const url = `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE_ID}/static/${overlay}/${centerLng},${centerLat},${zoom}/${sizePart}?access_token=${token}`;

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

/* -------------------- ARTSY LABELS + CORRECT STOP NUMBERS -------------------- */

function lngLatToPixel({ lng, lat, view, tileSize }) {
  const scale = tileSize * Math.pow(2, view.zoom) * (view.pixelRatio || 1);

  const p = lngLatToWorld(lng, lat);
  const c = lngLatToWorld(view.centerLng, view.centerLat);

  let dxWorld = p.x - c.x;
  if (dxWorld > 0.5) dxWorld -= 1;
  if (dxWorld < -0.5) dxWorld += 1;

  const dx = dxWorld * scale;
  const dy = (p.y - c.y) * scale;

  const x = view.pixelWidth / 2 + dx;
  const y = view.pixelHeight / 2 + dy;

  return { x, y };
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

  // If portQuery already has country, keep it tight:
  // e.g., "Nassau, Bahamas" or "Celebration Key, Bahamas"
  if (portQuery.includes(",")) return portQuery;

  const country = countryFromPlaceName(placeName);
  return country ? `${portQuery}, ${country}` : portQuery;
}

function labelAnchor({ x, y, view, labelW, labelH, prefer = "ur" }) {
  // label offset and edge-clamp (no big pill, just text + halo)
  const pad = 14;
  const gap = 22;

  const ur = { left: Math.round(x + gap), top: Math.round(y - gap - labelH) };
  const ul = { left: Math.round(x - gap - labelW), top: Math.round(y - gap - labelH) };
  const dr = { left: Math.round(x + gap), top: Math.round(y + gap) };
  const dl = { left: Math.round(x - gap - labelW), top: Math.round(y + gap) };

  const order =
    prefer === "ur" ? [ur, ul, dr, dl] :
    prefer === "ul" ? [ul, ur, dl, dr] :
    prefer === "dr" ? [dr, dl, ur, ul] :
    [dl, dr, ul, ur];

  const c = order[0];
  const left = Math.max(pad, Math.min(c.left, view.pixelWidth - labelW - pad));
  const top = Math.max(pad, Math.min(c.top, view.pixelHeight - labelH - pad));
  return { left, top };
}

function makeStopNumbers(count) {
  // Correct rules:
  // - index 0 is embark (no number)
  // - index last is disembark (no number)
  // - middle ports get 1..K
  const nums = new Array(count).fill("");
  if (count <= 2) return nums;

  let n = 1;
  for (let i = 1; i <= count - 2; i++) {
    nums[i] = String(n);
    n++;
  }
  return nums;
}

async function addArtsyDotsNumbersLabels({ pngBuffer, coords, resolvedPorts, view }) {
  const cleaned = cleanCoordinates(coords);
  if (cleaned.length < 1) {
    return { buffer: pngBuffer, debug: { drawnDots: 0, drawnLabels: 0, drawnTags: 0 } };
  }

  const meta = await sharp(pngBuffer).metadata();
  const actualW = meta?.width || view.requestedPixelWidth;
  const actualH = meta?.height || view.requestedPixelHeight;

  const actualView = { ...view, pixelWidth: actualW, pixelHeight: actualH };

  const pos512 = computePositions({ coords: cleaned, view: actualView, tileSize: 512 });
  const pos256 = computePositions({ coords: cleaned, view: actualView, tileSize: 256 });

  const in512 = countInBounds(pos512, actualView);
  const in256 = countInBounds(pos256, actualView);

  const tileSizeChosen = in256 > in512 ? 256 : 512;
  const positions = tileSizeChosen === 256 ? pos256 : pos512;

  // Visual system (scaled for @2x)
  const haloR = 20;
  const dotR = 13;

  // Numbers inside dot (only ports of call)
  const numFontSize = 18;
  const numFamily = "Arial, Helvetica, sans-serif";

  // Label style: text only, with a subtle white stroke (halo) so it reads on map
  const labelFontSize = 22;
  const labelWeight = 600;
  const labelOpacity = 0.84;

  // Tiny START/END tag
  const tagFontSize = 16;
  const tagPadX = 10;
  const tagPadY = 6;
  const tagRadius = 10;
  const tagFillOpacity = 0.72;
  const tagTextOpacity = 0.80;

  const overlays = [];

  // Build label strings
  const labels = (resolvedPorts || []).map(portLabelText);

  // Stop numbers (corrected)
  const stopNums = makeStopNumbers(positions.length);

  // 1) Draw labels first (so dots sit on top)
  let drawnLabels = 0;

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const label = labels[i] || "";
    if (!label) continue;

    // very rough width estimate
    const approxW = Math.min(Math.max(220, Math.round(label.length * labelFontSize * 0.55)), 980);
    const labelW = approxW;
    const labelH = Math.round(labelFontSize * 1.3);

    // Alternate preference by index to reduce overlaps
    const prefer = i % 2 === 0 ? "ur" : "ul";
    const anchor = labelAnchor({ x: p.x, y: p.y, view: actualView, labelW, labelH, prefer });

    // A tiny leader line to make it feel more “designed” and reduce ambiguity
    const lineX1 = Math.round(p.x);
    const lineY1 = Math.round(p.y);
    const lineX2 = Math.round(anchor.left + 8);
    const lineY2 = Math.round(anchor.top + Math.round(labelH * 0.75));

    const svg = `
      <svg width="${labelW}" height="${labelH}" xmlns="http://www.w3.org/2000/svg">
        <text x="0" y="${Math.round(labelH * 0.85)}"
          font-family="${numFamily}"
          font-weight="${labelWeight}"
          font-size="${labelFontSize}"
          fill="#${SLATE}"
          fill-opacity="${labelOpacity}"
          paint-order="stroke"
          stroke="white"
          stroke-width="5"
          stroke-opacity="0.85"
          stroke-linejoin="round">${escapeXml(label)}</text>
      </svg>
    `.trim();

    // leader line is a separate overlay so it can extend outside the label box
    overlays.push({
      input: Buffer.from(`
        <svg width="${actualView.pixelWidth}" height="${actualView.pixelHeight}" xmlns="http://www.w3.org/2000/svg">
          <line x1="${lineX1}" y1="${lineY1}" x2="${lineX2}" y2="${lineY2}"
            stroke="#${SLATE}" stroke-opacity="0.25" stroke-width="3" stroke-linecap="round"/>
          <circle cx="${lineX2}" cy="${lineY2}" r="4" fill="#${SLATE}" fill-opacity="0.25"/>
        </svg>
      `.trim()),
      left: 0,
      top: 0
    });

    overlays.push({
      input: Buffer.from(svg),
      left: anchor.left,
      top: anchor.top
    });

    drawnLabels++;
  }

  // 2) START/END tags (small)
  let drawnTags = 0;
  if (positions.length >= 1) {
    const first = positions[0];
    const last = positions[positions.length - 1];

    const makeTag = (text, x, y, prefer) => {
      const w = Math.round(text.length * tagFontSize * 0.62 + tagPadX * 2);
      const h = Math.round(tagFontSize + tagPadY * 2);
      const pos = labelAnchor({ x, y, view: actualView, labelW: w, labelH: h, prefer });

      overlays.push({
        input: Buffer.from(`
          <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="0" width="${w}" height="${h}" rx="${tagRadius}" ry="${tagRadius}"
              fill="white" fill-opacity="${tagFillOpacity}"/>
            <text x="${tagPadX}" y="${Math.round(h / 2 + tagFontSize * 0.35)}"
              font-family="${numFamily}" font-weight="700"
              font-size="${tagFontSize}"
              fill="#${SLATE}" fill-opacity="${tagTextOpacity}"
              letter-spacing="0.6">${escapeXml(text)}</text>
          </svg>
        `.trim()),
        left: pos.left,
        top: pos.top
      });
      drawnTags++;
    };

    makeTag("START", first.x, first.y, "dr");
    makeTag("END", last.x, last.y, "dl");
  }

  // 3) Dots + stop numbers on top
  let drawnDots = 0;

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    if (p.x < -60 || p.y < -60 || p.x > actualView.pixelWidth + 60 || p.y > actualView.pixelHeight + 60) continue;

    const num = stopNums[i]; // "" for start/end
    const showNum = Boolean(num);

    const svg = `
      <svg width="${haloR * 2}" height="${haloR * 2}" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${haloR}" cy="${haloR}" r="${haloR}" fill="white" fill-opacity="0.72"/>
        <circle cx="${haloR}" cy="${haloR}" r="${dotR}" fill="#${SLATE}" fill-opacity="0.92"/>
        ${
          showNum
            ? `<text x="${haloR}" y="${haloR + Math.round(numFontSize * 0.35)}"
                text-anchor="middle"
                font-family="${numFamily}"
                font-weight="800"
                font-size="${numFontSize}"
                fill="#ffffff" fill-opacity="0.95">${escapeXml(num)}</text>`
            : ``
        }
      </svg>
    `.trim();

    overlays.push({
      input: Buffer.from(svg),
      left: Math.round(p.x - haloR),
      top: Math.round(p.y - haloR)
    });

    drawnDots++;
  }

  const out = overlays.length ? await sharp(pngBuffer).composite(overlays).png().toBuffer() : pngBuffer;

  return {
    buffer: out,
    debug: {
      drawnDots,
      drawnLabels,
      drawnTags,
      tileSizeChosen,
      inBounds512: in512,
      inBounds256: in256,
      requested: { w: view.requestedPixelWidth, h: view.requestedPixelHeight, pixelRatio: view.pixelRatio },
      actual: { w: actualW, h: actualH },
      sample: positions.slice(0, 3).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
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

  const stagedInput = [
    { resource: "FILE", filename, mimeType: "image/png", httpMethod: "POST" }
  ];

  const stagedData = await shopifyGraphQL(stagedQuery, { input: stagedInput });
  const staged = stagedData?.stagedUploadsCreate;
  if (staged?.userErrors?.length) {
    throw new Error(`stagedUploadsCreate userErrors: ${JSON.stringify(staged.userErrors)}`);
  }

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
  if (fc?.userErrors?.length) {
    throw new Error(`fileCreate userErrors: ${JSON.stringify(fc.userErrors)}`);
  }

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

  const noteBlock =
`Port to Port — Map Generated
Download: ${mapUrl}`;

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
    metafields: [
      {
        ownerId: gid,
        namespace: "port_to_port",
        key: "map_url",
        type: "single_line_text_field",
        value: String(mapUrl || "")
      }
    ]
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
  let resolved = [];

  let previewBaseUrl = null;
  let finalBaseUrl = null;

  let renderDebug = null;

  let shopifyFileId = null;
  let shopifyFileUrl = null;
  let shopifyFileStatus = null;

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

    resolved = [];
    for (const q of cleanedPortQueries) resolved.push(await resolvePort(q));

    const coords = resolved.map((r) => r.coordinates);

    const preview = buildBaseMapUrl({ coords, width: 1200, height: 800, retina: false });
    previewBaseUrl = preview.url;

    const final = buildBaseMapUrl({ coords, width: 1280, height: 853, retina: true });
    finalBaseUrl = final.url;

    const basePng = await downloadImageToBuffer(final.url);

    const rendered = await addArtsyDotsNumbersLabels({
      pngBuffer: basePng,
      coords,
      resolvedPorts: resolved,
      view: final.view
    });
    renderDebug = rendered.debug;

    const safeShip = (shipName || "ship").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
    const safeDate = (sailDate || "date").replace(/[^0-9-]+/g, "");
    const filename = `cruise-map-${safeShip}-${safeDate}.png`;

    const uploaded = await uploadPngToShopifyFiles({ buffer: rendered.buffer, filename });
    shopifyFileId = uploaded.fileId;
    shopifyFileUrl = uploaded.url;
    shopifyFileStatus = uploaded.status;

    if (shopifyFileUrl && body.id) {
      await addMapLinkToOrderNote({ orderId: body.id, mapUrl: shopifyFileUrl });
      orderNoteWritten = true;

      await setOrderMetafieldMapUrl({ orderId: body.id, mapUrl: shopifyFileUrl });
      metafieldWritten = true;
    }

    const customerEmail = body.email || body?.customer?.email || null;
    if (shopifyFileUrl && customerEmail) {
      const subject = `Your Cruise Route Map (${shipName || "Port to Port"})`;
      const text =
`Hi!

Your Port to Port cruise route map is ready.

Download here:
${shopifyFileUrl}

— Port to Port`;

      const html =
`<div style="font-family: Arial, sans-serif; line-height: 1.5;">
  <p>Hi!</p>
  <p>Your <strong>Port to Port</strong> cruise route map is ready.</p>
  <p><a href="${shopifyFileUrl}">Download your map</a></p>
  <p>— Port to Port</p>
</div>`;

      emailResult = await sendEmailViaResend({ to: customerEmail, subject, html, text });
      emailSent = Boolean(emailResult?.sent);
    } else {
      emailResult = {
        sent: false,
        skipped: true,
        reason: !shopifyFileUrl ? "No shopifyFileUrl" : "No customer email on order payload"
      };
    }

    const entry = {
      at: new Date().toISOString(),
      inputs: { cruiseLine, shipName, sailDate, portsChanged },
      ports: { source: portsSource, list: finalPorts, chosenMeta },
      map: {
        cleanedPortQueries,
        resolvedPorts: resolved.map((r) => ({
          portQuery: r.portQuery,
          placeName: r.placeName,
          coordinates: r.coordinates,
          pinned: Boolean(PINNED_PORT_COORDS[r.portQuery])
        })),
        previewBaseUrl,
        finalBaseUrl,
        render: renderDebug,
        shopifyFileId,
        shopifyFileStatus,
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
      map: { previewBaseUrl, finalBaseUrl, render: renderDebug, shopifyFileId, shopifyFileStatus, shopifyFileUrl }
    });
    if (recentWebhookHits.length > 20) recentWebhookHits.pop();

    res.status(200).send("OK");
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
