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
require("dotenv").config();

// Connect to MongoDB
connectDB();

const app = express();
const PORT = process.env.PORT || 5000;

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
  "http://192.168.1.4:5173",
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(addUserContext);

// Routes
const fs = require("fs");
const { marked } = require("marked");

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

// Entry Fee routes
app.use("/api/entry-fee", require("./routes/entryFee.routes"));

// Serve uploaded files statically
app.use("/uploads", express.static("uploads"));

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
  res.status(404).json({ error: "Route not found" });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
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
});
