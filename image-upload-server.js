/**
 * Image Upload Server — S3-only (Supabase S3 Gateway) using memory (no local temp)
 * -------------------------------------------------------------------------------
 * - Uploads go directly from RAM to Supabase's S3-compatible endpoint via AWS SDK v3.
 * - Returns a public URL (if bucket is public) or a signed GET URL (if private).
 * - Also returns a signed DELETE URL; plus endpoints to mint delete URLs & server-side deletes.
 *
 * =========================
 * Required Environment Vars
 * =========================
 * SERVER_HOST=0.0.0.0
 * FRONTEND_ORIGINS=https://your-frontend.example.com     # or "*" while testing
 * MAX_FILE_MB=10
 *
 * # Supabase S3 Gateway
 * SUPABASE_S3_ENDPOINT=https://<project-ref>.supabase.co/storage/v1/s3
 * SUPABASE_S3_ACCESS_KEY=<your-rotated-access-key>
 * SUPABASE_S3_SECRET_KEY=<your-rotated-secret-key>
 * SUPABASE_S3_BUCKET=imageserver                         # your bucket name
 * SUPABASE_S3_PREFIX=uploads                             # optional folder path
 *
 * # For GET URLs
 * SUPABASE_URL=https://<project-ref>.supabase.co
 * SUPABASE_PUBLIC=true                                   # false if bucket is private
 * SUPABASE_SIGNED_SECONDS=604800                         # used when PUBLIC=false
 * SUPABASE_SIGNED_DELETE_SECONDS=600
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// -------------------- Config --------------------
const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.SERVER_HOST || "0.0.0.0";
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || "10", 10);

const S3_ENDPOINT = process.env.SUPABASE_S3_ENDPOINT;
const S3_ACCESS_KEY = process.env.SUPABASE_S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.SUPABASE_S3_SECRET_KEY;
const S3_BUCKET = process.env.SUPABASE_S3_BUCKET || "imageserver";
const S3_PREFIX = (process.env.SUPABASE_S3_PREFIX || "uploads").replace(/^\/+|\/+$/g, "");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const IS_PUBLIC = String(process.env.SUPABASE_PUBLIC || "true").toLowerCase() === "true";
const SIGNED_GET_SECONDS = parseInt(process.env.SUPABASE_SIGNED_SECONDS || `${60*60*24*7}`, 10);
const SIGNED_DELETE_SECONDS = parseInt(process.env.SUPABASE_SIGNED_DELETE_SECONDS || "600", 10);

// Validate required env
function requireEnv(name, val) {
  if (!val) throw new Error(`Missing required env: ${name}`);
}
requireEnv("SUPABASE_S3_ENDPOINT", S3_ENDPOINT);
requireEnv("SUPABASE_S3_ACCESS_KEY", S3_ACCESS_KEY);
requireEnv("SUPABASE_S3_SECRET_KEY", S3_SECRET_KEY);
requireEnv("SUPABASE_S3_BUCKET", S3_BUCKET);
if (IS_PUBLIC) requireEnv("SUPABASE_URL", SUPABASE_URL); // to build public object URLs

// -------------------- S3 Client --------------------
const S3_REGION = process.env.SUPABASE_S3_REGION || "us-east-1"; // arbitrary for Supabase S3
const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY }
});

// -------------------- App & Middleware --------------------
const app = express();
app.use(express.json({ limit: `${MAX_FILE_MB}mb` }));

const allowAll = FRONTEND_ORIGINS.length === 0 || FRONTEND_ORIGINS.includes("*");
const isOriginAllowed = (origin) => {
  if (allowAll) return true;
  if (!origin) return false;
  return FRONTEND_ORIGINS.some(entry => {
    if (entry.startsWith("/") && entry.endsWith("/")) {
      const pattern = entry.slice(1, -1);
      try { return new RegExp(pattern).test(origin); } catch { return false; }
    }
    return origin === entry;
  });
};
app.use(cors((req, cb) => {
  const origin = req.header("Origin");
  cb(null, {
    origin: isOriginAllowed(origin),
    credentials: true,
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    allowedHeaders: "Content-Type, Authorization, X-Requested-With"
  });
}));

// -------------------- Multer (memory-only) --------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 }
});

// -------------------- Helpers --------------------
const buildKey = (filename) => (S3_PREFIX ? `${S3_PREFIX}/` : "") + filename;
const encodeKeyForUrl = (key) => encodeURIComponent(key).replace(/%2F/g, "/");

async function putObjectBuffer(buffer, key, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || "application/octet-stream"
  }));
}

async function signedGetUrl(key, seconds) {
  return await getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), { expiresIn: seconds });
}

async function signedDeleteUrl(key, seconds) {
  return await getSignedUrl(s3, new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }), { expiresIn: seconds });
}

function buildPublicObjectUrl(key) {
  return `${SUPABASE_URL}/storage/v1/object/public/${S3_BUCKET}/${encodeKeyForUrl(key)}`;
}

// -------------------- Routes --------------------
app.get("/api/health", (req, res) => res.status(200).json({ ok: true, storage: "s3", bucket: S3_BUCKET }));
app.get("/api/ready",  (req, res) => res.status(200).json({ ready: true }));

// Single upload
app.post("/api/upload-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file received. Use field 'image'." });
    const safeName = (req.file.originalname ? req.file.originalname : "file").replace(/[^\w.\-]/g, "_");
    const key = buildKey(`${Date.now()}-${safeName}`);
    await putObjectBuffer(req.file.buffer, key, req.file.mimetype);
    const url = IS_PUBLIC ? buildPublicObjectUrl(key) : await signedGetUrl(key, SIGNED_GET_SECONDS);
    const delUrl = await signedDeleteUrl(key, SIGNED_DELETE_SECONDS);
    res.status(201).json({
      message: "Uploaded",
      file: {
        bucket: S3_BUCKET,
        key,
        url,
        deleteUrl: delUrl,
        visibility: IS_PUBLIC ? "public" : "private",
        expiresIn: IS_PUBLIC ? undefined : SIGNED_GET_SECONDS,
        deleteExpiresIn: SIGNED_DELETE_SECONDS
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Upload failed" });
  }
});

// Multiple upload
app.post("/api/upload-images", upload.array("images", 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No files received. Use field 'images'." });
    const results = [];
    for (const f of files) {
      const safeName = (f.originalname ? f.originalname : "file").replace(/[^\w.\-]/g, "_");
      const key = buildKey(`${Date.now()}-${safeName}`);
      await putObjectBuffer(f.buffer, key, f.mimetype);
      const url = IS_PUBLIC ? buildPublicObjectUrl(key) : await signedGetUrl(key, SIGNED_GET_SECONDS);
      const delUrl = await signedDeleteUrl(key, SIGNED_DELETE_SECONDS);
      results.push({
        bucket: S3_BUCKET,
        key,
        url,
        deleteUrl: delUrl,
        visibility: IS_PUBLIC ? "public" : "private",
        expiresIn: IS_PUBLIC ? undefined : SIGNED_GET_SECONDS,
        deleteExpiresIn: SIGNED_DELETE_SECONDS
      });
    }
    res.status(201).json({ message: "Uploaded", files: results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Upload failed" });
  }
});

// Generate a new signed DELETE URL on demand
app.post("/api/files/delete-url", async (req, res) => {
  try {
    const key = (req.body && req.body.key) ? String(req.body.key) : null;
    if (!key) return res.status(400).json({ error: "key is required" });
    const seconds = req.body && req.body.expiresIn ? Math.max(30, Math.min(3600, parseInt(req.body.expiresIn, 10))) : SIGNED_DELETE_SECONDS;
    const delUrl = await signedDeleteUrl(key, seconds);
    res.status(200).json({ key, deleteUrl: delUrl, expiresIn: seconds });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Failed to create delete URL" });
  }
});

// Optional: server-side delete (no URL)
app.delete("/api/files", async (req, res) => {
  try {
    const key = (req.body && req.body.key) ? String(req.body.key) : null;
    if (!key) return res.status(400).json({ error: "key is required" });
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    res.status(200).json({ deleted: true, key });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Delete failed" });
  }
});

// 404
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Error handler (multer size errors, etc.)
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File too large. Max ${MAX_FILE_MB} MB.` });
  }
  console.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

// -------------------- Start --------------------
const server = app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
  console.log(`[startup] bucket=${S3_BUCKET}, prefix=${S3_PREFIX}, public=${IS_PUBLIC}`);
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
