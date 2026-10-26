/**
 * Speich-AI renderer
 * Records short mic chunks → POST /api/sts/convert → plays result
 * Near-live STS (chunk latency ~1–2s depending on size)
 *
 * UI notes: the stage draws two live "ribbons" — amber is your microphone,
 * lilac is the converted voice — driven by real Web Audio analysers.
 */

let token = localStorage.getItem("speich_token") || null;
let currentUser = null;
let authMode = "login";
let mediaStream = null;
let mediaRecorder = null;
let isRunning = false;
let starting = false;
let selectedVoiceId = null;
let voices = [];
let audioQueue = [];
let playing = false;

// audio graph
let ac = null;
let micAnalyser = null;
let micSource = null;
let outAnalyser = null;
let levelBuf = null;

// session stats
let sessionStart = 0;
let elapsedTimer = null;
let inflight = 0;

const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* ============================================================
   API
   ============================================================ */
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

/* ============================================================
   Ribbons — the live waveform
   ============================================================ */
function createRibbons(canvas, { levels, ambient = 0.08 }) {
  const ctx = canvas.getContext("2d");
  const cs = getComputedStyle(document.documentElement);
  const COLOR = { you: cs.getPropertyValue("--you").trim(), voice: cs.getPropertyValue("--voice").trim() };
  let w = 0, h = 0, raf = 0, running = false, you = 0, voice = 0;
  const t0 = performance.now();

  const ro = new ResizeObserver(() => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = r.width;
    h = r.height;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!running) frame(performance.now());
  });
  ro.observe(canvas);

  // fast attack, slow release — reads like a real meter
  const follow = (cur, target) => cur + (target - cur) * (target > cur ? 0.35 : 0.08);

  function graticule() {
    ctx.save();
    ctx.strokeStyle = "rgba(236,234,246,0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 48) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
    ctx.stroke();
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = "rgba(236,234,246,0.14)";
    ctx.beginPath();
    ctx.moveTo(0, Math.round(h / 2) + 0.5);
    ctx.lineTo(w, Math.round(h / 2) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  function ribbon(t, amp, color, phase, speed, lw, alpha, dy) {
    ctx.beginPath();
    for (let x = 0; x <= w; x += 4) {
      const u = x / w;
      const env = Math.pow(Math.sin(Math.PI * u), 1.4);
      const y =
        h / 2 + dy +
        env * amp * (Math.sin(u * 9 + t * speed + phase) * 0.65 + Math.sin(u * 17 - t * speed * 1.3 + phase * 2) * 0.35);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  function frame(now) {
    if (!w || !h) { if (running) raf = requestAnimationFrame(frame); return; }
    const t = reduceMotion.matches ? 0 : (now - t0) / 1000;
    const L = levels(t);
    you = follow(you, L.you);
    voice = follow(voice, L.voice);

    ctx.clearRect(0, 0, w, h);
    graticule();

    const maxA = h * 0.4;
    const idle = ambient * (0.75 + 0.25 * Math.sin(t * 0.7));
    const aYou = maxA * (idle + you * 0.9);
    const aVoice = maxA * (idle * 0.9 + voice * 0.9);

    ctx.globalCompositeOperation = "lighter";
    ctx.shadowBlur = 14;
    ctx.shadowColor = COLOR.voice;
    ribbon(t, aVoice, COLOR.voice, 1.6, 0.9, 2.6, 0.95, 3);
    ctx.shadowBlur = 0;
    ribbon(t, aVoice * 0.7, COLOR.voice, 2.1, 0.7, 1.4, 0.35, 4);
    ctx.shadowBlur = 14;
    ctx.shadowColor = COLOR.you;
    ribbon(t, aYou, COLOR.you, 0, 1.15, 2.2, 0.95, -3);
    ctx.shadowBlur = 0;
    ribbon(t, aYou * 0.7, COLOR.you, 0.7, 0.85, 1.2, 0.3, -4);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    if (running) raf = requestAnimationFrame(frame);
  }

  return {
    start() { if (running) return; running = true; raf = requestAnimationFrame(frame); },
    stop() { running = false; cancelAnimationFrame(raf); }
  };
}

function rms(analyser) {
  analyser.getByteTimeDomainData(levelBuf);
  let s = 0;
  for (let i = 0; i < levelBuf.length; i++) {
    const v = (levelBuf[i] - 128) / 128;
    s += v * v;
  }
  return Math.min(1, Math.sqrt(s / levelBuf.length) * 3.4);
}

function setNode(id, on) {
  const el = $(id);
  if (el._on !== on) { el._on = on; el.classList.toggle("on", on); }
}

const authRibbons = createRibbons($("authCanvas"), {
  ambient: 0.2,
  levels: () => {
    const n = performance.now();
    return { you: 0.16 + 0.12 * Math.sin(n / 1300), voice: 0.18 + 0.14 * Math.sin(n / 1700 + 1.2) };
  }
});

const stageRibbons = createRibbons($("stageCanvas"), {
  ambient: 0.075,
  levels: () => {
    const you = micAnalyser ? rms(micAnalyser) : 0;
    const voice = outAnalyser && playing ? rms(outAnalyser) : 0;
    setNode("nodeMic", you > 0.08);
    setNode("nodeConv", inflight > 0);
    setNode("nodeOut", playing && voice > 0.04);
    return { you, voice };
  }
});

/* ============================================================
   Screens
   ============================================================ */
function swapScreens(toApp, animate = true) {
  const apply = () => {
    $("authScreen").classList.toggle("hidden", toApp);
    $("appScreen").classList.toggle("hidden", !toApp);
    if (toApp) { authRibbons.stop(); stageRibbons.start(); }
    else { stageRibbons.stop(); authRibbons.start(); }
  };
  if (animate && document.startViewTransition && !reduceMotion.matches) {
    document.startViewTransition(apply);
  } else {
    apply();
  }
}
const showAuth = (animate) => swapScreens(false, animate);
const showApp = (animate) => swapScreens(true, animate);

/* ============================================================
   Small UI helpers
   ============================================================ */
function toast(msg, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind === "error" ? "error" : ""}`;
  el.textContent = msg;
  $("toasts").appendChild(el);
  const life = kind === "error" ? 5000 : 3000;
  setTimeout(() => {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  }, life);
  while ($("toasts").children.length > 3) $("toasts").firstChild.remove();
}

function setStatus(text, state) {
  const el = $("statusText");
  if (state) $("statusChip").dataset.state = state;
  if (el.textContent !== text) {
    el.textContent = text;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }
}

function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

/* ---------- Balance (animated count) ---------- */
let balShown = null;
let balRaf = 0;

function formatBalance(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${String(r).padStart(2, "0")}s`;
}

function paintBalance(sec) {
  $("balanceLabel").textContent = formatBalance(sec);
}

function setBalance(sec) {
  if (currentUser) currentUser.balanceSeconds = sec;
  const to = Math.max(0, Math.floor(sec || 0));
  $("balancePill").dataset.tone = to < 60 ? "critical" : to < 300 ? "low" : "ok";
  $("balancePill").setAttribute("aria-label", `Balance: ${formatBalance(to)} left`);

  cancelAnimationFrame(balRaf);
  if (balShown === null || reduceMotion.matches || Math.abs(to - balShown) < 1) {
    balShown = to;
    paintBalance(to);
    return;
  }
  const from = balShown;
  const start = performance.now();
  const dur = 650;
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    balShown = Math.round(from + (to - from) * e);
    paintBalance(balShown);
    if (p < 1) balRaf = requestAnimationFrame(step);
  };
  balRaf = requestAnimationFrame(step);
}

/* ============================================================
   Auth UI
   ============================================================ */
function setAuthMode(mode) {
  authMode = mode;
  const reg = mode === "register";
  $("authSeg").dataset.mode = mode;
  document.querySelectorAll(".tab").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  $("authSubmitLabel").textContent = reg ? "Create account" : "Log in";
  $("authHeading").textContent = reg ? "Create your account" : "Welcome back";
  $("authSub").textContent = reg ? "Set up in a minute, then pick a voice." : "Log in to pick up where you left off.";
  $("nameWrap").classList.toggle("open", reg);
  $("nameWrap").inert = !reg;
  $("authPassword").autocomplete = reg ? "new-password" : "current-password";
  clearAuthError();
}
document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => setAuthMode(btn.dataset.mode)));
$("nameWrap").inert = true;

function showAuthError(msg) {
  const el = $("authError");
  el.textContent = msg;
  el.classList.add("show");
}
function clearAuthError() {
  $("authError").classList.remove("show");
}

$("pwToggle").addEventListener("click", () => {
  const input = $("authPassword");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("pwToggle").setAttribute("aria-pressed", String(show));
  $("pwToggle").setAttribute("aria-label", show ? "Hide password" : "Show password");
});

$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAuthError();
  const btn = $("authSubmit");
  btn.disabled = true;
  btn.classList.add("loading");
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
    showAuthError(err.message || "Could not sign in. Check your details and server address.");
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
  }
});

$("logoutBtn").addEventListener("click", () => {
  stopPreview();
  stopSession();
  token = null;
  currentUser = null;
  balShown = null;
  localStorage.removeItem("speich_token");
  $("authPassword").value = "";
  showAuth();
});

$("refreshBalBtn").addEventListener("click", async () => {
  const btn = $("refreshBalBtn");
  btn.classList.remove("spin");
  void btn.offsetWidth;
  btn.classList.add("spin");
  try {
    const data = await api("/api/me");
    currentUser = data.user;
    setBalance(data.user.balanceSeconds);
  } catch (err) {
    toast(err.message || "Could not refresh balance", "error");
  }
});

/* ---------- Settings dialog ---------- */
async function openSettings() {
  $("apiBaseInput").value = await apiBase();
  $("settingsDialog").showModal();
}
$("settingsBtn").addEventListener("click", openSettings);
$("authServerBtn").addEventListener("click", openSettings);
$("cancelApiBtn").addEventListener("click", () => $("settingsDialog").close());
$("settingsDialog").addEventListener("click", (e) => {
  if (e.target === $("settingsDialog")) $("settingsDialog").close(); // click on backdrop
});
$("settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = $("apiBaseInput").value.trim().replace(/\/$/, "");
  if (!v) return;
  await window.speich.setSetting("apiBaseUrl", v);
  $("settingsDialog").close();
  toast("Server address saved");
});

/* ============================================================
   Voices
   ============================================================ */
function escapeText(s) { return String(s == null ? "" : s); }

function hueFor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

function voiceSub(v) {
  const l = v.labels || {};
  const bits = [l.gender, l.accent, l.age].filter(Boolean);
  return bits.length ? bits.join(", ") : v.category || "";
}

const PLAY_SVG = `<svg viewBox="0 0 34 34" aria-hidden="true">
  <circle class="ring-bg" cx="17" cy="17" r="14.5"/>
  <circle class="ring" cx="17" cy="17" r="14.5" transform="rotate(-90 17 17)"/>
  <path class="i-play" d="M14 11.5v11l9-5.5z"/>
  <g class="i-pause"><rect x="12.5" y="11.5" width="3.2" height="11" rx="1.1"/><rect x="18.3" y="11.5" width="3.2" height="11" rx="1.1"/></g>
</svg>`;

function renderVoices() {
  stopPreview();
  const box = $("voiceItems");
  box.textContent = "";
  voices.forEach((v) => {
    const wrap = document.createElement("div");
    wrap.className = "voice-row";
    wrap.dataset.name = (v.name || "").toLowerCase();

    const row = document.createElement("button");
    row.type = "button";
    row.className = "voice";
    row.setAttribute("role", "radio");
    row.dataset.id = v.voiceId;
    row.style.setProperty("--h", hueFor(v.name || v.voiceId));

    const mono = document.createElement("span");
    mono.className = "mono";
    mono.textContent = (v.name || "?").trim().charAt(0).toUpperCase();

    const text = document.createElement("span");
    text.className = "v-text";
    const name = document.createElement("span");
    name.className = "v-name";
    name.textContent = escapeText(v.name);
    const sub = document.createElement("span");
    sub.className = "v-sub";
    sub.textContent = voiceSub(v);
    text.append(name, sub);

    row.append(mono, text);
    row.addEventListener("click", () => selectVoice(v.voiceId, { focus: false }));
    wrap.appendChild(row);

    // preview button sits beside the voice, never inside the radio button
    if (v.previewUrl) {
      wrap.classList.add("has-preview");
      const pb = document.createElement("button");
      pb.type = "button";
      pb.className = "play";
      pb.dataset.state = "idle";
      pb.dataset.name = v.name || "voice";
      pb.setAttribute("aria-label", `Play preview of ${v.name || "voice"}`);
      pb.innerHTML = PLAY_SVG;
      pb.addEventListener("click", () => togglePreview(v, pb));
      wrap.appendChild(pb);
    }
    box.appendChild(wrap);
  });

  $("voiceCount").textContent = voices.length ? String(voices.length) : "";
  $("voiceSearchWrap").classList.toggle("off", voices.length <= 8);
  const empty = document.createElement("p");
  empty.className = "voice-empty hidden";
  empty.id = "voiceEmpty";
  empty.textContent = "No voices match that search.";
  box.appendChild(empty);
  selectVoice(selectedVoiceId, { instant: true });
}

/* ---------- Voice preview ---------- */
let preview = null; // { id, audio, btn }

function setPreviewState(btn, state) {
  btn.dataset.state = state;
  btn.setAttribute("aria-label", `${state === "idle" ? "Play" : "Stop"} preview of ${btn.dataset.name}`);
  if (state !== "playing") btn.style.setProperty("--p", "0");
}

function stopPreview() {
  if (!preview) return;
  const { audio, btn } = preview;
  preview = null; // clear first so the audio's own events are ignored
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  setPreviewState(btn, "idle");
}

function previewFailed(cur) {
  if (preview !== cur) return;
  setPreviewState(cur.btn, "idle");
  preview = null;
  toast("Couldn't play this preview. Check your connection and try again.", "error");
}

function togglePreview(v, btn) {
  if (isRunning || starting) {
    toast("Stop your session to preview voices");
    return;
  }
  if (preview && preview.id === v.voiceId) { stopPreview(); return; }
  stopPreview();

  const audio = new Audio();
  const cur = { id: v.voiceId, audio, btn };
  preview = cur;
  setPreviewState(btn, "loading");

  audio.addEventListener("playing", () => { if (preview === cur) setPreviewState(btn, "playing"); });
  audio.addEventListener("timeupdate", () => {
    if (preview === cur && audio.duration) btn.style.setProperty("--p", (audio.currentTime / audio.duration).toFixed(3));
  });
  audio.addEventListener("ended", () => {
    if (preview !== cur) return;
    btn.style.setProperty("--p", "1");
    setTimeout(() => { if (preview === cur) { setPreviewState(btn, "idle"); preview = null; } }, 180);
  });
  audio.addEventListener("error", () => previewFailed(cur));
  audio.src = v.previewUrl;
  audio.play().catch((err) => { if (err.name !== "AbortError") previewFailed(cur); });
}

function selectVoice(id, { instant = false, focus = false } = {}) {
  selectedVoiceId = id;
  const v = voices.find((x) => x.voiceId === id);
  const h2 = $("speakingAs");
  const label = v ? v.name : "Choose a voice";
  if (h2.textContent !== label) {
    h2.textContent = label;
    h2.classList.remove("swap");
    void h2.offsetWidth;
    if (!instant) h2.classList.add("swap");
  }
  document.querySelectorAll("#voiceItems .voice").forEach((r) => {
    const on = r.dataset.id === id;
    r.setAttribute("aria-checked", String(on));
    r.tabIndex = on ? 0 : -1;
    if (on && focus) r.focus();
  });
  placeHighlight(instant);
}

function placeHighlight(instant) {
  const hi = $("voiceHi");
  const radio = document.querySelector(`#voiceItems .voice[aria-checked="true"]`);
  const row = radio && radio.parentElement;
  if (!row || row.classList.contains("hide")) { hi.classList.remove("show"); return; }
  hi.style.height = `${row.offsetHeight}px`;
  if (instant || !hi.classList.contains("show")) hi.classList.remove("ready");
  hi.style.transform = `translateY(${row.offsetTop}px)`;
  hi.classList.add("show");
  if (!hi.classList.contains("ready")) requestAnimationFrame(() => requestAnimationFrame(() => hi.classList.add("ready")));
  if (!instant) row.scrollIntoView({ block: "nearest", behavior: reduceMotion.matches ? "auto" : "smooth" });
}

$("voiceList").addEventListener("keydown", (e) => {
  if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  if (!e.target.closest(".voice")) return; // leave the play buttons alone
  const rows = [...document.querySelectorAll("#voiceItems .voice-row:not(.hide) .voice")];
  if (!rows.length) return;
  e.preventDefault();
  let i = rows.findIndex((r) => r.dataset.id === selectedVoiceId);
  if (e.key === "Home") i = 0;
  else if (e.key === "End") i = rows.length - 1;
  else i = Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1)));
  selectVoice(rows[i].dataset.id, { focus: true });
});

$("voiceSearch").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll("#voiceItems .voice-row").forEach((r) => {
    const hit = !q || r.dataset.name.includes(q);
    r.classList.toggle("hide", !hit);
    if (hit) shown++;
  });
  $("voiceEmpty").classList.toggle("hidden", shown > 0);
  placeHighlight(true);
});

window.addEventListener("resize", () => placeHighlight(true));

async function loadVoices() {
  stopPreview();
  const box = $("voiceItems");
  box.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  $("voiceHi").classList.remove("show");
  try {
    const data = await api("/api/voices");
    voices = data.voices || [];
    if (!voices.length) {
      box.innerHTML = "";
      const p = document.createElement("p");
      p.className = "voice-empty";
      p.textContent = "No voices found on your ElevenLabs account.";
      box.appendChild(p);
      $("voiceCount").textContent = "";
      selectVoice(null, { instant: true });
      return;
    }
    if (!voices.some((v) => v.voiceId === selectedVoiceId)) selectedVoiceId = voices[0].voiceId;
    renderVoices();
  } catch (err) {
    box.innerHTML = "";
    const p = document.createElement("p");
    p.className = "voice-empty";
    p.textContent = "Could not load voices. Check your server address and try again.";
    box.appendChild(p);
    toast(err.message || "Failed to load voices", "error");
  }
}

/* ============================================================
   Recording / convert loop
   ============================================================ */
function ensureAudioGraph() {
  if (!ac) ac = new AudioContext();
  if (ac.state === "suspended") ac.resume();
  if (!outAnalyser) {
    // route playback through an analyser so the Voice ribbon reacts to real output
    const src = ac.createMediaElementSource($("playback"));
    outAnalyser = ac.createAnalyser();
    outAnalyser.fftSize = 1024;
    src.connect(outAnalyser);
    outAnalyser.connect(ac.destination);
    levelBuf = new Uint8Array(outAnalyser.fftSize);
  }
}

function setLiveButton(state) {
  $("liveBtn").dataset.live = state; // "false" | "busy" | "true"
  $("liveBtn").disabled = state === "busy";
  $("appScreen").querySelector(".stage").classList.toggle("live", state === "true");
  $("appScreen").classList.toggle("session-live", state !== "false");
}

function micErrorMessage(err) {
  if (err && err.name === "NotAllowedError") return "Microphone access is blocked. Allow it in your system privacy settings.";
  if (err && err.name === "NotFoundError") return "No microphone found. Plug one in and try again.";
  return (err && err.message) || "Could not start the session";
}

async function startSession() {
  if (isRunning || starting) return;
  if (!selectedVoiceId) {
    toast("Choose a voice first", "error");
    return;
  }
  if ((currentUser?.balanceSeconds || 0) < 1) {
    toast("Your balance is empty. Add minutes to start.", "error");
    return;
  }

  stopPreview();
  starting = true;
  setLiveButton("busy");
  setStatus("Connecting…", "connecting");

  try {
    await api("/api/sts/session", {
      method: "POST",
      body: JSON.stringify({ voiceId: selectedVoiceId })
    });

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
    });

    ensureAudioGraph();
    micSource = ac.createMediaStreamSource(mediaStream);
    micAnalyser = ac.createAnalyser();
    micAnalyser.fftSize = 1024;
    micSource.connect(micAnalyser);
  } catch (err) {
    if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
    starting = false;
    setLiveButton("false");
    setStatus("Ready", "idle");
    toast(err.status === 402 ? err.message : micErrorMessage(err), "error");
    return;
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
    const sentAt = performance.now();
    inflight++;
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
      $("latency").textContent = `${((performance.now() - sentAt) / 1000).toFixed(1)}s`;
      setBalance(result.balanceSeconds);
      if (result.balanceSeconds < 1) {
        setStatus("Stopped, balance empty", "stopped");
        toast("Your balance ran out. Add minutes to continue.", "error");
        stopSession(true);
        return;
      }
      enqueuePlayback(result.audioBase64, result.contentType || "audio/mpeg");
      setStatus("Live, converting", "converting");
    } catch (err) {
      if (err.status === 402) {
        setStatus("Stopped, balance empty", "stopped");
        toast("Your balance ran out. Add minutes to continue.", "error");
        stopSession(true);
      } else {
        console.error(err);
        setStatus("Conversion error", "error");
        toast(err.message || "Conversion failed", "error");
      }
    } finally {
      inflight = Math.max(0, inflight - 1);
    }
  };

  isRunning = true;
  starting = false;
  setLiveButton("true");
  setStatus("Listening", "listening");
  $("latency").textContent = "–";
  sessionStart = performance.now();
  $("elapsed").textContent = "0:00";
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    $("elapsed").textContent = fmtClock((performance.now() - sessionStart) / 1000);
  }, 250);
  mediaRecorder.start(1200); // ~1.2s chunks
}

function stopSession(keepStatus = false) {
  const wasRunning = isRunning;
  isRunning = false;
  starting = false;
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch (_) {}
  mediaRecorder = null;
  if (micSource) { try { micSource.disconnect(); } catch (_) {} micSource = null; }
  micAnalyser = null;
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  clearInterval(elapsedTimer);
  setLiveButton("false");
  if (wasRunning && !keepStatus) setStatus("Stopped", "stopped");
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

$("liveBtn").addEventListener("click", () => {
  if (isRunning) stopSession();
  else startSession().catch((e) => { setLiveButton("false"); toast(e.message, "error"); });
});

/* ============================================================
   Boot
   ============================================================ */
async function enterApp() {
  setBalance(currentUser.balanceSeconds);
  setStatus("Ready", "idle");
  showApp();
  await loadVoices();
}

(async function init() {
  if (token) {
    try {
      const data = await api("/api/me");
      currentUser = data.user;
      setBalance(currentUser.balanceSeconds);
      setStatus("Ready", "idle");
      showApp(false);
      await loadVoices();
      return;
    } catch (_) {
      token = null;
      localStorage.removeItem("speich_token");
    }
  }
  showAuth(false);
})();
