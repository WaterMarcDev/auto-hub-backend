const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const { auth } = require("../middleware/auth");
const {
  createCarIntake,
  getCarIntakes,
  getCarIntake,
  updateCarIntake,
  deleteCarIntake,
  updateCarIntakeStatus,
  getCarIntakeStats,
  bulkUploadCarIntakes,
  bulkUploadScraped,
} = require("../controllers/carIntakeController");

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/"); // Make sure this directory exists
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(
      null,
      file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname)
    );
  },
});

const upload = multer({
  storage: storage,
  fileFilter: function (req, file, cb) {
    // Accept images, PDFs, and Excel files
    if (
      file.mimetype.startsWith("image/") ||
      file.mimetype === "application/pdf" ||
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel"
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only images, PDF, and Excel files are allowed!"), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});

// Validation middleware - removed for now
// const validateCarIntake = [];

// @route   GET /api/car-intake/stats
// @desc    Get car intake statistics
// @access  Private
router.get("/stats", auth, getCarIntakeStats);

// @route   POST /api/car-intake/bulk-upload
// @desc    Bulk upload car intakes from Excel (accepts file URL in body)
// @access  Private
router.post("/bulk-upload", auth, bulkUploadCarIntakes);
// @route   POST /api/car-intake/bulk-upload-scraped
// @desc    Bulk upload scraped records from Excel (sheet 'GONE')
// @access  Private
router.post("/bulk-upload-scraped", auth, bulkUploadScraped);

// @route   POST /api/car-intake
// @desc    Create new car intake
// @access  Private
router.post("/", auth, upload.any(), createCarIntake);

// @route   GET /api/car-intake
// @desc    Get all car intakes
// @access  Private
router.get("/", auth, getCarIntakes);

// @route   GET /api/car-intake/:id
// @desc    Get single car intake
// @access  Private
router.get("/:id", auth, getCarIntake);

// @route   PUT /api/car-intake/:id
// @desc    Update car intake
// @access  Private
router.put("/:id", auth, updateCarIntake);

// @route   PATCH /api/car-intake/:id/status
// @desc    Update car intake status
// @access  Private
router.patch("/:id/status", auth, updateCarIntakeStatus);

// @route   DELETE /api/car-intake/:id
// @desc    Delete car intake
// @access  Private
router.delete("/:id", auth, deleteCarIntake);

module.exports = router;
