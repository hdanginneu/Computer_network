// backend/index.js
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import morgan from "morgan";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev")); // log request cho dễ debug

// ====================== CONFIG CƠ BẢN ======================
const STORAGE_ROOT = process.env.STORAGE_PATH || "storage";
const PORT = process.env.PORT || 3000;

// Tự tạo thư mục storage nếu chưa có
if (!fs.existsSync(STORAGE_ROOT)) {
  fs.mkdirSync(STORAGE_ROOT, { recursive: true });
  console.log(`📁 Created folder: ${STORAGE_ROOT}`);
}

// ====================== MULTER CONFIG ======================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, STORAGE_ROOT);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/\s+/g, "_");
    cb(null, `${timestamp}_${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB
  },
});

// ====================== API ======================

// Test API
app.get("/", (req, res) => {
  res.json({ message: "Backend running successfully" });
});

// Upload file
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  res.json({
    message: "Upload success",
    filename: req.file.filename,
    path: `${STORAGE_ROOT}/${req.file.filename}`,
  });
});

// Lấy danh sách file
app.get("/files", (req, res) => {
  fs.readdir(STORAGE_ROOT, (err, files) => {
    if (err) return res.status(500).json({ error: "Cannot read folder" });
    res.json({ files });
  });
});

// Xóa file
app.delete("/files/:name", (req, res) => {
  const filePath = path.join(STORAGE_ROOT, req.params.name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  fs.unlink(filePath, (err) => {
    if (err) return res.status(500).json({ error: "Delete error" });
    res.json({ message: "Deleted successfully" });
  });
});

// ====================== GLOBAL ERROR HANDLER ======================
app.use((err, req, res, next) => {
  console.error("🔥 ERROR:", err);
  res.status(500).json({ error: "Server error" });
});

// ====================== START SERVER ======================
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
