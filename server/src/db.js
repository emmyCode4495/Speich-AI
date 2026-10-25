const { Pool } = require("pg");

let pool = null;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pool = new Pool({
      connectionString: url,
      ssl: url.includes("localhost") ? false : { rejectUnauthorized: false }
    });
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      balance_seconds INTEGER NOT NULL DEFAULT 0,
      reset_code_hash TEXT,
      reset_code_salt TEXT,
      reset_expires BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS packs (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      minutes INTEGER NOT NULL,
      price_usd NUMERIC(10,2) NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sessions_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      voice_id TEXT,
      seconds_used INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const { rows } = await query("SELECT COUNT(*)::int AS c FROM packs");
  if (rows[0].c === 0) {
    const { DEFAULT_PACKS } = require("../../shared");
    for (const p of DEFAULT_PACKS) {
      await query(
        `INSERT INTO packs (id, label, minutes, price_usd, sort_order, active)
         VALUES ($1,$2,$3,$4,$5,TRUE) ON CONFLICT (id) DO NOTHING`,
        [p.id, p.label, p.minutes, p.priceUsd, p.sortOrder]
      );
    }
  }
  console.log("✓ Postgres ready (Speich-AI)");
}

module.exports = { query, initDb, getPool };
