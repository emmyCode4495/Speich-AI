/**
 * Speich-AI API
 * - Master ElevenLabs key only on server
 * - Prepaid balance in seconds
 * - STS convert endpoint for live/near-live chunks
 */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const { initDb, query } = require("./db");
const {
  createUser,
  verifyLogin,
  getById,
  addSeconds,
  deductSeconds,
  signToken,
  verifyToken
} = require("./users");
const elevenlabs = require("./elevenlabs");

const PORT = parseInt(process.env.PORT || "3850", 10);
const AUTH_SECRET = process.env.AUTH_SECRET;

if (!AUTH_SECRET || AUTH_SECRET.length < 16) {
  console.error("❌ AUTH_SECRET must be set (min 16 chars)");
  process.exit(1);
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: true,
    credentials: true
  })
);
app.use(express.json({ limit: "2mb" }));

const strictLimiter = rateLimit({ windowMs: 60_000, max: 30 });
const convertLimiter = rateLimit({ windowMs: 60_000, max: 120 });

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  const userId = verifyToken(token, AUTH_SECRET);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  req.userId = userId;
  next();
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "speich-ai",
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY)
  });
});

// ---------- Auth ----------
app.post("/api/auth/register", strictLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    const user = await createUser({ email, password, name });
    const token = signToken(user.id, AUTH_SECRET);
    res.json({ token, user });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Register failed" });
  }
});

app.post("/api/auth/login", strictLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await verifyLogin(email, password);
    const token = signToken(user.id, AUTH_SECRET);
    res.json({ token, user });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Login failed" });
  }
});

app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const user = await getById(req.userId);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed" });
  }
});

// ---------- Packs & balance ----------
app.get("/api/packs", async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, label, minutes, price_usd AS "priceUsd", sort_order AS "sortOrder"
       FROM packs WHERE active = TRUE ORDER BY sort_order ASC`
    );
    res.json({ packs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Dev/admin: grant minutes (protect with ADMIN_SECRET in production) */
app.post("/api/admin/grant", async (req, res) => {
  const secret = req.headers["x-admin-secret"] || req.body?.adminSecret;
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const { userId, email, minutes } = req.body || {};
    let id = userId;
    if (!id && email) {
      const r = await query(`SELECT id FROM users WHERE email = $1`, [
        String(email).trim().toLowerCase()
      ]);
      id = r.rows[0]?.id;
    }
    if (!id) return res.status(400).json({ error: "userId or email required" });
    const secs = Math.round(Number(minutes) * 60);
    const user = await addSeconds(id, secs);
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Voices (proxied so key stays server-side) ----------
app.get("/api/voices", authMiddleware, async (_req, res) => {
  try {
    const voices = await elevenlabs.listVoices();
    res.json({ voices });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Failed to list voices" });
  }
});

/**
 * Convert one audio chunk (base64) → converted audio (base64 mpeg)
 * Body: { voiceId, audioBase64, contentType?, durationSeconds? }
 * Deducts ceil(durationSeconds) or minimum 1 second per call.
 */
app.post("/api/sts/convert", authMiddleware, convertLimiter, async (req, res) => {
  try {
    const user = await getById(req.userId);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (user.balanceSeconds < 1) {
      return res.status(402).json({
        error: "Insufficient balance. Buy more minutes to continue.",
        balanceSeconds: 0
      });
    }

    const { voiceId, audioBase64, contentType, durationSeconds, filename } = req.body || {};
    if (!voiceId || !audioBase64) {
      return res.status(400).json({ error: "voiceId and audioBase64 required" });
    }

    const buf = Buffer.from(audioBase64, "base64");
    if (buf.length < 100) {
      return res.status(400).json({ error: "Audio too short" });
    }
    if (buf.length > 3_500_000) {
      return res.status(400).json({ error: "Audio chunk too large" });
    }

    const out = await elevenlabs.speechToSpeech(voiceId, buf, {
      contentType: contentType || "audio/webm",
      filename: filename || "chunk.webm"
    });

    const used = Math.max(1, Math.ceil(Number(durationSeconds) || 1));
    let updated;
    try {
      updated = await deductSeconds(req.userId, used);
    } catch (e) {
      if (e.status === 402) {
        return res.status(402).json({ error: e.message, balanceSeconds: 0 });
      }
      throw e;
    }

    await query(
      `INSERT INTO sessions_log (id, user_id, voice_id, seconds_used) VALUES ($1,$2,$3,$4)`,
      [uuidv4(), req.userId, voiceId, used]
    );

    res.json({
      audioBase64: out.toString("base64"),
      contentType: "audio/mpeg",
      secondsUsed: used,
      balanceSeconds: updated.balanceSeconds
    });
  } catch (err) {
    console.error("STS convert error:", err.message);
    res.status(err.status || 500).json({ error: err.message || "Conversion failed" });
  }
});

/** Start a billed session ticket (client polls/converts with this) */
app.post("/api/sts/session", authMiddleware, async (req, res) => {
  try {
    const user = await getById(req.userId);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (user.balanceSeconds < 3) {
      return res.status(402).json({
        error: "Need at least a few seconds of balance to start.",
        balanceSeconds: user.balanceSeconds
      });
    }
    const voiceId = req.body?.voiceId || null;
    res.json({
      sessionId: uuidv4(),
      voiceId,
      balanceSeconds: user.balanceSeconds,
      model: elevenlabs.defaultModel()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function main() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`\n🎙️  Speich-AI API → http://localhost:${PORT}`);
    console.log(`   ElevenLabs: ${process.env.ELEVENLABS_API_KEY ? "✓" : "MISSING"}`);
    console.log(`   DB: ${process.env.DATABASE_URL ? "✓" : "MISSING"}\n`);
  });
}

main().catch((e) => {
  console.error("Failed to start:", e);
  process.exit(1);
});
