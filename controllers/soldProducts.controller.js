/**
 * Sold Products — parts sold on eBay or Wix (read side of
 * services/marketplaceSales.service.js).
 *
 *   GET  /api/sold-products          list (filters: channel, search, dateFrom, dateTo, conflicts)
 *   GET  /api/sold-products/summary  counts per channel + last sync per channel
 *   POST /api/sold-products/sync     run the eBay + Wix sold-status sync now
 *   GET  /api/sold-products/:id      one sold part with full order details
 */
const mongoose = require("mongoose");
const Inventory = require("../models/Inventory.model");
const MarketplaceSaleSync = require("../models/MarketplaceSaleSync.model");
const startMarketplaceSalesSyncJob = require("../jobs/marketplaceSalesSyncJob");

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LISTED_ON_EBAY = ["PUBLISHED", "UPDATED"];

/**
 * The other channel may still be offering a part that already sold
 * (sold on Wix but its eBay listing is live, or sold on eBay while it also
 * has a Wix product). The CRM doesn't end listings itself, so staff check.
 */
function otherChannelListing(part) {
  const channel = part.sale?.channel;
  if (channel === "wix" && part.ebayListingId && LISTED_ON_EBAY.includes(part.ebaySyncStatus)) {
    return { channel: "ebay", listingId: part.ebayListingId };
  }
  if (channel === "ebay" && part.wixProductId) {
    return { channel: "wix", listingId: part.wixProductId };
  }
  return null;
}

function toRow(part) {
  return {
    _id: part._id,
    partName: part.partName,
    vin: part.vin,
    sku: part.sku,
    year: part.year,
    make: part.make ? { _id: part.make._id, name: part.make.name } : null,
    model: part.model ? { _id: part.model._id, name: part.model.name } : null,
    trim: part.trim ? { _id: part.trim._id, name: part.trim.name } : null,
    category: part.category,
    location: part.location,
    quality: part.quality,
    image: part.image,
    crmPrice: part.price,
    isDeleted: Boolean(part.isDeleted),
    ebayListingId: part.ebayListingId || null,
    wixProductId: part.wixProductId || null,
    sale: part.sale || null,
    saleConflicts: part.saleConflicts || [],
    alsoListedOn: otherChannelListing(part),
    quantityAvailable: part.quantityAvailable ?? (part.saleStatus === "sold" ? 0 : 1),
    quantitySold: part.quantitySold ?? 0,
    returnInfo: part.returnInfo || null,
    ebayQuantitySync: part.ebayQuantitySync || null,
  };
}

function buildFilter(query) {
  const filter = { saleStatus: "sold" };
  if (["ebay", "wix", "crm"].includes(query.channel)) filter["sale.channel"] = query.channel;
  if (query.conflicts === "true") filter["saleConflicts.0"] = { $exists: true };

  const range = {};
  if (query.dateFrom) {
    const d = new Date(query.dateFrom);
    if (!Number.isNaN(d.getTime())) range.$gte = d;
  }
  if (query.dateTo) {
    const d = new Date(query.dateTo);
    if (!Number.isNaN(d.getTime())) range.$lte = d;
  }
  if (Object.keys(range).length) filter["sale.soldAt"] = range;

  const search = String(query.search || "").trim();
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: "i" };
    filter.$or = [
      { partName: rx },
      { vin: rx },
      { sku: rx },
      { "sale.orderNumber": rx },
      { "sale.orderId": rx },
      { "sale.buyerName": rx },
      { "sale.buyerEmail": rx },
      { "sale.buyerUsername": rx },
      { "sale.listingTitle": rx },
      { "sale.listingId": rx },
    ];
  }
  return filter;
}

exports.list = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const filter = buildFilter(req.query);

    const [items, total] = await Promise.all([
      Inventory.find(filter)
        .populate("make", "name")
        .populate("model", "name")
        .populate("trim", "name")
        .sort({ "sale.soldAt": -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Inventory.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: items.map(toRow),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
    });
  } catch (err) {
    console.error("[SOLD PRODUCTS] list error:", err);
    res.status(500).json({ success: false, message: "Server error while loading sold products" });
  }
};

exports.summary = async (req, res) => {
  try {
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [byChannel, last30, conflicts, syncs] = await Promise.all([
      Inventory.aggregate([
        { $match: { saleStatus: "sold" } },
        { $group: { _id: "$sale.channel", count: { $sum: 1 }, revenue: { $sum: { $ifNull: ["$sale.price", 0] } } } },
      ]),
      Inventory.countDocuments({ saleStatus: "sold", "sale.soldAt": { $gte: since30 } }),
      Inventory.countDocuments({ saleStatus: "sold", "saleConflicts.0": { $exists: true } }),
      MarketplaceSaleSync.find({}).lean(),
    ]);

    const channel = (name) => {
      const row = byChannel.find((r) => r._id === name);
      return { count: row ? row.count : 0, revenue: row ? Math.round(row.revenue * 100) / 100 : 0 };
    };
    const sync = (name) => {
      const s = syncs.find((x) => x._id === name);
      return s
        ? {
            lastRunAt: s.lastRunAt,
            lastSuccessAt: s.lastSuccessAt,
            lastStatus: s.lastStatus,
            lastError: s.lastError,
            lastSummary: s.lastSummary,
            unmatched: s.unmatched || [],
          }
        : null;
    };

    const ebay = channel("ebay");
    const crm = channel("crm"); // sold in store
    const wix = channel("wix");
    res.json({
      success: true,
      data: {
        total: ebay.count + wix.count + crm.count,
        ebay,
        wix,
        crm,
        last30Days: last30,
        conflicts,
        sync: { ebay: sync("ebay"), wix: sync("wix") },
      },
    });
  } catch (err) {
    console.error("[SOLD PRODUCTS] summary error:", err);
    res.status(500).json({ success: false, message: "Server error while loading the sold summary" });
  }
};

exports.syncNow = async (req, res) => {
  try {
    const outcome = await startMarketplaceSalesSyncJob.runNow(`manual:${req.user?._id || "unknown"}`);
    if (!outcome.ran) return res.status(409).json({ success: false, message: outcome.reason });
    res.json({ success: true, data: outcome.result });
  } catch (err) {
    console.error("[SOLD PRODUCTS] sync error:", err);
    res.status(500).json({ success: false, message: err.message || "Sync failed" });
  }
};

exports.getOne = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid id" });

    const part = await Inventory.findById(id)
      .populate("make", "name")
      .populate("model", "name")
      .populate("trim", "name")
      .populate("sale.orderRef", "orderId legacyOrderId total currency status paymentStatus shippingStatus trackingNumber carrier trackingUrl items createdAtEbay")
      .lean();
    if (!part) return res.status(404).json({ success: false, message: "Part not found" });

    res.json({ success: true, data: { ...toRow(part), saleStatus: part.saleStatus || "available" } });
  } catch (err) {
    console.error("[SOLD PRODUCTS] detail error:", err);
    res.status(500).json({ success: false, message: "Server error while loading the part" });
  }
};
