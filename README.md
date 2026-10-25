# Speich AI

Live / near-live **speech-to-speech** voice changer for calls & streaming.  
Architecture mirrors Morphly: Electron client + secure Express API + prepaid **seconds** wallet.  
Voice conversion runs via **ElevenLabs STS** (API key only on the server).

## Features (MVP)

- Register / login (JWT)
- Prepaid balance in **seconds** (minute packs in DB)
- List ElevenLabs voices (proxied)
- Mic → ~1.2s chunks → STS convert → playback
- Balance deducts per chunk; stops at 0
- Admin grant minutes (`ADMIN_SECRET`)

## Quick start (local)

### 1. ElevenLabs
1. Create account at https://elevenlabs.io  
2. API key → `ELEVENLABS_API_KEY`  
3. Ensure your plan supports **Speech to Speech**

### 2. Database
Use Supabase Postgres (or any Postgres). Copy URI to `DATABASE_URL`.

### 3. Server

```bash
cd server
cp .env.example .env
# edit .env
npm install
npm run dev
```

### 4. Electron

```bash
cd electron
npm install
# optional: set default API
# in main.js store default or Settings in UI
npm run dev
```

### 5. Grant test minutes

```bash
curl -X POST http://localhost:3850/api/admin/grant \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: YOUR_ADMIN_SECRET" \
  -d '{"email":"you@example.com","minutes":30}'
```

Set `ADMIN_SECRET` in `.env`.

## Deploy API (Render)

1. New Web Service → this `server` folder (or monorepo root with start command `npm start --workspace=server`)
2. Env:
   - `DATABASE_URL`
   - `AUTH_SECRET` (long random)
   - `ELEVENLABS_API_KEY`
   - `ADMIN_SECRET`
   - `NODE_ENV=production`
   - `PUBLIC_API_URL=https://your-service.onrender.com`
   - `SIGNUP_BONUS_SECONDS=0` (or small trial)
3. In Electron Settings / `apiBaseUrl` → your Render URL
4. Rebuild installer for users

## Payments (Morphly-style)

Copy Morphly’s NOWPayments + Flutterwave/Korapay modules and map:

- pack `minutes` → `addSeconds(userId, minutes * 60)` on webhook success  

Wire later; MVP uses admin grant + optional signup bonus.

## Latency note

MVP uses **chunked** STS (~1–2s). For lower latency later:

- Smaller chunks (quality tradeoff)
- ElevenLabs streaming STS endpoint
- Virtual audio cable (VB-Audio / BlackHole) so Discord hears output

## Project layout

```
speich-ai/
  server/          Express API
  electron/        Desktop app
  shared/          Default packs
```
