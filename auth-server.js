/* =========================================================
   PLANORA SERVER SIGN-IN CHECK  (auth-server.js)

   Accounts, sessions and per-user data now live in Supabase
   (see auth.js and supabase/schema.sql). This server only:

   - never serves private files (.env, server code, old data…)
   - checks the Supabase access token on Ask Planora's AI
     endpoints (/api/...): the browser sends
       Authorization: Bearer <access token>
     and the server asks Supabase who that is. No secrets needed:
     the Supabase URL and anon key are public values.
   - allows the live site (planoraai.net) to call this server
     when it is hosted somewhere else (CORS)

   Development: on localhost, if Supabase isn't configured yet or
   you use "Skip to dashboard", requests from this computer are
   allowed as a local guest. That never applies to other hosts.
   ========================================================= */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Files that must never be sent to the browser.
const PRIVATE_PATHS = /^\/(data(\/|$)|node_modules(\/|$)|\.git(\/|$)|\.env|server\.js$|auth-server\.js$|smart-plan-server\.js$|package(-lock)?\.json$|.*\.code-workspace$|supabase(\/|$))/i;

/* ---------------- Supabase project (public values) ---------------- */
// .env (SUPABASE_URL / SUPABASE_ANON_KEY) wins; otherwise the same public
// values as the browser, read from planora-config.js — one place to set them.
function readPublicConfig() {
    const out = { url: process.env.SUPABASE_URL || "", key: process.env.SUPABASE_ANON_KEY || "", prod: "" };
    try {
        const text = fs.readFileSync(path.join(__dirname, "planora-config.js"), "utf8");
        const pick = name => { const m = text.match(new RegExp(name + "\\s*:\\s*[\"']([^\"']*)[\"']")); return m ? m[1] : ""; };
        if (!out.url) out.url = pick("supabaseUrl");
        if (!out.key) out.key = pick("supabaseAnonKey");
        out.prod = pick("productionUrl");
    } catch {}
    out.url = out.url.replace(/\/$/, "");
    return out;
}
const SUPA = readPublicConfig();
const supabaseReady = () => Boolean(SUPA.url && SUPA.key);

/* ---------------- who is calling? ---------------- */
const tokenCache = new Map();   // sha256(token) -> { user, until }

function isLocalRequest(req) {
    const ip = (req.socket && req.socket.remoteAddress) || "";
    const hostHeader = String(req.headers.host || "").split(":")[0];
    const loopback = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip);
    return loopback && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostHeader);
}

function prefsFromHeader(req) {
    try {
        const raw = req.headers["x-planora-prefs"];
        if (!raw) return {};
        const p = JSON.parse(decodeURIComponent(String(raw)).slice(0, 4000));
        if (!p || typeof p !== "object" || Array.isArray(p)) return {};
        const clean = {};
        ["goal", "productiveTimes", "activeDays", "reminders", "reminderTime", "shortSessionsDate"].forEach(k => { if (p[k] !== undefined) clean[k] = p[k]; });
        return clean;
    } catch { return {}; }
}

async function verifyToken(token) {
    const key = crypto.createHash("sha256").update(token).digest("hex");
    const hit = tokenCache.get(key);
    if (hit && hit.until > Date.now()) return hit.user;
    const response = await fetch(`${SUPA.url}/auth/v1/user`, {
        headers: { apikey: SUPA.key, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    const user = await response.json().catch(() => null);
    if (!user || !user.id) return null;
    if (tokenCache.size > 2000) tokenCache.clear();
    tokenCache.set(key, { user, until: Date.now() + 5 * 60 * 1000 });
    return user;
}

async function requireAuth(req, res, next) {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    try {
        if (token && supabaseReady()) {
            const user = await verifyToken(token);
            if (user) {
                req.user = { id: user.id, email: user.email || "", prefs: prefsFromHeader(req) };
                return next();
            }
            return res.status(401).json({ error: "Your session has ended. Please sign in again." });
        }
        // Development convenience: local guest on this computer only
        if (!token && isLocalRequest(req)) {
            req.user = { id: "guest-local", email: "", prefs: prefsFromHeader(req), guest: true };
            return next();
        }
        return res.status(401).json({ error: "Please sign in to continue." });
    } catch (error) {
        console.error("Sign-in check failed:", error.message);
        return res.status(503).json({ error: "Planora can't check your sign-in right now. Please try again." });
    }
}

/* ---------------- install ---------------- */
function install(app) {
    // Never serve private files (old local data, .env, server code...)
    app.use((req, res, next) => {
        let p = req.path;
        try { p = decodeURIComponent(p); } catch {}
        if (PRIVATE_PATHS.test(p)) return res.status(404).send("Not found");
        next();
    });

    // The live site may call a hosted copy of this server for Ask Planora.
    const allowed = new Set(String(process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean));
    if (SUPA.prod) { allowed.add(SUPA.prod.replace(/\/$/, "")); allowed.add(SUPA.prod.replace(/\/$/, "").replace("://", "://www.")); }
    app.use("/api", (req, res, next) => {
        const origin = req.headers.origin;
        if (origin && (allowed.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
            res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Planora-Prefs");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
            res.setHeader("Access-Control-Max-Age", "600");
        }
        if (req.method === "OPTIONS") return res.sendStatus(204);
        next();
    });

    // Old cookie-based endpoints are gone: tell any old open tab to reload.
    app.all(["/api/auth/*", "/api/data"], (req, res) => {
        res.status(410).json({ error: "Planora's sign-in has been upgraded. Please reload the page and sign in again." });
    });
}

module.exports = { install, requireAuth, supabaseReady, config: SUPA };
