/**
 * Image Upload Server — Free Render Friendly (Local /tmp or Supabase Storage)
 * --------------------------------------------------------------------------
 * Modes (choose via STORAGE_PROVIDER env):
 *   1) STORAGE_PROVIDER=local   -> stores on writable /tmp/uploads (ephemeral)
 *   2) STORAGE_PROVIDER=supabase-> uploads to Supabase Storage bucket (persistent)
 *
 * Common env (Render injects PORT automatically):
 *   SERVER_HOST=0.0.0.0
 *   FRONTEND_ORIGINS=https://your-frontend.example.com   (or * while testing)
 *   MAX_FILE_MB=10
 *   STORAGE_PROVIDER=local | supabase
 *
 * Supabase-specific env (only if STORAGE_PROVIDER=supabase):
 *   SUPABASE_URL= https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_KEY= <service role key>  (keep secret)
 *   SUPABASE_BUCKET= uploads                  (your bucket name)
 *   SUPABASE_PATH_PREFIX= optional/folder     (optional path prefix)
 *   SUPABASE_PUBLIC= true|false               (default: true; if false uses signed URLs)
 *   SUPABASE_SIGNED_SECONDS= 604800           (validity if PUBLIC=false; default 7d)
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/ready
 *   POST /api/upload-image    (field "image")
 *   POST /api/upload-images   (field "images")
 *   GET  /assets/uploads/*    (serves local files only in local mode)
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.SERVER_HOST || "0.0.0.0";
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || "10", 10);
const STORAGE_PROVIDER = (process.env.STORAGE_PROVIDER || "local").toLowerCase();

// ----- CORS (dynamic)
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

// ----- Local storage (/tmp fallback; no Disk needed on free plan)
function resolveLocalUploadDir() {
  const candidates = [];
  if (process.env.UPLOAD_DIR && process.env.UPLOAD_DIR.trim()) {
    const raw = process.env.UPLOAD_DIR.trim();
    candidates.push(path.isAbsolute(raw) ? raw : path.resolve(raw));
  }
  candidates.push(path.resolve(process.cwd(), "uploads"));
  candidates.push("/tmp/uploads");
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch { /* try next */ }
  }
  throw new Error("No writable upload directory found for local mode.");
}
const LOCAL_UPLOAD_DIR = resolveLocalUploadDir();

// ----- Multer config (always writes to local temp first)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LOCAL_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const name = (file && file.originalname) ? file.originalname : "file";
    const safe = name.replace(/[^\w.\-]/g, "_");
    cb(null, Date.now() + "-" + safe);
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } });

// ----- Supabase client (lazy init)
let supabase = null;
async function ensureSupabase() {
  if (supabase) return supabase;
  const { createClient } = require("@supabase/supabase-js");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Supabase env missing: SUPABASE_URL and SUPABASE_SERVICE_KEY are required.");
  supabase = createClient(url, key, { auth: { persistSession: false } });
  return supabase;
}

// ----- Helpers
const app = express();
app.use(express.json({ limit: `${MAX_FILE_MB}mb` }));
app.use(cors((req, cb) => {
  const origin = req.header("Origin");
  cb(null, {
    origin: isOriginAllowed(origin),
    credentials: true,
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    allowedHeaders: "Content-Type, Authorization, X-Requested-With"
  });
}));

const buildPublicUrlLocal = (req, storedName) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}/assets/uploads/${encodeURIComponent(storedName)}`;
};

// Serve static only in local mode
if (STORAGE_PROVIDER === "local") {
  app.use("/assets/uploads", express.static(LOCAL_UPLOAD_DIR, { index: false, maxAge: "1h" }));
}

app.get("/api/health", (req, res) => res.status(200).json({ ok: true, storage: STORAGE_PROVIDER }));
app.get("/api/ready",  (req, res) => res.status(200).json({ ready: true }));

async function handleFileResult(req, file) {
  if (STORAGE_PROVIDER === "supabase") {
    const sb = await ensureSupabase();
    const bucket = process.env.SUPABASE_BUCKET || "uploads";
    const prefix = (process.env.SUPABASE_PATH_PREFIX || "").replace(/^\/+|\/+$/g, "");
    const key = (prefix ? `${prefix}/` : "") + file.filename;
    const fileBuffer = fs.readFileSync(file.path);
    const contentType = file.mimetype || "application/octet-stream";
    const { data, error } = await sb.storage.from(bucket).upload(key, fileBuffer, { contentType, upsert: true });
    // Remove temp file after upload
    try { fs.unlinkSync(file.path); } catch {}
    if (error) throw error;

    const isPublic = String(process.env.SUPABASE_PUBLIC || "true").toLowerCase() === "true";
    if (isPublic) {
      const { data: pub } = sb.storage.from(bucket).getPublicUrl(key);
      return { storage: "supabase", bucket, key, url: pub.publicUrl };
    } else {
      const seconds = parseInt(process.env.SUPABASE_SIGNED_SECONDS || `${60*60*24*7}`, 10);
      const { data: signed, error: signErr } = await sb.storage.from(bucket).createSignedUrl(key, seconds);
      if (signErr) throw signErr;
      return { storage: "supabase", bucket, key, url: signed.signedUrl, expiresIn: seconds };
    }
  }

  // local (ephemeral)
  const url = buildPublicUrlLocal(req, file.filename);
  return {
    storage: "local",
    filename: file.filename,
    path: file.path,
    url
  };
}

// Single file
app.post("/api/upload-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file received. Use field 'image'." });
    const out = await handleFileResult(req, req.file);
    res.status(201).json({ message: "Uploaded", file: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Upload failed" });
  }
});

// Multiple files
app.post("/api/upload-images", upload.array("images", 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No files received. Use field 'images'." });
    const results = [];
    for (const f of files) {
      results.push(await handleFileResult(req, f));
    }
    res.status(201).json({ message: "Uploaded", files: results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Upload failed" });
  }
});

// 404
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Error handler
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: `File too large. Max ${MAX_FILE_MB} MB.` });
  }
  console.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[startup] storage=${STORAGE_PROVIDER}, localDir=${LOCAL_UPLOAD_DIR}`);
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
process.on("SIGINT", () => server.close(()=>process.exit(0)));
process.on("SIGTERM", () => server.close(()=>process.exit(0)));
