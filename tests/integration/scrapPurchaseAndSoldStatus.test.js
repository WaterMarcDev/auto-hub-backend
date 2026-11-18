// End-to-end test of the Scrap Purchase → Element Hub integration and the
// eBay/Wix sold-status sync, run against an in-memory MongoDB.
// Usage: node e2e.js <backend dir>
const path = require("path");
const { MongoMemoryServer } = require("mongodb-memory-server");

const BACKEND = path.resolve(process.argv[2] || path.join(__dirname, "..", ".."));
const req = (p) => require(path.join(BACKEND, p));
const mongoose = require(path.join(BACKEND, "node_modules", "mongoose"));
const axios = require(path.join(BACKEND, "node_modules", "axios"));

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log("  PASS", label);
  else {
    failures += 1;
    console.log("  FAIL", label, extra !== undefined ? JSON.stringify(extra) : "");
  }
};
const mockRes = () => {
  const r = { statusCode: 200, body: undefined };
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (b) => ((r.body = b), r);
  r.send = (b) => ((r.body = b), r);
  return r;
};
const call = async (fn, reqObj) => {
  const res = mockRes();
  await fn({ params: {}, query: {}, body: {}, user: { _id: new mongoose.Types.ObjectId() }, ...reqObj }, res);
  return res;
};

(async () => {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  const ElementHub = req("models/ElementHub.model");
  const ElementHubHistory = req("models/ElementHubHistory.model");
  const Element = req("models/Element.model");
  const ScrapPurchase = req("models/ScrapPurchase.model");
  const Inventory = req("models/Inventory.model");
  const IntegrationAccount = req("models/IntegrationAccount.model");
  const Order = req("models/Order.model");
  const spc = req("controllers/scrapPurchase.controller");
  const { addToHubInternal } = req("controllers/elementHub.controller");
  await Promise.all([ElementHub.init(), Inventory.init(), ScrapPurchase.init()]);

  const weight = async (name) => {
    const h = await ElementHub.findOne({ elementName: name }).lean();
    return h ? h.totalWeight : null;
  };

  // ── PART 1: Scrap Purchase → Element Hub ─────────────────────────────────
  console.log("\nPART 1 — Scrap Purchase → Element Hub");
  const alu = await Element.create({ name: "Aluminium" });
  const cu = await Element.create({ name: "Copper" });
  await addToHubInternal({ elementName: "Aluminium", elementId: alu._id, amount: 100, sourceVin: "VIN1", createdBy: undefined });
  ok((await weight("Aluminium")) === 100, "car extraction still adds stock (unchanged path)");

  let r = await call(spc.createScrapPurchase, {
    body: {
      items: [
        { materialName: "Aluminum", weightLbs: 10, pricePerLb: 1 },
        { materialName: "Copper", weightLbs: 5.5, pricePerLb: 3 },
        { materialName: "Steel", weightLbs: "", pricePerLb: "", totalAmount: 20 },
      ],
    },
  });
  ok(r.statusCode === 201, "create purchase → 201", r.body);
  const pid = r.body._id;
  ok((await weight("Aluminium")) === 110, '"Aluminum" lands on existing "Aluminium" row (100 + 10)', await weight("Aluminium"));
  ok((await ElementHub.countDocuments({ elementName: /^aluminum$/i })) === 0, 'no separate "Aluminum" row created');
  ok((await weight("Copper")) === 5.5, "new Copper row created with 5.5 lb");
  ok(String((await ElementHub.findOne({ elementName: "Copper" })).elementId) === String(cu._id), "new hub row linked to Element master");
  ok((await weight("Steel")) === null, "weightless line (total only) adds no stock");
  let p = await ScrapPurchase.findById(pid).lean();
  ok(p.elementHubPosted.length === 2 && p.elementHubError === null, "purchase records what it posted", p.elementHubPosted);
  let hist = await ElementHubHistory.find({ scrapPurchaseId: pid }).lean();
  ok(hist.length === 2 && hist.every((h) => h.type === "add" && h.source === "scrap-purchase" && /SP-0000001/.test(h.note)), "2 'add' history rows tagged with the bill", hist.map((h) => h.note));
  ok(r.body.elementHubPosted && r.body.elementHubPosted.length === 2, "API response includes posted stock");

  r = await call(spc.updateScrapPurchase, {
    params: { id: pid },
    body: { items: [{ materialName: "aluminium", weightLbs: 4, pricePerLb: 1 }, { materialName: "Brass", weightLbs: 2, pricePerLb: 2 }] },
  });
  ok(r.statusCode === 200, "edit purchase → 200", r.body);
  ok((await weight("Aluminium")) === 104, "edit applies only the difference (110 - 6)", await weight("Aluminium"));
  ok((await weight("Copper")) === 0, "removed line takes its stock back out");
  ok((await weight("Brass")) === 2, "new line adds its stock");
  hist = await ElementHubHistory.find({ scrapPurchaseId: pid }).sort({ createdAt: 1 }).lean();
  ok(hist.filter((h) => h.type === "adjust").length === 2, "reductions logged as 'adjust' rows", hist.map((h) => [h.type, h.elementName, h.amount]));

  r = await call(spc.updateScrapPurchase, { params: { id: pid }, body: { note: "just a note" } });
  ok(r.statusCode === 200 && (await weight("Aluminium")) === 104 && (await weight("Brass")) === 2, "edit without line changes leaves stock alone");

  await ElementHub.updateOne({ elementName: "Brass" }, { $inc: { totalWeight: -2 } }); // Brass sold from the hub
  r = await call(spc.deleteScrapPurchase, { params: { id: pid } });
  ok(r.statusCode === 409, "delete refused when its stock was already sold (409)", r.body);
  ok((await weight("Aluminium")) === 104 && (await weight("Brass")) === 0, "refused delete changed nothing (rolled back)");
  ok(!(await ScrapPurchase.findById(pid)).isDeleted, "purchase still active after refused delete");

  r = await call(spc.updateScrapPurchase, { params: { id: pid }, body: { items: [{ materialName: "Aluminium", weightLbs: 4 }, { materialName: "Brass", weightLbs: 1 }] } });
  ok(r.statusCode === 409, "edit reducing already-sold stock refused (409)", r.body);
  ok((await weight("Aluminium")) === 104, "refused edit changed nothing");

  await ElementHub.updateOne({ elementName: "Brass" }, { $inc: { totalWeight: 2 } });
  r = await call(spc.deleteScrapPurchase, { params: { id: pid } });
  ok(r.statusCode === 200, "delete → 200 when stock is available", r.body);
  ok((await weight("Aluminium")) === 100 && (await weight("Brass")) === 0, "delete takes all purchase stock back out");
  p = await ScrapPurchase.findById(pid).lean();
  ok(p.isDeleted && p.elementHubPosted.length === 0, "purchase soft-deleted, nothing posted");
  r = await call(spc.deleteScrapPurchase, { params: { id: pid } });
  ok(r.statusCode === 200 && (await weight("Aluminium")) === 100, "deleting again is harmless (old behaviour)");

  // Legacy purchase (created before the integration): edits/deletes must not touch the hub
  const legacy = await ScrapPurchase.create({ items: [{ materialName: "Aluminium", weightLbs: 50 }] });
  ok((await ScrapPurchase.findById(legacy._id).lean()).elementHubPosted === undefined, "legacy purchase has no postings");
  r = await call(spc.updateScrapPurchase, { params: { id: legacy._id }, body: { items: [{ materialName: "Aluminium", weightLbs: 70 }] } });
  ok(r.statusCode === 200 && (await weight("Aluminium")) === 100, "legacy edit leaves hub alone");
  r = await call(spc.deleteScrapPurchase, { params: { id: legacy._id } });
  ok(r.statusCode === 200 && (await weight("Aluminium")) === 100, "legacy delete leaves hub alone");

  // Single-material (no items[]) purchase
  r = await call(spc.createScrapPurchase, { body: { materialName: "ALUMINUM", weightLbs: 7, pricePerLb: 1 } });
  ok(r.statusCode === 201 && (await weight("Aluminium")) === 107, "single-material purchase adds stock (ALUMINUM → Aluminium)");

  r = await call(spc.createScrapPurchase, { body: { items: [{ materialName: "Copper", weightLbs: -1 }] } });
  ok(r.statusCode === 400, "validation still rejects bad input before any stock move");

  // ── PART 2: eBay / Wix sold status ───────────────────────────────────────
  console.log("\nPART 2 — eBay / Wix sold status");
  const sales = req("services/marketplaceSales.service");
  const Make = req("models/Make.model");
  const CarModel = req("models/CarModel.model");
  const Trim = req("models/Trim.model");
  const oid = () => new mongoose.Types.ObjectId();
  const refs = { make: oid(), model: oid(), trim: oid() };
  await Make.collection.insertOne({ _id: refs.make, name: "BMW" });
  await CarModel.collection.insertOne({ _id: refs.model, name: "X5" });
  await Trim.collection.insertOne({ _id: refs.trim, name: "xDrive35i" });
  const mk = (o) => Inventory.create({ partName: "part", unit: "1", year: 2015, ...refs, vin: `V${Math.random()}`, ...o });
  const P1 = await mk({ partName: "frontBumper", ebayListingId: "111", ebaySyncStatus: "PUBLISHED", wixProductId: "wpX", price: 100 });
  const P2 = await mk({ partName: "hood", ebayListingId: "222", ebaySyncStatus: "PUBLISHED" });
  const P3 = await mk({ partName: "door", wixProductId: "wp2" });
  const P4 = await mk({ partName: "door2", wixProductId: "wp2" });
  const P5 = await mk({ partName: "mirror", wixProductId: "wp5" });

  const ebayOrder = (over = {}) => ({
    orderId: "12-34567-89012",
    legacyOrderId: "12-34567-89012",
    creationDate: "2026-11-01T10:00:00.000Z",
    orderFulfillmentStatus: "NOT_STARTED",
    orderPaymentStatus: "PAID",
    buyer: { username: "buyer_joe" },
    pricingSummary: { total: { value: "120.00", currency: "USD" } },
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: "Joe Buyer", email: "joe@example.com", primaryPhone: { phoneNumber: "5551234" }, contactAddress: { addressLine1: "1 Main St", city: "Newark", stateOrProvince: "NJ", postalCode: "07102", countryCode: "US" } } } }],
    lineItems: [{ lineItemId: "L1", sku: String(P1._id), legacyItemId: "111", title: "Front Bumper", quantity: 1, lineItemCost: { value: "110.00", currency: "USD" } }],
    ...over,
  });

  let res1 = await sales.applyEbayOrder(ebayOrder(), null);
  let d = await Inventory.findById(P1._id).lean();
  ok(res1.sold === 1 && d.saleStatus === "sold", "eBay line (SKU = Inventory _id) marks part sold");
  ok(d.sale.channel === "ebay" && d.sale.orderNumber === "12-34567-89012" && d.sale.price === 110 && d.sale.buyerName === "Joe Buyer" && d.sale.shippingAddress.city === "Newark" && d.sale.paymentStatus, "full sale details stored", d.sale);
  const firstRecorded = d.sale.recordedAt;
  res1 = await sales.applyEbayOrder(ebayOrder({ orderFulfillmentStatus: "FULFILLED" }), { trackingNumber: "1Z999", carrier: "UPS" });
  d = await Inventory.findById(P1._id).lean();
  ok(res1.refreshed === 1 && res1.sold === 0 && !d.saleConflicts, "same order again → refreshed, not double-counted");
  ok(d.sale.trackingNumber === "1Z999" && String(d.sale.recordedAt) === String(firstRecorded), "refresh updates tracking, keeps recordedAt");

  res1 = await sales.applyEbayOrder(ebayOrder({ orderId: "99-1", legacyOrderId: "99-1", lineItems: [{ lineItemId: "L9", sku: "SOMETHING-ELSE", legacyItemId: "222", title: "Hood", quantity: 1, lineItemCost: { value: "50" } }] }), null);
  ok(res1.sold === 1 && (await Inventory.findById(P2._id).lean()).saleStatus === "sold", "fallback match by eBay item id → ebayListingId");

  res1 = await sales.applyEbayOrder(ebayOrder({ orderId: "77-7", legacyOrderId: "77-7", lineItems: [{ lineItemId: "L7", sku: "NOPE", legacyItemId: "000", title: "Unknown", quantity: 1 }] }), null);
  ok(res1.unmatched.length === 1 && res1.sold === 0, "unknown eBay line reported as unmatched");

  res1 = await sales.applyEbayOrder(ebayOrder({ orderId: "99-1", cancelStatus: { cancelState: "CANCELED" }, lineItems: [] }), null);
  d = await Inventory.findById(P2._id).lean();
  ok(res1.released === 1 && d.saleStatus === "available" && d.sale === null, "cancelled eBay order puts part back in stock");

  const wixOrder = (over = {}) => ({
    id: "wix-order-1",
    number: "10001",
    status: "APPROVED",
    paymentStatus: "PAID",
    fulfillmentStatus: "NOT_FULFILLED",
    createdDate: "2026-11-02T12:00:00.000Z",
    currency: "USD",
    buyerInfo: { email: "ann@example.com" },
    billingInfo: { contactDetails: { firstName: "Ann", lastName: "Lee", phone: "555" } },
    shippingInfo: { logistics: { shippingDestination: { address: { addressLine1: "2 Oak Ave", city: "Edison", subdivision: "US-NJ", postalCode: "08817", country: "US" }, contactDetails: { firstName: "Ann", lastName: "Lee" } } } },
    lineItems: [{ id: "wl1", quantity: 2, catalogReference: { catalogItemId: "wp2" }, productName: { original: "Door" }, price: { amount: "40.00" } }],
    ...over,
  });
  let w = await sales.applyWixOrder(wixOrder());
  ok(w.sold === 2, "Wix line qty 2 marks both parts of the Wix product sold", w);
  ok((await Inventory.countDocuments({ wixProductId: "wp2", saleStatus: "sold", "sale.orderNumber": "10001", "sale.buyerName": "Ann Lee", "sale.price": 40 })) === 2, "Wix sale details stored");
  w = await sales.applyWixOrder(wixOrder({ fulfillmentStatus: "FULFILLED" }));
  ok(w.sold === 0 && w.refreshed === 2 && (await Inventory.countDocuments({ "sale.shippingStatus": "Fulfilled" })) === 2, "Wix order again → refreshed only");

  w = await sales.applyWixOrder(wixOrder({ id: "wix-order-2", number: "10002", lineItems: [{ id: "wl2", quantity: 1, catalogReference: { catalogItemId: "wpX" }, productName: { original: "Front Bumper" }, price: { amount: "99" } }] }));
  d = await Inventory.findById(P1._id).lean();
  ok(w.conflicts === 1 && d.sale.channel === "ebay" && d.saleConflicts.length === 1 && d.saleConflicts[0].orderNumber === "10002", "part sold on eBay then on Wix → recorded as sold twice", { w, c: d.saleConflicts });
  w = await sales.applyWixOrder(wixOrder({ id: "wix-order-2", number: "10002", lineItems: [{ id: "wl2", quantity: 1, catalogReference: { catalogItemId: "wpX" } }] }));
  ok((await Inventory.findById(P1._id).lean()).saleConflicts.length === 1, "same conflict is recorded only once");

  w = await sales.applyWixOrder(wixOrder({ id: "wix-pending", status: "INITIALIZED", lineItems: [{ id: "x", quantity: 1, catalogReference: { catalogItemId: "wp5" } }] }));
  ok((await Inventory.findById(P5._id).lean()).saleStatus !== "sold", "unfinished Wix checkout (INITIALIZED) is ignored");

  w = await sales.applyWixOrder(wixOrder({ status: "CANCELED" }));
  ok(w.released === 2 && (await Inventory.countDocuments({ wixProductId: "wp2", saleStatus: "sold" })) === 0, "cancelled Wix order puts both parts back in stock");

  // Push pipelines skip sold parts
  const wps = req("services/wixPartSync.service");
  const eligible = await wps.fetchEligibleInventory();
  ok(!eligible.some((e) => String(e._id) === String(P1._id)) && eligible.some((e) => String(e._id) === String(P5._id)), "Wix sync selection skips sold parts, keeps available ones");
  const ebayEligible = await Inventory.find({ isDeleted: { $ne: true }, saleStatus: { $ne: "sold" } }).lean();
  ok(!ebayEligible.some((e) => String(e._id) === String(P1._id)), "eBay catalog-sync query skips sold parts");
  ok(ebayEligible.some((e) => String(e._id) === String(P5._id)), "legacy docs without saleStatus still count as available");

  // ── sync runs with mocked eBay / Wix APIs ────────────────────────────────
  console.log("\nPART 2 — scheduled sync runs (mocked marketplace APIs)");
  process.env.WIX_API_KEY = "k";
  process.env.WIX_SITE_ID = "s";
  const origPost = axios.post;
  let wixCalls = [];
  axios.post = async (url, body) => {
    wixCalls.push(body);
    if (!body.search.cursorPaging.cursor) {
      return { data: { orders: [wixOrder({ id: "wix-order-3", number: "10003", lineItems: [{ id: "wl3", quantity: 1, catalogReference: { catalogItemId: "wp5" }, price: { amount: "15" } }] })], metadata: { hasNext: true, cursors: { next: "CUR2" } } } };
    }
    return { data: { orders: [], metadata: { hasNext: false, cursors: {} } } };
  };
  const wixRun = await sales.syncWixSales();
  axios.post = origPost;
  ok(wixRun.sold === 1 && (await Inventory.findById(P5._id).lean()).saleStatus === "sold", "Wix sync run marks sold", wixRun);
  ok(wixCalls.length === 2 && !wixCalls[1].search.filter && wixCalls[1].search.cursorPaging.cursor === "CUR2", "Wix paging sends cursor without filter on page 2");
  ok(wixCalls[0].search.filter.updatedDate.$gte, "Wix query uses an updatedDate window");

  axios.post = async () => { const e = new Error("Forbidden"); e.response = { status: 403, data: { message: "no permission" } }; throw e; };
  const wixFail = await sales.syncWixSales();
  axios.post = origPost;
  const MarketplaceSaleSync = req("models/MarketplaceSaleSync.model");
  const wixState = await MarketplaceSaleSync.findById("wix").lean();
  ok(wixFail.error && /Read Orders/.test(wixFail.error) && wixState.lastStatus === "failed" && wixState.lastSuccessAt, "Wix permission error reported clearly; last success kept", wixState);

  await IntegrationAccount.create({ platform: "ebay", isActive: true, accessToken: "tok", tokenExpiresAt: new Date(Date.now() + 3600e3) });
  const ebayAdapter = req("services/adapters/ebayAdapter");
  const P6 = await mk({ partName: "tailLight", ebayListingId: "666", ebaySyncStatus: "PUBLISHED" });
  const origGet = ebayAdapter.client.get;
  const origShip = ebayAdapter.client.getShippingFulfillments;
  let ebayParams = null;
  ebayAdapter.client.get = async (token, url, params) => {
    ebayParams = params;
    return { total: 1, orders: [ebayOrder({ orderId: "55-5", legacyOrderId: "55-5", lineItems: [{ lineItemId: "L55", sku: String(P6._id), legacyItemId: "666", title: "Tail Light", quantity: 1, lineItemCost: { value: "35" } }] })] };
  };
  ebayAdapter.client.getShippingFulfillments = async () => ({ fulfillments: [{ shipmentTrackingNumber: "TRK55", shippingCarrierCode: "USPS" }] });
  const ebayRun = await sales.syncEbaySales();
  ebayAdapter.client.get = origGet;
  ebayAdapter.client.getShippingFulfillments = origShip;
  d = await Inventory.findById(P6._id).lean();
  const ord = await Order.findOne({ orderId: "55-5" }).lean();
  ok(ebayRun.sold === 1 && d.saleStatus === "sold", "eBay sync run marks sold", ebayRun);
  ok(ord && String(d.sale.orderRef) === String(ord._id) && d.sale.trackingNumber === "TRK55", "sold part linked to the CRM Order with tracking");
  ok(/^lastmodifieddate:\[.+\.\.\]$/.test(ebayParams.filter), "eBay query uses a lastmodifieddate window", ebayParams);

  // ── Sold Products API + master list ──────────────────────────────────────
  console.log("\nPART 2 — Sold Products API / Master Parts list");
  const spcSold = req("controllers/soldProducts.controller");
  r = await call(spcSold.list, { query: {} });
  ok(r.statusCode === 200 && r.body.data.length === 3, "list returns sold parts", r.body.data && r.body.data.map((x) => x.partName));
  ok(r.body.data[0].partName === "mirror", "newest sale first (Wix sale of Nov 2 before eBay sales of Nov 1)", r.body.data.map((x) => [x.partName, x.sale.soldAt]));
  const bumper = r.body.data.find((x) => x.partName === "frontBumper");
  ok(bumper.alsoListedOn && bumper.alsoListedOn.channel === "wix" && bumper.saleConflicts.length === 1, "row flags other-channel listing + sold twice");
  r = await call(spcSold.list, { query: { channel: "wix" } });
  ok(r.body.data.length === 1 && r.body.data[0].partName === "mirror", "channel filter");
  r = await call(spcSold.list, { query: { search: "joe@example" } });
  ok(r.body.data.length === 2, "search by buyer email");
  r = await call(spcSold.list, { query: { conflicts: "true" } });
  ok(r.body.data.length === 1, "sold-twice filter");
  r = await call(spcSold.summary, {});
  ok(r.body.data.total === 3 && r.body.data.ebay.count === 2 && r.body.data.wix.count === 1 && r.body.data.conflicts === 1 && r.body.data.sync.wix && r.body.data.sync.ebay, "summary counts + sync state", r.body.data);
  r = await call(spcSold.getOne, { params: { id: String(P6._id) } });
  ok(r.body.data.sale.orderRef && r.body.data.sale.orderRef.orderId === "55-5", "detail populates the CRM order");

  const inv = req("controllers/inventory.controller");
  const ml = async (q) => (await call(inv.getPartsMasterList, { query: q })).body;
  const all = await ml({ limit: 100 });
  const avail = await ml({ limit: 100, saleStatus: "available" });
  const sold = await ml({ limit: 100, saleStatus: "sold" });
  ok(all.pagination.total === 6 && avail.pagination.total === 3 && sold.pagination.total === 3, "master list: all / in-stock / sold", [all.pagination.total, avail.pagination.total, sold.pagination.total]);
  ok(sold.parts.every((x) => x.saleStatus === "sold" && x.sale.channel) && avail.parts.every((x) => x.saleStatus === "available"), "master list rows carry sale status");

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL CHECKS PASSED");
  await mongoose.disconnect();
  await mem.stop();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error("TEST CRASHED:", e);
  process.exit(2);
});
