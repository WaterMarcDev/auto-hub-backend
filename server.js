// dotenv must load before any other require() — checkBackInStock.service.js
// (required below) pulls in sendBackInStockEmail.service.js, which calls
// sgMail.setApiKey(process.env.SENDGRID_API_KEY) at module load time. With
// dotenv loading later, that ran with an undefined key, which is what
// produced the "API key does not start with 'SG.'" startup warning.
require("dotenv").config({ override: true });   // added override: true by shiva

const express = require("express");
const nunjucks = require("nunjucks");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const connectDB = require("./config/database");
const loggerConfig = require("./config/logger");
const addUserContext = require("./middleware/logging");
const morgan = require("morgan");
const path = require("path");
const partRequestRoutes = require("./routes/PartRequestRoutes");
const junkCarRoutes = require("./routes/junkCar.routes");
const { swaggerUi, specs } = require("./config/swagger");  // by shiva
const http = require("http");                                // real time update by shiva
const { Server } = require("socket.io");                     // by shiva
const startBackInStockChecker = require("./services/checkBackInStock.service");    // by shiva
const ebayRoutes = require("./routes/ebay.routes");   // by shiva
const ebayCatalogSyncRoutes = require("./routes/ebayCatalogSync.routes");

console.log("[ENV CHECK]", {
  envFile: path.join(__dirname, ".env"),
  hasPartSyncSecret: Boolean(process.env.PART_SYNC_SECRET),
  partSyncSecretLength: process.env.PART_SYNC_SECRET?.length || 0,
});

// Connect to MongoDB
connectDB();

const app = express();
const PORT = process.env.PORT || 5000;

// Create Server + Socket by shiva
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

//  make io available in controllers
app.set("io", io);

// debug connection
io.on("connection", (socket) => {
  console.log("🟢 Socket connected:", socket.id);
});
// end here


// Configure Nunjucks templating (views in backend/views) and get environment
const njEnv = nunjucks.configure(path.join(__dirname, "views"), {
  autoescape: true,
  express: app,
  watch: process.env.NODE_ENV === "development",
});
app.set("view engine", "njk");

// Nunjucks filter to format dates in US format (attach to same env)
njEnv.addFilter("usDate", function (dateVal, fallback = "-") {
  try {
    if (!dateVal) return fallback;
    const d = typeof dateVal === "string" ? new Date(dateVal) : dateVal;
    if (isNaN(d.getTime())) return fallback;
    return d.toLocaleString("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch (e) {
    return fallback;
  }
});

// Nunjucks filter to format numbers as US Dollar currency
njEnv.addFilter("usCurrency", function (val, fallback = "-$0.00") {
  try {
    if (val === undefined || val === null || val === "") return fallback;
    const num = Number(val);
    if (Number.isNaN(num)) return fallback;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  } catch (e) {
    return fallback;
  }
});


const allowlist = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",  //added by shiva
  "http://localhost:3000",
  "http://192.168.1.4:5173",
  "http://192.168.1.4:3000",
  "https://wmshostings.us",
  "https://www.wmshostings.us",
  "https://autohubexpress.us",
  "https://www.autohubexpress.us",
];


const corsOptionsDelegate = (req, callback) => {
  const origin = req.header("Origin");
  const isAllowed = origin && allowlist.includes(origin);
  callback(null, {
    origin: isAllowed ? origin : false, // exact echo or disallow
    credentials: true, // only useful if origin is not false
  });
};

// app.options("/{*path}", cors(corsOptionsDelegate)); // preflight
app.use(cors(corsOptionsDelegate));

app.use(morgan("dev"));

// `verify` stashes the exact raw bytes onto req.rawBody without changing
// parsing behavior at all — needed by the TikTok webhook adapter to verify
// the Tiktok-Signature HMAC (which must be computed over the raw body, not
// a re-serialized copy of the parsed JSON). Every other route/consumer is
// unaffected: req.body still parses exactly as before.
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));
// Uploads path by shiva
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"))
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(addUserContext);

//added by shiva
const emailRoutes = require("./routes/email.routes");
app.use("/api/email", emailRoutes);
//end here


// Add here(shiva)
app.get("/test-direct", (req, res) => {
  res.send("Direct route working");
});

// Swagger UI
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));
// end here

// Routes
const fs = require("fs");
const { marked } = require("marked");
const partRequestmodels = require("./models/PartRequest.model");

// No custom marked renderer configured — rendering uses default behavior

// Serve rendered API docs at '/'
// app.get("/", (req, res, next) => {
//   console.log("API docs requested");
//   const docsPath = path.join(__dirname, "API_DOCS.md");
//   fs.readFile(docsPath, "utf8", (err, data) => {
//     if (err) return next(err);
//     const html = `<!doctype html>
// <html>
//   <head>
//     <meta charset="utf-8">
//     <meta name="viewport" content="width=device-width,initial-scale=1">
//     <title>AutoHub API Docs</title>
//     <style>
//   :root{color-scheme: light}
//       body{font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial;margin:20px;line-height:1.6;}
//       pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto;}
//       code{background:#f6f8fa;padding:2px 6px;border-radius:4px;}
//       h1,h2,h3{color:#0b3d91;}
//       a{color:#0366d6;}
//       table{border-collapse:collapse;}
//       table td, table th{border:1px solid #dfe2e5;padding:6px 13px;}
//   /* small responsive container for wide docs */
//   .docs-container { max-width: 960px; margin: 0 auto; }
//     </style>
//   </head>
//   <body>
//     <div class="docs-container">
//       ${marked.parse(data)}
//     </div>

//   </body>
// </html>`;
//     res.setHeader("Content-Type", "text/html; charset=utf-8");
//     res.send(html);
//   });
// });

app.get("/", (req, res) => {
  res.send("AutoHub API up and running");
});

// Status endpoint (replaced previous root JSON)
app.get("/api/status", (req, res) => {
  res.json({
    message: "AutoHub API is running",
    corsEnabled: true,
    allowedOrigins: allowlist,
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
  });
});

// Auth routes
app.use("/api/auth", require("./routes/auth"));

// Part Request Routes : added by shiva
app.use("/api/part-request", partRequestRoutes);

// JunkCarRequest Routes: added by shiva
app.use("/api/junk-car", junkCarRoutes);

// Auth routes
// app.use("/api/auth", require("./routes/auth"));   //end

// User routes
app.use("/api/users", require("./routes/users"));

// Car Intake routes
app.use("/api/car-intake", require("./routes/carIntake"));

// Seller routes
app.use("/api/sellers", require("./routes/sellers"));

// Transaction routes
app.use("/api/transactions", require("./routes/transactions"));

// Tag routes
app.use("/api/tags", require("./routes/tag.routes"));

// Upload routes
app.use("/api/upload", require("./routes/upload"));

// VIN routes
app.use("/api/vin", require("./routes/vin"));

// Make routes
app.use("/api/make", require("./routes/make.routes"));

// Model routes
app.use("/api/model", require("./routes/model.routes"));

// Trim routes
app.use("/api/trim", require("./routes/trim.routes"));

// Part routes
app.use("/api/part", require("./routes/part.routes"));

// Elements routes
app.use("/api/element", require("./routes/element.routes"));

// Scrap Element routes
app.use("/api/scrap-element", require("./routes/scrapElement.routes"));

// Element Hub routes (accumulated elements + history + sell)
app.use("/api/element-hub", require("./routes/elementHub.routes"));

// Scrap Material Purchase routes (independent module — no Car Intake coupling)
app.use("/api/scrap-purchase", require("./routes/scrapPurchase.routes"));

// Scrap Material Purchase — dedicated seller routes (independent from the
// shared Customer collection; mounted on its own base path to avoid any
// conflict with the /api/scrap-purchase/:id route).
app.use(
  "/api/scrap-purchase-sellers",
  require("./routes/scrapPurchaseSeller.routes")
);

// Inventory routes
app.use("/api/inventory", require("./routes/inventory.routes"));

// Buyer routes
app.use("/api/buyers", require("./routes/buyer.routes"));

// Waiver routes
app.use("/api/waivers", require("./routes/waiver.routes"));

// Customer routes
app.use("/api/customers", require("./routes/customer"));

// CheckIn routes
app.use("/api/checkins", require("./routes/checkIn"));

// Dashboard routes (aggregations for frontend charts)
app.use("/api/dashboard", require("./routes/dashboard.routes"));

// Invoice print route
app.use("/api/invoices", require("./routes/invoice.routes"));

// Wix integration routes
app.use("/api/wix", require("./routes/wix.routes"));

// Social & Marketplace Integration Routes
app.use("/api/social-leads", require("./routes/socialLead.routes"));
app.use("/api/marketplace-leads", require("./routes/marketplaceListing.routes"));
app.use("/api/conversations", require("./routes/conversation.routes"));
app.use("/api/orders", require("./routes/order.routes"));
app.use("/api/integrations", require("./routes/integration.routes"));
app.use("/api/integrations/ebay", ebayRoutes);
app.use("/api/ebay", ebayCatalogSyncRoutes);

// WhatsApp adapter — self-registers with PlatformManager on require
require("./services/adapters/whatsappAdapter");

// eBay adapter — self-registers with PlatformManager on require
require("./services/adapters/ebayAdapter");

// TikTok adapter — self-registers with PlatformManager on require
require("./services/adapters/tiktokAdapter");

// Entry Fee routes
app.use("/api/entry-fee", require("./routes/entryFee.routes"));

// Serve uploaded files statically
app.use("/uploads", express.static(path.join(__dirname, "uploads")));


app.use("/assets", express.static(path.join(__dirname, "assets")));

// Error handling middleware
app.use((err, req, res, next) => {
  // Log the full error details
  console.error(`Error ${err.status || 500}: ${err.message}`);
  console.error(`Request: ${req.method} ${req.url}`);
  console.error(`User: ${req.user ? req.user._id : "Anonymous"}`);
  console.error(`Stack: ${err.stack}`);

  // Don't leak error details in production
  const isDevelopment = process.env.NODE_ENV === "development";

  res.status(err.status || 500).json({
    error: err.message || "Something went wrong!",
    ...(isDevelopment && { stack: err.stack }),
    timestamp: new Date().toISOString(),
  });
});

// 404 handler - must be last
app.use((req, res) => {
  // ─── eBay OAuth diagnostic: only fires for requests that mention "ebay" ──
  // and reached here (i.e. matched no route). Purely additive — does not
  // change the response for this or any other unmatched request.
  if (typeof req.originalUrl === "string" && req.originalUrl.toLowerCase().includes("ebay")) {
    console.error(JSON.stringify({
      tag: "[EBAY][ERROR]",
      timestamp: new Date().toISOString(),
      platform: "ebay",
      step: "404_ROUTE_NOT_FOUND",
      function: "server.js 404 handler",
      requestedUrl: req.originalUrl,
      expectedCallbackUrl: "/api/integrations/ebay/callback",
      expectedConnectUrl: "/api/integrations/ebay/connect",
      expectedStatusUrl: "/api/integrations/ebay/status",
      method: req.method,
      referer: req.get("Referer") || null,
      origin: req.get("Origin") || null,
      frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
      backendHost: `${req.protocol}://${req.get("host")}`,
      routeFound: false,
    }));
  }

  res.status(404).json({ error: "Route not found" });
});

// Module-scope references to the eBay cron starters so graceful shutdown can
// stop scheduling new eBay work. Assigned inside the listen callback below.
let ebayCatalogSyncJobRef = null;
let ebayListingReconcileJobRef = null;

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);

  startBackInStockChecker();   // Added by shiva

  // Start the eBay token auto-refresh cron job.
  // Prevents a connected eBay integration from silently showing as
  // "disconnected" once its ~2h access token expires with no auto-refresh.
  try {
    const startEbayTokenRefresh = require("./services/ebayTokenRefresh.service");
    startEbayTokenRefresh();
    console.log("eBay token auto-refresh cron job started");
  } catch (err) {
    console.error("Failed to start eBay token auto-refresh cron job:", err.message || err);
  }

  // Start the VIN cron job unless explicitly disabled
  try {
    if (
      !process.env.DISABLE_VIN_CRON ||
      process.env.DISABLE_VIN_CRON === "false"
    ) {
      // require lazily so it doesn't block startup when disabled
      const vinJob = require("./jobs/fetchVinDetailsJob");

      vinJob.startCron();
      console.log("VIN cron job started");
    } else {
      console.log("VIN cron job disabled by DISABLE_VIN_CRON");
    }
  } catch (err) {
    console.error("Failed to start VIN cron job:", err.message || err);
  }

  // Start the eBay catalog sync (6-hour) cron job.
  // Automatically syncs CRM Inventory to eBay every 6 hours.
  // Failure-tolerant: one failed run never prevents future runs.
  try {
    const startEbayCatalogSync = require("./jobs/ebayCatalogSyncJob");
    startEbayCatalogSync();
    ebayCatalogSyncJobRef = startEbayCatalogSync;
    console.log("eBay catalog 6-hour sync cron job started");
  } catch (err) {
    console.error("Failed to start eBay catalog sync cron job:", err.message || err);
  }

  // Start the eBay ACTIVE LISTING reconciliation (30-minute) cron job.
  // This is the opposite direction to the catalog sync above: it PULLS the
  // seller's currently active eBay listings into the CRM Marketplace Listing
  // dataset so the CRM never shows listings that are not live on eBay.
  // Shares the existing EbaySyncRun lock, so it can never run concurrently
  // with itself. Failure-tolerant: one failed run never prevents later runs.
  try {
    const startEbayListingReconcile = require("./jobs/ebayListingReconcileJob");
    startEbayListingReconcile();
    ebayListingReconcileJobRef = startEbayListingReconcile;
    console.log("eBay active listing reconciliation cron job started");
  } catch (err) {
    console.error(
      "Failed to start eBay active listing reconciliation cron job:",
      err.message || err
    );
  }
});

// ─── Graceful shutdown (Passenger/Plesk send SIGTERM; Ctrl-C sends SIGINT) ──
// PURPOSE: on a CLEAN termination, stop scheduling new eBay work and best-effort
// release an in-flight eBay sync lock so the next process is not left blocked.
// This is a SECONDARY safety layer ONLY. If it fails, times out, or the process
// is SIGKILLed/OOM-killed, the MongoDB LEASE (models/EbaySyncRun.model.js)
// expires by itself and the lock becomes reclaimable automatically. We never
// block Passenger shutdown indefinitely, and never do async work in exit().
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SHUTDOWN] Received ${signal} — starting graceful shutdown`);

  // 1) Stop starting new eBay work.
  try { if (ebayCatalogSyncJobRef && ebayCatalogSyncJobRef.stop) ebayCatalogSyncJobRef.stop(); } catch (_) { /* best-effort */ }
  try { if (ebayListingReconcileJobRef && ebayListingReconcileJobRef.stop) ebayListingReconcileJobRef.stop(); } catch (_) { /* best-effort */ }

  // 2) Signal any in-flight protected eBay sync operation to cancel, wait
  //    (bounded by this same timeout) for it to actually finish, and only
  //    then release its lock — ownership-verified, as always. If it does
  //    NOT finish within the timeout, the lock is deliberately left held
  //    (see EbaySyncRun.shutdownActiveLocks's doc comment): the lease
  //    expires naturally and the next process reclaims it, which is safer
  //    than releasing a lock while this process might still be writing to
  //    eBay. This is a SECONDARY safety layer — if it fails entirely, the
  //    lease still expires by itself.
  try {
    const EbaySyncRun = require("./models/EbaySyncRun.model");
    const res = await EbaySyncRun.shutdownActiveLocks(3000);
    console.log(`[SHUTDOWN] eBay sync lock cleanup: total=${res.total} released=${res.released} stillRunning=${res.stillRunning} timedOut=${res.timedOut}`);
  } catch (err) {
    console.error("[SHUTDOWN] eBay sync lock cleanup failed (the lease will still expire):", (err && err.message) || err);
  }

  // 3) Hard-exit guard: never hang Passenger if server.close() stalls.
  const forceTimer = setTimeout(() => {
    console.error("[SHUTDOWN] Forcing exit after timeout");
    process.exit(0);
  }, 8000);
  if (forceTimer.unref) forceTimer.unref();

  server.close(() => {
    console.log("[SHUTDOWN] HTTP server closed");
    process.exit(0);
  });
}

process.on("SIGTERM", () => { gracefulShutdown("SIGTERM"); });
process.on("SIGINT", () => { gracefulShutdown("SIGINT"); });

