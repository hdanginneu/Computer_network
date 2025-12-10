# Web Interview Recorder (Local, Client–Server)

A small web app to record interview answers one question at a time (up to 5), upload each answer immediately, and only allow moving to the next question after a successful upload. Architecture: Frontend (React + Vite) ↔ Backend (Express), with server-side token verification.

1) Goals & Scope

Record sequentially Q1 → Q5 (you can stop earlier), one file per question.

Stop ⇒ Upload immediately; Next is enabled only after upload succeeds.

API flow: verify-token → session/start → upload-one (repeat per question) → session/finish.

Server persists a session folder (timestamp + username) plus a meta.json.

Extras implemented: 3-second pre-countdown, per-question time limit (default 60s), upload retry with backoff, and Start button gating (enabled only after Verify Token + Start Session + Enable Camera).

2) How it works (user flow)

Enter token and click Verify.

Enter Name and click Start Session ⇒ the server creates a session folder and returns its name.

Enable camera/mic, click Start ⇒ 3…2…1 ⇒ record (up to 60s) ⇒ Stop (auto when time is up).

Click Upload for the current question. When the server confirms, Next becomes available.

When finished, click Finish to write finishedAt and questionsCount to meta.json.

3) Project structure
web-interview-recorder/
├─ backend/
│  ├─ index.js
│  ├─ .env
│  └─ storage/                 # server output: Q*.webm + meta.json
└─ frontend/
   ├─ src/App.jsx              # UI + FE logic
   ├─ vite.config.js           # proxy /api → http://localhost:4000
   └─ ...

4) Setup & Run
Backend
cd backend
npm i
# .env (example)
cat > .env << 'EOF'
TOKEN_LIST=demo123,abc456
STORAGE_PATH=storage
MAX_SIZE_MB=50
PORT=4000
EOF

npm run dev
# console: "Backend http://localhost:4000"

Frontend
cd ../frontend
npm i
npm run dev
# open http://localhost:5173


Note: if your browser/proxy blocks the relative /api calls and Verify shows a JSON parse error, temporarily switch FE fetch URLs to absolute http://127.0.0.1:4000/... and it will work.

5) API (concise)

GET /api/health → service check.

POST /api/verify-token
Body: { token } → 200 { ok:true } or 401 for invalid token.

POST /api/session/start
Body: { token, userName } → 200 { ok:true, folder }.

POST /api/upload-one (multipart/form-data)
Fields:
token (string), folder (string), questionIndex ("1"… "5"),
video (file, mimetype video/webm, recommended filename Q{index}.webm).
200 { ok:true, savedAs:"Q{index}.webm" }
409 if out-of-order (sending Qk while Q1…Q(k−1) are missing)
415/413 for wrong MIME / oversized file.

POST /api/session/finish
Body: { token, folder, questionsCount } → 200 { ok:true }.

6) Storage convention (server)

Session folder: storage/DD_MM_YYYY_HH_mm_user_name/ (timezone Asia/Bangkok).

Video files: Q1.webm … Q5.webm.

Minimal meta.json:

{
  "userName": "user_name",
  "timeZone": "Asia/Bangkok",
  "uploaded": [
    { "q": 1, "file": "Q1.webm", "uploadedAt": "ISO-8601" }
  ],
  "startedAt": "ISO-8601",
  "finishedAt": "ISO-8601|null",
  "questionsCount": 1
}


You can review uploaded files at:
http://localhost:4000/uploads/<folder>/Q1.webm

7) Limits & Security

Accepted MIME: video/webm; max size via MAX_SIZE_MB (defaults to 50MB).

Order is enforced in the backend (you cannot skip questions).

Token is verified on the server. This is basic API-key style auth, which is sufficient for local coursework.

If deployed publicly, use HTTPS to get camera/mic permissions reliably in browsers.

8) Quick tests (optional)

Health:

curl -i http://127.0.0.1:4000/api/health


Out-of-order guard:

echo "dummy" > dummy.webm
# send Q2 before Q1 (expect 409)
curl -i -X POST http://127.0.0.1:4000/api/upload-one \
  -F "token=demo123" \
  -F "folder=<FOLDER_FROM_START_SESSION>" \
  -F "questionIndex=2" \
  -F "video=@dummy.webm;type=video/webm"

9) Demo script (≤ 3 minutes)

Verify Token → Start Session (show returned Folder).

Enable camera → Start (3-second countdown) → Stop (auto at 60s) → Upload → Next.

Repeat for 1–2 questions.

Open uploads/<folder>/ to show Q*.webm and meta.json.

10) API Reference
    
POST /api/verify-token
Validate the input token.

POST /api/session/start
Start a new interview session and create a storage folder.

POST /api/upload-one
Upload a single answer video (Q1–Q5).

Multipart fields:

token

folder

questionIndex

video (.webm)

POST /api/session/finish
Mark the interview as completed.

POST /api/ai/process
Run Whisper + GPT analysis on all uploaded videos.

Storage Format
Example session folder:

storage/10_12_2025_21_30_Nam/
├─ Q1.webm
├─ Q2.webm
├─ meta.json
└─ analysis.json

Finish.
