import { useEffect, useRef, useState } from "react";

const MAX_SECONDS = 60;   // thời lượng tối đa mỗi câu
const PRECOUNT_SEC = 3;   // đếm ngược trước khi bắt đầu ghi
const UPLOAD_RETRIES = 3; // số lần retry upload
const UPLOAD_BASE_DELAY = 500; // ms (exponential backoff: 0.5s, 1s, 2s)

export default function App() {
  // ===== Auth + Session =====
  const [token, setToken] = useState("demo123");
  const [name, setName] = useState("");
  const [tokenOk, setTokenOk] = useState(false);
  const [folder, setFolder] = useState(null);
  const [status, setStatus] = useState("Idle");

  // ===== Per-question =====
  const [qIndex, setQIndex] = useState(1);
  const [uploadedThisQ, setUploadedThisQ] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // ===== Recording / Timer =====
  const [cameraReady, setCameraReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(MAX_SECONDS);
  const [preCount, setPreCount] = useState(null);   // null = không đếm; số = đang đếm
  const [isPrecounting, setIsPrecounting] = useState(false);

  const intervalRef = useRef(null);
  const timeoutRef = useRef(null);
  const precountRef = useRef(null);

  // ===== Media =====
  const previewRef = useRef(null);
  const playRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const [blob, setBlob] = useState(null);
  const playbackUrlRef = useRef(null);

  // ===== Helpers =====
  function clearTimers() {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (precountRef.current) { clearInterval(precountRef.current); precountRef.current = null; }
  }
  useEffect(() => () => {
    clearTimers();
    if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current);
  }, []);

  // ===== API calls =====
async function verifyToken() {
  setStatus("Verifying token...");
  try {
    const r = await fetch("http://localhost:4000/api/verify-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: String(token).trim() }),
    });

    // Phòng trường hợp server trả non-JSON
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      const txt = await r.text();
      throw new Error(`Expected JSON, got: ${ct}. Body: ${txt.slice(0,120)}...`);
    }

    const d = await r.json();
    if (d.ok) { setTokenOk(true); setStatus("Token OK"); }
    else { setTokenOk(false); setStatus("Token invalid"); }
  } catch (e) {
    setTokenOk(false);
    setStatus("Verify error: " + (e?.message || "fetch failed"));
  }
}


  async function startSession() {
    if (!tokenOk) return alert("Hãy Verify Token trước.");
    if (!name.trim()) return alert("Nhập tên trước.");
    setStatus("Starting session...");
    try {
      const r = await fetch("/api/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, userName: name })
      });
      const d = await r.json();
      if (!d.ok) return alert("Start fail: " + (d.error || ""));
      setFolder(d.folder);
      setStatus(`Session started: ${d.folder}`);
    } catch (e) {
      setStatus("Start error: " + e.message);
    }
  }

  async function enableCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (previewRef.current) previewRef.current.srcObject = stream;
      setCameraReady(true);
      setStatus("Camera ready");
    } catch (e) {
      setCameraReady(false);
      alert("Không bật được camera/mic: " + e.message);
    }
  }

  // ===== Recording with pre-countdown + max time =====
  function startRecord() {
    if (!tokenOk || !folder || !cameraReady) {
      return alert("Cần Verify Token + Start Session + Enable camera trước.");
    }
    if (isRecording || isPrecounting) return;
    setUploadedThisQ(false);
    setBlob(null);
    chunksRef.current = [];

    // Pre-countdown 3s
    setIsPrecounting(true);
    setPreCount(PRECOUNT_SEC);
    setStatus(`Starting in ${PRECOUNT_SEC}...`);
    precountRef.current = setInterval(() => {
      setPreCount((s) => {
        const next = (s ?? PRECOUNT_SEC) - 1;
        if (next <= 0) {
          clearInterval(precountRef.current);
          precountRef.current = null;
          setIsPrecounting(false);
          setPreCount(null);
          startRecordReal();
        } else {
          setStatus(`Starting in ${next}...`);
        }
        return next;
      });
    }, 1000);
  }

  function startRecordReal() {
    const mr = new MediaRecorder(streamRef.current, { mimeType: "video/webm;codecs=vp8,opus" });
    mediaRecorderRef.current = mr;

    mr.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
    mr.onstop = () => {
      const b = new Blob(chunksRef.current, { type: "video/webm" });
      setBlob(b);
      const url = URL.createObjectURL(b);
      if (playRef.current) { playRef.current.src = url; playRef.current.controls = true; }
      if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current);
      playbackUrlRef.current = url;
      setIsRecording(false);
      clearTimers();
      setStatus(`Stopped Q${qIndex}`);
    };

    // start + timers
    setSecondsLeft(MAX_SECONDS);
    setIsRecording(true);
    mr.start();
    setStatus(`Recording Q${qIndex} (max ${MAX_SECONDS}s)...`);

    intervalRef.current = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);

    timeoutRef.current = setTimeout(() => {
      stopRecord(); // auto stop
    }, MAX_SECONDS * 1000);
  }

  function stopRecord() {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      mr.stop();
    }
    clearTimers();
    setIsRecording(false);
  }

  // ===== Upload with retry/backoff =====
  async function uploadWithRetry(fd) {
    let attempt = 0;
    let lastErr = null;
    while (attempt < UPLOAD_RETRIES) {
      try {
        const r = await fetch("/api/upload-one", { method: "POST", body: fd });
        const d = await r.json();
        if (d.ok) return d;
        lastErr = new Error(d.error || "upload failed");
      } catch (e) {
        lastErr = e;
      }
      // backoff
      const delay = UPLOAD_BASE_DELAY * Math.pow(2, attempt); // 0.5s, 1s, 2s
      await new Promise(res => setTimeout(res, delay));
      attempt++;
    }
    throw lastErr || new Error("upload failed");
  }

  async function uploadClip() {
    if (!folder) return alert("Chưa start session.");
    if (!blob) return alert("Chưa có clip — Start rồi Stop trước.");
    if (isRecording || isPrecounting) return alert("Hãy dừng ghi trước.");

    setIsUploading(true);
    try {
      const filename = `Q${qIndex}.webm`;
      const fd = new FormData();
      fd.append("token", token);
      fd.append("folder", folder);
      fd.append("questionIndex", String(qIndex));  // dự phòng
      fd.append("video", blob, filename);          // originalname = Q*.webm

      const d = await uploadWithRetry(fd);
      setUploadedThisQ(true);
      setStatus(`Uploaded: ${d.savedAs}`);
      alert(`Uploaded: ${d.savedAs}`);
    } catch (e) {
      setUploadedThisQ(false);
      setStatus("Upload error: " + e.message);
      alert("Upload error: " + e.message);
    } finally {
      setIsUploading(false);
    }
  }

  // ===== Finish & Next =====
  async function finishSession() {
    if (!folder) return alert("Chưa start session.");
    try {
      const r = await fetch("/api/session/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, folder, questionsCount: qIndex })
      });
      const d = await r.json();
      if (!d.ok) return alert("Finish fail: " + (d.error || ""));
      alert("Session finished!");
    } catch (e) {
      alert("Finish error: " + e.message);
    }
  }

  function nextQuestion() {
    if (!uploadedThisQ) return;
    setQIndex((q) => Math.min(q + 1, 5));
    setUploadedThisQ(false);
    setBlob(null);
    setSecondsLeft(MAX_SECONDS);
    setStatus(`Moved to Q${Math.min(qIndex + 1, 5)}`);
  }

  // ===== UI gating =====
  const canStart =
    tokenOk && !!folder && cameraReady && !isRecording && !isPrecounting && !isUploading;
  const progress = 1 - secondsLeft / MAX_SECONDS;

  return (
    <div style={{ fontFamily: "system-ui", padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1>Web Interview Recorder — Timer + Retry + Gating</h1>
      <p>Status: <b>{status}</b></p>

      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr auto", alignItems: "end" }}>
        <div>
          <label>Token</label>
          <input value={token} onChange={e => setToken(e.target.value)} style={{ width: "100%" }} />
        </div>
        <div>
          <label>Name</label>
          <input value={name} onChange={e => setName(e.target.value)} style={{ width: "100%" }} />
        </div>
        <button onClick={verifyToken}>Verify Token</button>
      </div>

      <div style={{ marginTop: 8 }}>
        <button onClick={startSession} disabled={!tokenOk || !name}>Start Session</button>
        <button onClick={enableCamera} style={{ marginLeft: 8 }}>Enable camera + mic</button>
      </div>

      {folder && (
        <p style={{ fontSize: 13, color: "#555", marginTop: 4 }}>
          Folder: <code>{folder}</code> (xem file qua <code>/uploads/{folder}/Q*.webm</code>)
        </p>
      )}

      <hr style={{ margin: "16px 0" }} />

      <h2>Question {qIndex}/5</h2>
      <video
        ref={previewRef}
        autoPlay
        playsInline
        muted
        style={{ width: "100%", border: "1px solid #ccc", borderRadius: 8 }}
      />

      {/* Pre-countdown + Timer */}
      <div style={{ marginTop: 12 }}>
        {isPrecounting ? (
          <div style={{ fontSize: 18, fontWeight: 600 }}>Starting in {preCount}s…</div>
        ) : (
          <>
            <div style={{ height: 8, background: "#eee", borderRadius: 6, overflow: "hidden" }}>
              <div
                style={{
                  width: `${progress * 100}%`,
                  height: "100%",
                  transition: "width 0.5s",
                  background: isRecording ? "#4caf50" : "#bbb"
                }}
              />
            </div>
            <div style={{ marginTop: 6, fontSize: 13, color: "#555" }}>
              {isRecording ? `Time left: ${secondsLeft}s` : `Max per question: ${MAX_SECONDS}s`}
            </div>
          </>
        )}
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={startRecord} disabled={!canStart}>Start</button>
        <button onClick={stopRecord} disabled={!isRecording}>Stop</button>
        <button onClick={uploadClip} disabled={isUploading || isRecording || isPrecounting}>
          {isUploading ? "Uploading..." : "Upload"}
        </button>
        <button onClick={nextQuestion} disabled={!uploadedThisQ}>Next</button>
        <button onClick={finishSession} style={{ marginLeft: 8 }}>Finish</button>
      </div>

      <p style={{ color: uploadedThisQ ? "green" : "#999", marginTop: 8 }}>
        {uploadedThisQ ? "Đã upload câu hiện tại ✔" : (isUploading ? "Đang upload…" : "Chưa upload")}
      </p>

      <video
        ref={playRef}
        playsInline
        style={{ width: "100%", marginTop: 12, border: "1px solid #ccc", borderRadius: 8 }}
      />
    </div>
  );
}
