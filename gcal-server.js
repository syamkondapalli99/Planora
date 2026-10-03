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
// Planora → Google: lets Planora make ONE calendar of its own ("Planora") and manage only the events in it.
// It can't touch the person's other calendars or events.
const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const SCOPE_SYNC = SCOPE + " " + WRITE_SCOPE;
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
            const err = new Error(/column/i.test(msg) && /does not exist|schema cache|could not find/i.test(msg) ? "column_missing"
                : /does not exist|schema cache/i.test(msg) ? "table_missing" : "db_error");
            err.detail = msg; err.status = res.status;
            throw err;
        }
        return json;
    }
    async function getRow(req) {
        const q = `?user_id=eq.${encodeURIComponent(req.user.id)}&select=`;
        let rows;
        try { rows = await db(req, "GET", q + "user_id,google_email,token_enc,calendars,scopes,sync,planora_cal"); }
        catch (err) {
            if (err.message !== "column_missing") throw err;
            // the sync columns haven't been added yet (supabase/google-calendar.sql): reading still works
            rows = await db(req, "GET", q + "user_id,google_email,token_enc,calendars");
            (rows || []).forEach(r => { r.legacy = true; r.scopes = ""; r.sync = false; r.planora_cal = ""; });
        }
        return Array.isArray(rows) && rows[0] ? rows[0] : null;
    }
    const canWrite = row => Boolean(row && String(row.scopes || "").includes("calendar.app.created"));
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
            googleSelected: Boolean(c.selected || c.primary),
            planora: /^Tasks and events from Planora/.test(String(c.description || ""))   // the calendar Planora itself fills
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
    }, limiter, express.json({ limit: "200kb" }));
    router.use((req, res, next) => {
        if (req.path === "/status" || configured()) return next();
        res.status(503).json({ error: "Google Calendar isn't set up on Planora's server yet.", code: "not_configured" });
    });

    router.get("/status", async (req, res) => {
        if (!configured()) return res.json({ configured: false, connected: false, clientId: clientId() || "", scope: SCOPE, scopeSync: SCOPE_SYNC });
        try {
            const row = await getRow(req);
            res.json({ configured: true, connected: Boolean(row), email: row ? row.google_email : "", clientId: clientId(), scope: SCOPE, scopeSync: SCOPE_SYNC,
                sync: Boolean(row && row.sync && canWrite(row)), canWrite: canWrite(row), needsUpdate: Boolean(row && row.legacy) });
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
            const fields = { google_email: String(email).slice(0, 200), token_enc: refresh ? seal(refresh) : existing.token_enc, ...(existing ? {} : { calendars: [] }) };
            const write = granted.includes("calendar.app.created");
            const wantSync = Boolean(req.body && req.body.sync);
            if (!(existing && existing.legacy)) {
                fields.scopes = granted.slice(0, 1000);
                if (wantSync) fields.sync = write;
            } else if (wantSync) {
                return res.status(503).json({ error: "Syncing to Google Calendar isn't switched on in Planora's database yet.", code: "needs_update" });
            }
            await saveRow(req, fields);
            access.set(req.user.id, { token: r.json.access_token, until: Date.now() + Math.max(60, (r.json.expires_in || 3600) - 120) * 1000 });
            calCache.delete(req.user.id);
            // linked fine, but the "make its own calendar" box was left unticked in Google's window
            if (wantSync && !write) return res.json({ connected: true, email, canWrite: false, sync: false, syncNote: "To add your Planora tasks to Google Calendar, tick the box that lets Planora make its own calendar." });
            res.json({ connected: true, email, canWrite: write, sync: Boolean(wantSync && write) });
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
            const calendars = chosen((await calendarsFor(req, token)).filter(c => c.id !== row.planora_cal && !c.planora), row.calendars);   // Planora's own calendar is already in Planora
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

    /* ---------- Planora → Google Calendar (one-way copy into a "Planora" calendar) ---------- */
    async function gsend(token, method, path, body) {
        const res = await fetch(API + path, {
            method,
            headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined
        });
        const json = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, json };
    }
    async function ensurePlanoraCalendar(req, row, token, tz) {
        if (row.planora_cal) return row.planora_cal;
        // linked before? reuse the "Planora" calendar that's already in their Google account
        try {
            calCache.delete(req.user.id);
            const mine = (await calendarsFor(req, token)).find(c => c.planora);
            if (mine) {
                row.planora_cal = mine.id;
                await saveRow(req, { planora_cal: row.planora_cal, token_enc: row.token_enc });
                return row.planora_cal;
            }
        } catch {}
        const r = await gsend(token, "POST", "/calendar/v3/calendars", { summary: "Planora", description: "Tasks and events from Planora (planoraai.net). Changes you make in Planora show up here.", timeZone: tz });
        if (!r.ok || !r.json.id) {
            if (r.status === 403) throw codeError("scope_write", "Planora needs permission to add its calendar. Turn on sync again.");
            if (r.status === 401) { const e = codeError("reconnect", "Please link Google Calendar again."); e.httpStatus = 401; throw e; }
            throw codeError("google_error", "Google Calendar isn't answering right now. Please try again.");
        }
        row.planora_cal = String(r.json.id);
        await saveRow(req, { planora_cal: row.planora_cal, token_enc: row.token_enc });
        calCache.delete(req.user.id);
        return row.planora_cal;
    }
    const eventId = (req, key) => "pl" + crypto.createHash("sha1").update(req.user.id + ":" + key).digest("hex");
    const clock = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ""));
    const addMin = (hhmm, n) => { const [h, m] = hhmm.split(":").map(Number); const t = Math.min(23 * 60 + 59, h * 60 + m + n); return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0"); };
    function cleanItem(it) {
        if (!it || typeof it !== "object") return null;
        const key = String(it.key || "");
        if (!/^[te]:[\w.:-]{1,90}$/.test(key) || !isDate(it.date) || !clock(it.start)) return null;
        let end = clock(it.end) && it.end > it.start ? it.end : addMin(it.start, 30);
        return { key, title: String(it.title || "Planora").slice(0, 200), date: it.date, start: it.start, end, done: Boolean(it.done), kind: key[0] === "e" ? "event" : "task" };
    }

    router.post("/sync-setting", async (req, res) => {
        const on = Boolean(req.body && req.body.on);
        try {
            const row = await getRow(req);
            if (!row) return res.status(409).json({ error: "Google Calendar isn't linked.", code: "not_connected" });
            if (row.legacy) return res.status(503).json({ error: "Syncing to Google Calendar isn't switched on in Planora's database yet.", code: "needs_update" });
            if (on && !canWrite(row)) return res.status(409).json({ error: "Planora needs one more permission from Google.", code: "scope_write" });
            await saveRow(req, { sync: on, token_enc: row.token_enc });
            res.json({ sync: on });
        } catch (err) { fail(res, err, "sync-setting"); }
    });

    router.post("/push", async (req, res) => {
        const tz = validTz(String((req.body && req.body.tz) || "")) ? String(req.body.tz) : "UTC";
        const ups = (Array.isArray(req.body && req.body.upserts) ? req.body.upserts : []).slice(0, 150).map(cleanItem).filter(Boolean);
        const dels = (Array.isArray(req.body && req.body.deletes) ? req.body.deletes : []).slice(0, 150).map(String).filter(k => /^[te]:[\w.:-]{1,90}$/.test(k));
        try {
            const row = await getRow(req);
            if (!row) return res.status(409).json({ error: "Google Calendar isn't linked.", code: "not_connected" });
            if (!row.sync || !canWrite(row)) return res.status(409).json({ error: "Syncing to Google Calendar is off.", code: "sync_off" });
            const token = await accessTokenFor(req, row);
            let cal = await ensurePlanoraCalendar(req, row, token, tz);
            const done = [], failed = [];
            const body = it => ({
                id: eventId(req, it.key),
                summary: (it.done ? "✓ " : "") + it.title,
                description: `${it.kind === "event" ? "Event" : "Task"} from Planora — https://planoraai.net/calendar.html?date=${it.date}`,
                start: { dateTime: `${it.date}T${it.start}:00`, timeZone: tz },
                end: { dateTime: `${it.date}T${it.end}:00`, timeZone: tz },
                status: "confirmed",
                transparency: it.done ? "transparent" : "opaque",
                reminders: { useDefault: false },
                extendedProperties: { private: { planora: it.key } }
            });
            const one = async (job, retried) => {
                const path = `/calendar/v3/calendars/${encodeURIComponent(cal)}/events`;
                let r;
                if (job.del) {
                    r = await gsend(token, "DELETE", `${path}/${eventId(req, job.key)}`);
                    if (r.ok || r.status === 404 || r.status === 410) return done.push(job.key);
                } else {
                    r = await gsend(token, "PUT", `${path}/${eventId(req, job.it.key)}`, body(job.it));
                    if (r.status === 404) r = await gsend(token, "POST", path, body(job.it));
                    if (r.ok) return done.push(job.it.key);
                }
                if (r.status === 404 && !retried && !job.del) {                       // the "Planora" calendar was deleted in Google: make it again
                    row.planora_cal = ""; cal = await ensurePlanoraCalendar(req, row, token, tz);
                    return one(job, true);
                }
                if (r.status === 401) { const e = codeError("reconnect", "Please link Google Calendar again."); e.httpStatus = 401; throw e; }
                if (r.status === 403 && /insufficient|scope|permission/i.test(JSON.stringify(r.json))) throw codeError("scope_write", "Planora needs permission to add to Google Calendar. Turn on sync again.");
                failed.push(job.del ? job.key : job.it.key);
            };
            const jobs = ups.map(it => ({ it })).concat(dels.map(key => ({ del: true, key })));
            for (let i = 0; i < jobs.length; i += 5) await Promise.all(jobs.slice(i, i + 5).map(j => one(j)));
            res.json({ done, failed, calendar: "Planora" });
        } catch (err) {
            if (err.code === "scope_write") {
                await saveRow(req, { sync: false, scopes: "", token_enc: (await getRow(req).catch(() => null) || {}).token_enc }).catch(() => {});
                return res.status(409).json({ error: err.message, code: "scope_write" });
            }
            if (err.code === "reconnect") forget(req.user.id);
            fail(res, err, "push");
        }
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

module.exports = { install, SCOPE, SCOPE_SYNC };
