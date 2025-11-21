// backend/index.js
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ====== cấu hình cơ bản ======
const STORAGE_ROOT = process.env.STORAGE_PATH || "storage";
const TIMEZONE = "Asia/Bangkok";
const TOKEN_LIST = (process.env.TOKEN_LIST || "demo123,abc456")
  .split(",").map(s => s.trim()).filter(Boolean);
const MAX_Q = 5;

ensureDir(STORAGE_ROOT);
app.use("/uploads", express.static(STORAGE_ROOT)); // xem lại file đã upload

// ====== utils ======
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function sanitizeName(s = "") {
  return s.toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "user";
}
function formatFolderName(userName) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value || "";
  const DD = get("day"), MM = get("month"), YYYY = get("year");
  const HH = get("hour"), mm = get("minute");
  return `${DD}_${MM}_${YYYY}_${HH}_${mm}_${sanitizeName(userName)}`;
}
function mergeMeta(folderAbs, updater) {
  const metaPath = path.join(folderAbs, "meta.json");
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch {}
  const next = updater(meta);
  fs.writeFileSync(metaPath, JSON.stringify(next, null, 2));
}
function clampQ(i) {
  const n = parseInt(i, 10);
  if (Number.isNaN(n)) return null;
  return Math.max(1, Math.min(MAX_Q, n));
}
function getIndexFromOriginalName(original) {
  const m = /Q(\d+)\.webm$/i.exec(original || "");
  const i = m ? parseInt(m[1], 10) : NaN;
  return Number.isNaN(i) ? null : clampQ(i);
}
function fileExists(f) {
  try { return fs.existsSync(f); } catch { return false; }
}

// ====== health ======
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "backend", time: new Date().toISOString() });
});

// ====== 1) verify-token ======
app.post("/api/verify-token", (req, res) => {
  const { token } = req.body || {};
  if (!token || !TOKEN_LIST.includes(token)) {
    return res.status(401).json({ ok: false, error: "invalid token" });
  }
  return res.json({ ok: true });
});

// ====== 2) session/start ======
app.post("/api/session/start", (req, res) => {
  const { token, userName } = req.body || {};
  if (!token || !TOKEN_LIST.includes(token)) {
    return res.status(401).json({ ok: false, error: "invalid token" });
  }
  const folder = formatFolderName(userName || "user");
  const folderAbs = path.join(STORAGE_ROOT, folder);
  ensureDir(folderAbs);

  mergeMeta(folderAbs, (prev) => ({
    userName: userName || "user",
    timeZone: TIMEZONE,
    uploaded: prev.uploaded || [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    questionsCount: prev.questionsCount || null
  }));

  return res.json({ ok: true, folder });
});

// ====== 3) upload-one (enforce thứ tự) ======
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { folder } = req.body || {};
    if (!folder) return cb(new Error("missing folder"), null);
    const folderAbs = path.join(STORAGE_ROOT, folder);
    ensureDir(folderAbs);
    cb(null, folderAbs);
  },
  filename: (req, file, cb) => {
    const fromName = getIndexFromOriginalName(file.originalname);
    const fromBody = clampQ(req.body?.questionIndex);
    const q = fromName ?? fromBody ?? 1;
    const finalName = `Q${q}.webm`;
    console.log("[upload-one] originalname=", file.originalname,
                " body.questionIndex=", req.body?.questionIndex,
                " -> savedAs=", finalName);
    cb(null, finalName);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: (Number(process.env.MAX_SIZE_MB || 50)) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "video/webm") return cb(new Error("invalid mime"), false);
    cb(null, true);
  },
});

// middleware: kiểm tra thứ tự trước khi lưu
function enforceSequential(req, res, next) {
  const { folder } = req.body || {};
  if (!folder) return res.status(400).json({ ok: false, error: "missing folder" });

  // Q mục tiêu:
  const qFromBody = clampQ(req.body?.questionIndex);
  const qFromName = getIndexFromOriginalName(req?.file?.originalname || req?.body?.filename);
  const q = qFromBody ?? qFromName ?? 1;

  // Tất cả Q1..Q(q-1) phải tồn tại
  const folderAbs = path.join(STORAGE_ROOT, folder);
  for (let k = 1; k < q; k++) {
    const must = path.join(folderAbs, `Q${k}.webm`);
    if (!fileExists(must)) {
      return res.status(409).json({
        ok: false,
        error: "sequential_violation",
        message: `Q${q} bị từ chối vì thiếu Q${k}. Hãy upload tuần tự.`,
        missing: k
      });
    }
  }
  // OK
  req._targetQ = q;
  next();
}

app.post(
  "/api/upload-one",
  // LƯU Ý: dùng multer.any() để đọc được body trước khi quyết định tên file
  multer({ storage, limits: { fileSize: (Number(process.env.MAX_SIZE_MB || 50)) * 1024 * 1024 },
           fileFilter: (req, file, cb) => file.mimetype === "video/webm" ? cb(null, true) : cb(new Error("invalid mime"), false)
  }).single("video"),
  (req, res, next) => {
    // sau khi multer parse xong, enforce thứ tự dựa trên body & các file đã có
    return enforceSequential(req, res, next);
  },
  (req, res) => {
    const { token, folder } = req.body || {};
    if (!token || !TOKEN_LIST.includes(token)) {
      return res.status(401).json({ ok: false, error: "invalid token" });
    }
    if (!req.file) return res.status(400).json({ ok: false, error: "no file" });

    const folderAbs = path.join(STORAGE_ROOT, folder);
    const q = req._targetQ || getIndexFromOriginalName(req.file.filename) || 1;

    mergeMeta(folderAbs, (prev) => {
      const list = Array.isArray(prev.uploaded) ? prev.uploaded : [];
      const entry = { q, file: `Q${q}.webm`, uploadedAt: new Date().toISOString() };
      const filtered = list.filter(x => x.q !== entry.q);
      return { ...prev, uploaded: [...filtered, entry].sort((a, b) => a.q - b.q) };
    });

    return res.json({ ok: true, savedAs: `Q${q}.webm` });
  }
);

// ====== 4) session/finish ======
app.post("/api/session/finish", (req, res) => {
  const { token, folder, questionsCount } = req.body || {};
  if (!token || !TOKEN_LIST.includes(token)) {
    return res.status(401).json({ ok: false, error: "invalid token" });
  }
  if (!folder) return res.status(400).json({ ok: false, error: "missing folder" });

  const folderAbs = path.join(STORAGE_ROOT, folder);
  if (!fs.existsSync(folderAbs)) return res.status(400).json({ ok: false, error: "folder not found" });

  mergeMeta(folderAbs, (prev) => ({
    ...prev,
    questionsCount: Number(questionsCount || prev.questionsCount || 0),
    finishedAt: new Date().toISOString()
  }));

  return res.json({ ok: true });
});

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => console.log(`Backend http://localhost:${PORT}`));
