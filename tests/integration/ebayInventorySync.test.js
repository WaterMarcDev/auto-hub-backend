// eBay ↔ CRM inventory sync — automated tests on an in-memory MongoDB.
// Real backend code; eBay HTTP calls are mocked. Usage: node ebaySync.test.js <backend dir>
process.env.EBAY_QUANTITY_SYNC_AUTORUN = "false";
process.env.EBAY_NOTIFICATION_AUTORUN = "false";
process.env.EBAY_ENVIRONMENT = process.env.EBAY_ENVIRONMENT || "sandbox";

const path = require("path");
const crypto = require("crypto");
const { MongoMemoryServer } = require("mongodb-memory-server");
const B = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const req = (p) => require(path.join(B, p));
const mongoose = require(path.join(B, "node_modules", "mongoose"));

let failures = 0;
let passes = 0;
const results = [];
const ok = (cond, label, extra) => {
  results.push({ label, pass: !!cond });
  if (cond) {
    passes += 1;
    console.log("  PASS", label);
  } else {
    failures += 1;
    console.log("  FAIL", label, extra !== undefined ? JSON.stringify(extra) : "");
  }
};
const section = (t) => console.log(`\n${t}`);
const mockRes = () => {
  const r = { statusCode: 200 };
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (b) => ((r.body = b), r);
  r.end = () => r;
  return r;
};
const call = async (fn, reqObj) => {
  const res = mockRes();
  await fn({ params: {}, query: {}, body: {}, user: { _id: new mongoose.Types.ObjectId(), role: "admin" }, ...reqObj }, res);
  return res;
};
const rid = () => crypto.randomBytes(8).toString("hex");

(async () => {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  const Inventory = req("models/Inventory.model");
  const InventoryTransaction = req("models/InventoryTransaction.model");
  const MarketplaceEvent = req("models/MarketplaceEvent.model");
  const MarketplaceListing = req("models/MarketplaceListing.model");
  const ledger = req("services/inventoryLedger.service");
  const sales = req("services/marketplaceSales.service");
  const qsync = req("services/ebayQuantitySync.service");
  const notif = req("services/ebayNotification.service");
  const recon = req("services/inventoryReconciliation.service");
  const ctl = req("controllers/inventorySync.controller");
  const ebayAdapter = req("services/adapters/ebayAdapter");
  await Promise.all([Inventory.init(), InventoryTransaction.init(), MarketplaceEvent.init()]);

  const refs = { make: new mongoose.Types.ObjectId(), model: new mongoose.Types.ObjectId(), trim: new mongoose.Types.ObjectId() };
  const mk = async (o = {}) => {
    const doc = await Inventory.create({ partName: `p${rid()}`, unit: "1", year: 2010, ...refs, vin: `V${rid()}`, ...o });
    if (o.legacyNoQty) await Inventory.collection.updateOne({ _id: doc._id }, { $unset: { quantityAvailable: "", quantitySold: "", saleStatus: "" } });
    return doc;
  };
  const get = (id) => Inventory.findById(id).select("+appliedTxKeys").lean();
  const ebayOrder = (part, over = {}, line = {}) => ({
    orderId: over.orderId || `O-${rid()}`,
    legacyOrderId: over.orderId || "12-345",
    creationDate: "2026-11-05T10:00:00.000Z",
    orderFulfillmentStatus: "NOT_STARTED",
    orderPaymentStatus: "PAID",
    buyer: { username: "buyer1" },
    pricingSummary: { total: { value: "50.00", currency: "USD" } },
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: "Jane Buyer", contactAddress: { city: "Newark" } } } }],
    lineItems: [{ lineItemId: "L1", sku: String(part._id), legacyItemId: part.ebayListingId || "999", title: "Part", quantity: 1, lineItemCost: { value: "50.00", currency: "USD" }, ...line }],
    ...over,
  });

  // ── Ledger core ──────────────────────────────────────────────────────────
  section("LEDGER — atomic, idempotent, never negative");
  const L1 = await mk({ legacyNoQty: true });
  let r = await ledger.deduct({ inventoryId: L1._id, quantity: 1, key: "k-1", source: "CRM_SALE", countAsSale: true });
  let d = await get(L1._id);
  ok(r.outcome === "applied" && d.quantityAvailable === 0 && d.saleStatus === "sold" && d.quantitySold === 1, "legacy part (no qty field) counts as 1; sale → 0, sold", { r, d });
  const tx = await InventoryTransaction.findOne({ key: "k-1" }).lean();
  ok(tx && tx.previousQuantity === 1 && tx.newQuantity === 0 && tx.status === "applied" && tx.source === "CRM_SALE", "ledger row has previous/new quantity, source, status", tx);
  r = await ledger.deduct({ inventoryId: L1._id, quantity: 1, key: "k-1", source: "CRM_SALE" });
  ok(r.outcome === "duplicate" && (await get(L1._id)).quantityAvailable === 0, "same key again → duplicate, no change");
  r = await ledger.deduct({ inventoryId: L1._id, quantity: 1, key: "k-2", source: "CRM_SALE" });
  d = await get(L1._id);
  ok(r.outcome === "insufficient" && d.quantityAvailable === 0, "deduct at 0 → insufficient, stock never negative");
  ok((await InventoryTransaction.findOne({ key: "k-2" }).lean()).status === "rejected", "rejected deduction recorded in ledger");

  const C1 = await mk({ quantityAvailable: 1 });
  const race = await Promise.all(Array.from({ length: 10 }, (_, i) => ledger.deduct({ inventoryId: C1._id, quantity: 1, key: `race-${i}`, source: "EBAY_SALE" })));
  ok(race.filter((x) => x.outcome === "applied").length === 1 && (await get(C1._id)).quantityAvailable === 0, "10 simultaneous sales of the last unit → exactly 1 succeeds", race.map((x) => x.outcome));

  const C2 = await mk({ quantityAvailable: 5 });
  const dup = await Promise.all(Array.from({ length: 6 }, () => ledger.deduct({ inventoryId: C2._id, quantity: 1, key: "same-notification", source: "EBAY_SALE" })));
  ok(dup.filter((x) => x.outcome === "applied").length === 1 && (await get(C2._id)).quantityAvailable === 4, "6 simultaneous duplicate notifications → deducted once (5 → 4)", dup.map((x) => x.outcome));

  const LS = await mk({});
  await Inventory.collection.updateOne({ _id: LS._id }, { $unset: { quantityAvailable: "" }, $set: { saleStatus: "sold", sale: { channel: "ebay", orderId: "LEG-1", lineItemId: "L1" } } });
  r = await ledger.deduct({ inventoryId: LS._id, quantity: 1, key: "leg-sell", source: "CRM_SALE" });
  ok(r.outcome === "insufficient" && r.previousQuantity === 0, "part marked sold before quantities existed counts as 0 (cannot be sold again)", r);
  const relLeg = await sales.releaseOrder("ebay", "LEG-1", "was cancelled");
  d = await get(LS._id);
  ok(relLeg === 1 && d.quantityAvailable === 1 && d.saleStatus === "available", "its cancellation restores it to 1", { relLeg, q: d.quantityAvailable });

  const RM = await mk({ isDeleted: true });
  r = await ledger.deduct({ inventoryId: RM._id, quantity: 1, key: "rm", source: "EBAY_SALE" });
  ok(r.outcome === "removed", "removed (scrapped) part cannot be sold");

  // ── A. eBay sales ────────────────────────────────────────────────────────
  section("A. eBay sales");
  const A1 = await mk({ quantityAvailable: 2, ebayListingId: "111", ebayOfferId: "OF1", ebaySyncStatus: "PUBLISHED" });
  const o1 = ebayOrder(A1, { orderId: "A-1" });
  let s = await sales.applyEbayOrder(o1, null);
  d = await get(A1._id);
  ok(s.sold === 1 && d.quantityAvailable === 1 && d.saleStatus === "available", "one unit sold: 2 → 1, still available", { s, q: d.quantityAvailable });
  ok(!d.ebayQuantitySync, "eBay-originated sale does NOT queue an eBay update (no loop)", d.ebayQuantitySync);
  s = await sales.applyEbayOrder(ebayOrder(A1, { orderId: "A-2" }), null);
  d = await get(A1._id);
  ok(s.sold === 1 && d.quantityAvailable === 0 && d.saleStatus === "sold", "second sale: 1 → 0, out of stock / sold");
  s = await sales.applyEbayOrder(o1, null);
  ok(s.refreshed === 1 && (await get(A1._id)).quantityAvailable === 0, "duplicate / delayed notification of the same order → no second deduction");

  const A2 = await mk({ quantityAvailable: 3 });
  s = await sales.applyEbayOrder(ebayOrder(A2, { orderId: "A-3" }, { quantity: 3 }), null);
  ok(s.sold === 1 && (await get(A2._id)).quantityAvailable === 0, "multiple units in one line (qty 3) → 3 → 0");

  const A3 = await mk({ ebayListingId: "333" });
  s = await sales.applyEbayOrder(ebayOrder(A3, { orderId: "A-4" }, { sku: undefined, legacyItemId: "333" }), null);
  ok(s.sold === 1 && (await get(A3._id)).quantityAvailable === 0, "missing SKU → matched by eBay item id");

  s = await sales.applyEbayOrder(ebayOrder({ _id: "nope" }, { orderId: "A-5" }, { sku: "UNKNOWN-SKU", legacyItemId: "000" }), null);
  ok(s.unmatched.length === 1 && /no CRM part/.test(s.unmatched[0].reason), "unmapped listing → unmatched, nothing deducted", s.unmatched);

  const AM1 = await mk({ ebayListingId: "dup-1", quantityAvailable: 1 });
  const AM2 = await mk({ ebayListingId: "dup-1", quantityAvailable: 1 });
  s = await sales.applyEbayOrder(ebayOrder(AM1, { orderId: "A-6" }, { sku: "NOT-AN-ID", legacyItemId: "dup-1" }), null);
  ok(s.unmatched.length === 1 && /ambiguous/.test(s.unmatched[0].reason) && (await get(AM1._id)).quantityAvailable === 1 && (await get(AM2._id)).quantityAvailable === 1, "ambiguous mapping (2 parts share an eBay item id) → NO deduction", s.unmatched);

  // ── C. Cancellations ─────────────────────────────────────────────────────
  section("C. Cancellations");
  const C3 = await mk({});
  s = await sales.applyEbayOrder(ebayOrder(C3, { orderId: "C-1", cancelStatus: { cancelState: "CANCELED" } }), null);
  ok(s.released === 0 && (await get(C3._id)).quantityAvailable === 1, "cancellation before any deduction → nothing restored");
  await sales.applyEbayOrder(ebayOrder(C3, { orderId: "C-2" }), null);
  ok((await get(C3._id)).quantityAvailable === 0, "(sale deducted)");
  s = await sales.applyEbayOrder(ebayOrder(C3, { orderId: "C-2", cancelStatus: { cancelState: "IN_PROGRESS" } }), null);
  ok((await get(C3._id)).quantityAvailable === 0, "cancellation REQUESTED (in progress) → not restored");
  s = await sales.applyEbayOrder(ebayOrder(C3, { orderId: "C-2", cancelStatus: { cancelState: "CANCELED" } }), null);
  d = await get(C3._id);
  ok(s.released === 1 && d.quantityAvailable === 1 && d.saleStatus === "available" && d.sale === null, "completed cancellation after deduction → restored once, sale cleared", { s, d: { q: d.quantityAvailable, st: d.saleStatus } });
  s = await sales.applyEbayOrder(ebayOrder(C3, { orderId: "C-2", cancelStatus: { cancelState: "CANCELED" } }), null);
  ok(s.released === 0 && (await get(C3._id)).quantityAvailable === 1, "duplicate cancellation event → no second restore");
  ok((await InventoryTransaction.countDocuments({ source: "EBAY_CANCELLATION", orderId: "C-2", status: "applied" })) === 1, "exactly one EBAY_CANCELLATION in ledger");

  const C4 = await mk({});
  await sales.applyEbayOrder(ebayOrder(C4, { orderId: "C-3" }), null);
  await sales.applyEbayOrder(ebayOrder(C4, { orderId: "C-3", orderPaymentStatus: "FULLY_REFUNDED" }), null);
  ok((await get(C4._id)).quantityAvailable === 0, "refund recorded first: still 0");
  await sales.applyEbayOrder(ebayOrder(C4, { orderId: "C-3", orderPaymentStatus: "FULLY_REFUNDED", cancelStatus: { cancelState: "CANCELED" } }), null);
  ok((await get(C4._id)).quantityAvailable === 1, "cancellation after refund processing → restored exactly once");

  // ── B. Refunds & returns ─────────────────────────────────────────────────
  section("B. Refunds & returns");
  const R1 = await mk({ ebayOfferId: "OFR1", ebayListingId: "R1L" });
  await sales.applyEbayOrder(ebayOrder(R1, { orderId: "R-1" }), null);
  await sales.applyEbayOrder(ebayOrder(R1, { orderId: "R-1", orderPaymentStatus: "FULLY_REFUNDED" }), null);
  d = await get(R1._id);
  ok(d.quantityAvailable === 0, "full refund without return → stock unchanged (0)");
  ok((await InventoryTransaction.countDocuments({ orderId: "R-1", status: "recorded", source: "EBAY_RETURN" })) === 1, "refund recorded in ledger as information only");
  await sales.applyEbayOrder(ebayOrder(R1, { orderId: "R-1", orderPaymentStatus: "FULLY_REFUNDED" }), null);
  ok((await InventoryTransaction.countDocuments({ orderId: "R-1", status: "recorded" })) === 1, "duplicate refund notification → recorded once");

  const R2 = await mk({});
  await sales.applyEbayOrder(ebayOrder(R2, { orderId: "R-2", orderPaymentStatus: "PARTIALLY_REFUNDED" }), null);
  ok((await get(R2._id)).quantityAvailable === 0, "partial refund → stock unchanged");

  let res = await call(ctl.returnInspection, { params: { id: String(R1._id) }, body: { result: "pass" } });
  ok(res.statusCode === 404, "inspection before any return is recorded → refused");
  res = await call(ctl.returnReceived, { params: { id: String(R1._id) } });
  d = await get(R1._id);
  ok(res.statusCode === 200 && d.returnInfo.status === "received" && d.quantityAvailable === 0, "return received → status received, stock still 0");
  res = await call(ctl.returnReceived, { params: { id: String(R1._id) } });
  ok(res.statusCode === 409, "marking received twice → refused");
  res = await call(ctl.returnInspection, { params: { id: String(R1._id) }, body: { result: "pass", notes: "ok" } });
  d = await get(R1._id);
  ok(res.statusCode === 200 && res.body.restocked && d.quantityAvailable === 1 && d.saleStatus === "available" && d.returnInfo.status === "inspection_passed", "approved for resale → restocked to 1", { b: res.body, q: d.quantityAvailable });
  ok((await InventoryTransaction.countDocuments({ inventoryId: R1._id, source: "EBAY_RESTOCK", status: "applied" })) === 1, "EBAY_RESTOCK in ledger");
  ok(d.ebayQuantitySync && d.ebayQuantitySync.status === "pending", "restock queues an eBay quantity update", d.ebayQuantitySync);
  res = await call(ctl.returnInspection, { params: { id: String(R1._id) }, body: { result: "pass" } });
  ok(res.statusCode === 200 && res.body.alreadyProcessed && (await get(R1._id)).quantityAvailable === 1, "duplicate restock attempt → no second restore");

  const R3 = await mk({});
  await sales.applyEbayOrder(ebayOrder(R3, { orderId: "R-3" }), null);
  await call(ctl.returnReceived, { params: { id: String(R3._id) } });
  res = await call(ctl.returnInspection, { params: { id: String(R3._id) }, body: { result: "fail", notes: "cracked" } });
  d = await get(R3._id);
  ok(res.statusCode === 200 && d.quantityAvailable === 0 && d.returnInfo.status === "inspection_failed", "damaged return → not restocked, inspection_failed");
  res = await call(ctl.returnInspection, { params: { id: String(R3._id) }, body: { result: "pass" } });
  ok(res.statusCode === 409 && (await get(R3._id)).quantityAvailable === 0, "cannot pass after failing → stays unavailable");

  // ── D. CRM sale + CRM → eBay sync ────────────────────────────────────────
  section("D. CRM-originated sale and CRM → eBay sync");
  const D1 = await mk({ quantityAvailable: 2, ebayOfferId: "OFD1", ebayListingId: "D1L", ebaySku: String(new mongoose.Types.ObjectId()) });
  const reqId = rid();
  res = await call(ctl.sellInStore, { params: { id: String(D1._id) }, body: { quantity: 1, price: 40, buyerName: "Walk-in", requestId: reqId } });
  d = await get(D1._id);
  ok(res.statusCode === 200 && d.quantityAvailable === 1 && d.sale.channel === "crm", "in-store sale: 2 → 1");
  ok(d.ebayQuantitySync?.status === "pending", "CRM sale queues eBay quantity update");
  res = await call(ctl.sellInStore, { params: { id: String(D1._id) }, body: { quantity: 1, requestId: reqId } });
  ok(res.statusCode === 200 && res.body.alreadyProcessed && (await get(D1._id)).quantityAvailable === 1, "double-click (same requestId) → sold once");
  res = await call(ctl.sellInStore, { params: { id: String(D1._id) }, body: { quantity: 2, requestId: rid() } });
  ok(res.statusCode === 409 && (await get(D1._id)).quantityAvailable === 1, "selling more than in stock → 409, unchanged");
  res = await call(ctl.sellInStore, { params: { id: String(D1._id) }, body: { quantity: 1 } });
  ok(res.statusCode === 400, "sale without requestId → 400");

  // mocked eBay
  const calls = [];
  let restBehaviour = "ok";
  const fakeClient = {
    post: async (token, endpoint, body) => {
      calls.push({ api: "rest", endpoint, body });
      if (restBehaviour === "timeout") { const e = new Error("timeout of 30000ms exceeded"); throw e; }
      if (restBehaviour === "ratelimit") { const e = new Error("rate limited"); e.name = "EbayRateLimitError"; e.statusCode = 429; throw e; }
      if (restBehaviour === "reject") return { responses: [{ statusCode: 400, errors: [{ message: "Offer not published" }] }] };
      return { responses: [{ statusCode: 200, sku: body.requests[0].sku }] };
    },
  };
  const fakeTrading = {
    call: async (token, name, xml) => { calls.push({ api: "trading", name, xml }); return { ReviseInventoryStatusResponse: { Ack: "Success" } }; },
    endFixedPriceItem: async (token, xml) => { calls.push({ api: "trading", name: "EndFixedPriceItem", xml }); return { EndFixedPriceItemResponse: { Ack: "Success" } }; },
  };
  let account = { accessToken: "tok" };
  qsync._deps.getClient = () => fakeClient;
  qsync._deps.getTradingClient = () => fakeTrading;
  qsync._deps.getAccount = async () => account;

  let q = await qsync.processQueue();
  d = await get(D1._id);
  const restCall = calls.find((c) => c.api === "rest" && c.body.requests[0].offers[0].offerId === "OFD1");
  ok(restCall && restCall.body.requests[0].shipToLocationAvailability.quantity === 1 && d.ebayQuantitySync.status === "synced" && d.ebayQuantitySync.syncedQuantity === 1, "REST listing: eBay quantity set to CRM quantity (1) → synced", { q, sync: d.ebayQuantitySync });

  const T1 = await mk({ ebayListingId: "110099887766", quantityAvailable: 1 });
  await call(ctl.sellInStore, { params: { id: String(T1._id) }, body: { quantity: 1, requestId: rid() } });
  await qsync.processQueue();
  ok(calls.some((c) => c.name === "EndFixedPriceItem" && c.xml.includes("110099887766")) && (await get(T1._id)).ebayQuantitySync.status === "synced", "Trading listing sold out → EndFixedPriceItem");
  await call(ctl.adjustStock, { params: { id: String(T1._id) }, body: { delta: 2, reason: "found 2 more", requestId: rid() } });
  await qsync.processQueue();
  ok(calls.some((c) => c.name === "ReviseInventoryStatus" && c.xml.includes("<Quantity>2</Quantity>")), "Trading listing restocked → ReviseInventoryStatus quantity 2");

  const F1 = await mk({ ebayOfferId: "OFF1", ebayListingId: "F1L", quantityAvailable: 3 });
  await call(ctl.sellInStore, { params: { id: String(F1._id) }, body: { quantity: 1, requestId: rid() } });
  restBehaviour = "timeout";
  await qsync.processQueue();
  d = await get(F1._id);
  ok(d.ebayQuantitySync.status === "failed" && d.ebayQuantitySync.attempts === 1 && new Date(d.ebayQuantitySync.nextAttemptAt) > new Date(), "eBay API timeout → failed, retry scheduled with backoff", d.ebayQuantitySync);
  q = await qsync.processQueue();
  ok(q.processed === 0, "not retried before its backoff time");
  await Inventory.updateOne({ _id: F1._id }, { $set: { "ebayQuantitySync.nextAttemptAt": new Date(0) } });
  restBehaviour = "ratelimit";
  await qsync.processQueue();
  d = await get(F1._id);
  ok(d.ebayQuantitySync.status === "failed" && d.ebayQuantitySync.attempts === 2, "rate limit → transient failure, retried later");
  await Inventory.updateOne({ _id: F1._id }, { $set: { "ebayQuantitySync.nextAttemptAt": new Date(0) } });
  restBehaviour = "ok";
  await qsync.processQueue();
  d = await get(F1._id);
  ok(d.ebayQuantitySync.status === "synced" && d.ebayQuantitySync.syncedQuantity === 2, "recovery after failures → synced with current quantity (2)");

  const F2 = await mk({ ebayOfferId: "OFF2", ebayListingId: "F2L" });
  await call(ctl.adjustStock, { params: { id: String(F2._id) }, body: { delta: 1, reason: "count", requestId: rid() } });
  account = null;
  await qsync.processQueue();
  d = await get(F2._id);
  ok(d.ebayQuantitySync.status === "pending" && d.ebayQuantitySync.attempts === 0 && /not connected|expired/.test(d.ebayQuantitySync.lastError), "OAuth token expired / not connected → waits, no attempt burned", d.ebayQuantitySync);
  account = { accessToken: "tok" };
  await Inventory.updateOne({ _id: F2._id }, { $set: { "ebayQuantitySync.nextAttemptAt": new Date(0) } });
  restBehaviour = "reject";
  await qsync.processQueue();
  d = await get(F2._id);
  ok(d.ebayQuantitySync.status === "dead" && /Offer not published/.test(d.ebayQuantitySync.lastError), "permanent eBay rejection → dead (no endless retries)", d.ebayQuantitySync);
  restBehaviour = "ok";
  res = await call(ctl.retryEbaySync, { params: { id: String(F2._id) } });
  await qsync.processQueue();
  ok(res.statusCode === 200 && (await get(F2._id)).ebayQuantitySync.status === "synced", "staff Retry → synced");

  const F3 = await mk({ ebayOfferId: "OFF3", ebayListingId: "F3L" });
  await call(ctl.adjustStock, { params: { id: String(F3._id) }, body: { delta: 1, reason: "count", requestId: rid() } });
  restBehaviour = "timeout";
  for (let i = 0; i < qsync.MAX_ATTEMPTS; i += 1) {
    await Inventory.updateOne({ _id: F3._id }, { $set: { "ebayQuantitySync.nextAttemptAt": new Date(0) } });
    await qsync.processQueue();
  }
  d = await get(F3._id);
  ok(d.ebayQuantitySync.status === "dead" && d.ebayQuantitySync.attempts === qsync.MAX_ATTEMPTS, `gives up after ${qsync.MAX_ATTEMPTS} attempts → dead`, d.ebayQuantitySync);
  restBehaviour = "ok";

  const W1 = await mk({ ebayOfferId: "OFW1", ebayListingId: "W1L", wixProductId: "wix-W1" });
  await sales.applyWixOrder({ id: "wix-o1", number: "5001", status: "APPROVED", lineItems: [{ id: "wl", quantity: 1, catalogReference: { catalogItemId: "wix-W1" }, price: { amount: "20" } }] });
  d = await get(W1._id);
  ok(d.quantityAvailable === 0 && d.ebayQuantitySync?.status === "pending", "Wix sale → CRM 0 and eBay listing queued to 0 (cross-channel)");

  const N1 = await mk({});
  await call(ctl.sellInStore, { params: { id: String(N1._id) }, body: { quantity: 1, requestId: rid() } });
  ok(!(await get(N1._id)).ebayQuantitySync, "part not on eBay → nothing queued");

  // ── Webhooks ─────────────────────────────────────────────────────────────
  section("WEBHOOKS — signature, idempotency, processing");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pemOneLine = publicKey.export({ type: "spki", format: "pem" }).toString().replace(/\n/g, "");
  notif._deps.fetchPublicKey = async () => ({ key: pemOneLine, digest: "SHA1" });
  const sign = (raw) => {
    const s2 = crypto.createSign("sha1");
    s2.update(raw);
    return Buffer.from(JSON.stringify({ alg: "ECDSA", kid: "kid-1", signature: s2.sign(privateKey, "base64"), digest: "SHA1" })).toString("base64");
  };
  const WH = await mk({ ebayListingId: "WH-L" });
  const body = { metadata: { topic: "ORDER_CONFIRMATION", schemaVersion: "1.0" }, notification: { notificationId: "N-1", data: { order: { orderId: "WH-ORDER", orderLineItems: [{ orderLineItemId: "L1", listingId: "WH-L", quantity: 1 }] } } } };
  const raw = Buffer.from(JSON.stringify(body));
  let w = await notif.receive({ signature: sign(raw), rawBody: raw, body });
  ok(w.status === 204 && w.stored, "valid signed notification → stored, 204");
  w = await notif.receive({ signature: sign(raw), rawBody: raw, body });
  ok(w.status === 204 && w.duplicate && (await MarketplaceEvent.countDocuments({ eventId: "N-1" })) === 1, "re-delivered notification → stored once");
  const tampered = Buffer.from(JSON.stringify({ ...body, notification: { ...body.notification, notificationId: "N-X" } }));
  w = await notif.receive({ signature: sign(raw), rawBody: tampered, body: JSON.parse(tampered) });
  ok(w.status === 412 && !(await MarketplaceEvent.exists({ eventId: "N-X" })), "tampered body / bad signature → 412, nothing stored");
  w = await notif.receive({ signature: undefined, rawBody: raw, body });
  ok(w.status === 412, "missing signature header → 412");
  const otherBody = { metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { notificationId: "N-2", data: {} } };
  const otherRaw = Buffer.from(JSON.stringify(otherBody));
  w = await notif.receive({ signature: sign(otherRaw), rawBody: otherRaw, body: otherBody });
  ok(w.status === 204 && (await MarketplaceEvent.findOne({ eventId: "N-2" })).status === "ignored", "unrelated topic → stored as ignored");
  const sim = Buffer.from(JSON.stringify({ ...body, notification: { ...body.notification, notificationId: "N-SIM" } }));
  const simSig = sign(sim);
  await Promise.all(Array.from({ length: 5 }, () => notif.receive({ signature: simSig, rawBody: sim, body: JSON.parse(sim) })));
  ok((await MarketplaceEvent.countDocuments({ eventId: "N-SIM" })) === 1, "5 simultaneous identical deliveries → 1 event");

  // processing (authoritative order fetch, mocked)
  const realClient = ebayAdapter.client;
  let fetchFail = false;
  ebayAdapter.client = {
    get: async (token, url) => {
      if (fetchFail) { const e = new Error("eBay 503"); e.statusCode = 503; throw e; }
      const id = decodeURIComponent(url.split("/").pop());
      return ebayOrder(WH, { orderId: id });
    },
    getShippingFulfillments: async () => ({ fulfillments: [] }),
    getBaseUrl: () => "https://api.sandbox.ebay.com",
  };
  notif._deps.getAccount = async () => ({ accessToken: "tok" });
  let pe = await notif.processEvents();
  d = await get(WH._id);
  const ev = await MarketplaceEvent.findOne({ eventId: "N-1" }).lean();
  ok(ev.status === "done" && d.quantityAvailable === 0 && d.sale.orderId === "WH-ORDER", "webhook → authoritative order fetched → CRM stock 1 → 0", { ev: ev.status, err: ev.lastError, q: d.quantityAvailable, pe });
  ok((await req("models/Order.model").countDocuments({ orderId: "WH-ORDER" })) === 1, "order also saved to the CRM Orders page");
  const simEv = await MarketplaceEvent.findOne({ eventId: "N-SIM" }).lean();
  ok(simEv.status === "done" && (await get(WH._id)).quantityAvailable === 0, "second notification for the same order → no double deduction");

  await MarketplaceEvent.create({ channel: "ebay", eventId: "N-FAIL", topic: "ORDER_CONFIRMATION", orderId: "FAIL-1", status: "received" });
  fetchFail = true;
  await notif.processEvents();
  let fe = await MarketplaceEvent.findOne({ eventId: "N-FAIL" }).lean();
  ok(fe.status === "failed" && fe.attempts === 1 && new Date(fe.nextAttemptAt) > new Date(), "eBay down while processing → failed, retried later");
  for (let i = 0; i < notif.MAX_ATTEMPTS; i += 1) {
    await MarketplaceEvent.updateOne({ eventId: "N-FAIL" }, { $set: { nextAttemptAt: new Date(0) } });
    await notif.processEvents();
  }
  fe = await MarketplaceEvent.findOne({ eventId: "N-FAIL" }).lean();
  ok(fe.status === "dead", "event gives up after max attempts → dead", fe.status);
  fetchFail = false;
  res = await call(ctl.retryEvent, { params: { id: String(fe._id) } });
  await notif.processEvents();
  ok(res.statusCode === 200 && (await MarketplaceEvent.findOne({ eventId: "N-FAIL" })).status === "done", "staff Retry → processed");
  ebayAdapter.client = realClient;

  ok(notif.challengeResponse("abc") === null, "challenge without config → not answered (no guessing)");
  process.env.EBAY_NOTIFICATION_ENDPOINT_URL = "https://example.test/api/integrations/ebay/notifications";
  process.env.EBAY_NOTIFICATION_VERIFICATION_TOKEN = "x".repeat(40);
  const expect = crypto.createHash("sha256").update("abc").update("x".repeat(40)).update(process.env.EBAY_NOTIFICATION_ENDPOINT_URL).digest("hex");
  ok(notif.challengeResponse("abc") === expect, "destination challenge hash = sha256(code + token + endpoint)");

  // ── Sale/cancellation race ───────────────────────────────────────────────
  section("E. Concurrency: sale and cancellation close together");
  const E1 = await mk({});
  const eo = ebayOrder(E1, { orderId: "E-1" });
  await Promise.all([sales.applyEbayOrder(eo, null), sales.applyEbayOrder({ ...eo, cancelStatus: { cancelState: "CANCELED" } }, null)]);
  await sales.applyEbayOrder({ ...eo, cancelStatus: { cancelState: "CANCELED" } }, null);
  d = await get(E1._id);
  ok(d.quantityAvailable === 1, "sale + cancellation racing, then final state cancelled → stock ends at 1 (never 2, never 0)", d.quantityAvailable);

  // ── Reconciliation ───────────────────────────────────────────────────────
  section("RECONCILIATION (report only)");
  const X1 = await mk({ ebayListingId: "X1", ebaySyncStatus: "PUBLISHED", quantityAvailable: 2 });
  const X2 = await mk({ ebayListingId: "X2", ebaySyncStatus: "PUBLISHED", quantityAvailable: 0, saleStatus: "sold" });
  const X3 = await mk({ ebayListingId: "X3", ebaySyncStatus: "PUBLISHED", quantityAvailable: 1 });
  await MarketplaceListing.collection.insertMany([
    { marketplace: "ebay", marketplaceOrderId: "LISTING-X1", marketplaceListingId: "X1", quantity: 1, listingStatus: "Active" },
    { marketplace: "ebay", marketplaceOrderId: "LISTING-X2", marketplaceListingId: "X2", quantity: 1, listingStatus: "Active" },
  ]);
  const before = (await get(X1._id)).quantityAvailable;
  const rep = await recon.runReconciliation();
  ok(rep.issues.quantity_mismatch.some((i) => String(i.inventoryId) === String(X1._id) && i.ebayQuantity === 1 && i.crmQuantity === 2), "quantity mismatch detected (CRM 2 vs eBay 1)");
  ok(rep.issues.unavailable_but_listed.some((i) => String(i.inventoryId) === String(X2._id)), "sold in CRM but still listed on eBay detected");
  ok(rep.issues.missing_listing.some((i) => String(i.inventoryId) === String(X3._id)), "published in CRM but missing on eBay detected");
  ok(rep.counts.failed_quantity_sync >= 1 && rep.counts.sold_twice >= 0, "failed eBay syncs included", rep.counts);
  ok((await get(X1._id)).quantityAvailable === before, "reconciliation never overwrites CRM stock");

  // ── Real-time ────────────────────────────────────────────────────────────
  section("REAL-TIME");
  const emitted = [];
  req("utils/realtime").setIO({ emit: (ev, p) => emitted.push(`${ev}:${p.scope}`) });
  const RT = await mk({});
  await call(ctl.sellInStore, { params: { id: String(RT._id) }, body: { quantity: 1, requestId: rid() } });
  ok(emitted.includes("cache:invalidate:inventory") && emitted.includes("cache:invalidate:soldProducts"), "stock change pushes live refresh to CRM pages", emitted);

  console.log(`\n${passes} passed, ${failures} failed`);
    await mongoose.disconnect();
  await mem.stop();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("TEST CRASHED:", e);
  process.exit(2);
});
