const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Basic health check
app.get("/", (req, res) => {
  res.send("Savvy Cruiser Map Generator is running");
});

// Placeholder webhook endpoint (we'll expand later)
app.post("/webhooks/order-paid", express.json(), (req, res) => {
  console.log("Order received from Shopify");
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

