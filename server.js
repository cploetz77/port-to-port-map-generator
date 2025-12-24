const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Pilot-only: store last webhook events in memory
const recentWebhookHits = [];

// Parse JSON (Shopify payloads can be large)
app.use(express.json({ limit: "4mb" }));

app.get("/", (req, res) => {
  res.send("Savvy Cruiser Map Generator is running");
});

app.get("/debug/webhooks", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(recentWebhookHits, null, 2));
});

// Helper: safely pull "custom fields" from line items (Uploadery / line item properties)
function extractLineItemProperties(lineItem) {
  // Shopify can provide these as `properties` or `customAttributes` depending on source
  const props = [];

  if (Array.isArray(lineItem?.properties)) {
    // common format: [{ name, value }, ...]
    for (const p of lineItem.properties) {
      if (!p) continue;
      const name = p.name ?? p.key;
      const value = p.value;
      if (name && value != null && String(value).trim() !== "") {
        props.push({ name: String(name), value: String(value) });
      }
    }
  }

  if (Array.isArray(lineItem?.customAttributes)) {
    for (const p of lineItem.customAttributes) {
      if (!p) continue;
      const name = p.key ?? p.name;
      const value = p.value;
      if (name && value != null && String(value).trim() !== "") {
        props.push({ name: String(name), value: String(value) });
      }
    }
  }

  return props;
}

// Webhook endpoint
app.post("/webhooks/order-paid", (req, res) => {
  try {
    const body = req.body || {};
    const lineItems = Array.isArray(body.line_items) ? body.line_items : [];

    // Grab the first line item (pilot assumes the map product is the main item)
    const firstItem = lineItems[0] || {};
    const properties = extractLineItemProperties(firstItem);

    const entry = {
      at: new Date().toISOString(),
      topic: req.get("x-shopify-topic") || null,
      shop: req.get("x-shopify-shop-domain") || null,
      order: {
        id: body.id || null,
        name: body.name || null,
        email: body.email || null,
        financial_status: body.financial_status || null,
        total_price: body.total_price || null
      },
      item: {
        title: firstItem.title || null,
        variant_title: firstItem.variant_title || null,
        quantity: firstItem.quantity || null
      },
      // This is what we care about:
      customization_fields: properties
    };

    recentWebhookHits.unshift(entry);
    if (recentWebhookHits.length > 20) recentWebhookHits.pop();

    console.log("✅ Order webhook received:", {
      order: entry.order.name,
      status: entry.order.financial_status,
      item: entry.item.title,
      fields: entry.customization_fields.length
    });

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).send("Webhook error");
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
