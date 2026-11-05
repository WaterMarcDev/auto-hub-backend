const express = require("express");
const router = express.Router();
const { auth, permit } = require("../middleware/auth");
const c = require("../controllers/inventorySync.controller");

// Base path: /api/inventory-sync — stock ledger, in-store sales, returns,
// eBay quantity sync queue, eBay webhook events, reconciliation.
const ANY_STAFF = permit("admin", "manager", "staff", "front_desk");
const MANAGERS = permit("admin", "manager");

router.use(auth);

router.get("/summary", MANAGERS, c.summary);

router.post("/parts/:id/sell", ANY_STAFF, c.sellInStore);
router.post("/parts/:id/adjust", MANAGERS, c.adjustStock);
router.post("/parts/:id/return/received", ANY_STAFF, c.returnReceived);
router.post("/parts/:id/return/inspection", MANAGERS, c.returnInspection);

router.get("/transactions", MANAGERS, c.listTransactions);
router.get("/returns", ANY_STAFF, c.listReturns);

router.get("/ebay-sync", MANAGERS, c.listEbaySync);
router.post("/ebay-sync/run", MANAGERS, c.runEbaySync);
router.post("/ebay-sync/:id/retry", MANAGERS, c.retryEbaySync);

router.get("/events", MANAGERS, c.listEvents);
router.post("/events/:id/retry", MANAGERS, c.retryEvent);

router.get("/reconciliation", MANAGERS, c.getReconciliation);
router.post("/reconciliation/run", MANAGERS, c.runReconciliation);

module.exports = router;
