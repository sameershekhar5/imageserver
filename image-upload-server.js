/**
 * Image Upload Server (Render-ready, no hardcoded ports)
 * -----------------------------------------------------
 * - Listens on process.env.PORT (Render injects this).
 * - Binds to process.env.SERVER_HOST or "0.0.0.0".
 * - CORS origins via process.env.FRONTEND_ORIGINS (CSV, "*", or regex between /slashes/).
 * - Upload directory via process.env.UPLOAD_DIR (default: "src/assets/uploads").
 * - File size limit via process.env.MAX_FILE_MB (default: 10 MB).
 * - Endpoints:
 *      GET  /                -> basic info
 *      GET  /api/health      -> { ok: true }
 *      GET  /api/ready       -> { ready: true }
 *      POST /api/upload-image   (single file, field "image")
 *      POST /api/upload-images  (multiple files, field "images")
 *      GET  /assets/uploads/* -> serves uploaded files (static)
 *
 * Run locally:
 *   npm install express multer cors
 *   # PowerShell
 *   $env:SERVER_HOST="0.0.0.0"; $env:PORT="3001"; $env:FRONTEND_ORIGINS="http://localhost:4200"; `
 *   $env:UPLOAD_DIR="src/assets/uploads"; $env:MAX_FILE_MB="10"; node image-upload-server.js
 *
 * Render env vars (Web Service):
 *   SERVER_HOST=0.0.0.0
 *   FRONTEND_ORIGINS=https://your-frontend.example.com  (or "*" during testing)
 *   UPLOAD_DIR=/app/src/assets/uploads   (or a mounted disk path)
 *   MAX_FILE_MB=10
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");

// -------------------- Config (no hardcoded values) --------------------
const PORT = parseInt(process.env.PORT || "3001", 10);         // Render sets this
const HOST = process.env.SERVER_HOST || "0.0.0.0";              // 0.0.0.0 works on PaaS
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve("src/assets/uploads");
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || "10", 10);

// Ensure upload dir exists
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// -------------------- App & Middlewares --------------------
const app = express();
app.use(express.json({ limit: `${MAX_FILE_MB}mb` }));

// ---- Dynamic CORS (CSV, *, or regex between /slashes/)
const allowAll = FRONTEND_ORIGINS.length === 0 || FRONTEND_ORIGINS.includes("*");

const isOriginAllowed = (origin) => {
  if (allowAll) return true;              // if not set or "*" -> allow all
  if (!origin) return false;              // curl/postman without Origin
  return FRONTEND_ORIGINS.some(entry => {
    if (entry.startsWith("/") && entry.endsWith("/")) {
      const pattern = entry.slice(1, -1);
      try { return new RegExp(pattern).test(origin); }
      catch { return false; }
    }
    return origin === entry;
  });
};

app.use(cors((req, cb) => {
  const origin = req.header("Origin");
  const ok = isOriginAllowed(origin);
  cb(null, {
    origin: ok,
    credentials: true,
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    allowedHeaders: "Content-Type, Authorization, X-Requested-With"
  });
}));

// -------------------- Multer (disk storage) --------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const original = (file && file.originalname) ? file.originalname : "file";
    const safe = original.replace(/[^\w.\-]/g, "_");
    cb(null, Date.now() + "-" + safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 }
});

// -------------------- Helpers --------------------
const buildPublicUrl = (req, storedName) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}/assets/uploads/${encodeURIComponent(storedName)}`;
};

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.status(200).json({
    name: "Image Upload Server",
    ok: true,
    uploads: "/assets/uploads",
    singleUploadEndpoint: "POST /api/upload-image (field 'image')",
    multiUploadEndpoint: "POST /api/upload-images (field 'images')"
  });
});

app.get("/api/health", (req, res) => res.status(200).json({ ok: true }));
app.get("/api/ready",  (req, res) => res.status(200).json({ ready: true }));

// Single file: field name "image"
app.post("/api/upload-image", upload.single("image"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file received. Use field name 'image'." });
  }
  const url = buildPublicUrl(req, req.file.filename);
  res.status(201).json({
    message: "Uploaded",
    file: {
      fieldname: req.file.fieldname,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      filename: req.file.filename,
      path: req.file.path,
      url
    }
  });
});

// Multiple files: field name "images"
app.post("/api/upload-images", upload.array("images", 10), (req, res) => {
  const files = (req.files || []).map(f => ({
    fieldname: f.fieldname,
    originalname: f.originalname,
    mimetype: f.mimetype,
    size: f.size,
    filename: f.filename,
    path: f.path,
    url: buildPublicUrl(req, f.filename)
  }));
  if (files.length === 0) {
    return res.status(400).json({ error: "No files received. Use field name 'images'." });
  }
  res.status(201).json({ message: "Uploaded", files });
});

// Delete image endpoint
app.delete('/api/images/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(UPLOAD_DIR, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ 
        success: false, 
        error: 'File not found' 
      });
    }

    fs.unlinkSync(filePath);
    console.log('✅ Image deleted successfully:', filename);

    res.json({ 
      success: true, 
      message: 'Image deleted successfully' 
    });

  } catch (error) {
    console.error('❌ Delete error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete image' 
    });
  }
});
// Serve static uploads
app.use("/assets/uploads", express.static(UPLOAD_DIR, {
  fallthrough: true,
  index: false,
  immutable: false,
  maxAge: "1h"
}));

// 404
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler (includes Multer file limit error)
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File too large. Max ${MAX_FILE_MB} MB.` });
  }
  console.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

// -------------------- Start & Graceful Shutdown --------------------
const server = app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});

const shutdown = (signal) => () => {
  console.log(`Received ${signal}. Shutting down...`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown("SIGINT"));
process.on("SIGTERM", shutdown("SIGTERM"));
