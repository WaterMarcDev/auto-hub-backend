require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const nunjucks = require("nunjucks");
const path = require("path");

const connectDB = require("../shared/database");
const { errorHandler, notFound } = require("../shared/errorHandler");

const transactionRoutes = require("./routes/transaction.routes");
const checkInRoutes     = require("./routes/checkIn.routes");
const invoiceRoutes     = require("./routes/invoice.routes");
const entryFeeRoutes    = require("./routes/entryFee.routes");
const dashboardRoutes   = require("./routes/dashboard.routes");

const app = express();
const PORT = process.env.PORT || 3004;

connectDB();

// Templating for invoice print routes
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

app.get("/health", (req, res) => res.json({ service: "transaction-service", status: "ok", timestamp: new Date().toISOString() }));

app.use("/api/transactions", transactionRoutes);
app.use("/api/checkins",     checkInRoutes);
app.use("/api/invoices",     invoiceRoutes);
app.use("/api/entry-fee",    entryFeeRoutes);
app.use("/api/dashboard",    dashboardRoutes);

app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => console.log(`[transaction-service] Running on port ${PORT}`));

module.exports = app;
