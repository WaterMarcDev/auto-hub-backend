require("dotenv").config();
const express      = require("express");
const cors         = require("cors");
const cookieParser = require("cookie-parser");
const morgan       = require("morgan");
const path         = require("path");
const http         = require("http");
const { Server }   = require("socket.io");

const mongoose = require("mongoose");
const connectDB              = require("../shared/database");
const { errorHandler, notFound } = require("../shared/errorHandler");

const uploadRoutes = require("./routes/upload.routes");
const emailRoutes  = require("./routes/email.routes");
const wixRoutes    = require("./routes/wix.routes");

const startBackInStockChecker = require("./services/checkBackInStock.service");

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3006;

connectDB(mongoose);

// Socket.IO for real-time email notifications
const io = new Server(server, { cors: { origin: "*" } });
app.set("io", io);
io.on("connection", socket => console.log("🟢 [integration-service] Socket connected:", socket.id));

app.use(cors({ origin: true, credentials: true }));
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/assets",  express.static(path.join(__dirname, "assets")));

app.get("/health", (req, res) =>
  res.json({ service: "integration-service", status: "ok", timestamp: new Date().toISOString() })
);

app.use("/api/upload", uploadRoutes);
app.use("/api/email",  emailRoutes);
app.use("/api/wix",    wixRoutes);

app.use(notFound);
app.use(errorHandler);

server.listen(PORT, () => {
  console.log(`[integration-service] Running on port ${PORT}`);
  startBackInStockChecker();
});

module.exports = app;
