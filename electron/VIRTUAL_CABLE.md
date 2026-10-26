# Route Speich into Discord / Zoom / OBS

Speich **cannot** register itself as a system microphone. That requires a virtual audio driver.

## Flow

```
Mic → Speich (converts) → Virtual Cable (playback) → Discord/Zoom (uses cable as mic)
```

## Windows — VB-Audio Virtual Cable

1. Download & install: https://vb-audio.com/Cable/
2. Restart Speich AI
3. **Settings** → **Output device** → choose **CABLE Input (VB-Audio Virtual Cable)**
4. In Discord/Zoom/OBS:
   - Input / Microphone → **CABLE Output (VB-Audio Virtual Cable)**
5. Start Speich live session, speak — the other app hears the converted voice

Optional: VoiceMeeter for monitoring yourself on headphones while the cable feeds the call.

## Mac — BlackHole

1. Install BlackHole 2ch: https://existential.audio/blackhole/
2. Speich **Output device** → **BlackHole 2ch**
3. Discord/Zoom mic → **BlackHole 2ch**
4. To hear yourself + system audio, use a Multi-Output Device in Audio MIDI Setup (BlackHole + your headphones)

## Checklist

- [ ] Virtual cable installed
- [ ] Speich output = cable **input**/playback device
- [ ] Call app mic = cable **output**/recording device
- [ ] Speich session is **Live**
- [ ] Balance > 0

## Latency

Chunk STS is ~1–2s. Fine for many streams; for calls, expect slight delay.
