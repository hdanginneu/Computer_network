import "./App.css";
import { useEffect, useRef, useState } from "react";

const API = "http://localhost:4000";
const MAX_SECONDS = 60;
const PRECOUNT_SEC = 3;

export default function App() {
  const [token, setToken] = useState("demo123");
  const [name, setName] = useState("");
  const [tokenOk, setTokenOk] = useState(false);
  const [folder, setFolder] = useState(null);
  const [status, setStatus] = useState("Idle");

  const [qIndex, setQIndex] = useState(1);

  // NEW: Lưu kết quả AI từng câu
  const [aiResults, setAiResults] = useState({});

  const [uploadedThisQ, setUploadedThisQ] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const [cameraReady, setCameraReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(MAX_SECONDS);
  const [preCount, setPreCount] = useState(null);
  const [isPrecounting, setIsPrecounting] = useState(false);

  const intervalRef = useRef(null);
  const timeoutRef = useRef(null);
  const precountRef = useRef(null);

  const previewRef = useRef(null);
  const playRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const [blob, setBlob] = useState(null);
  const playbackUrlRef = useRef(null);

  // Hiển thị AI của câu hiện tại
  const [aiTranscript, setAiTranscript] = useState("");
  const [aiSummary, setAiSummary] = useState("");
  const [aiLoading, setAiLoading] = useState(false);

  // ==========================
  // CLEAR TIMER
  // ==========================
  function clearTimers() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (precountRef.current) clearInterval(precountRef.current);
  }

  useEffect(() => () => {
    clearTimers();
    if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current);
  }, []);

  // ==========================
  // 🔥 AI ANALYSIS
  // ==========================
  async function analyzeByAI(videoFile) {
    try {
      setAiLoading(true);

      const fd = new FormData();
      fd.append("video", videoFile);

      const r = await fetch(`${API}/api/ai-analyze`, { method: "POST", body: fd });
      const d = await r.json();

      // Lưu vào AI kết quả từng câu
      setAiResults(prev => ({
        ...prev,
        [qIndex]: {
          transcript: d.transcript || "",
          summary: d.summary || ""
        }
      }));

      // Hiển thị lên UI
      setAiTranscript(d.transcript || "");
      setAiSummary(d.summary || "");

    } finally {
      setAiLoading(false);
    }
  }

  // ==========================
  // VERIFY TOKEN
  // ==========================
  async function verifyToken() {
    setStatus("Verifying token...");
    try {
      const r = await fetch(`${API}/api/verify-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: String(token).trim() }),
      });

      const d = await r.json();
      setTokenOk(d.ok);
      setStatus(d.ok ? "Token OK" : "Token invalid");

    } catch (e) {
      setStatus("Verify error: " + e.message);
    }
  }

  // ==========================
  // START SESSION
  // ==========================
  async function startSession() {
    if (!tokenOk) return alert("Hãy Verify Token trước.");
    if (!name.trim()) return alert("Nhập tên.");

    const r = await fetch(`${API}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, userName: name }),
    });

    const d = await r.json();
    if (!d.ok) return alert("Start fail");

    setFolder(d.folder);
    setStatus("Session Started");
  }

  // ==========================
  // CAMERA
  // ==========================
  async function enableCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      previewRef.current.srcObject = stream;
      setCameraReady(true);
    } catch (e) {
      alert("Không bật được camera: " + e.message);
    }
  }

  // ==========================
  // RECORDING
  // ==========================
  function startRecord() {
    if (!tokenOk || !folder || !cameraReady) return alert("Hãy verify + start session + bật camera.");

    setUploadedThisQ(false);
    setBlob(null);
    chunksRef.current = [];

    setIsPrecounting(true);
    setPreCount(PRECOUNT_SEC);
    setStatus(`Starting in ${PRECOUNT_SEC}`);

    precountRef.current = setInterval(() => {
      setPreCount(v => {
        const next = v - 1;
        if (next <= 0) {
          clearInterval(precountRef.current);
          setIsPrecounting(false);
          startRecordReal();
        }
        return next;
      });
    }, 1000);
  }

  function startRecordReal() {
    const mr = new MediaRecorder(streamRef.current, {
      mimeType: "video/webm;codecs=vp8,opus",
    });

    mediaRecorderRef.current = mr;

    mr.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };

    mr.onstop = () => {
      const b = new Blob(chunksRef.current, { type: "video/webm" });
      setBlob(b);

      const url = URL.createObjectURL(b);
      playRef.current.src = url;
      playRef.current.controls = true;

      if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current);
      playbackUrlRef.current = url;

      setIsRecording(false);
    };

    setSecondsLeft(MAX_SECONDS);
    setIsRecording(true);
    mr.start();

    intervalRef.current = setInterval(() => {
      setSecondsLeft(s => Math.max(0, s - 1));
    }, 1000);

    timeoutRef.current = setTimeout(stopRecord, MAX_SECONDS * 1000);
  }

  function stopRecord() {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") mr.stop();
    setIsRecording(false);
    clearTimers();
  }

  // ==========================
  // UPLOAD
  // ==========================
  async function uploadClip() {
    if (!blob) return alert("Chưa có video.");
    if (!folder) return alert("Chưa start session.");

    setIsUploading(true);

    const fd = new FormData();
    fd.append("token", token);
    fd.append("folder", folder);
    fd.append("questionIndex", String(qIndex));
    fd.append("video", new File([blob], `Q${qIndex}.webm`, { type: "video/webm" }));

    const r = await fetch(`${API}/api/upload-one`, { method: "POST", body: fd });
    const d = await r.json();

    if (!d.ok) {
      alert("Upload error");
    } else {
      setUploadedThisQ(true);
      setStatus("Uploaded");

      await analyzeByAI(new File([blob], `Q${qIndex}.webm`, { type: "video/webm" }));
      setStatus("AI analysis completed");
    }

    setIsUploading(false);
  }

  // ==========================
  // NEXT QUESTION
  // ==========================
  function nextQuestion() {
    if (!uploadedThisQ) return alert("Hãy upload trước khi next.");

    const nextQ = Math.min(qIndex + 1, 5);
    setQIndex(nextQ);

    // Clear UI
    setBlob(null);
    setAiTranscript("");
    setAiSummary("");
  }

  // ==========================
  // PREVIOUS / FORWARD
  // ==========================
  function goPrev() {
    if (qIndex > 1) setQIndex(qIndex - 1);
  }

  function goNext() {
    if (qIndex < 5) setQIndex(qIndex + 1);
  }

  // ==========================
  // LOAD AI KHI ĐỔI CÂU
  // ==========================
  useEffect(() => {
    if (aiResults[qIndex]) {
      setAiTranscript(aiResults[qIndex].transcript);
      setAiSummary(aiResults[qIndex].summary);
    } else {
      setAiTranscript("");
      setAiSummary("");
    }
  }, [qIndex]);


  // ==========================
  // FINISH SESSION
  // ==========================
  async function finishSession() {
    await fetch(`${API}/api/session/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, folder, questionsCount: qIndex }),
    });

    alert("Done!");
  }

  const canStart = tokenOk && folder && cameraReady && !isRecording && !isUploading;
  const progress = 1 - secondsLeft / MAX_SECONDS;

  // ==========================
  // UI
  // ==========================
  return (
    <div className="app-container">

      <h1 className="title">Offline Whisper Interview Recorder</h1>
      <p className="status">Status: <span>{status}</span></p>

      <div className="card auth-card">
        <div className="auth-grid">
          <div>
            <label>Token</label>
            <input value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <div>
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <button className="btn primary verify" onClick={verifyToken}>Verify</button>
        </div>

        <div className="auth-actions">
          <button className="btn primary" onClick={startSession}>Start Session</button>
          <button className="btn" onClick={enableCamera}>Enable Camera</button>
        </div>
      </div>

      <h2 className="subtitle">Question {qIndex} / 5</h2>

      <div className="nav-buttons">
        <button className="btn" onClick={goPrev} disabled={qIndex <= 1}>Previous</button>
        <button className="btn" onClick={goNext} disabled={qIndex >= 5}>Forward</button>
      </div>

      <video ref={previewRef} autoPlay muted playsInline className="camera-preview" />

      <div className="timer-wrap">
        {isPrecounting ? (
          <div className="precount">Starting in {preCount}…</div>
        ) : (
          <>
            <div className="timer-bar">
              <div
                className="timer-progress"
                style={{
                  width: `${progress * 100}%`,
                  background: isRecording ? "#00ffaa" : "#444",
                }}
              />
            </div>
            <div className="timer-text">
              {isRecording ? `Time left: ${secondsLeft}s` : `Max: ${MAX_SECONDS}s`}
            </div>
          </>
        )}
      </div>

      <div className="actions">
        <button className="btn primary" onClick={startRecord} disabled={!canStart}>Start</button>
        <button className="btn danger" onClick={stopRecord} disabled={!isRecording}>Stop</button>
        <button className="btn" onClick={uploadClip} disabled={!blob || isUploading}>
          {isUploading ? "Uploading…" : "Upload"}
        </button>
        <button className="btn" onClick={nextQuestion} disabled={!uploadedThisQ}>Next</button>
        <button className="btn" onClick={finishSession}>Finish</button>
      </div>

      <video ref={playRef} playsInline className="playback" />

      <div className="card ai-card">
        <h2 className="subtitle">AI Transcript</h2>
        <pre>{aiTranscript}</pre>

        <h2 className="subtitle">AI Summary / Feedback</h2>
        <pre>{aiSummary}</pre>
      </div>
    </div>
  );
}
