const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const connectDB = require("./config/database");
const loggerConfig = require("./config/logger");
const addUserContext = require("./middleware/logging");
const morgan = require("morgan");
require("dotenv").config();

// Connect to MongoDB
connectDB();

const app = express();
const PORT = process.env.PORT || 5000;

const allowlist = [
  "http://localhost:5173",
  "https://wmshostings.us",
  "https://www.wmshostings.us",
];

const corsOptionsDelegate = (req, callback) => {
  const origin = req.header("Origin");
  const isAllowed = origin && allowlist.includes(origin);
  callback(null, {
    origin: isAllowed ? origin : false, // exact echo or disallow
    credentials: true, // only useful if origin is not false
  });
};

app.options("/{*path}", cors(corsOptionsDelegate)); // preflight
app.use(cors(corsOptionsDelegate));

app.use(morgan("dev"));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(addUserContext);

// Routes
app.get("/", (req, res) => {
  res.json({
    message: "AutoHub API is running! fine",
    corsEnabled: true,
    allowedOrigins: allowlist,
    environment: process.env.NODE_ENV || "development",
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    corsEnabled: true,
    allowedOrigins: allowlist,
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

// Serve uploaded files statically
app.use("/uploads", express.static("uploads"));

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
});
