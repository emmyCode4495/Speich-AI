/**
 * ElevenLabs Speech-to-Speech helper
 * Docs: POST /v1/speech-to-speech/{voice_id}
 *       POST /v1/speech-to-speech/{voice_id}/stream
 */
const fetch = require("node-fetch");
const FormData = require("form-data");

const BASE = "https://api.elevenlabs.io/v1";

function apiKey() {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw Object.assign(new Error("ELEVENLABS_API_KEY not configured"), { status: 503 });
  return k;
}

function defaultModel() {
  return process.env.ELEVENLABS_STS_MODEL || "eleven_multilingual_sts_v2";
}

/** List voices available on the account */
async function listVoices() {
  const res = await fetch(`${BASE}/voices`, {
    headers: { "xi-api-key": apiKey() }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.detail?.message || data.message || "Failed to list voices"), {
      status: res.status
    });
  }
  return (data.voices || []).map((v) => ({
    voiceId: v.voice_id,
    name: v.name,
    category: v.category,
    previewUrl: v.preview_url || null,
    labels: v.labels || {}
  }));
}

/**
 * Convert a full audio buffer (non-stream) — good for short clips / testing.
 * audioBuffer: Buffer of mp3/wav/webm
 * returns: Buffer of output audio (mpeg by default)
 */
async function speechToSpeech(voiceId, audioBuffer, opts = {}) {
  const form = new FormData();
  form.append("audio", audioBuffer, {
    filename: opts.filename || "input.webm",
    contentType: opts.contentType || "audio/webm"
  });
  if (opts.modelId || defaultModel()) {
    form.append("model_id", opts.modelId || defaultModel());
  }

  const res = await fetch(`${BASE}/speech-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey(),
      Accept: opts.accept || "audio/mpeg",
      ...form.getHeaders()
    },
    body: form
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let msg = errText;
    try {
      const j = JSON.parse(errText);
      msg = j.detail?.message || j.message || errText;
    } catch (_) {}
    throw Object.assign(new Error(msg || `ElevenLabs STS error ${res.status}`), { status: res.status });
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Stream STS — returns a Node readable stream of audio bytes.
 */
async function speechToSpeechStream(voiceId, audioBuffer, opts = {}) {
  const form = new FormData();
  form.append("audio", audioBuffer, {
    filename: opts.filename || "input.webm",
    contentType: opts.contentType || "audio/webm"
  });
  form.append("model_id", opts.modelId || defaultModel());

  const res = await fetch(`${BASE}/speech-to-speech/${encodeURIComponent(voiceId)}/stream`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey(),
      Accept: opts.accept || "audio/mpeg",
      ...form.getHeaders()
    },
    body: form
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw Object.assign(new Error(errText || `ElevenLabs stream error ${res.status}`), {
      status: res.status
    });
  }
  return res.body;
}

module.exports = {
  listVoices,
  speechToSpeech,
  speechToSpeechStream,
  defaultModel
};
