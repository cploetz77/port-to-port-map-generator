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

const PINNED_PORT_COORDS = {
  "Port Canaveral, Florida": [-80.6056, 28.41],
  "Grand Turk Cruise Center, Turks and Caicos": [-71.142, 21.4643],
  "Amber Cove, Dominican Republic": [-70.15, 19.833],
  "Nassau, Bahamas": [-77.355, 25.078],
  "Grand Bahama Island, Bahamas": [-78.65, 26.533]
};

function normalizePortText(raw) {
  if (!raw) return "";
  let s = String(raw).trim();

  s = s.replace(/^Arriving in\s+/i, "").trim();
  s = s.replace(/^Arriving at\s+/i, "").trim();
  s = s.replace(/^Departing from\s+/i, "").trim();

  const lower = s.toLowerCase();

  if (lower.includes("port canaveral")) return "Port Canaveral, Florida";
  if (lower.includes("grand turk")) return "Grand Turk Cruise Center, Turks and Caicos";
  if (lower.includes("amber cove") || lower.includes("puerto plata-amber cove"))
    return "Amber Cove, Dominican Republic";
  if (lower.includes("nassau")) return "Nassau, Bahamas";
  if (lower.includes("celebration key") || lower.includes("grand bahama"))
    return "Grand Bahama Island, Bahamas";

  s = s.replace(/\s+/g, " ").trim();
  return s;
}

async function geocodePortFallback(portQuery) {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error("Missing MAPBOX_TOKEN in Render environment variables.");

  const cacheKey = `bbox:${portQuery.toLowerCase().trim()}`;
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);

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

/**
 * Build base map URL (route only — NO markers).
 * Returns { url, view } where view includes center/zoom and pixel dims used.
 */
function buildBaseMapUrl({ coords, width = 1200, height = 800, retina = false }) {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error("Missing MAPBOX_TOKEN in Render environment variables.");

  if (width < 1 || width > 1280) throw new Error("Width must be between 1-1280.");
  if (height < 1 || height > 1280) throw new Error("Height must be between 1-1280.");

  const cleaned = cleanCoordinates(coords);
  if (cleaned.length < 2) throw new Error("Not enough valid coordinates to draw route.");

  const poly = encodePolylineLngLat(cleaned);
  const polyEnc = encodeURIComponent(poly);

  // Two-layer route (halo + main)
  const routeHalo = `path-10+${SLATE}-0.18(${polyEnc})`;
  const routeMain = `path-5+${ROUTE_TEAL}-0.85(${polyEnc})`;

  const { centerLng, centerLat, zoom } = computeCenterZoom(cleaned, width, height, 140);

  const overlay = `${routeHalo},${routeMain}`;
  const sizePart = retina ? `${width}x${height}@2x` : `${width}x${height}`;

  const url = `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE_ID}/static/${overlay}/${centerLng},${centerLat},${zoom}/${sizePart}?access_token=${token}`;

  // Actual pixel dimensions of the PNG returned
  const pixelWidth = retina ? width * 2 : width;
  const pixelHeight = retina ? height * 2 : height;

  return {
    url,
    view: { centerLng, centerLat, zoom, pixelWidth, pixelHeight }
  };
}

/**
 * Convert lng/lat to pixel coordinate in the returned image (Web Mercator).
 * Uses the same zoom and center used to request the static image.
 */
function lngLatToPixel({ lng, lat, view }) {
  const tileSize = 512;
  const scale = tileSize * Math.pow(2, view.zoom);

  const p = lngLatToWorld(lng, lat);
  const c = lngLatToWorld(view.centerLng, view.centerLat);

  const dx = (p.x - c.x) * scale;
  const dy = (p.y - c.y) * scale;

  // Center of image is 0,0
  const x = view.pixelWidth / 2 + dx;
  const y = view.pixelHeight / 2 + dy;

  return { x, y };
}

/**
 * Draw true minimalist dots (medium + confident):
 * - outer soft halo (white) so it pops on ocean/land
 * - inner filled slate dot
 */
async function addDotsToPng({ pngBuffer, coords, view }) {
  const cleaned = cleanCoordinates(coords);
  if (cleaned.length < 1) return pngBuffer;

  // Dot sizing tuned for "medium & confident"
  // (retina images are already 2x pixels, so sizes here are in actual pixels)
  const innerR = Math.round(Math.max(8, Math.min(16, view.pixelWidth / 300))); // ~9–12 on typical sizes
  const haloR = innerR + 6;

  const overlays = [];

  for (const [lng, lat] of cleaned) {
    const { x, y } = lngLatToPixel({ lng, lat, view });

    // Skip if off-image
    if (x < -50 || y < -50 || x > view.pixelWidth + 50 || y > view.pixelHeight + 50) continue;

    const svg = `
      <svg width="${haloR * 2}" height="${haloR * 2}" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${haloR}" cy="${haloR}" r="${haloR}" fill="white" fill-opacity="0.78"/>
        <circle cx="${haloR}" cy="${haloR}" r="${innerR}" fill="#${SLATE}" fill-opacity="1"/>
      </svg>
    `.trim();

    overlays.push({
      input: Buffer.from(svg),
      left: Math.round(x - haloR),
      top: Math.round(y - haloR)
    });
  }

  if (!overlays.length) return pngBuffer;

  return await sharp(pngBuffer)
    .composite(overlays)
    .png()
    .toBuffer();
}

/* -------------------- STEP 14: SHOPIFY FILE UPLOAD -------------------- */

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

/* -------------------- STEP 15: WRITE TO ORDER (NOTE + METAFIELD) -------------------- */

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

/* -------------------- STEP 15: EMAIL CUSTOMER (RESEND) -------------------- */

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

  // URLs for debugging
  let previewBaseUrl = null;
  let finalBaseUrl = null;

  // Step 14 outputs (uploaded)
  let shopifyFileId = null;
  let shopifyFileUrl = null;
  let shopifyFileStatus = null;

  // Step 15 outputs
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

    // Preview base (no dots — just for quick debug)
    const preview = buildBaseMapUrl({ coords, width: 1200, height: 800, retina: false });
    previewBaseUrl = preview.url;

    // Final base (no dots) + view metadata
    const final = buildBaseMapUrl({ coords, width: 1280, height: 853, retina: true });
    finalBaseUrl = final.url;

    // Download final base, then add TRUE dots, then upload to Shopify
    const basePng = await downloadImageToBuffer(final.url);
    const dottedPng = await addDotsToPng({ pngBuffer: basePng, coords, view: final.view });

    const safeShip = (shipName || "ship").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
    const safeDate = (sailDate || "date").replace(/[^0-9-]+/g, "");
    const filename = `cruise-map-${safeShip}-${safeDate}.png`;

    const uploaded = await uploadPngToShopifyFiles({ buffer: dottedPng, filename });
    shopifyFileId = uploaded.fileId;
    shopifyFileUrl = uploaded.url;
    shopifyFileStatus = uploaded.status;

    // Write link to order (note + metafield)
    if (shopifyFileUrl && body.id) {
      await addMapLinkToOrderNote({ orderId: body.id, mapUrl: shopifyFileUrl });
      orderNoteWritten = true;

      await setOrderMetafieldMapUrl({ orderId: body.id, mapUrl: shopifyFileUrl });
      metafieldWritten = true;
    }

    // Email (paused unless you set env vars later)
    const customerEmail = body.email || body?.customer?.email || null;
    if (shopifyFileUrl && customerEmail) {
      const subject = `Your Cruise Route Map (${shipName || "Port to Port"})`;
      const text =
`Hi!

Your Port to Port cruise route map is ready.

Download here:
${shopifyFileUrl}

If you have any trouble opening it, just reply to this email.

— Port to Port`;

      const html =
`<div style="font-family: Arial, sans-serif; line-height: 1.5;">
  <p>Hi!</p>
  <p>Your <strong>Port to Port</strong> cruise route map is ready.</p>
  <p><a href="${shopifyFileUrl}">Download your map</a></p>
  <p style="color:#666;">If you have any trouble opening it, just reply to this email.</p>
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
      topic: req.get("x-shopify-topic") || null,
      shop: req.get("x-shopify-shop-domain") || null,
      order: {
        id: body.id || null,
        name: body.name || null,
        email: body.email || null,
        financial_status: body.financial_status || null
      },
      inputs: { cruiseLine, shipName, sailDate, portsChanged },
      customization_fields: fields,
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
        shopifyFileId,
        shopifyFileStatus,
        shopifyFileUrl
      },
      delivery: {
        wroteOrderNote: orderNoteWritten,
        wroteMetafield: metafieldWritten,
        emailSent,
        emailResult
      }
    };

    recentWebhookHits.unshift(entry);
    if (recentWebhookHits.length > 20) recentWebhookHits.pop();

    res.status(200).send("OK");
  } catch (err) {
    recentWebhookHits.unshift({
      at: new Date().toISOString(),
      error: String(err?.message || err),
      map: { previewBaseUrl, finalBaseUrl, shopifyFileId, shopifyFileStatus, shopifyFileUrl },
    });
    if (recentWebhookHits.length > 20) recentWebhookHits.pop();

    res.status(200).send("OK");
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
