const carIntakeService = require("../services/carIntake.service");

// @desc    Create new car intake (with seller and transaction)
// @route   POST /api/car-intake
// @access  Private
const createCarIntake = async (req, res) => {
  try {
    const result = await carIntakeService.createCarIntake(req.body, req.user._id);

    if (result.alreadyExisted) {
      return res.status(200).json({
        message: "Car intake already exists",
        carIntake: result.carIntake,
      });
    }

    res.status(201).json({
      message: "Car intake created successfully",
      carIntake: result.carIntake,
    });
  } catch (error) {
    console.error("CREATE ERROR FULL:", error);

    if (error.errors) {
      Object.keys(error.errors).forEach((key) => {
        console.error(key, "=>", error.errors[key].message);
      });
    }

    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }

    return res.status(400).json({
      success: false,
      error: "Car intake creation failed",
      details: error.message,
    });
  }
};

// @desc    Get all car intakes
// @route   GET /api/car-intake
// @access  Private
const getCarIntakes = async (req, res) => {
  try {
    const result = await carIntakeService.getCarIntakes(req.query);
    res.json(result);
  } catch (error) {
    console.error("Get car intakes error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Get single car intake
// @route   GET /api/car-intake/:id
// @access  Private
const getCarIntake = async (req, res) => {
  try {
    const result = await carIntakeService.getCarIntake(req.params.id);
    res.json(result);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Get car intake error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Update car intake
// @route   PUT /api/car-intake/:id
// @access  Private
const updateCarIntake = async (req, res) => {
  try {
    const updatedCarIntake = await carIntakeService.updateCarIntake(req.params.id, req.body, req.user._id);

    res.json({
      message: "Car intake updated successfully",
      carIntake: updatedCarIntake,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Update car intake error:", error);
    res.status(500).json({
      error: "Server error during update",
      details: error.message,
    });
  }
};

// @desc    Delete car intake
// @route   DELETE /api/car-intake/:id
// @access  Private
const deleteCarIntake = async (req, res) => {
  try {
    await carIntakeService.deleteCarIntake(req.params.id);
    res.json({ message: "Car intake deleted successfully" });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Delete car intake error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Update car intake status
// @route   PATCH /api/car-intake/:id/status
// @access  Private
const updateCarIntakeStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const carIntake = await carIntakeService.updateCarIntakeStatus(req.params.id, status, req.user?._id);

    res.json({
      message: "Status updated successfully",
      carIntake,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Update status error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// "Move to Ready-to-Scrap" API by shiva
const moveToReadyToScrap = async (req, res) => {
  try {
    const updated = await carIntakeService.moveToReadyToScrap(req.params.id);

    res.json({
      success: true,
      message: "Car moved to Ready to Scrap",
      data: updated,
    });
  } catch (error) {
    console.error("Ready-to-Scrap Error:", error);

    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// moveToScrapped function by shiva
const moveToScrapped = async (req, res) => {
  try {
    const { id } = req.params;
    const { scrapRemarks } = req.body;

    const updated = await carIntakeService.moveToScrapped(id, scrapRemarks, req.user.id);

    res.json({
      success: true,
      data: updated,
    });
  } catch (error) {
    console.error("Move To Scrapped Error:", error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// @desc    Get car intake statistics
// @route   GET /api/car-intake/stats
// @access  Private
const getCarIntakeStats = async (req, res) => {
  try {
    const result = await carIntakeService.getCarIntakeStats(req.query);
    res.json(result);
  } catch (error) {
    console.error("Get stats error:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// @desc    Render payment slip for a car intake
// @route   GET /api/car-intake/:id/print-payment
// @access  Private
const printPaymentSlip = async (req, res) => {
  try {
    const data = await carIntakeService.buildPrintPaymentSlipData(req.params.id, req.user);
    return res.render("paymentSlip.njk", data);
  } catch (err) {
    if (err.statusCode && err.plainText) {
      return res.status(err.statusCode).send(err.message);
    }
    console.error("Print payment slip error:", err);
    return res.status(500).json({ error: "Server error rendering payment slip" });
  }
};

// @desc    Print combined documents (receipt + title certificate)
// @route   GET /api/car-intake/:id/print-all-documents
// @access  Private
const printAllDocuments = async (req, res) => {
  try {
    const data = await carIntakeService.buildPrintAllDocumentsData(req.params.id, req.user);
    return res.render("combinedDocuments.njk", data);
  } catch (err) {
    if (err.statusCode && err.plainText) {
      return res.status(err.statusCode).send(err.message);
    }
    console.error("Print all documents error:", err);
    return res.status(500).json({ error: "Server error rendering documents" });
  }
};

// @desc    Bulk upload car intakes from Excel
// @route   POST /api/car-intake/bulk-upload
// @access  Private
const bulkUploadCarIntakes = async (req, res) => {
  try {
    const { fileUrl } = req.body;
    const result = await carIntakeService.bulkUploadCarIntakes(fileUrl, req.user._id, req.body.manualVinMode);

    res.status(200).json({
      message: "Bulk upload completed",
      ...result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Bulk upload error:", error);

    res.status(500).json({
      error: "Server error during bulk upload",
      details: error.message,
    });
  }
};

// @desc    Bulk upload scraped car records from Excel (sheet named 'GONE')
// @route   POST /api/car-intake/bulk-upload-scraped
// @access  Private
const bulkUploadScraped = async (req, res) => {
  try {
    const { fileUrl } = req.body;
    const result = await carIntakeService.bulkUploadScraped(fileUrl, req.user._id, req.user);

    res.status(200).json({
      message: "Bulk scraped upload completed",
      ...result,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error("Bulk upload scraped error:", error);
    res.status(500).json({
      error: "Server error during bulk upload scraped",
      details: error.message,
    });
  }
};

module.exports = {
  createCarIntake,
  getCarIntakes,
  getCarIntake,
  updateCarIntake,
  deleteCarIntake,
  updateCarIntakeStatus,
  getCarIntakeStats,
  bulkUploadCarIntakes,
  bulkUploadScraped,
  printPaymentSlip,
  printAllDocuments,
  moveToReadyToScrap, // added by shiva
  moveToScrapped, // added by shiva
};
