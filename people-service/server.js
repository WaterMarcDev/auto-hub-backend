require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const cookieParser = require("cookie-parser");
const morgan     = require("morgan");
const path       = require("path");

const mongoose = require("mongoose");
const connectDB              = require("../shared/database");
const { errorHandler, notFound } = require("../shared/errorHandler");

const sellerRoutes      = require("./routes/seller.routes");
const buyerRoutes       = require("./routes/buyer.routes");
const customerRoutes    = require("./routes/customer.routes");
const waiverRoutes      = require("./routes/waiver.routes");
const partRequestRoutes = require("./routes/partRequest.routes");

const app  = express();
const PORT = process.env.PORT || 3005;

connectDB(mongoose);

app.use(cors({ origin: true, credentials: true }));
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/health", (req, res) =>
  res.json({ service: "people-service", status: "ok", timestamp: new Date().toISOString() })
);

app.use("/api/sellers",      sellerRoutes);
app.use("/api/buyers",       buyerRoutes);
app.use("/api/customers",    customerRoutes);
app.use("/api/waivers",      waiverRoutes);
app.use("/api/part-request", partRequestRoutes);

app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => console.log(`[people-service] Running on port ${PORT}`));
module.exports = app;
