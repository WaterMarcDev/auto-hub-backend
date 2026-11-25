const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { auth } = require("../middleware/auth");
const { UPLOAD_DIR } = require("../config/uploads");
const router = express.Router();

// Upload folder (created on startup by config/uploads.js; set UPLOAD_DIR to move it)
const uploadsDir = UPLOAD_DIR;

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    // Create unique filename with timestamp
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const sanitizedOriginalName = file.originalname.replace(
      /[^a-zA-Z0-9.]/g,
      "_"
    );
    cb(null, file.fieldname + "-" + uniqueSuffix + "-" + sanitizedOriginalName);
  },
});

// File filter to accept images and Excel files
const fileFilter = (req, file, cb) => {
  const allowedImageTypes = /jpeg|jpg|png|gif|webp/;
  const allowedExcelTypes = /xlsx|xls/;

  const extname = path.extname(file.originalname).toLowerCase();
  const isImage =
    allowedImageTypes.test(extname.substring(1)) &&
    allowedImageTypes.test(file.mimetype);
  const isExcel =
    allowedExcelTypes.test(extname.substring(1)) ||
    file.mimetype ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    file.mimetype === "application/vnd.ms-excel";

  if (isImage || isExcel) {
    return cb(null, true);
  } else {
    cb(
      new Error(
        "Only image and Excel files are allowed (jpeg, jpg, png, gif, webp, xlsx, xls)"
      )
    );
  }
};

// Configure multer
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: fileFilter,
});

// A file named / typed as an image must really be one: its first bytes must be
// a JPEG, PNG, GIF or WEBP signature. Anything else (a corrupted or renamed
// file) is deleted and rejected. Excel uploads are not affected.
const IMAGE_SIGNATURES = [
  (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, // JPEG
  (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), // PNG
  (b) => b.slice(0, 6).toString("ascii") === "GIF87a" || b.slice(0, 6).toString("ascii") === "GIF89a", // GIF
  (b) => b.slice(0, 4).toString("ascii") === "RIFF" && b.slice(8, 12).toString("ascii") === "WEBP", // WEBP
];
const CORRUPT_IMAGE_MESSAGE =
  "The image could not be read. It may be damaged or not a real image. Please upload a valid JPG, JPEG, PNG, GIF or WEBP image.";

const isImageUpload = (file) =>
  /^image\//i.test(file.mimetype || "") ||
  /\.(jpe?g|png|gif|webp)$/i.test(file.originalname || "");

const hasImageSignature = (filePath) => {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(12);
    const read = fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    return read >= 4 && IMAGE_SIGNATURES.some((check) => check(buf));
  } catch {
    return false;
  }
};

// Removes every uploaded file of the request when any image is not real.
// Returns true when the request was rejected.
const rejectCorruptImages = (req, res) => {
  const files = req.file ? [req.file] : req.files || [];
  const bad = files.find((f) => isImageUpload(f) && !hasImageSignature(f.path));
  if (!bad) return false;
  files.forEach((f) => fs.unlink(f.path, () => {}));
  res.status(400).json({ error: CORRUPT_IMAGE_MESSAGE, message: CORRUPT_IMAGE_MESSAGE });
  return true;
};

// @route   POST /api/upload/image
// @desc    Upload a single image or Excel file
// @access  Private
router.post("/image", auth, upload.single("image"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    if (rejectCorruptImages(req, res)) return;

    const imageUrl = `/uploads/${req.file.filename}`;

    res.status(200).json({
      message: "File uploaded successfully",
      imageUrl,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Failed to upload file" });
  }
});

// @route   POST /api/upload/multiple
// @desc    Upload multiple images
// @access  Private
router.post("/multiple", auth, upload.array("images", 10), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No image files uploaded" });
    }
    if (rejectCorruptImages(req, res)) return;

    const uploadedFiles = req.files.map((file) => ({
      imageUrl: `/uploads/${file.filename}`,
      filename: file.filename,
      originalName: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
    }));

    res.status(200).json({
      message: "Images uploaded successfully",
      files: uploadedFiles,
      count: uploadedFiles.length,
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Failed to upload images" });
  }
});

// Path traversal guard for the /:filename routes.
// Express decodes "%2F", so a request like "..%2F.env" arrives as "../.env",
// and path.join() would then point outside uploads/. path.basename() keeps
// only the last path segment ("../.env" -> ".env"), so the resolved path
// always stays inside uploads/. "." and ".." are rejected because they would
// resolve to uploads/ itself or its parent folder.
// Returns null when the name is not a usable file name.
const resolveUploadPath = (rawFilename) => {
  const filename = path.basename(String(rawFilename || ""));
  if (!filename || filename === "." || filename === "..") return null;
  return { filename, filePath: path.join(uploadsDir, filename) };
};

// @route   DELETE /api/upload/:filename
// @desc    Delete an uploaded image
// @access  Private
router.delete("/:filename", auth, (req, res) => {
  try {
    const resolved = resolveUploadPath(req.params.filename);
    if (!resolved) {
      return res.status(404).json({ error: "File not found" });
    }
    const { filename, filePath } = resolved;

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }

    // Delete the file
    fs.unlinkSync(filePath);

    res.status(200).json({
      message: "Image deleted successfully",
      filename,
    });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ error: "Failed to delete image" });
  }
});

// @route   GET /api/upload/:filename
// @desc    Serve uploaded image
// @access  Public
router.get("/:filename", (req, res) => {
  try {
    const resolved = resolveUploadPath(req.params.filename);
    if (!resolved) {
      return res.status(404).json({ error: "File not found" });
    }
    const { filename, filePath } = resolved;

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }

    // Set appropriate headers
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
    };

    const contentType = mimeTypes[ext] || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000"); // Cache for 1 year

    // Send the file
    res.sendFile(filePath);
  } catch (error) {
    console.error("Serve file error:", error);
    res.status(500).json({ error: "Failed to serve image" });
  }
});

// Error handling middleware for multer
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res
        .status(400)
        .json({ error: "File too large. Maximum size is 10MB." });
    }
    if (error.code === "LIMIT_FILE_COUNT") {
      return res
        .status(400)
        .json({ error: "Too many files. Maximum is 10 files." });
    }
    if (error.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({ error: "Unexpected field name." });
    }
  }

  if (error.message.includes("Only image and Excel files are allowed")) {
    return res.status(400).json({ error: error.message });
  }

  next(error);
});

module.exports = router;
