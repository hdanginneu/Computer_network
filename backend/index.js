import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { exec } from "child_process";
import { runWhisperLocal } from "./run_whisper_local.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ==================================================
// CONFIG
// ==================================================
const STORAGE_ROOT = "storage";
const TMP_AI = "tmp_ai";

const TOKEN_LIST = (process.env.TOKEN_LIST || "demo123")
  .split(",")
  .map(s => s.trim());

const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";

console.log("FFMPEG_BIN =", FFMPEG_BIN);

// Ensure folders exist
ensureDir(STORAGE_ROOT);
ensureDir(TMP_AI);

// ==================================================
// UTILS
// ==================================================
function ensureDir(p) {
  try {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  } catch (err) {
    console.error("[ERROR] Cannot create folder:", p, err);
  }
}

function sanitize(s = "") {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function timestampFolderName(user = "user") {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getDate())}_${pad(d.getMonth() + 1)}_${d.getFullYear()}_${pad(
    d.getHours()
  )}_${pad(d.getMinutes())}_${sanitize(user)}`;
}

function getQ(name = "") {
  const m = /Q(\d+)\.webm$/i.exec(name);
  return m ? Number(m[1]) : null;
}

function safeJsonRead(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    console.error("[ERROR] Cannot read JSON:", p, err);
    return null;
  }
}

function safeJsonWrite(p, data) {
  try {
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("[ERROR] Cannot write JSON:", p, err);
  }
}

// ==================================================
// VERIFY TOKEN
// ==================================================
app.post("/api/verify-token", (req, res) => {
  const token = req.body?.token;
  const ok = token && TOKEN_LIST.includes(token);
  res.json({ ok });
});

// ==================================================
// START SESSION
// ==================================================
app.post("/api/session/start", (req, res) => {
  const { token, userName } = req.body;

  if (!TOKEN_LIST.includes(token)) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }

  const folder = timestampFolderName(userName);
  const folderAbs = path.join(STORAGE_ROOT, folder);
  ensureDir(folderAbs);

  const meta = {
    userName,
    uploaded: [],
    startedAt: new Date().toISOString(),
    finishedAt: null
  };

  safeJsonWrite(path.join(folderAbs, "meta.json"), meta);

  res.json({ ok: true, folder });
});

// ==================================================
// UPLOAD Qn.webm
// ==================================================
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const abs = path.join(STORAGE_ROOT, req.body.folder);
    ensureDir(abs);
    cb(null, abs);
  },
  filename: (req, file, cb) => {
    const q = getQ(file.originalname) || Number(req.body.questionIndex) || 1;
    cb(null, `Q${q}.webm`);
  }
});

const uploadVideo = multer({ storage: videoStorage });

app.post("/api/upload-one", uploadVideo.single("video"), (req, res) => {
  const { token, folder } = req.body;

  if (!TOKEN_LIST.includes(token)) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }

  const abs = path.join(STORAGE_ROOT, folder);
  const metaPath = path.join(abs, "meta.json");
  const meta = safeJsonRead(metaPath);

  if (!meta) return res.status(500).json({ ok: false, error: "Corrupted metadata" });

  const q = getQ(req.file.filename);

  // Update upload list without duplicates
  meta.uploaded = [
    ...meta.uploaded.filter(x => x.q !== q),
    { q, file: req.file.filename, uploadedAt: new Date().toISOString() }
  ];

  safeJsonWrite(metaPath, meta);

  res.json({ ok: true, savedAs: req.file.filename });
});

// ==================================================
// FINISH SESSION
// ==================================================
app.post("/api/session/finish", (req, res) => {
  const { token, folder, questionsCount } = req.body;

  if (!TOKEN_LIST.includes(token)) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }

  const metaPath = path.join(STORAGE_ROOT, folder, "meta.json");
  const meta = safeJsonRead(metaPath);

  if (!meta) return res.status(500).json({ ok: false, error: "Corrupted metadata" });

  meta.finishedAt = new Date().toISOString();
  meta.questionsCount = questionsCount;

  safeJsonWrite(metaPath, meta);

  res.json({ ok: true });
});

// ==================================================
// FFMPEG: WEBM → WAV
// ==================================================
function convertToWav(webmPath) {
  return new Promise((resolve, reject) => {
    const wavPath = `${webmPath}.wav`;
    const cmd = `"${FFMPEG_BIN}" -y -i "${webmPath}" -ar 16000 -ac 1 "${wavPath}"`;

    console.log("[FFMPEG]", cmd);

    exec(cmd, { maxBuffer: 32 * 1024 * 1024 }, err => {
      if (err) return reject(err);
      resolve(wavPath);
    });
  });
}

// ==================================================
// RUN PYTHON SUMMARIZER
// ==================================================
function runAISummary(text) {
  return new Promise((resolve, reject) => {
    const safe = text.replace(/"/g, '\\"');
    const cmd = `python ai_summary.py "${safe}"`;

    exec(cmd, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);

      try {
        const data = JSON.parse(stdout);
        resolve(data.summary);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ==================================================
// AI ANALYZE
// ==================================================
const aiUpload = multer({ dest: TMP_AI });

app.post("/api/ai-analyze", aiUpload.single("video"), async (req, res) => {
  try {
    const inputPath = req.file.path;
    console.log("[AI] Uploaded:", inputPath);

    const wav = await convertToWav(inputPath);
    console.log("[AI] WAV created:", wav);

    const ai = await runWhisperLocal(wav);
    const transcript = ai.transcript;

    console.log("[AI] Generating summary...");
    const summary = await runAISummary(transcript);

    // Cleanup
    fs.unlinkSync(inputPath);
    fs.unlinkSync(wav);

    res.json({ ok: true, transcript, summary });
  } catch (err) {
    console.error("[AI ERROR]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==================================================
// START SERVER
// ==================================================
app.listen(4000, () => {
  console.log("🚀 Backend running: http://localhost:4000");
});
