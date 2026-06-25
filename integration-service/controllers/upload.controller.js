const path = require("path");
const fs   = require("fs");

// POST /api/upload  — multer populates req.file / req.files
const uploadFile = (req, res) => {
  try {
    if (!req.file && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Single file
    if (req.file) {
      return res.status(200).json({
        message: "File uploaded successfully",
        filename: req.file.filename,
        originalname: req.file.originalname,
        url: `${process.env.BACKEND_URL || ""}/uploads/${req.file.filename}`,
        size: req.file.size,
        mimetype: req.file.mimetype,
      });
    }

    // Multiple files
    const files = req.files.map(f => ({
      filename: f.filename,
      originalname: f.originalname,
      url: `${process.env.BACKEND_URL || ""}/uploads/${f.filename}`,
      size: f.size,
      mimetype: f.mimetype,
    }));

    res.status(200).json({ message: "Files uploaded successfully", files });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "Server error during upload" });
  }
};

// DELETE /api/upload/:filename
const deleteFile = (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(__dirname, "..", "uploads", filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }

    fs.unlinkSync(filePath);
    res.json({ message: "File deleted successfully", filename });
  } catch (error) {
    console.error("Delete file error:", error);
    res.status(500).json({ error: "Server error during file deletion" });
  }
};

module.exports = { uploadFile, deleteFile };
