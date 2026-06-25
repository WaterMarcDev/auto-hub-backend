const CarIntake  = require("../models/CarIntake.model");
const Transaction = require("../models/Transaction.model");
const PaymentSlip = require("../models/PaymentSlip.model");
const EntryFee   = require("../models/EntryFee.model");
const fs   = require("fs");
const path = require("path");

// GET /api/car-intake/:id/print-all-documents
const printAllDocuments = async (req, res) => {
  try {
    const carIntake = await CarIntake.findOne({ _id: req.params.id, isDeleted: { $ne: true } })
      .populate("kyc.seller", "firstName lastName email mobileNo signatureImage description")
      .populate("createdBy", "first_name last_name email");
    if (!carIntake) return res.status(404).send("Car intake not found");

    const transaction = await Transaction.findOne({ carIntake: carIntake._id, isActive: true })
      .sort({ createdAt: -1 }).populate("createdBy", "first_name last_name email");

    let paymentSlipDoc = await PaymentSlip.findOne({ carIntake: carIntake._id })
      .sort({ createdAt: -1 }).populate("transaction").populate("createdBy", "first_name last_name email");

    if (!paymentSlipDoc) {
      const netAmount  = carIntake.price?.finalPrice || 0;
      const taxRate    = transaction?.taxRate || 0.06625;
      const grossAmount = netAmount / (1 - taxRate);
      paymentSlipDoc = await PaymentSlip.create({
        carIntake: carIntake._id, transaction: transaction?._id,
        paymentMethod: transaction?.paymentMethod || carIntake.payment?.paymentMethod,
        grossAmount: Math.round(grossAmount * 100) / 100,
        netAmount: Math.round(netAmount * 100) / 100,
        taxRate, paymentDate: transaction?.createdAt || new Date(), createdBy: req.user?._id,
      });
      paymentSlipDoc = await PaymentSlip.findById(paymentSlipDoc._id)
        .populate("transaction").populate("createdBy", "first_name last_name email");
    }

    let logoDataUri = null;
    try {
      const buf = fs.readFileSync(path.join(__dirname, "..", "assets", "logo-sm1.png"));
      logoDataUri = `data:image/png;base64,${buf.toString("base64")}`;
    } catch { /* ignore */ }

    // Collect uploaded KYC documents as base64
    const documents = [];
    const docKeys   = [
      { key: "titleCertificate", title: "Title Certificate" },
      { key: "driversLicense",   title: "Driver's License" },
      { key: "physicalPaper",    title: "Physical Paper" },
    ];

    for (const { key, title } of docKeys) {
      const docPath = carIntake?.kyc?.documents?.[key];
      if (!docPath) continue;
      let filename = docPath.includes("uploads/")
        ? docPath.substring(docPath.lastIndexOf("uploads/") + 8)
        : path.basename(docPath);
      const fullPath = path.join(__dirname, "..", "uploads", filename);
      if (fs.existsSync(fullPath)) {
        try {
          const buf  = fs.readFileSync(fullPath);
          const ext  = path.extname(filename).toLowerCase();
          const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" }[ext] || "image/jpeg";
          documents.push({ title, dataUri: `data:${mime};base64,${buf.toString("base64")}` });
        } catch { /* skip unreadable doc */ }
      }
    }

    const entryFee = await EntryFee.findOne().sort({ createdAt: -1 });

    return res.render("combinedDocuments.njk", {
      carIntake, transaction, paymentSlip: paymentSlipDoc,
      slipPadded: paymentSlipDoc?.slipNumber ? String(paymentSlipDoc.slipNumber).padStart(7, "0") : null,
      documents, generatedAt: new Date(),
      generatedBy: req.user ? { id: req.user._id, name: req.user.first_name || "" } : null,
      logoSrc: logoDataUri || "/assets/logo-sm1.png",
      adjustedEntryFee: entryFee?.entryFee || 2.0,
    });
  } catch (err) {
    console.error("Print all documents error:", err);
    res.status(500).json({ error: "Server error rendering documents" });
  }
};

module.exports = { printAllDocuments };
