const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Store last few webhook events in memory (pilot-only)
const recentWebhookHits = [];

// Parse JSON (increase limit a bit)
app.use(express.json({ limit: "2mb" }));

// Health check
app.get("/", (req, res) => {
  res.send("Savvy Cruiser Map Generator is running");
});

// A page you can open in your browser to SEE webhook activity
app.get("/debug/webhooks", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(recentWebhookHits, null, 2));
});

// Webhook endpoint
app.post("/webhooks/order-paid", (req, res) => {
  const entry = {
    at: new Date().toISOString(),
    path: req.path,
    headers: {
      "x-shopify-topic": req.get("x-shopify-topic"),
      "x-shopify-shop-domain": req.get("x-shopify-shop-domain"),
    },
    // Keep payload tiny in debug log to avoid clutter
    bodyPreviewKeys: req.body ? Object.keys(req.body).slice(0, 30) : [],
  };

  recentWebhookHits.unshift(entry);
  if (recentWebhookHits.length > 20) recentWebhookHits.pop();

  console.log("✅ Webhook received:", entry);

  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
