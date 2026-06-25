require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const nunjucks = require("nunjucks");
const path = require("path");

const mongoose = require("mongoose");
const connectDB = require("../shared/database");
const { errorHandler, notFound } = require("../shared/errorHandler");

const inventoryRoutes = require("./routes/inventory.routes");
const partRoutes = require("./routes/part.routes");
const tagRoutes = require("./routes/tag.routes");
const scrapElementRoutes = require("./routes/scrapElement.routes");
const elementHubRoutes = require("./routes/elementHub.routes");
const elementRoutes = require("./routes/element.routes");

const app = express();
const PORT = process.env.PORT || 3003;

connectDB(mongoose);

// Views for invoice print routes
const njEnv = nunjucks.configure(path.join(__dirname, "views"), {
  autoescape: true, express: app, watch: process.env.NODE_ENV === "development",
});
app.set("view engine", "njk");
njEnv.addFilter("usDate", (v, fb = "-") => {
  try { const d = new Date(v); return isNaN(d) ? fb : d.toLocaleString("en-US", { year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" }); } catch { return fb; }
});
njEnv.addFilter("usCurrency", (v, fb = "-$0.00") => {
  try { const n = Number(v); return isNaN(n) ? fb : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n); } catch { return fb; }
});

app.use(cors({ origin: true, credentials: true }));
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use("/assets", express.static(path.join(__dirname, "assets")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/health", (req, res) => res.json({ service: "inventory-service", status: "ok", timestamp: new Date().toISOString() }));

app.use("/api/inventory", inventoryRoutes);
app.use("/api/part", partRoutes);
app.use("/api/tags", tagRoutes);
app.use("/api/scrap-element", scrapElementRoutes);
app.use("/api/element-hub", elementHubRoutes);
app.use("/api/element", elementRoutes);

app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => console.log(`[inventory-service] Running on port ${PORT}`));

module.exports = app;
