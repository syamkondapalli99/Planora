/* =========================================================
   FEEDBACK (feedback-server.js)

   Profile → Help and support → Send feedback opens a small form
   (name, email, message). It posts here; this server checks it and
   passes it to a tiny Google Apps Script that runs in the
   info@jkssofttech.com Google account and emails it to that inbox
   (with "Reply" going straight back to the person who wrote).

   Settings (Render → Environment), never in the web page:
     FEEDBACK_WEBHOOK_URL – the Apps Script web app URL (…/exec; Workspace accounts get …/a/macros/<domain>/s/…/exec)
     FEEDBACK_SECRET      – any long random text; the same text goes in the Apps Script
   The Apps Script to paste is in setup/feedback-apps-script.gs
   ========================================================= */

const express = require("express");
const rateLimit = require("express-rate-limit");

const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,24}$/i;

function install(app, requireAuth) {
    const env = k => String(process.env[k] || "").trim();
    const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, n);

    // signed-in people are recognised; people who aren't can still send feedback
    // (an expired sign-in doesn't block feedback: they're simply treated as not signed in)
    const optionalAuth = (req, res, next) => {
        req.user = null;
        if (!String(req.headers.authorization || "").startsWith("Bearer ")) return next();
        let done = false;
        const anon = () => { if (!done) { done = true; req.user = null; next(); } };
        const quiet = { status: () => ({ json: anon, send: anon, end: anon }), json: anon, send: anon, end: anon, setHeader() {} };
        Promise.resolve(requireAuth(req, quiet, () => { if (!done) { done = true; next(); } })).catch(anon);
    };

    const perVisitor = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, skipFailedRequests: true, standardHeaders: true, legacyHeaders: false,
        message: { error: "You've sent a few messages already. Please try again in an hour." } });
    const perDay = rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 200, skipFailedRequests: true, keyGenerator: () => "all", standardHeaders: false, legacyHeaders: false,
        message: { error: "Feedback is busy right now. Please email info@jkssofttech.com instead." } });

    app.post("/api/feedback", express.json({ limit: "16kb" }), optionalAuth, perVisitor, perDay, async (req, res) => {
        const url = env("FEEDBACK_WEBHOOK_URL"), secret = env("FEEDBACK_SECRET");
        if (!/^https:\/\/script\.google\.com\/(a\/macros\/[a-z0-9.-]+\/|macros\/)s\/[\w-]+\/exec$/i.test(url) || secret.length < 16) {
            return res.status(503).json({ error: "Feedback isn't switched on yet. Please email info@jkssofttech.com." });
        }
        const b = req.body || {};
        if (clean(b.website, 200)) return res.json({ ok: true });            // hidden "website" box: only bots fill it in
        const name = clean(b.name, 80);
        const email = clean(b.email, 254).toLowerCase();
        const message = clean(b.message, 4000);
        if (!name) return res.status(400).json({ error: "Please enter your name." });
        if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Please enter a valid email address so we can reply." });
        if (message.length < 5) return res.status(400).json({ error: "Please write a little more about your enquiry." });

        const payload = {
            secret,
            name, email, message,
            account: req.user && !req.user.guest ? { id: req.user.id, email: req.user.email || "" } : null,
            page: clean(b.page, 120),
            app: clean(b.app, 40),
            device: clean(req.headers["user-agent"], 300),
            sentAt: new Date().toISOString()
        };
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 15000);
            const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), redirect: "follow", signal: ctrl.signal });
            clearTimeout(timer);
            const text = await r.text();
            let out = null; try { out = JSON.parse(text); } catch {}
            if (!r.ok || !out || out.ok !== true) {
                console.error("Feedback: Apps Script said", r.status, text.slice(0, 200));
                return res.status(502).json({ error: "Your message couldn't be sent right now. Please try again, or email info@jkssofttech.com." });
            }
            res.json({ ok: true });
        } catch (err) {
            console.error("Feedback:", err.message);
            res.status(502).json({ error: "Your message couldn't be sent right now. Please try again, or email info@jkssofttech.com." });
        }
    });
}

module.exports = { install, EMAIL_RE };
