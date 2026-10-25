/**
 * Speich-AI renderer
 * Records short mic chunks → POST /api/sts/convert → plays result
 * Near-live STS (chunk latency ~1–2s depending on size)
 */

let token = localStorage.getItem("speich_token") || null;
let currentUser = null;
let authMode = "login";
let mediaStream = null;
let mediaRecorder = null;
let isRunning = false;
let selectedVoiceId = null;
let audioQueue = [];
let playing = false;

const $ = (id) => document.getElementById(id);

async function apiBase() {
  const fromStore = (await window.speich.getApiBase()) || "http://localhost:3850";
  return String(fromStore).replace(/\/$/, "");
}

async function api(path, opts = {}) {
  const base = await apiBase();
  const headers = { ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData)) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || "Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function showAuth() {
  $("authScreen").classList.remove("hidden");
  $("appScreen").classList.add("hidden");
}

function showApp() {
  $("authScreen").classList.add("hidden");
  $("appScreen").classList.remove("hidden");
}

function formatBalance(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${String(r).padStart(2, "0")}s left`;
}

function setBalance(sec) {
  if (currentUser) currentUser.balanceSeconds = sec;
  $("balanceLabel").textContent = formatBalance(sec);
}

function setStatus(t) {
  $("statusText").textContent = t;
}

// Auth UI
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    authMode = btn.dataset.mode;
    $("authSubmit").textContent = authMode === "login" ? "Login" : "Create account";
    $("authName").classList.toggle("hidden", authMode === "login");
  });
});

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("authError").textContent = "";
  try {
    const body = {
      email: $("authEmail").value.trim(),
      password: $("authPassword").value
    };
    if (authMode === "register") body.name = $("authName").value.trim();
    const path = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
    const data = await api(path, { method: "POST", body: JSON.stringify(body) });
    token = data.token;
    localStorage.setItem("speich_token", token);
    currentUser = data.user;
    await enterApp();
  } catch (err) {
    $("authError").textContent = err.message || "Auth failed";
  }
});

$("logoutBtn").addEventListener("click", () => {
  stopSession();
  token = null;
  currentUser = null;
  localStorage.removeItem("speich_token");
  showAuth();
});

$("refreshBalBtn").addEventListener("click", async () => {
  try {
    const data = await api("/api/me");
    currentUser = data.user;
    setBalance(data.user.balanceSeconds);
  } catch (err) {
    setStatus(err.message);
  }
});

$("saveApiBtn").addEventListener("click", async () => {
  const v = $("apiBaseInput").value.trim().replace(/\/$/, "");
  await window.speich.setSetting("apiBaseUrl", v);
  setStatus("API base saved");
});

async function enterApp() {
  showApp();
  setBalance(currentUser.balanceSeconds);
  const settings = await window.speich.getSettings();
  $("apiBaseInput").value = settings.apiBaseUrl || "http://localhost:3850";
  await loadVoices();
}

async function loadVoices() {
  const sel = $("voiceSelect");
  sel.innerHTML = `<option value="">Loading…</option>`;
  try {
    const data = await api("/api/voices");
    const voices = data.voices || [];
    if (!voices.length) {
      sel.innerHTML = `<option value="">No voices on ElevenLabs account</option>`;
      return;
    }
    sel.innerHTML = voices
      .map((v) => `<option value="${v.voiceId}">${escapeHtml(v.name)}</option>`)
      .join("");
    selectedVoiceId = voices[0].voiceId;
    sel.value = selectedVoiceId;
  } catch (err) {
    sel.innerHTML = `<option value="">Failed to load voices</option>`;
    setStatus(err.message);
  }
}

$("voiceSelect").addEventListener("change", (e) => {
  selectedVoiceId = e.target.value;
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- Recording / convert loop ----------
async function startSession() {
  if (isRunning) return;
  if (!selectedVoiceId) {
    setStatus("Select a voice first");
    return;
  }
  if ((currentUser?.balanceSeconds || 0) < 1) {
    setStatus("Insufficient balance — buy minutes");
    return;
  }

  try {
    await api("/api/sts/session", {
      method: "POST",
      body: JSON.stringify({ voiceId: selectedVoiceId })
    });
  } catch (err) {
    setStatus(err.message);
    return;
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      channelCount: 1
    }
  });

  // Level meter
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(mediaStream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  const dataArr = new Uint8Array(analyser.frequencyBinCount);
  function tickLevel() {
    if (!isRunning) return;
    analyser.getByteFrequencyData(dataArr);
    let sum = 0;
    for (let i = 0; i < dataArr.length; i++) sum += dataArr[i];
    const pct = Math.min(100, (sum / dataArr.length / 128) * 100);
    $("levelBar").style.width = `${pct}%`;
    requestAnimationFrame(tickLevel);
  }

  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime, audioBitsPerSecond: 64000 });

  mediaRecorder.ondataavailable = async (ev) => {
    if (!ev.data || ev.data.size < 500 || !isRunning) return;
    const blob = ev.data;
    // ~chunk duration estimate from timeslice
    const durationSeconds = 1.2;
    try {
      const ab = await blob.arrayBuffer();
      const b64 = arrayBufferToBase64(ab);
      const result = await api("/api/sts/convert", {
        method: "POST",
        body: JSON.stringify({
          voiceId: selectedVoiceId,
          audioBase64: b64,
          contentType: mime.split(";")[0],
          durationSeconds,
          filename: "chunk.webm"
        })
      });
      setBalance(result.balanceSeconds);
      if (result.balanceSeconds < 1) {
        setStatus("Balance empty — stopped");
        stopSession();
        return;
      }
      enqueuePlayback(result.audioBase64, result.contentType || "audio/mpeg");
      setStatus("Live · converting…");
    } catch (err) {
      if (err.status === 402) {
        setStatus("Insufficient balance");
        stopSession();
      } else {
        console.error(err);
        setStatus(err.message || "Convert error");
      }
    }
  };

  isRunning = true;
  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  setStatus("Listening…");
  mediaRecorder.start(1200); // ~1.2s chunks
  tickLevel();
}

function stopSession() {
  isRunning = false;
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch (_) {}
  mediaRecorder = null;
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  $("levelBar").style.width = "0%";
  if ($("statusText").textContent.startsWith("Live") || $("statusText").textContent.startsWith("Listening")) {
    setStatus("Stopped");
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function enqueuePlayback(b64, contentType) {
  const byteChars = atob(b64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: contentType });
  const url = URL.createObjectURL(blob);
  audioQueue.push(url);
  pumpAudio();
}

function pumpAudio() {
  if (playing || !audioQueue.length) return;
  playing = true;
  const url = audioQueue.shift();
  const el = $("playback");
  el.src = url;
  el.onended = () => {
    URL.revokeObjectURL(url);
    playing = false;
    pumpAudio();
  };
  el.play().catch((e) => {
    console.warn("play failed", e);
    playing = false;
    pumpAudio();
  });
}

$("startBtn").addEventListener("click", () => startSession().catch((e) => setStatus(e.message)));
$("stopBtn").addEventListener("click", stopSession);

// Boot
(async function init() {
  const settings = await window.speich.getSettings();
  $("apiBaseInput").value = settings.apiBaseUrl || "http://localhost:3850";
  if (token) {
    try {
      const data = await api("/api/me");
      currentUser = data.user;
      await enterApp();
      return;
    } catch (_) {
      token = null;
      localStorage.removeItem("speich_token");
    }
  }
  showAuth();
})();
