const express = require("express");
const router  = express.Router();
const multer  = require("multer");
const path    = require("path");
const { auth } = require("../middleware/auth.middleware");
const { uploadFile, deleteFile } = require("../controllers/upload.controller");

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "..", "uploads")),
  filename:    (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${file.fieldname}-${unique}${path.extname(file.originalname)}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ["image/jpeg","image/png","image/gif","image/webp","application/pdf",
    "application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];
  cb(null, allowed.includes(file.mimetype));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 20 * 1024 * 1024 } });

// Single file upload
router.post("/",            auth, upload.single("file"),  uploadFile);
// Multiple files upload
router.post("/multiple",    auth, upload.array("files", 10), uploadFile);
// Any field name (for email inbound attachments)
router.post("/any",         upload.any(), uploadFile);
router.delete("/:filename", auth, deleteFile);

module.exports = router;
