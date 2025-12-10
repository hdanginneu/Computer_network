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

// =====================================
// CONFIG
// =====================================
const STORAGE_ROOT = "storage";
if (!fs.existsSync(STORAGE_ROOT)) fs.mkdirSync(STORAGE_ROOT, { recursive: true });

const TOKEN_LIST = (process.env.TOKEN_LIST || "demo123")
  .split(",")
  .map(s => s.trim());

const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";

console.log("FFMPEG_BIN   =", FFMPEG_BIN);

// =====================================
// UTILS
// =====================================
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
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

function makeFolder(user) {
  const d = new Date();
  const pad = n => (n < 10 ? "0" + n : n);
  return `${pad(d.getDate())}_${pad(d.getMonth() + 1)}_${d.getFullYear()}_${pad(
    d.getHours()
  )}_${pad(d.getMinutes())}_${sanitize(user || "user")}`;
}

function getQ(name = "") {
  const m = /Q(\d+)\.webm$/i.exec(name);
  return m ? Number(m[1]) : null;
}

// =====================================
// VERIFY TOKEN
// =====================================
app.post("/api/verify-token", (req, res) => {
  const token = req.body?.token;
  if (!token || !TOKEN_LIST.includes(token)) {
    return res.status(401).json({ ok: false, error: "invalid token" });
  }
  res.json({ ok: true });
});

// =====================================
// START SESSION
// =====================================
app.post("/api/session/start", (req, res) => {
  const { token, userName } = req.body || {};
  if (!TOKEN_LIST.includes(token)) return res.status(401).json({ ok: false });

  const folder = makeFolder(userName);
  const folderAbs = path.join(STORAGE_ROOT, folder);
  ensureDir(folderAbs);

  fs.writeFileSync(
    path.join(folderAbs, "meta.json"),
    JSON.stringify(
      {
        userName,
        uploaded: [],
        startedAt: new Date().toISOString(),
        finishedAt: null
      },
      null,
      2
    )
  );

  res.json({ ok: true, folder });
});

// =====================================
// UPLOAD Qn.webm
// =====================================
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = req.body.folder;
    const abs = path.join(STORAGE_ROOT, folder);
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
  if (!TOKEN_LIST.includes(token)) return res.status(401).json({ ok: false });

  const abs = path.join(STORAGE_ROOT, folder);
  const metaPath = path.join(abs, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath));

  const q = getQ(req.file.filename);

  meta.uploaded = [
    ...meta.uploaded.filter(x => x.q !== q),
    { q, file: req.file.filename, uploadedAt: new Date().toISOString() }
  ];

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  res.json({ ok: true, savedAs: req.file.filename });
});

// =====================================
// FINISH SESSION
// =====================================
app.post("/api/session/finish", (req, res) => {
  const { token, folder, questionsCount } = req.body;
  if (!TOKEN_LIST.includes(token)) return res.status(401).json({ ok: false });

  const metaPath = path.join(STORAGE_ROOT, folder, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath));

  meta.finishedAt = new Date().toISOString();
  meta.questionsCount = questionsCount;

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  res.json({ ok: true });
});

// =================================================
// CONVERT WEBM → WAV (FFMPEG)
// =================================================
function convertToWav(webmPath) {
  const wav = webmPath + ".wav";
  const cmd = `"${FFMPEG_BIN}" -y -i "${webmPath}" -ar 16000 -ac 1 "${wav}"`;

  console.log("[FFMPEG] Running:", cmd);

  return new Promise((resolve, reject) => {
    exec(
      cmd,
      { maxBuffer: 16 * 1024 * 1024 },
      (err) => {
        if (err) return reject(err);
        resolve(wav);
      }
    );
  });
}

// =================================================
// NEW — RUN TRUE AI SUMMARIZER
// =================================================
function runAISummary(text) {
  return new Promise((resolve, reject) => {
    const safe = text.replace(/"/g, '\\"');
    const cmd = `python ai_summary.py "${safe}"`;

    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
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

// =================================================
// API AI-ANALYZE
// =================================================
ensureDir("tmp_ai");
const aiUpload = multer({ dest: "tmp_ai/" });

app.post("/api/ai-analyze", aiUpload.single("video"), async (req, res) => {
  try {
    console.log("[AI] Received video:", req.file.path);

    const wav = await convertToWav(req.file.path);
    console.log("[AI] WAV:", wav);

    // 1️⃣ WHISPER LOCAL → TRANSCRIPT
    const ai = await runWhisperLocal(wav);
    const transcript = ai.transcript;

    // 2️⃣ AI SUMMARY REAL MODEL
    console.log("[AI] Running summarizer...");
    const summary = await runAISummary(transcript);
    console.log("[AI] Summary OK");

    // cleanup
    fs.unlinkSync(req.file.path);
    fs.unlinkSync(wav);

    res.json({ ok: true, transcript, summary });

  } catch (err) {
    console.error("[AI ERROR]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =================================================
// START SERVER
// =================================================
app.listen(4000, () => {
  console.log("Backend running http://localhost:4000");
});
