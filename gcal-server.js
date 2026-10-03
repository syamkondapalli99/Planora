/* =========================================================
   PLANORA ⇄ GOOGLE CALENDAR  (gcal-server.js)

   Shows a person's Google Calendar events inside Planora's calendar.
   Read-only: Planora never changes anything in Google Calendar.

   How it stays safe
   - The browser asks Google (Google's own popup) for a one-time code.
     This server swaps that code for Google's long-lived permission using
     the Google client secret, which lives ONLY in the server's settings
     (GOOGLE_CLIENT_SECRET) — never in the web page.
   - That permission is encrypted here (AES-256-GCM, key GCAL_TOKEN_KEY)
     before it is saved in Supabase, in a row protected by Row Level
     Security (only that user's own sign-in can read it). The browser
     never receives it, and even the encrypted copy is useless without
     the server's key.
   - Every call needs the person's Supabase sign-in (requireAuth), and
     the database is read/written AS that person, so RLS applies.
   - Google's short-lived access tokens stay in this server's memory.

   Server settings (Render → Environment):
     GOOGLE_CLIENT_SECRET   the Web client's secret (Google Cloud → Clients)
     GCAL_TOKEN_KEY         any long random text (used to encrypt)
     GOOGLE_CLIENT_ID       optional; defaults to googleClientId in planora-config.js

   Endpoints (all under /api/gcal, all need sign-in)
     GET  /status                 → { configured, connected, email, calendars }
     POST /connect   { code }     → link Google Calendar
     GET  /events?from&to&tz      → { email, calendars, events }
     POST /calendars { ids }      → choose which calendars to show
     POST /disconnect             → unlink (and tell Google to forget it)
   ========================================================= */

const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");

const SCOPE = "openid email https://www.googleapis.com/auth/calendar.readonly";
const TABLE = "planora_google_calendar";

// Google's 11 event colours (Calendar API → colors.event)
const EVENT_COLORS = {
    1: "#7986CB", 2: "#33B679", 3: "#8E24AA", 4: "#E67C73", 5: "#F6BF26", 6: "#F4511E",
    7: "#039BE5", 8: "#616161", 9: "#3F51B5", 10: "#0B8043", 11: "#D50000"
};

function install(app, requireAuth, supa) {
    const OAUTH = (process.env.GOOGLE_OAUTH_BASE || "https://oauth2.googleapis.com").replace(/\/$/, "");
    const API = (process.env.GOOGLE_API_BASE || "https://www.googleapis.com").replace(/\/$/, "");
    const clientId = () => process.env.GOOGLE_CLIENT_ID || readClientId();
    const configured = () => Boolean(clientId() && process.env.GOOGLE_CLIENT_SECRET && process.env.GCAL_TOKEN_KEY && supa.url && supa.key);

    function readClientId() {
        try {
            const text = require("fs").readFileSync(require("path").join(__dirname, "planora-config.js"), "utf8");
            const m = text.match(/googleClientId\s*:\s*["']([^"']*)["']/);
            return m ? m[1] : "";
        } catch { return ""; }
    }

    /* ---------- encryption of Google's long-lived permission ---------- */
    const key = () => crypto.createHash("sha256").update(String(process.env.GCAL_TOKEN_KEY || "")).digest();
    function seal(text) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
        const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
        return "v1." + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
    }
    function open(sealed) {
        const raw = Buffer.from(String(sealed || "").replace(/^v1\./, ""), "base64");
        const d = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    }

    /* ---------- the person's own row, read and written AS them (RLS) ---------- */
    const bearer = req => { const h = String(req.headers.authorization || ""); return h.startsWith("Bearer ") ? h.slice(7).trim() : ""; };
    async function db(req, method, query, body, extraHeaders) {
        const res = await fetch(`${supa.url}/rest/v1/${TABLE}${query || ""}`, {
            method,
            headers: {
                apikey: supa.key,
                Authorization: "Bearer " + bearer(req),
                "Content-Type": "application/json",
                ...(extraHeaders || {})
            },
            body: body ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
        if (!res.ok) {
            const msg = (json && (json.message || json.error)) || text || res.statusText;
            const err = new Error(/does not exist|schema cache/i.test(msg) ? "table_missing" : "db_error");
            err.detail = msg; err.status = res.status;
            throw err;
        }
        return json;
    }
    async function getRow(req) {
        const rows = await db(req, "GET", `?user_id=eq.${encodeURIComponent(req.user.id)}&select=user_id,google_email,token_enc,calendars`);
        return Array.isArray(rows) && rows[0] ? rows[0] : null;
    }
    const saveRow = (req, fields) => db(req, "POST", "?on_conflict=user_id", { user_id: req.user.id, updated_at: new Date().toISOString(), ...fields },
        { Prefer: "resolution=merge-duplicates,return=minimal" });
    const deleteRow = req => db(req, "DELETE", `?user_id=eq.${encodeURIComponent(req.user.id)}`, null, { Prefer: "return=minimal" });

    /* ---------- Google ---------- */
    const access = new Map();      // user id -> { token, until }
    const calCache = new Map();    // user id -> { list, until }
    const forget = id => { access.delete(id); calCache.delete(id); };

    async function googleForm(path, params) {
        const res = await fetch(OAUTH + path, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(params).toString()
        });
        const json = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, json };
    }
    async function accessTokenFor(req, row) {
        const hit = access.get(req.user.id);
        if (hit && hit.until > Date.now()) return hit.token;
        let refresh;
        try { refresh = open(row.token_enc); }
        catch {                                                          // e.g. GCAL_TOKEN_KEY was changed
            forget(req.user.id);
            await deleteRow(req).catch(() => {});
            throw codeError("reconnect", "Please link Google Calendar again.");
        }
        const r = await googleForm("/token", { client_id: clientId(), client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: "refresh_token" });
        if (!r.ok || !r.json.access_token) {
            if (r.json && r.json.error === "invalid_grant") {           // removed in Google, expired, or password changed
                forget(req.user.id);
                await deleteRow(req).catch(() => {});
                throw codeError("reconnect", "Google Calendar was unlinked. Please link it again.");
            }
            throw codeError("google_error", "Google Calendar isn't answering right now. Please try again.");
        }
        access.set(req.user.id, { token: r.json.access_token, until: Date.now() + Math.max(60, (r.json.expires_in || 3600) - 120) * 1000 });
        return r.json.access_token;
    }
    async function gget(token, path) {
        const res = await fetch(API + path, { headers: { Authorization: "Bearer " + token } });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            const e = codeError(res.status === 401 ? "reconnect" : "google_error",
                res.status === 403 ? "Planora doesn't have permission to see this calendar. Please link Google Calendar again." : "Google Calendar isn't answering right now. Please try again.");
            e.httpStatus = res.status;
            throw e;
        }
        return json;
    }
    async function calendarsFor(req, token) {
        const hit = calCache.get(req.user.id);
        if (hit && hit.until > Date.now()) return hit.list;
        const json = await gget(token, "/calendar/v3/users/me/calendarList?maxResults=250&minAccessRole=reader");
        const list = (json.items || []).filter(c => !c.deleted && !c.hidden).map(c => ({
            id: String(c.id),
            name: String(c.summaryOverride || c.summary || c.id).slice(0, 120),
            color: validHex(c.backgroundColor) || "#039BE5",
            primary: Boolean(c.primary),
            googleSelected: Boolean(c.selected || c.primary)
        })).sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name));
        calCache.set(req.user.id, { list, until: Date.now() + 10 * 60 * 1000 });
        return list;
    }
    function chosen(list, saved) {
        const ids = Array.isArray(saved) ? saved.map(String) : [];      // ["-"] = show none
        return list.map(c => ({ ...c, selected: ids.length ? ids.includes(c.id) : c.googleSelected }));
    }

    function codeError(code, message) { const e = new Error(message); e.code = code; return e; }
    const validHex = v => /^#[0-9a-f]{6}$/i.test(String(v || "")) ? String(v).toUpperCase() : "";
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
    const addDays = (ds, n) => { const d = new Date(ds + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const validTz = tz => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };

    /* Turn Google events into Planora's day-by-day calendar items. */
    function toItems(ev, cal, from, to) {
        if (!ev || ev.status === "cancelled") return [];
        const me = (ev.attendees || []).find(a => a.self);
        if (me && me.responseStatus === "declined") return [];
        const base = {
            gid: String(ev.id || "") + "~" + crypto.createHash("sha1").update(cal.id).digest("hex").slice(0, 6),
            cal: cal.id,
            calName: cal.name,
            title: String(ev.summary || "(No title)").slice(0, 200),
            color: (Object.prototype.hasOwnProperty.call(EVENT_COLORS, String(ev.colorId)) && EVENT_COLORS[String(ev.colorId)]) || cal.color,
            location: String(ev.location || "").slice(0, 200),
            link: /^https:\/\/(www\.)?google\.com\/calendar\//.test(String(ev.htmlLink || "")) ? String(ev.htmlLink) : ""
        };
        const out = [];
        if (ev.start && ev.start.date) {                       // all-day (end date is exclusive)
            const endEx = (ev.end && ev.end.date) || addDays(ev.start.date, 1);
            for (let d = ev.start.date > from ? ev.start.date : from, i = 0; d < endEx && i < 120; d = addDays(d, 1), i++) {
                if (d >= from && d <= to) out.push({ ...base, id: `${base.gid}@${d}`, date: d, allDay: true, start: "", end: "" });
            }
            return out;
        }
        const s = String((ev.start && ev.start.dateTime) || ""), e = String((ev.end && ev.end.dateTime) || s);
        if (!s) return out;
        const sd = s.slice(0, 10), st = s.slice(11, 16), ed = e.slice(0, 10), et = e.slice(11, 16);
        for (let d = sd > from ? sd : from, i = 0; d <= ed && i < 120; d = addDays(d, 1), i++) {
            if (d === ed && d !== sd && et === "00:00") break;  // ends exactly at midnight
            const start = d === sd ? st : "00:00";
            const end = d === ed ? et : "23:59";
            if (d >= from && d <= to) out.push({ ...base, id: `${base.gid}@${d}`, date: d, allDay: false, start, end: end > start ? end : start });
        }
        return out;
    }

    function fail(res, err, where) {
        if (err && err.code === "reconnect") return res.status(409).json({ error: err.message, code: "reconnect" });
        if (err && err.message === "table_missing") return res.status(503).json({ error: "Google Calendar isn't set up in the database yet.", code: "not_configured" });
        if (err && err.code === "google_error") return res.status(502).json({ error: err.message, code: "google_error" });
        console.error(`Google Calendar (${where}) failed:`, err && (err.detail || err.message));
        return res.status(500).json({ error: "Something went wrong with Google Calendar. Please try again." });
    }

    /* ---------- routes ---------- */
    const router = express.Router();
    const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: req => "u:" + req.user.id,
        message: { error: "Too many Google Calendar requests. Please wait a minute." } });
    router.use(requireAuth, (req, res, next) => {
        if (!req.user || req.user.guest || !bearer(req)) return res.status(401).json({ error: "Sign in to link Google Calendar.", code: "sign_in" });
        next();
    }, limiter, express.json({ limit: "20kb" }));
    router.use((req, res, next) => {
        if (req.path === "/status" || configured()) return next();
        res.status(503).json({ error: "Google Calendar isn't set up on Planora's server yet.", code: "not_configured" });
    });

    router.get("/status", async (req, res) => {
        if (!configured()) return res.json({ configured: false, connected: false, clientId: clientId() || "", scope: SCOPE });
        try {
            const row = await getRow(req);
            res.json({ configured: true, connected: Boolean(row), email: row ? row.google_email : "", clientId: clientId(), scope: SCOPE });
        } catch (err) {
            if (err.message === "table_missing") return res.json({ configured: false, connected: false, clientId: clientId(), scope: SCOPE, reason: "table_missing" });
            fail(res, err, "status");
        }
    });

    router.post("/connect", async (req, res) => {
        const code = String((req.body && req.body.code) || "");
        if (!code || code.length > 2048) return res.status(400).json({ error: "Google didn't send a sign-in code. Please try again." });
        try {
            const r = await googleForm("/token", { code, client_id: clientId(), client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: "postmessage", grant_type: "authorization_code" });
            if (!r.ok || !r.json.access_token) {
                console.error("Google code exchange failed:", r.status, r.json && r.json.error);
                return res.status(400).json({ error: "Google didn't accept the link. Please try again." });
            }
            const granted = String(r.json.scope || "");
            if (!granted.includes("calendar.readonly")) {
                return res.status(400).json({ error: "Planora needs permission to see your calendar. Please tick the calendar box in Google's window.", code: "scope" });
            }
            let email = "";
            try { email = JSON.parse(Buffer.from(String(r.json.id_token || "").split(".")[1] || "", "base64url").toString("utf8")).email || ""; } catch {}
            let refresh = r.json.refresh_token;
            const existing = await getRow(req);
            if (!refresh) {
                if (existing && email && existing.google_email && existing.google_email.toLowerCase() !== String(email).toLowerCase()) {
                    return res.status(400).json({ error: `Planora is linked to ${existing.google_email}. Unlink it first, then link ${email}.`, code: "other_account" });
                }
                if (!existing) return res.status(400).json({ error: "Google didn't give Planora lasting access. Remove Planora at myaccount.google.com/permissions, then link again.", code: "no_refresh" });
            }
            await saveRow(req, { google_email: String(email).slice(0, 200), token_enc: refresh ? seal(refresh) : existing.token_enc, ...(existing ? {} : { calendars: [] }) });
            access.set(req.user.id, { token: r.json.access_token, until: Date.now() + Math.max(60, (r.json.expires_in || 3600) - 120) * 1000 });
            calCache.delete(req.user.id);
            res.json({ connected: true, email });
        } catch (err) { fail(res, err, "connect"); }
    });

    router.get("/events", async (req, res) => {
        const from = String(req.query.from || ""), to = String(req.query.to || "");
        const tz = validTz(String(req.query.tz || "")) ? String(req.query.tz) : "UTC";
        if (!isDate(from) || !isDate(to) || to < from) return res.status(400).json({ error: "Pick a valid date range." });
        if ((new Date(to) - new Date(from)) / 864e5 > 100) return res.status(400).json({ error: "That date range is too long." });
        const load = async () => {
            const row = await getRow(req);
            if (!row) { const e = codeError("not_connected", "Google Calendar isn't linked."); throw e; }
            const token = await accessTokenFor(req, row);
            const calendars = chosen(await calendarsFor(req, token), row.calendars);
            const timeMin = encodeURIComponent(addDays(from, -1) + "T00:00:00Z");
            const timeMax = encodeURIComponent(addDays(to, 2) + "T00:00:00Z");
            const shown = calendars.filter(c => c.selected).slice(0, 15);
            // If any calendar fails, the whole answer fails, so the app keeps what it showed
            // before instead of making events disappear (and planning over them).
            const lists = await Promise.all(shown.map(async c => {
                const out = [];
                let page = "";
                for (let i = 0; i < 4; i++) {
                    const j = await gget(token, `/calendar/v3/calendars/${encodeURIComponent(c.id)}/events?singleEvents=true&orderBy=startTime&maxResults=2500&timeMin=${timeMin}&timeMax=${timeMax}&timeZone=${encodeURIComponent(tz)}${page ? "&pageToken=" + encodeURIComponent(page) : ""}`);
                    (j.items || []).forEach(ev => out.push(...toItems(ev, c, from, to)));
                    page = j.nextPageToken || "";
                    if (!page) break;
                }
                return out;
            }));
            return { email: row.google_email, calendars: calendars.map(({ id, name, color, primary, selected }) => ({ id, name, color, primary, selected })), events: lists.flat() };
        };
        try {
            let out;
            try { out = await load(); }
            catch (err) {
                // Google said our short-lived access is no good: get a fresh one and try once more
                if (err.code !== "reconnect" || err.httpStatus !== 401) throw err;
                forget(req.user.id);
                try { out = await load(); }
                catch (again) {
                    if (again.code === "reconnect") await deleteRow(req).catch(() => {});   // Google keeps refusing: unlink cleanly
                    throw again;
                }
            }
            res.setHeader("Cache-Control", "no-store");
            res.json(out);
        } catch (err) {
            if (err.code === "reconnect") forget(req.user.id);
            if (err.code === "not_connected") return res.status(409).json({ error: err.message, code: "not_connected" });
            fail(res, err, "events");
        }
    });

    router.post("/calendars", async (req, res) => {
        let ids = req.body && Array.isArray(req.body.ids) ? req.body.ids.map(String).filter(s => s && s.length < 300).slice(0, 50) : null;
        if (!ids) return res.status(400).json({ error: "Choose which calendars to show." });
        if (!ids.length) ids = ["-"];                                    // none ticked: show none (not Google's defaults)
        try {
            const row = await getRow(req);
            if (!row) return res.status(409).json({ error: "Google Calendar isn't linked.", code: "not_connected" });
            await saveRow(req, { calendars: ids, token_enc: row.token_enc });
            res.json({ ok: true });
        } catch (err) { fail(res, err, "calendars"); }
    });

    router.post("/disconnect", async (req, res) => {
        try {
            const row = await getRow(req);
            if (row) {
                try { await googleForm("/revoke", { token: open(row.token_enc) }); } catch {}   // tell Google to forget Planora's access
                await deleteRow(req);
            }
            forget(req.user.id);
            res.json({ connected: false });
        } catch (err) { fail(res, err, "disconnect"); }
    });

    app.use("/api/gcal", router);
    return { configured, toItems, seal, open };
}

module.exports = { install, SCOPE };
