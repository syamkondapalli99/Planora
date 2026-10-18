/* =========================================================
   REMINDERS (push-server.js)

   - Morning summary: "Here's your day" or, if nothing is planned,
     "Let's plan your day".
   - 15 minutes before each task and event: "Starts in 15 min".

   How it works
   1. A device turns reminders on (Profile → Notifications). The browser gives
      a push address; Planora stores it for that signed-in person.
   2. Whenever plans change, the app sends the next 14 days of reminders
      (times + text). They replace that person's unsent ones.
   3. Every minute this server sends the reminders that are due, through the
      phone's / browser's own push service (Web Push, signed with VAPID keys).

   Settings (Render → Environment), never in the web page:
     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY  – make once: npx web-push generate-vapid-keys
     VAPID_SUBJECT                        – mailto:info@jkssofttech.com
     SUPABASE_SERVICE_ROLE_KEY            – Supabase → Project settings → API keys
     PUSH_CRON_KEY (optional)             – lets an outside timer call /api/push/tick
   Tables: supabase/push-notifications.sql
   ========================================================= */

const express = require("express");
const rateLimit = require("express-rate-limit");
let webpush = null;
try { webpush = require("web-push"); } catch { webpush = null; }

const MAX_ITEMS = 200;
const DAYS_AHEAD = 15;

function install(app, requireAuth, supa) {
    const env = k => String(process.env[k] || "").trim();
    const configured = () => Boolean(webpush && env("VAPID_PUBLIC_KEY") && env("VAPID_PRIVATE_KEY") && env("SUPABASE_SERVICE_ROLE_KEY") && supa && supa.url);
    let vapidSet = false;
    const ready = () => {
        if (!configured()) return false;
        if (!vapidSet) {
            try { webpush.setVapidDetails(env("VAPID_SUBJECT") || "mailto:info@jkssofttech.com", env("VAPID_PUBLIC_KEY"), env("VAPID_PRIVATE_KEY")); vapidSet = true; }
            catch (e) { console.error("Reminders: VAPID keys look wrong:", e.message); return false; }
        }
        return true;
    };

    /* ---- Supabase with the service-role key (server only) ---- */
    async function db(table, method, query, body, prefer) {
        const key = env("SUPABASE_SERVICE_ROLE_KEY");
        const res = await fetch(`${supa.url.replace(/\/$/, "")}/rest/v1/${table}${query || ""}`, {
            method,
            headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
            body: body ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
        if (!res.ok) {
            const msg = (json && (json.message || json.error)) || text || res.statusText;
            const err = new Error(/does not exist|schema cache/i.test(msg) ? "table_missing" : "db_error");
            err.detail = msg; throw err;
        }
        return json;
    }
    const enc = encodeURIComponent;
    const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

    const guard = (req, res) => {
        if (!ready()) { res.status(503).json({ error: "Reminders aren't switched on on Planora's server yet." }); return false; }
        if (!req.user || req.user.guest || !/^[0-9a-f-]{36}$/i.test(req.user.id)) { res.status(403).json({ error: "Please sign in to get reminders." }); return false; }
        return true;
    };
    const fail = (res, err) => {
        console.error("Reminders:", err.message, err.detail || "");
        res.status(err.message === "table_missing" ? 503 : 500).json({ error: err.message === "table_missing" ? "Reminders aren't set up in the database yet." : "Planora couldn't save your reminders right now." });
    };

    const limiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests. Please wait a moment." } });

    // public key for the browser (safe to share)
    app.get("/api/push/key", (req, res) => res.json({ ready: ready(), key: ready() ? env("VAPID_PUBLIC_KEY") : "" }));

    // this device: save its push address for the signed-in person
    app.post("/api/push/subscribe", requireAuth, limiter, express.json({ limit: "8kb" }), async (req, res) => {
        if (!guard(req, res)) return;
        const s = (req.body || {}).subscription || {};
        const endpoint = clean(s.endpoint, 1000), p256dh = clean(s.keys && s.keys.p256dh, 200), auth = clean(s.keys && s.keys.auth, 100);
        if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) return res.status(400).json({ error: "This device's push address looks wrong." });
        try {
            await db("planora_push_subs", "POST", "?on_conflict=endpoint",
                { user_id: req.user.id, endpoint, p256dh, auth, updated_at: new Date().toISOString() },
                "resolution=merge-duplicates,return=minimal");
            res.json({ ok: true });
        } catch (err) { fail(res, err); }
    });

    app.post("/api/push/unsubscribe", requireAuth, limiter, express.json({ limit: "8kb" }), async (req, res) => {
        if (!guard(req, res)) return;
        const endpoint = clean((req.body || {}).endpoint, 1000);
        try {
            if (endpoint) await db("planora_push_subs", "DELETE", `?user_id=eq.${enc(req.user.id)}&endpoint=eq.${enc(endpoint)}`, null, "return=minimal");
            const left = await db("planora_push_subs", "GET", `?user_id=eq.${enc(req.user.id)}&select=id`);
            if (!left || !left.length) await db("planora_push_queue", "DELETE", `?user_id=eq.${enc(req.user.id)}&sent_at=is.null`, null, "return=minimal");
            res.json({ ok: true });
        } catch (err) { fail(res, err); }
    });

    // the next 14 days of reminders, worked out by the app from the person's plans
    app.post("/api/push/schedule", requireAuth, limiter, express.json({ limit: "120kb" }), async (req, res) => {
        if (!guard(req, res)) return;
        const now = Date.now(), until = now + DAYS_AHEAD * 864e5;
        const items = (Array.isArray((req.body || {}).items) ? req.body.items : []).slice(0, 1000).map(it => {
            const t = Date.parse(it && it.at);
            if (!Number.isFinite(t)) return null;
            const url = clean(it && it.url, 200);
            return {
                user_id: req.user.id,
                fire_at: new Date(t).toISOString(),
                kind: ["morning", "task", "event"].includes(it && it.kind) ? it.kind : "task",
                title: clean(it && it.title, 90) || "Planora",
                body: clean(it && it.body, 220),
                url: /^\/[A-Za-z0-9_./?=&%-]*$/.test(url) ? url : "/home.html",
                tag: clean(it && it.tag, 80)
            };
        }).filter(it => it && Date.parse(it.fire_at) > now - 60e3 && Date.parse(it.fire_at) < until)
          .sort((a, b) => a.fire_at.localeCompare(b.fire_at)).slice(0, MAX_ITEMS);
        try {
            await db("planora_push_queue", "DELETE", `?user_id=eq.${enc(req.user.id)}&sent_at=is.null`, null, "return=minimal");
            if (items.length) await db("planora_push_queue", "POST", "", items, "return=minimal");
            res.json({ ok: true, count: items.length });
        } catch (err) { fail(res, err); }
    });

    // "Send a test notification"
    app.post("/api/push/test", requireAuth, limiter, async (req, res) => {
        if (!guard(req, res)) return;
        try {
            const subs = await db("planora_push_subs", "GET", `?user_id=eq.${enc(req.user.id)}&select=id,endpoint,p256dh,auth`);
            if (!subs || !subs.length) return res.status(404).json({ error: "Reminders aren't on for any of your devices yet." });
            const sent = await sendTo(subs, { title: "Planora reminders are on ✅", body: "You'll get your morning summary and a heads-up 15 minutes before each task.", url: "/home.html", tag: "planora-test" });
            res.json({ ok: sent > 0, sent });
        } catch (err) { fail(res, err); }
    });

    async function sendTo(subs, payload) {
        let sent = 0;
        const dead = [];
        await Promise.all(subs.map(async s => {
            try {
                await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
                sent++;
            } catch (e) {
                if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(s.id);     // the device turned notifications off / uninstalled
                else console.error("Reminders: send failed", e && e.statusCode, e && e.body);
            }
        }));
        if (dead.length) await db("planora_push_subs", "DELETE", `?id=in.(${dead.map(enc).join(",")})`, null, "return=minimal").catch(() => {});
        return sent;
    }

    /* ---- every minute: send what's due ---- */
    let running = false, lastClean = 0;
    async function tick() {
        if (running || !ready()) return { skipped: true };
        running = true;
        let done = 0;
        try {
            const now = new Date(), from = new Date(now.getTime() - 20 * 60e3);   // don't send very late ones (server was asleep)
            const due = await db("planora_push_queue", "GET",
                `?sent_at=is.null&fire_at=lte.${enc(now.toISOString())}&fire_at=gte.${enc(from.toISOString())}&select=id,user_id,title,body,url,tag,kind&order=fire_at.asc&limit=500`);
            if (due && due.length) {
                const users = Array.from(new Set(due.map(d => d.user_id)));
                const subs = await db("planora_push_subs", "GET", `?user_id=in.(${users.map(enc).join(",")})&select=id,user_id,endpoint,p256dh,auth`) || [];
                for (const d of due) {
                    const mine = subs.filter(s => s.user_id === d.user_id);
                    if (mine.length) await sendTo(mine, { title: d.title, body: d.body, url: d.url, tag: d.tag || ("planora-" + d.id) });
                    done++;
                }
                await db("planora_push_queue", "PATCH", `?id=in.(${due.map(d => d.id).join(",")})`, { sent_at: now.toISOString() }, "return=minimal");
            }
            if (Date.now() - lastClean > 6 * 3600e3) {            // tidy up old rows a few times a day
                lastClean = Date.now();
                await db("planora_push_queue", "DELETE", `?fire_at=lt.${enc(new Date(Date.now() - 2 * 864e5).toISOString())}`, null, "return=minimal").catch(() => {});
            }
        } catch (err) { console.error("Reminders tick:", err.message, err.detail || ""); }
        finally { running = false; }
        return { sent: done };
    }
    if (!process.env.PUSH_NO_TIMER) setInterval(() => { tick(); }, 60 * 1000).unref();

    // optional: an outside timer (e.g. cron-job.org every minute) keeps reminders on time even if the server sleeps
    app.all("/api/push/tick", async (req, res) => {
        const k = env("PUSH_CRON_KEY");
        if (!k || String(req.query.key || req.headers["x-cron-key"] || "") !== k) return res.status(404).end();
        res.json(await tick());
    });

    return { tick, ready };
}

module.exports = { install };
