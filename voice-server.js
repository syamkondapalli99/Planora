/* =========================================================
   PLANORA'S VOICE (voice-server.js)

   When someone talks to Ask Planora and has "Voice on", the reply is also
   read aloud. This turns the reply text into speech with OpenAI's
   text-to-speech, so Planora sounds the same warm, upbeat voice on every
   phone and computer.

   POST /api/speak { text }  →  audio/mpeg
   - signed-in people only, short texts only (replies), rate-limited
   - nothing is stored; if this fails, the app uses the device's own voice

   Settings (Render → Environment):
     OPENAI_API_KEY    – already set for Ask Planora
     OPENAI_TTS_MODEL  – optional, default gpt-4o-mini-tts
     OPENAI_TTS_VOICE  – optional, default nova
   ========================================================= */

const express = require("express");
const rateLimit = require("express-rate-limit");

const MAX_CHARS = 600;
const STYLE = "Speak as Planora: a warm, upbeat and enthusiastic personal planning assistant. " +
    "Sound genuinely happy to help, friendly and encouraging, with natural energy and a smile in your voice. " +
    "Keep a natural, conversational pace. Read times like 6 PM naturally.";

function install(app, requireAuth) {
    const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
        message: { error: "Planora's voice needs a short break. Replies will show as text for now." } });

    app.post("/api/speak", requireAuth, limiter, express.json({ limit: "8kb" }), async (req, res) => {
        const key = String(process.env.OPENAI_API_KEY || "").trim();
        if (!key) return res.status(503).json({ error: "voice_unavailable" });
        const text = String((req.body || {}).text || "").replace(/\*\*/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
        if (!text) return res.status(400).json({ error: "Nothing to say." });
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 15000);
            const r = await fetch("https://api.openai.com/v1/audio/speech", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
                body: JSON.stringify({
                    model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
                    voice: process.env.OPENAI_TTS_VOICE || "nova",
                    input: text,
                    instructions: STYLE,
                    response_format: "mp3"
                }),
                signal: ctrl.signal
            });
            clearTimeout(timer);
            if (!r.ok) {
                console.error("Voice: OpenAI said", r.status, (await r.text().catch(() => "")).slice(0, 200));
                return res.status(502).json({ error: "voice_unavailable" });
            }
            const audio = Buffer.from(await r.arrayBuffer());
            res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "Content-Length": audio.length });
            res.send(audio);
        } catch (err) {
            console.error("Voice:", err.message);
            res.status(502).json({ error: "voice_unavailable" });
        }
    });
}

module.exports = { install };
