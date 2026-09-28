const express = require("express");
const router = express.Router();
const os = require("os");
const mongoose = require("mongoose");
const { auth, requireAdmin } = require("../middleware/auth");
const { getRateLimiterStats } = require("../middleware/rateLimiter");

// Models for diagnostics
let CheckIn, Customer, Waiver, Inventory, Transaction, User, EbaySyncRun;
try { CheckIn = require("../models/CheckIn.model"); } catch (_) {}
try { Customer = require("../models/Customer.model"); } catch (_) {}
try { Waiver = require("../models/Waiver.model"); } catch (_) {}
try { Inventory = require("../models/Inventory.model"); } catch (_) {}
try { Transaction = require("../models/Transaction.model"); } catch (_) {}
try { User = require("../models/User.model"); } catch (_) {}
try { EbaySyncRun = require("../models/EbaySyncRun.model"); } catch (_) {}

/**
 * @swagger
 * /api/system/health:
 *   get:
 *     summary: Public health probe
 *     tags: [System]
 *     responses:
 *       200:
 *         description: Server health status
 */
router.get("/health", async (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  const status = dbConnected ? "ok" : "degraded";

  return res.status(dbConnected ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    database: dbConnected ? "connected" : "disconnected",
  });
});

/**
 * @swagger
 * /api/system/analytics:
 *   get:
 *     summary: Comprehensive system, network, and database telemetry (Admin only)
 *     tags: [System]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Full operational telemetry payload
 */
router.get("/analytics", auth, requireAdmin, async (req, res) => {
  try {
    const memory = process.memoryUsage();
    const uptimeSec = Math.floor(process.uptime());

    // 1. Measure DB ping latency
    let dbPingMs = null;
    let dbStatus = "disconnected";
    if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
      dbStatus = "connected";
      const startPing = Date.now();
      try {
        await mongoose.connection.db.admin().ping();
        dbPingMs = Date.now() - startPing;
      } catch (e) {
        dbPingMs = -1;
      }
    }

    // 2. Sample collection counts (approximate or bounded)
    const counts = {
      checkIns: 0,
      customers: 0,
      waivers: 0,
      inventory: 0,
      transactions: 0,
      users: 0,
    };

    if (dbStatus === "connected") {
      try {
        const [cCheckIns, cCustomers, cWaivers, cInventory, cTransactions, cUsers] =
          await Promise.allSettled([
            CheckIn?.estimatedDocumentCount?.() ?? Promise.resolve(0),
            Customer?.estimatedDocumentCount?.() ?? Promise.resolve(0),
            Waiver?.estimatedDocumentCount?.() ?? Promise.resolve(0),
            Inventory?.estimatedDocumentCount?.() ?? Promise.resolve(0),
            Transaction?.estimatedDocumentCount?.() ?? Promise.resolve(0),
            User?.estimatedDocumentCount?.() ?? Promise.resolve(0),
          ]);

        counts.checkIns = cCheckIns.status === "fulfilled" ? cCheckIns.value : 0;
        counts.customers = cCustomers.status === "fulfilled" ? cCustomers.value : 0;
        counts.waivers = cWaivers.status === "fulfilled" ? cWaivers.value : 0;
        counts.inventory = cInventory.status === "fulfilled" ? cInventory.value : 0;
        counts.transactions = cTransactions.status === "fulfilled" ? cTransactions.value : 0;
        counts.users = cUsers.status === "fulfilled" ? cUsers.value : 0;
      } catch (_) {}
    }

    // 3. Active WebSocket connections
    const io = req.app.get("io");
    let activeSockets = 0;
    if (io) {
      if (io.engine && typeof io.engine.clientsCount === "number") {
        activeSockets = io.engine.clientsCount;
      } else if (io.sockets && io.sockets.sockets) {
        activeSockets = io.sockets.sockets.size || 0;
      }
    }

    // 4. Rate limiter telemetry
    const rateLimiterStats = getRateLimiterStats();

    // 5. Background sync run (latest)
    let latestSyncRun = null;
    if (EbaySyncRun) {
      try {
        latestSyncRun = await EbaySyncRun.findOne()
          .sort({ createdAt: -1 })
          .select("runId trigger isLocked status startedAt completedAt durationMs totalDiscovered totalPublished totalFailed createdAt")
          .lean();
      } catch (_) {}
    }

    // 6. System health score calculation (0 - 100)
    let healthScore = 100;
    if (dbStatus !== "connected") healthScore -= 50;
    if (dbPingMs > 100) healthScore -= 10;
    if (dbPingMs > 300) healthScore -= 20;
    const heapUsedPct = (memory.heapUsed / memory.heapTotal) * 100;
    if (heapUsedPct > 85) healthScore -= 15;
    if (latestSyncRun?.status === "failed") healthScore -= 5;
    healthScore = Math.max(0, Math.min(100, Math.round(healthScore)));

    const overallStatus =
      healthScore >= 90 ? "operational" : healthScore >= 70 ? "degraded" : "critical";

    return res.json({
      success: true,
      timestamp: new Date().toISOString(),
      health: {
        score: healthScore,
        status: overallStatus,
      },
      system: {
        nodeVersion: process.version,
        environment: process.env.NODE_ENV || "development",
        uptimeSeconds: uptimeSec,
        pid: process.pid,
        platform: os.platform(),
        arch: os.arch(),
        cpuCount: os.cpus().length,
        loadAvg: os.loadavg(),
        totalMemoryBytes: os.totalmem(),
        freeMemoryBytes: os.freemem(),
      },
      processMemory: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers || 0,
      },
      database: {
        status: dbStatus,
        pingMs: dbPingMs,
        name: mongoose.connection.name || "autohub",
        host: mongoose.connection.host || "cluster",
        counts,
      },
      realtime: {
        activeSockets,
        gatewayStatus: io ? "active" : "offline",
      },
      rateLimiter: rateLimiterStats,
      backgroundTasks: {
        ebaySync: {
          latestRun: latestSyncRun,
          isLocked: Boolean(latestSyncRun?.isLocked),
        },
      },
    });
  } catch (error) {
    console.error("System analytics telemetry error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to gather telemetry",
    });
  }
});

module.exports = router;
