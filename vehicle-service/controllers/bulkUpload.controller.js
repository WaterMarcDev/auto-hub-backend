const xlsx = require("xlsx");
const fs   = require("fs");
const path = require("path");
const CarIntake = require("../models/CarIntake.model");

// POST /api/car-intake/bulk-upload
const bulkUploadCarIntakes = async (req, res) => {
  try {
    const { fileUrl } = req.body;
    if (!fileUrl) return res.status(400).json({ error: "No file URL provided" });

    const filename = fileUrl.replace(/^\/uploads\//, "");
    const filePath = path.join(__dirname, "..", "uploads", filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

    const workbook  = xlsx.readFile(filePath);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data      = xlsx.utils.sheet_to_json(worksheet);
    if (!data || data.length === 0) return res.status(400).json({ error: "Excel file is empty" });

    const vinsToCheck = data.map(r => (r.vin || r.VIN || "").toString().trim().toUpperCase()).filter(Boolean);
    const existing    = await CarIntake.find({ vin: { $in: vinsToCheck } }).select("vin").lean();
    const existingSet = new Set(existing.map(v => v.vin));

    const results = { successful: [], failed: [], skipped: [] };
    const toInsert = [];

    const allowedDrive        = ["2WD", "4WD", "AWD", "FWD"];
    const allowedTransmission = ["Automatic", "Manual"];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const vin = (row.vin || row.VIN || "").toString().trim().toUpperCase();
      if (!vin) { results.skipped.push({ row: i + 2, reason: "Missing VIN" }); continue; }
      if (existingSet.has(vin)) { results.skipped.push({ row: i + 2, reason: "VIN already exists", vin }); continue; }

      const drive = allowedDrive.includes((row.Drive || row.drive || "").toString().toUpperCase())
        ? (row.Drive || row.drive).toString().toUpperCase() : undefined;
      const transmission = allowedTransmission.find(t => t.toLowerCase() === (row.Transmission || row.transmission || "").toString().toLowerCase());

      let createdAt;
      const dateIn = row["date In"] || row["Date In"] || row.dateIn;
      if (dateIn) {
        createdAt = typeof dateIn === "number"
          ? new Date(new Date(1899, 11, 30).getTime() + dateIn * 86400000)
          : new Date(dateIn);
        if (isNaN(createdAt)) createdAt = undefined;
      }

      const carIntakeData = {
        vin,
        manualVinMode: req.body.manualVinMode,
        carDetails: {
          year: row.Year || row.year ? parseInt(row.Year || row.year) : undefined,
          make: (row.Make || row.make || "").toString().trim() || undefined,
          model: (row.Modal || row.Model || row.model || "").toString().trim() || undefined,
          trim: (row.trim || row.Trim || "").toString().trim() || undefined,
          color: (row.color || row.Color || "").toString().trim() || undefined,
          bodyClass: (row["Body Class"] || row.bodyClass || "").toString().trim() || undefined,
          engine: (row.Engine || row.engine || "").toString().trim() || undefined,
          transmission, drive,
          fuelType: (row["Fuel Type"] || row.fuelType || "").toString().trim() || undefined,
          scrapYardLocation: (row.Where || row.where || "").toString().trim() || undefined,
          carDetailsUploadedBy: req.user._id,
        },
        status: "intake",
        createdBy: req.user._id,
        ...(createdAt && { createdAt, updatedAt: createdAt }),
      };
      toInsert.push({ data: carIntakeData, row: i + 2 });
    }

    if (toInsert.length > 0) {
      try {
        const inserted = await CarIntake.insertMany(toInsert.map(x => x.data), { ordered: false });
        inserted.forEach((doc, idx) => {
          const cd = doc.carDetails || {};
          results.successful.push({ row: toInsert[idx]?.row, vin: doc.vin, car: [cd.year, cd.make, cd.model].filter(Boolean).join(" "), id: doc._id });
        });
      } catch (err) {
        if (err.name === "MongoBulkWriteError") {
          err.insertedDocs?.forEach((doc, idx) => {
            if (doc?._id) {
              const cd = doc.carDetails || {};
              results.successful.push({ row: toInsert[idx]?.row, vin: doc.vin, car: [cd.year, cd.make, cd.model].filter(Boolean).join(" "), id: doc._id });
            }
          });
          err.writeErrors?.forEach(e => results.failed.push({ row: toInsert[e.index]?.row, reason: e.errmsg || "Insert failed" }));
        } else {
          toInsert.forEach(x => results.failed.push({ row: x.row, reason: err.message }));
        }
      }
    }

    res.status(200).json({
      message: "Bulk upload completed",
      summary: { total: data.length, successful: results.successful.length, failed: results.failed.length, skipped: results.skipped.length },
      results,
    });
  } catch (error) {
    console.error("Bulk upload error:", error);
    res.status(500).json({ error: "Server error during bulk upload", details: error.message });
  }
};

// POST /api/car-intake/bulk-upload-scraped
const bulkUploadScraped = async (req, res) => {
  try {
    const { fileUrl } = req.body;
    if (!fileUrl) return res.status(400).json({ error: "No file URL provided" });

    const filename = fileUrl.replace(/^\/uploads\//, "");
    const filePath = path.join(__dirname, "..", "uploads", filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

    const workbook  = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames.find(n => n.toLowerCase() === "gone");
    if (!sheetName) return res.status(400).json({ error: "Sheet 'GONE' not found" });

    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: true });
    if (!data || data.length === 0) return res.status(400).json({ error: "GONE sheet is empty" });

    const vinsToCheck = data.map(r => (r.vin || r.VIN || "").toString().trim().toUpperCase()).filter(Boolean);
    const existing    = await CarIntake.find({ vin: { $in: vinsToCheck } }).select("vin").lean();
    const existingSet = new Set(existing.map(d => d.vin));

    const results = { successful: [], skipped: [], failed: [] };
    const toInsert = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const vin = (row.vin || row.VIN || "").toString().trim().toUpperCase();
      if (!vin) { results.skipped.push({ row: i + 2, reason: "Missing VIN" }); continue; }
      if (existingSet.has(vin)) { results.skipped.push({ row: i + 2, reason: "VIN already exists", vin }); continue; }

      const what    = (row["What Happen?"] || row["What Happened?"] || row.what || "").toString().trim().toLowerCase();
      let   status  = "intake";
      if (what.includes("crush") || what.includes("scrapped")) status = "scraped";
      else if (what.includes("sold")) status = "sold";
      else if (what.includes("tow")) status = "towed";

      toInsert.push({
        data: {
          vin,
          carDetails: {
            year:  row.Year  || row.year  ? parseInt(row.Year || row.year)  : undefined,
            make:  (row.Make  || row.make  || "").toString().trim() || undefined,
            model: (row.Model || row.model || "").toString().trim() || undefined,
            carDetailsUploadedBy: req.user._id,
          },
          status,
          ...(status === "scraped" && { scrapedBy: req.user._id, scrapDate: new Date() }),
          createdBy: req.user._id,
        },
        row: i + 2,
      });
    }

    if (toInsert.length > 0) {
      try {
        const inserted = await CarIntake.insertMany(toInsert.map(x => x.data), { ordered: false });
        inserted.forEach((doc, idx) => results.successful.push({ row: toInsert[idx]?.row, vin: doc.vin, id: doc._id }));
      } catch (err) {
        if (err.name === "MongoBulkWriteError") {
          err.insertedDocs?.forEach((doc, idx) => { if (doc?._id) results.successful.push({ vin: doc.vin, id: doc._id }); });
          err.writeErrors?.forEach(e => results.failed.push({ row: toInsert[e.index]?.row, reason: e.errmsg }));
        } else {
          toInsert.forEach(x => results.failed.push({ row: x.row, reason: err.message }));
        }
      }
    }

    res.status(200).json({
      message: "Bulk upload (scraped) completed",
      summary: { total: data.length, successful: results.successful.length, failed: results.failed.length, skipped: results.skipped.length },
      results,
    });
  } catch (error) {
    console.error("Bulk upload scraped error:", error);
    res.status(500).json({ error: "Server error during bulk upload", details: error.message });
  }
};

module.exports = { bulkUploadCarIntakes, bulkUploadScraped };
