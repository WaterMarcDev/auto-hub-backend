require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const nunjucks = require("nunjucks");
const path = require("path");

const connectDB = require("../shared/database");
const { errorHandler, notFound } = require("../shared/errorHandler");

const carIntakeRoutes = require("./routes/carIntake.routes");
const vinRoutes = require("./routes/vin.routes");
const makeRoutes = require("./routes/make.routes");
const modelRoutes = require("./routes/model.routes");
const trimRoutes = require("./routes/trim.routes");
const junkCarRoutes = require("./routes/junkCar.routes");

const app = express();
const PORT = process.env.PORT || 3002;

connectDB();

// Templating (for print routes)
const njEnv = nunjucks.configure(path.join(__dirname, "views"), { autoescape: true, express: app, watch: process.env.NODE_ENV === "development" });
app.set("view engine", "njk");
njEnv.addFilter("usDate", (v, fallback = "-") => {
  try { if (!v) return fallback; const d = new Date(v); return isNaN(d) ? fallback : d.toLocaleString("en-US", { year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" }); } catch { return fallback; }
});
njEnv.addFilter("usCurrency", (val, fallback = "-$0.00") => {
  try { const n = Number(val); return isNaN(n) ? fallback : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n); } catch { return fallback; }
});

app.use(cors({ origin: true, credentials: true }));
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use("/assets", express.static(path.join(__dirname, "assets")));

app.get("/health", (req, res) => res.json({ service: "vehicle-service", status: "ok", timestamp: new Date().toISOString() }));

app.use("/api/car-intake", carIntakeRoutes);
app.use("/api/vin", vinRoutes);
app.use("/api/make", makeRoutes);
app.use("/api/model", modelRoutes);
app.use("/api/trim", trimRoutes);
app.use("/api/junk-car", junkCarRoutes);

app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`[vehicle-service] Running on port ${PORT}`);
  if (process.env.DISABLE_VIN_CRON !== "true") {
    try { require("./jobs/fetchVinDetailsJob").startCron(); console.log("[vehicle-service] VIN cron started"); }
    catch (err) { console.error("[vehicle-service] VIN cron failed to start:", err.message); }
  }
});

module.exports = app;
