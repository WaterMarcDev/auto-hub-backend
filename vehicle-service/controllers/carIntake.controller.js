const CarIntake = require("../models/CarIntake.model");
const Transaction = require("../models/Transaction.model");
const EntryFee = require("../models/EntryFee.model");
const PaymentSlip = require("../models/PaymentSlip.model");
const xlsx = require("xlsx");
const fs = require("fs");
const path = require("path");

const normalizeImageValue = (val) => {
  if (!val && val !== 0) return undefined;
  if (typeof val === "string") return val;
  if (typeof val === "object") {
    if (val.url) return val.url;
    if (val.filename) return val.filename;
    try { return JSON.stringify(val); } catch { return undefined; }
  }
  return String(val);
};

const computeStatusFrom = (data) => {
  try {
    const enumValues = CarIntake.schema.path("status").enumValues || [];
    if (data?.status && enumValues.includes(data.status)) return data.status;
  } catch {}

  if (data?.payment?.paidAmount != null && data?.payment?.paymentMethod) return "payment-done";
  if (data?.kyc?.seller) return "kyc-uploaded";
  if (data?.price?.finalPrice || data?.price?.ourPrice) return "price-uploaded";
  if (data?.partDetails?.parts && Object.keys(data.partDetails.parts || {}).length > 0) return "parts-uploaded";
  if (data?.imagesStep?.image1) return "images-uploaded";
  if (data?.carDetails?.make || data?.carDetails?.model) return "details-uploaded";
  if (data?.vin) return "vin-fetched";
  return "intake";
};

// POST /api/car-intake
const createCarIntake = async (req, res) => {
  try {
    const formData = req.body;
    formData.vin = String(formData.vin || "").trim().toUpperCase();
    formData.manualVinMode = formData.manualVinMode === true || formData.manualVinMode === "true" || formData.vin.length < 17;

    if (formData.vin) {
      const existing = await CarIntake.findOne({ vin: formData.vin }).populate("createdBy", "first_name last_name email");
      if (existing) return res.status(200).json({ message: "Car intake already exists", carIntake: existing });
    }

    const sellerId = formData.sellerId || formData.seller;
    if (sellerId && !/^[0-9a-fA-F]{24}$/.test(sellerId)) {
      return res.status(400).json({ error: "Invalid seller ObjectId format" });
    }

    const carIntakeData = {
      vin: formData.vin || "",
      vinDetails: formData.vinDetails || {},
      carDetails: {
        year: parseInt(formData.year) || undefined,
        make: formData.make || undefined,
        model: formData.model || undefined,
        trim: formData.trim || undefined,
        color: formData.color || undefined,
        bodyClass: formData.bodyClass || undefined,
        chassisNo: formData.chassisNo || undefined,
        engine: formData.engine || undefined,
        engineVariant: formData.engineVariant || undefined,
        drive: ["2WD","4WD","AWD","FWD"].includes(formData.drive) ? formData.drive : "FWD",
        transmission: ["Automatic","Manual"].includes(formData.transmission) ? formData.transmission : "Automatic",
        fuelType: formData.fuelType || undefined,
        keys: typeof formData.keys === "boolean" ? formData.keys : undefined,
        weight: formData.weight || undefined,
        dimensions: formData.dimensions || undefined,
        description: formData.description || undefined,
        carDetailsUploadedBy: req.user?._id,
      },
      kyc: { seller: sellerId || undefined, sellingDate: formData.sellingDate, pickupType: formData.pickupType, documents: formData.documents || {}, kycDescription: formData.kycDescription, kycUploadedBy: req.user?._id },
      payment: { paymentMethod: formData.paymentMethod, paidAmount: formData.paidAmount != null ? parseFloat(formData.paidAmount) : undefined, paymentDescription: formData.paymentDescription, paymentBy: req.user?._id },
      price: { actualWeight: formData.actualWeight != null ? parseFloat(formData.actualWeight) : undefined, ratePerPound: formData.ratePerPound != null ? parseFloat(formData.ratePerPound) : undefined, actualPrice: formData.actualPrice != null ? parseFloat(formData.actualPrice) : undefined, ourPrice: formData.ourPrice != null ? parseFloat(formData.ourPrice) : undefined, customerPrice: formData.customerPrice != null ? parseFloat(formData.customerPrice) : undefined, finalPrice: formData.finalPrice != null ? parseFloat(formData.finalPrice) : undefined, priceDescription: formData.priceDescription, priceUploadedBy: req.user?._id },
      manualVinMode: formData.manualVinMode,
      createdBy: req.user._id,
    };

    carIntakeData.status = computeStatusFrom(carIntakeData);
    const carIntake = await CarIntake.create(carIntakeData);
    const populated = await CarIntake.findById(carIntake._id).populate("kyc.seller", "firstName lastName email mobileNo").populate("createdBy", "first_name last_name email");
    res.status(201).json({ message: "Car intake created successfully", carIntake: populated });
  } catch (error) {
    console.error("CREATE ERROR:", error.message);
    res.status(400).json({ success: false, error: "Car intake creation failed", details: error.message });
  }
};

// GET /api/car-intake
const getCarIntakes = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const filter = { isActive: true, isDeleted: { $ne: true } };
    if (req.query.status) {
      const statuses = String(req.query.status).split(",").map(s => s.trim()).filter(Boolean);
      filter.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
    }
    if (req.query.search) {
      const re = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ vin: re }, { "carDetails.make": re }, { "carDetails.model": re }, { "carDetails.trim": re }];
    }
    const [carIntakes, total] = await Promise.all([
      CarIntake.find(filter).populate("kyc.seller", "firstName lastName email mobileNo").populate("createdBy", "first_name last_name email").populate("scrapedBy", "first_name last_name email").sort({ updatedAt: -1 }).skip(skip).limit(limit),
      CarIntake.countDocuments(filter),
    ]);
    res.json({ carIntakes, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error("Get car intakes error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/car-intake/:id
const getCarIntake = async (req, res) => {
  try {
    const carIntake = await CarIntake.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).populate("kyc.seller", "firstName lastName email mobileNo signatureImage").populate("createdBy", "first_name last_name email");
    if (!carIntake) return res.status(404).json({ error: "Car intake not found" });
    const transaction = await Transaction.findOne({ carIntake: carIntake._id });
    res.json({ carIntake, transaction });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// PUT /api/car-intake/:id
const updateCarIntake = async (req, res) => {
  try {
    const carIntake = await CarIntake.findById(req.params.id);
    if (!carIntake) return res.status(404).json({ error: "Car intake not found" });

    const data = req.body;
    if (data.sellerId || data.seller) {
      const sid = data.sellerId || data.seller;
      if (!/^[0-9a-fA-F]{24}$/.test(sid)) return res.status(400).json({ error: "Invalid seller ObjectId format" });
      carIntake.kyc = carIntake.kyc || {};
      carIntake.kyc.seller = sid;
    }

    const cdFields = ["year","make","model","trim","color","bodyClass","chassisNo","engine","engineVariant","drive","transmission","fuelType","keys","weight","dimensions","description"];
    carIntake.carDetails = carIntake.carDetails || {};
    cdFields.forEach(f => { if (data[f] !== undefined) { carIntake.carDetails[f] = data[f]; } });

    if (data.parts || data.partsDescription) {
      carIntake.partDetails = carIntake.partDetails || {};
      carIntake.partDetails.parts = data.parts || carIntake.partDetails.parts || {};
      carIntake.partDetails.partsDescription = data.partsDescription || carIntake.partDetails.partsDescription;
    }
    const priceFields = ["actualWeight","ratePerPound","actualPrice","ourPrice","customerPrice","finalPrice","priceDescription"];
    carIntake.price = carIntake.price || {};
    priceFields.forEach(f => { if (data[f] !== undefined) carIntake.price[f] = data[f]; });

    const payFields = ["paymentMethod","paidAmount","paymentDescription"];
    carIntake.payment = carIntake.payment || {};
    payFields.forEach(f => { if (data[f] !== undefined) carIntake.payment[f] = data[f]; });

    if (data.status) {
      const enumValues = CarIntake.schema.path("status").enumValues || [];
      if (enumValues.includes(data.status)) carIntake.status = data.status;
    } else {
      carIntake.status = computeStatusFrom(carIntake.toObject());
    }

    await carIntake.save();
    const updated = await CarIntake.findById(carIntake._id).populate("kyc.seller", "firstName lastName email mobileNo").populate("createdBy", "first_name last_name email");
    res.json({ message: "Car intake updated successfully", carIntake: updated });
  } catch (error) {
    console.error("Update car intake error:", error);
    res.status(500).json({ error: "Server error during update", details: error.message });
  }
};

// DELETE /api/car-intake/:id
const deleteCarIntake = async (req, res) => {
  try {
    const carIntake = await CarIntake.findById(req.params.id);
    if (!carIntake) return res.status(404).json({ error: "Car intake not found" });
    carIntake.isActive = false;
    carIntake.isDeleted = true;
    carIntake.deletedAt = new Date();
    await carIntake.save();
    await Transaction.updateMany({ carIntake: carIntake._id }, { isActive: false, isDeleted: true, deletedAt: new Date() });
    res.json({ message: "Car intake deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// PATCH /api/car-intake/:id/status
const updateCarIntakeStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const enumValues = CarIntake.schema.path("status").enumValues || [];
    if (!enumValues.includes(status)) return res.status(400).json({ error: "Invalid status" });
    const update = { status };
    if (status === "scraped") { update.scrapedBy = req.user?._id; update.scrapDate = new Date(); }
    const carIntake = await CarIntake.findByIdAndUpdate(req.params.id, update, { new: true }).populate("kyc.seller", "firstName lastName").populate("scrapedBy", "first_name last_name email");
    if (!carIntake) return res.status(404).json({ error: "Car intake not found" });
    res.json({ message: "Status updated successfully", carIntake });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// PATCH /api/car-intake/:id/ready-to-scrap
const moveToReadyToScrap = async (req, res) => {
  try {
    const updated = await CarIntake.findByIdAndUpdate(req.params.id, { $set: { status: "ready-to-scrap" } }, { new: true });
    if (!updated) return res.status(404).json({ success: false, message: "Car not found" });
    res.json({ success: true, message: "Car moved to Ready to Scrap", data: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /api/car-intake/:id/move-to-scrapped
const moveToScrapped = async (req, res) => {
  try {
    const { scrapRemarks } = req.body;
    const updated = await CarIntake.findByIdAndUpdate(req.params.id, { status: "scraped", scrapedBy: req.user.id, scrapDate: new Date(), scrapRemarks }, { new: true });
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/car-intake/stats
const getCarIntakeStats = async (req, res) => {
  try {
    const matchStage = { isActive: true };
    if (req.query.startDate) matchStage.createdAt = { ...matchStage.createdAt, $gte: new Date(req.query.startDate) };
    if (req.query.endDate) matchStage.createdAt = { ...matchStage.createdAt, $lte: new Date(req.query.endDate) };
    const stats = await CarIntake.aggregate([{ $match: matchStage }, { $group: { _id: "$status", count: { $sum: 1 }, totalValue: { $sum: "$price.finalPrice" } } }]);
    const totalCount = await CarIntake.countDocuments(matchStage);
    res.json({ stats, summary: { totalCount } });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
};

// GET /api/car-intake/:id/print-payment
const printPaymentSlip = async (req, res) => {
  try {
    const carIntake = await CarIntake.findOne({ _id: req.params.id, isDeleted: { $ne: true } }).populate("kyc.seller", "firstName lastName email mobileNo signatureImage").populate("createdBy", "first_name last_name email");
    if (!carIntake) return res.status(404).send("Car intake not found");

    const transaction = await Transaction.findOne({ carIntake: carIntake._id, isActive: true }).sort({ createdAt: -1 }).populate("createdBy", "first_name last_name email");
    let paymentSlipDoc = await PaymentSlip.findOne({ carIntake: carIntake._id }).sort({ createdAt: -1 }).populate("transaction").populate("createdBy", "first_name last_name email");

    if (!paymentSlipDoc) {
      const netAmount = carIntake.price?.finalPrice || 0;
      const taxRate = transaction?.taxRate || 0.06625;
      const grossAmount = netAmount / (1 - taxRate);
      paymentSlipDoc = await PaymentSlip.create({ carIntake: carIntake._id, transaction: transaction?._id, paymentMethod: transaction?.paymentMethod || carIntake.payment?.paymentMethod, grossAmount: Math.round(grossAmount * 100) / 100, netAmount: Math.round(netAmount * 100) / 100, taxRate, paymentDate: transaction?.createdAt || new Date(), createdBy: req.user?._id });
      paymentSlipDoc = await PaymentSlip.findById(paymentSlipDoc._id).populate("transaction").populate("createdBy", "first_name last_name email");
    }

    let logoDataUri = null;
    try {
      const buf = fs.readFileSync(path.join(__dirname, "..", "assets", "logo-sm1.png"));
      logoDataUri = `data:image/png;base64,${buf.toString("base64")}`;
    } catch {}

    const entryFee = await EntryFee.findOne().sort({ createdAt: -1 });
    return res.render("paymentSlip.njk", { carIntake, transaction, paymentSlip: paymentSlipDoc, slipPadded: paymentSlipDoc?.slipNumber ? String(paymentSlipDoc.slipNumber).padStart(7, "0") : null, generatedAt: new Date(), generatedBy: req.user ? { id: req.user._id, name: req.user.first_name || "" } : null, logoSrc: logoDataUri || "/assets/logo-sm1.png", adjustedEntryFee: entryFee?.entryFee || 2.0 });
  } catch (err) {
    console.error("Print payment slip error:", err);
    res.status(500).json({ error: "Server error rendering payment slip" });
  }
};

module.exports = { createCarIntake, getCarIntakes, getCarIntake, updateCarIntake, deleteCarIntake, updateCarIntakeStatus, moveToReadyToScrap, moveToScrapped, getCarIntakeStats, printPaymentSlip };
