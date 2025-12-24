const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Pilot-only: store last webhook events in memory (easy debugging)
const recentWebhookHits = [];

// Shopify payloads can be large
app.use(express.json({ limit: "4mb" }));

/**
 * Health check
 */
app.get("/", (req, res) => {
  res.send("Savvy Cruiser Map Generator is running");
});

/**
 * Debug inbox: open in browser to see last webhook events & selected ports
 */
app.get("/debug/webhooks", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(recentWebhookHits, null, 2));
});

/**
 * Extract line item properties / custom attributes (Uploadery + Shopify)
 */
function extractLineItemProperties(lineItem) {
  const props = [];

  // Common Shopify format: lineItem.properties = [{ name, value }, ...]
  if (Array.isArray(lineItem?.properties)) {
    for (const p of lineItem.properties) {
      const name = p?.name ?? p?.key;
      const value = p?.value;
      if (name && value != null && String(value).trim() !== "") {
        props.push({ name: String(name), value: String(value) });
      }
    }
  }

  // Some sources store as customAttributes = [{ key, value }, ...]
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

/**
 * Helper: get a field value by substring match on the field name
 */
function getField(fields, labelContains) {
  const hit = fields.find((f) =>
    (f.name || "").toLowerCase().includes(labelContains.toLowerCase())
  );
  return hit ? hit.value : null;
}

/**
 * Collect "Actual Port 1", "Actual Port 2", ... in numeric order
 */
function getActualPorts(fields) {
  const ports = fields
    .filter((f) => (f.name || "").toLowerCase().includes("actual port"))
    .map((f) => {
      const m = String(f.name).match(/(\d+)/);
      const n = m ? parseInt(m[1], 10) : 9999;
      return { n, value: String(f.value || "").trim() };
    })
    .filter((x) => x.value.length > 0)
    .sort((a, b) => a.n - b.n)
    .map((x) => x.value);

  return ports;
}

/**
 * Normalize date to YYYY-MM-DD if user entered MM/DD/YYYY
 * - "12/06/2025" -> "2025-12-06"
 * Leaves other formats untouched.
 */
function normalizeDateToYyyyMmDd(value) {
  if (!value) return value;
  const s = String(value).trim();

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // MM/DD/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mm = String(parseInt(m[1], 10)).padStart(2, "0");
    const dd = String(parseInt(m[2], 10)).padStart(2, "0");
    const yyyy = m[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  return s;
}

/**
 * Convert YYYY-MM-DD -> "YYYY Mon DD" to match Apify output cruise_date
 * Example: 2025-12-06 -> "2025 Dec 06"
 */
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

/**
 * Extract ports from Apify output "stop_#_text" fields.
 */
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

/**
 * Run Apify Task and return a ports list for the correct sailing.
 * Expects env vars:
 * - APIFY_TOKEN
 * - APIFY_TASK_ID
 */
async function runApifyTaskAndGetPorts({ cruiseLine, shipName, sailDate }) {
  const token = process.env.APIFY_TOKEN;
  const taskId = process.env.APIFY_TASK_ID;

  if (!token || !taskId) {
    throw new Error("Missing APIFY_TOKEN or APIFY_TASK_ID in Render environment variables.");
  }

  // ✅ Input keys based on your Apify input JSON
  const input = {
    cruise_line: cruiseLine || "",
    end_date: sailDate,              // YYYY-MM-DD
    max_number_of_pages: 1,
    ship_name: shipName,
    start_date: sailDate,            // YYYY-MM-DD
    cruise_length: "0",
    departure_port: "",
    destination: "0",
    ship_type: "0",
    port_of_call: ""
  };

  // Run task and wait for finish
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

  if (!datasetId) {
    throw new Error("Apify run did not return defaultDatasetId.");
  }

  // Fetch dataset items (array)
  const itemsUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&clean=true&format=json`;
  const itemsResp = await fetch(itemsUrl);

  if (!itemsResp.ok) {
    const t = await itemsResp.text();
    throw new Error(`Apify dataset fetch failed: ${itemsResp.status} ${t}`);
  }

  const items = await itemsResp.json();

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Apify returned no items.");
  }

  // Filter to exact ship + exact sail date
  const targetCruiseDate = toCruiseDateString(sailDate); // "2025 Dec 06"
  const targetShip = String(shipName || "").trim().toLowerCase();

  const candidates = items.filter((it) => {
    const ship = String(it.ship_name || "").trim().toLowerCase();
    const cd = String(it.cruise_date || "").trim();
    return ship === targetShip && cd === targetCruiseDate;
  });

  const chosen = candidates[0] || items[0]; // fallback for pilot stability

  const ports = extractPortsFromStops(chosen);

  if (!ports.length) {
    throw new Error(
      `Could not extract ports. Chosen keys: ${Object.keys(chosen).join(", ")}`
    );
  }

  return {
    ports,
    chosenMeta: {
      id: chosen.id || null,
      cruise_date: chosen.cruise_date || null,
      cruise_title: chosen.cruise_title || null
    }
  };
}

/**
 * Webhook endpoint: Shopify will POST here
 */
app.post("/webhooks/order-paid", async (req, res) => {
  const body = req.body || {};
  const lineItems = Array.isArray(body.line_items) ? body.line_items : [];
  const firstItem = lineItems[0] || {};
  const fields = extractLineItemProperties(firstItem);

  // Pull common fields (these must match your input field labels loosely)
  const cruiseLine = getField(fields, "cruise line");

  // ✅ Small improvement: match both "ship" and "ships"
  const shipName = getField(fields, "ship") || getField(fields, "ships");

  // ✅ Fix 2: normalize Sail Date to YYYY-MM-DD
  let sailDate = getField(fields, "sail date");
  sailDate = normalizeDateToYyyyMmDd(sailDate);

  // Determine override vs scrape
  const portsChanged =
    !!getField(fields, "ports of call changed") ||
    !!getField(fields, "ports changed") ||
    !!getField(fields, "my ports of call changed");

  const overridePorts = getActualPorts(fields);

  let finalPorts = [];
  let portsSource = null;
  let chosenMeta = null;

  try {
    if (portsChanged && overridePorts.length >= 2) {
      finalPorts = overridePorts;
      portsSource = "customer_override";
    } else {
      const apifyResult = await runApifyTaskAndGetPorts({
        cruiseLine,
        shipName,
        sailDate
      });
      finalPorts = apifyResult.ports;
      chosenMeta = apifyResult.chosenMeta;
      portsSource = "apify_scrape";
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
      inputs: {
        cruiseLine,
        shipName,
        sailDate,
        portsChanged
      },
      customization_fields: fields,
      ports: {
        source: portsSource,
        list: finalPorts,
        chosenMeta
      }
    };

    recentWebhookHits.unshift(entry);
    if (recentWebhookHits.length > 20) recentWebhookHits.pop();

    console.log("✅ Ports selected:", portsSource, finalPorts);

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook error:", err);

    recentWebhookHits.unshift({
      at: new Date().toISOString(),
      error: String(err?.message || err),
      inputs: { cruiseLine, shipName, sailDate, portsChanged },
      customization_fields: fields
    });
    if (recentWebhookHits.length > 20) recentWebhookHits.pop();

    // Pilot choice: avoid Shopify retry storms while iterating
    res.status(200).send("OK");
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
