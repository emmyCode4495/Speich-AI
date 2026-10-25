const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { query } = require("./db");

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    balanceSeconds: row.balance_seconds ?? 0,
    createdAt: row.created_at
  };
}

async function createUser({ email, password, name }) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !password || password.length < 8) {
    throw Object.assign(new Error("Valid email and password (8+ chars) required"), { status: 400 });
  }
  const existing = await query("SELECT id FROM users WHERE email = $1", [normalized]);
  if (existing.rows.length) {
    throw Object.assign(new Error("Email already registered"), { status: 409 });
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = hashPassword(password, salt);
  const id = uuidv4();
  const bonus = Math.max(0, parseInt(process.env.SIGNUP_BONUS_SECONDS || "0", 10) || 0);
  await query(
    `INSERT INTO users (id, email, name, password_hash, salt, balance_seconds)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, normalized, name || null, passwordHash, salt, bonus]
  );
  const res = await query(
    `SELECT id, email, name, balance_seconds, created_at FROM users WHERE id = $1`,
    [id]
  );
  return publicUser(res.rows[0]);
}

async function verifyLogin(email, password) {
  const normalized = String(email || "").trim().toLowerCase();
  const res = await query(
    `SELECT id, email, name, password_hash, salt, balance_seconds, created_at
     FROM users WHERE email = $1`,
    [normalized]
  );
  if (!res.rows.length) {
    throw Object.assign(new Error("Invalid email or password"), { status: 401 });
  }
  const user = res.rows[0];
  const attempt = hashPassword(password, user.salt);
  if (!crypto.timingSafeEqual(Buffer.from(attempt), Buffer.from(user.password_hash))) {
    throw Object.assign(new Error("Invalid email or password"), { status: 401 });
  }
  return publicUser(user);
}

async function getById(id) {
  const res = await query(
    `SELECT id, email, name, balance_seconds, created_at FROM users WHERE id = $1`,
    [id]
  );
  return res.rows[0] ? publicUser(res.rows[0]) : null;
}

async function addSeconds(userId, seconds) {
  const res = await query(
    `UPDATE users SET balance_seconds = balance_seconds + $1
     WHERE id = $2 RETURNING id, email, name, balance_seconds, created_at`,
    [seconds, userId]
  );
  return res.rows[0] ? publicUser(res.rows[0]) : null;
}

async function deductSeconds(userId, seconds) {
  const res = await query(
    `UPDATE users SET balance_seconds = GREATEST(0, balance_seconds - $1)
     WHERE id = $2 AND balance_seconds >= $1
     RETURNING id, email, name, balance_seconds, created_at`,
    [seconds, userId]
  );
  if (!res.rows.length) {
    const u = await getById(userId);
    if (!u || u.balanceSeconds < seconds) {
      throw Object.assign(new Error("Insufficient balance"), { status: 402 });
    }
    // race: try soft deduct remaining
    const soft = await query(
      `UPDATE users SET balance_seconds = 0 WHERE id = $1
       RETURNING id, email, name, balance_seconds, created_at`,
      [userId]
    );
    return soft.rows[0] ? publicUser(soft.rows[0]) : null;
  }
  return publicUser(res.rows[0]);
}

function signToken(userId, secret, ttlSeconds = 60 * 60 * 24 * 30) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data.sub;
  } catch {
    return null;
  }
}

module.exports = {
  createUser,
  verifyLogin,
  getById,
  addSeconds,
  deductSeconds,
  signToken,
  verifyToken
};
