/* =========================================================
   PLANORA CLIENT: accounts + sync  (auth.js)

   Loaded first on every page (after planora-config.js and
   vendor/supabase.js). Sign-in is Supabase Auth:

   1. PlanoraAuth helpers (current user, log out, profile, API calls)
   2. Session check on the app pages: signed out → login page.
      While checking, the page shows a small "Loading" state instead
      of flashing content or the login screen.
   3. Account sync: everything Planora saves in this browser (keys
      starting with "planora_") is saved to the signed-in user's own
      row in Supabase (table planora_user_data, protected by Row Level
      Security) and loaded back on any other device.
   4. Friendly toasts instead of browser alert() pop-ups.

   Sessions are stored and refreshed by the Supabase SDK itself
   (we never store tokens or passwords ourselves).
   ========================================================= */

(function () {

    const CFG = window.PLANORA_CONFIG || {};
    const TABLE = "planora_user_data";

    const USER_KEY = "planora_user";          // cached profile (this browser only)
    const OWNER_KEY = "planora_owner";        // which account the local data belongs to
    const META_KEY = "planora_sync_meta";     // sync bookkeeping
    const GUEST_KEY = "planora_guest_key";    // development-only guest mode
    const LOCAL_ONLY = new Set([USER_KEY, OWNER_KEY, META_KEY, GUEST_KEY]);
    const GUEST_ID = "guest-local";

    const store = window.localStorage;
    const rawSet = Storage.prototype.setItem;
    const rawRemove = Storage.prototype.removeItem;
    const rawGet = Storage.prototype.getItem;

    // Sync state as it was before this page's own scripts wrote anything
    const initialMeta = (() => { try { return JSON.parse(rawGet.call(store, META_KEY)) || {}; } catch { return {}; } })();

    const path = location.pathname.toLowerCase();
    const isLoginPage = path.endsWith("/") || path.endsWith("/index.html");
    const isResetPage = path.endsWith("/reset-password.html");
    const isAppPage = !isLoginPage && !isResetPage;

    const host = location.hostname;
    const IS_DEV = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(host);
    const configured = Boolean(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase && window.supabase.createClient);

    /* ---------------- where sign-in emails / OAuth come back to ---------------- */
    // Live site → always https://planoraai.net/ ; localhost (or any other host) → this folder on this host.
    function siteBase() {
        try {
            if (CFG.productionUrl) {
                const prod = new URL(CFG.productionUrl);
                const bare = h => h.replace(/^www\./, "");
                if (bare(host) === bare(prod.hostname)) return prod.origin + "/";
            }
        } catch {}
        return new URL(".", location.href).href;
    }

    const sb = configured ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
        auth: {
            flowType: "pkce",            // recommended for browser apps (OAuth + email links)
            persistSession: true,        // stay signed in after a refresh
            autoRefreshToken: true,
            detectSessionInUrl: true,    // finish OAuth / email-link sign-ins automatically
            storageKey: "sb-planora-auth"
        }
    }) : null;

    /* ---------------- loading state on app pages ---------------- */
    if (isAppPage) {
        document.documentElement.classList.add("auth-pending");
        const style = document.createElement("style");
        style.textContent = `
            html.auth-pending body > *:not(#planora-auth-wait) { visibility: hidden !important; }
            #planora-auth-wait { position: fixed; inset: 0; display: flex; flex-direction: column; gap: 14px; align-items: center; justify-content: center;
                background: linear-gradient(180deg, #E6F1FB 0%, #EEEDFE 100%); z-index: 2147483000; font: 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #534AB7; }
            #planora-auth-wait i { width: 34px; height: 34px; border-radius: 50%; border: 3px solid #CECBF6; border-top-color: #7F77DD; animation: planoraSpin .8s linear infinite; }
            @keyframes planoraSpin { to { transform: rotate(360deg); } }
            html:not(.auth-pending) #planora-auth-wait { display: none; }`;
        document.head.appendChild(style);
        const addWait = () => {
            if (!document.documentElement.classList.contains("auth-pending") || document.getElementById("planora-auth-wait")) return;
            const w = document.createElement("div");
            w.id = "planora-auth-wait";
            w.setAttribute("role", "status");
            w.innerHTML = `<i aria-hidden="true"></i><span>Loading Planora…</span>`;
            document.body.appendChild(w);
        };
        if (document.body) addWait(); else document.addEventListener("DOMContentLoaded", addWait);
    }
    function reveal() { document.documentElement.classList.remove("auth-pending"); }


    /* ---------------- small utilities ---------------- */

    function readJson(key, fallback) {
        try { return JSON.parse(rawGet.call(store, key)) ?? fallback; } catch { return fallback; }
    }
    function writeJson(key, value) { rawSet.call(store, key, JSON.stringify(value)); }
    function syncable(key) {
        return typeof key === "string" && key.startsWith("planora_") && !LOCAL_ONLY.has(key);
    }
    function collectLocalData() {
        const data = {};
        for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (syncable(key)) data[key] = rawGet.call(store, key);
        }
        return data;
    }
    function hasLocalData() { return Object.keys(collectLocalData()).length > 0; }
    const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ""));

    /* ---------------- human-readable errors ---------------- */
    function friendlyError(error, context) {
        const raw = String((error && (error.message || error.error_description || error.msg || error.error)) || error || "");
        const status = error && (error.status || error.code);
        const t = raw.toLowerCase();
        let message;
        if (error instanceof TypeError || /failed to fetch|networkerror|network request failed|load failed|fetch failed/.test(t)) message = "Can't reach Planora right now. Check your internet connection and try again.";
        else if (/invalid login credentials|invalid_grant|invalid email or password/.test(t)) message = "That email and password don't match. Try again, or reset your password.";
        else if (/email not confirmed/.test(t)) message = "Please confirm your email first. We've sent you a link.";
        else if (/already registered|already been registered|already exists|user_already_exists/.test(t)) message = "An account with this email already exists. Sign in instead, or reset your password.";
        else if (/password should be|weak[_ ]password|password is too weak|at least \d+ characters/.test(t)) message = "Please choose a stronger password: at least 8 characters.";
        else if (/same_password|should be different/.test(t)) message = "Your new password must be different from the old one.";
        else if (/rate limit|too many|over_request_rate_limit|over_email_send_rate_limit|429/.test(t) || status === 429) message = "Too many attempts. Please wait a minute and try again.";
        else if (/provider is not enabled|unsupported provider|validation_failed.*provider/.test(t)) message = `${context || "This"} sign-in isn't switched on yet. Please use another way to sign in for now.`;
        else if (/audience|nonce|id_token|id token/.test(t)) message = `${context || "This"} sign-in isn't fully set up yet. Please use email for now.`;
        else if (/access_denied|cancel|user denied|popup_closed/.test(t)) message = "Sign-in was cancelled.";
        else if (/redirect|not allowed|invalid_request/.test(t)) message = "Sign-in isn't set up for this web address yet.";
        else if (/jwt expired|refresh token|session.*(expired|not found|missing)|auth session missing|invalid jwt|not authenticated/.test(t)) message = "Your session has ended. Please sign in again.";
        else if (/otp_expired|expired|invalid.*link|code verifier|flow state/.test(t)) message = "That link has expired or was already used. Please request a new one.";
        else if (/unable to validate email|invalid email|email address .* invalid|email_address_invalid/.test(t)) message = "Please enter a valid email address.";
        else if (/signups? not allowed|signup is disabled/.test(t)) message = "New accounts can't be created right now.";
        else message = "Something went wrong. Please try again.";
        const out = new Error(message);
        out.status = status;
        out.raw = raw;
        return out;
    }

    /* ---------------- toast (replaces alert) ---------------- */
    function ensureToastHost() {
        let el = document.getElementById("planora-toast-host");
        if (!el) {
            el = document.createElement("div");
            el.id = "planora-toast-host";
            el.setAttribute("role", "status");
            el.setAttribute("aria-live", "polite");
            (document.body || document.documentElement).appendChild(el);
        }
        return el;
    }
    function toast(message, type = "info") {
        const show = () => {
            const hostEl = ensureToastHost();
            const el = document.createElement("div");
            el.className = "planora-toast " + type;
            el.textContent = String(message);
            hostEl.appendChild(el);
            requestAnimationFrame(() => el.classList.add("show"));
            setTimeout(() => {
                el.classList.remove("show");
                setTimeout(() => el.remove(), 300);
            }, Math.min(6000, 2600 + String(message).length * 30));
        };
        if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);
    }
    window.alert = function (message) { toast(message); };


    /* ---------------- Planora's own server (Ask Planora AI) ---------------- */
    // Every call to "/api/..." carries the Supabase access token, so the
    // server knows who is asking. apiBase lets the live site use a hosted server.
    const API_BASE = String(CFG.apiBase || "").replace(/\/$/, "");
    async function accessToken() {
        if (!sb) return null;
        try { const { data } = await sb.auth.getSession(); return data.session ? data.session.access_token : null; } catch { return null; }
    }
    const rawFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
        if (typeof input === "string" && input.startsWith("/api/")) {
            const headers = new Headers((init && init.headers) || {});
            const token = await accessToken();
            if (token && !headers.has("Authorization")) headers.set("Authorization", "Bearer " + token);
            const prefs = (currentUser() || {}).prefs;
            if (prefs && !headers.has("X-Planora-Prefs")) { try { headers.set("X-Planora-Prefs", encodeURIComponent(JSON.stringify(prefs))); } catch {} }
            init = { ...(init || {}), headers };
            input = API_BASE + input;
        }
        return rawFetch(input, init);
    };

    async function api(url, options = {}) {
        const response = await fetch(url, {
            credentials: "same-origin",
            ...options,
            headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
        });
        let body = {};
        try { body = await response.json(); } catch {}
        if (!response.ok) {
            const error = new Error(body.error || "Something went wrong. Please try again.");
            error.status = response.status;
            throw error;
        }
        return body;
    }


    /* ---------------- the user's row in Supabase ---------------- */

    async function fetchRow(userId) {
        const { data, error } = await sb.from(TABLE).select("profile, data, updated_at").eq("user_id", userId).maybeSingle();
        if (error) throw error;
        return data;
    }
    async function ensureRow(user) {
        let row = await fetchRow(user.id);
        if (!row) {
            const meta = user.user_metadata || {};
            const profile = { name: meta.full_name || meta.name || "", prefs: {}, onboarded: false };
            const { error } = await sb.from(TABLE).upsert({ user_id: user.id, profile, data: {} }, { onConflict: "user_id", ignoreDuplicates: true });
            if (error) throw error;
            row = (await fetchRow(user.id)) || { profile, data: {}, updated_at: null };
        }
        return row;
    }
    const rowTime = row => (row && row.updated_at ? Date.parse(row.updated_at) || 0 : 0);
    const asRecord = row => ({ data: (row && row.data) || {}, updatedAt: rowTime(row) });

    function buildUser(u, profile) {
        profile = profile || {};
        const meta = u.user_metadata || {};
        const providers = Array.from(new Set(((u.identities || []).map(i => i.provider)).concat((u.app_metadata && u.app_metadata.providers) || [])));
        const email = u.email || "";
        return {
            id: u.id,
            email,
            name: String(profile.name || meta.full_name || meta.name || (email ? email.split("@")[0] : "") || "Planora user").trim(),
            createdAt: u.created_at,
            providers,
            hasPassword: providers.includes("email"),
            emailConfirmed: Boolean(u.email_confirmed_at || u.confirmed_at),
            pendingEmail: u.new_email || null,
            prefs: profile.prefs || {},
            onboarded: Boolean(profile.onboarded)
        };
    }

    let profileCache = null;   // the profile part of the row, as last read/written


    /* ---------------- sync engine ---------------- */

    let syncTimer = null;
    let syncing = false;
    let syncBlocked = true;   // held until we know the local data belongs to this account

    function markDirty() {
        const meta = readJson(META_KEY, {});
        meta.dirty = true;
        meta.localChangedAt = Date.now();
        writeJson(META_KEY, meta);
    }
    function scheduleSync() {
        const owner = rawGet.call(store, OWNER_KEY);
        if (!owner || owner === GUEST_ID) return;
        markDirty();
        if (syncBlocked) return;
        clearTimeout(syncTimer);
        syncTimer = setTimeout(pushNow, 700);
    }

    async function pushNow() {
        const owner = rawGet.call(store, OWNER_KEY);
        if (syncing || syncBlocked || !sb || !isUuid(owner)) return false;
        syncing = true;
        const sentAt = Date.now();
        try {
            const updated = new Date(sentAt).toISOString();
            const { error } = await sb.from(TABLE).upsert({ user_id: owner, data: collectLocalData(), updated_at: updated }, { onConflict: "user_id" });
            if (error) throw error;
            const meta = readJson(META_KEY, {});
            meta.updatedAt = sentAt;
            if (!meta.localChangedAt || meta.localChangedAt <= sentAt) meta.dirty = false;
            writeJson(META_KEY, meta);
            return true;
        } catch (error) {
            const e = friendlyError(error);
            if (/session has ended/.test(e.message)) handleSignedOut(true);
            return false;   // keep "dirty" and retry on the next change / page hide
        } finally {
            syncing = false;
        }
    }

    // Best effort when the tab closes (keepalive fetch straight to Supabase's REST API)
    let lastToken = null;
    function flushOnLeave() {
        const meta = readJson(META_KEY, {});
        const owner = rawGet.call(store, OWNER_KEY);
        if (!meta.dirty || syncBlocked || !sb || !isUuid(owner) || !lastToken) return;
        clearTimeout(syncTimer);
        try {
            const body = JSON.stringify({ user_id: owner, data: collectLocalData(), updated_at: new Date().toISOString() });
            if (body.length > 60000) return;   // too big for keepalive; it syncs on the next visit
            rawFetch(`${CFG.supabaseUrl.replace(/\/$/, "")}/rest/v1/${TABLE}?on_conflict=user_id`, {
                method: "POST", keepalive: true, body,
                headers: { apikey: CFG.supabaseAnonKey, Authorization: "Bearer " + lastToken, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }
            }).catch(() => {});
        } catch {}
    }
    window.addEventListener("pagehide", flushOnLeave);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushOnLeave(); });

    // Watch every write Planora makes to localStorage (no page code changes needed)
    Storage.prototype.setItem = function (key, value) {
        rawSet.call(this, key, value);
        if (this === store && syncable(key)) scheduleSync();
    };
    Storage.prototype.removeItem = function (key) {
        rawRemove.call(this, key);
        if (this === store && syncable(key)) scheduleSync();
    };

    // Replace this browser's Planora data with the account's copy
    function applyServerData(record, userId) {
        const keys = [];
        for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (syncable(key)) keys.push(key);
        }
        keys.forEach(key => rawRemove.call(store, key));
        Object.entries(record.data || {}).forEach(([key, value]) => {
            if (syncable(key) && typeof value === "string") rawSet.call(store, key, value);
        });
        rawSet.call(store, OWNER_KEY, userId);
        writeJson(META_KEY, { updatedAt: record.updatedAt || 0, dirty: false });
    }

    function clearLocalAccountData() {
        const keys = [];
        for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (key && key.startsWith("planora_") && key !== GUEST_KEY) keys.push(key);
        }
        keys.forEach(key => rawRemove.call(store, key));
    }

    /*
     * Right after signing in, before opening the app:
     * - Same account as last time on this browser: newest copy wins.
     * - This browser's data belongs to no account yet (or to the old
     *   local guest/demo system) and the account is empty: keep it, so
     *   nothing made before signing in is lost.
     * - Data from a different account: load this account's data instead.
     * Returns true when this browser's data was replaced.
     */
    async function prepareDataFor(user, row) {
        const owner = rawGet.call(store, OWNER_KEY);
        row = row || await ensureRow({ id: user.id });
        const record = asRecord(row);
        const serverHasData = Object.keys(record.data).length > 0;
        let replaced = false;

        if (owner === user.id) {
            const meta = readJson(META_KEY, {});
            if (meta.dirty && (meta.localChangedAt || 0) > record.updatedAt) {
                syncBlocked = false;
                await pushNow();
            } else if (record.updatedAt > (meta.updatedAt || 0)) {
                applyServerData(record, user.id);
                replaced = true;
            }
        } else if ((!owner || !isUuid(owner)) && !serverHasData && hasLocalData()) {
            rawSet.call(store, OWNER_KEY, user.id);
            syncBlocked = false;
            await pushNow();
        } else {
            applyServerData(record, user.id);
            replaced = true;
        }
        syncBlocked = false;
        return replaced;
    }


    /* ---------------- user helpers ---------------- */

    function cacheUser(user) { writeJson(USER_KEY, user); }
    function currentUser() { return readJson(USER_KEY, null); }

    function firstName() {
        const user = currentUser();
        if (!user || !user.name || user.guest) return "";
        return user.name.trim().split(/\s+/)[0];
    }
    function initials() {
        const user = currentUser();
        if (!user || !user.name) return "?";
        const parts = user.name.trim().split(/\s+/);
        return ((parts[0] || "")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
    }

    function isGuest() {
        return IS_DEV && rawGet.call(store, GUEST_KEY) === "1";
    }

    let leaving = false;
    function handleSignedOut(expired) {
        if (leaving) return;
        rawRemove.call(store, USER_KEY);
        if (isAppPage) { leaving = true; location.replace("index.html" + (expired ? "?expired=1" : "")); }
    }

    async function logout() {
        clearTimeout(syncTimer);
        let safe = true;
        if (isGuest()) {
            rawRemove.call(store, GUEST_KEY);
            rawRemove.call(store, USER_KEY);
            leaving = true;
            location.replace("index.html?signedout=1");
            return;
        }
        const meta = readJson(META_KEY, {});
        if (meta.dirty) { syncBlocked = false; safe = await pushNow(); }
        leaving = true;
        try { if (sb) await sb.auth.signOut({ scope: "local" }); } catch {}
        // On a shared computer, don't leave your plans behind (unless they couldn't be saved yet)
        if (safe) clearLocalAccountData();
        else rawRemove.call(store, USER_KEY);
        location.replace("index.html?signedout=1");
    }

    async function loadUser() {
        if (isGuest()) {
            const u = { id: GUEST_ID, name: "Guest", email: "", providers: ["guest"], guest: true, prefs: (readJson(USER_KEY, {}) || {}).prefs || {}, onboarded: true };
            cacheUser(u);
            return { user: u, row: null };
        }
        if (!sb) { const e = new Error("Sign-in isn't set up yet."); e.status = 401; throw e; }
        const { data, error } = await sb.auth.getUser();
        if (error || !data.user) { const e = error ? friendlyError(error) : new Error("Signed out"); e.status = 401; throw e; }
        const row = await ensureRow(data.user);
        profileCache = row.profile || {};
        const user = buildUser(data.user, profileCache);
        cacheUser(user);
        return { user, row };
    }

    async function refreshUser() { return (await loadUser()).user; }

    async function saveProfile(patch) {
        const user = currentUser();
        if (!user) throw new Error("Please sign in again.");
        const cur = profileCache || {};
        const next = { ...cur, ...patch, prefs: { ...(cur.prefs || {}), ...((patch && patch.prefs) || {}) } };
        if (user.guest) {
            cacheUser({ ...user, prefs: next.prefs, name: next.name || user.name });
            profileCache = next;
            return;
        }
        const { error } = await sb.from(TABLE).upsert({ user_id: user.id, profile: next }, { onConflict: "user_id" });
        if (error) throw friendlyError(error);
        profileCache = next;
    }

    // { name, email, prefs, onboarded }
    async function updateProfile(changes) {
        const user = currentUser();
        if (!user) throw new Error("Please sign in again.");
        const patch = {};
        if (changes.name !== undefined) {
            const name = String(changes.name).trim();
            if (!name) throw new Error("Name can't be empty.");
            patch.name = name.slice(0, 80);
        }
        if (changes.prefs && typeof changes.prefs === "object") patch.prefs = changes.prefs;
        if (changes.onboarded !== undefined) patch.onboarded = Boolean(changes.onboarded);
        let emailNote = null;
        if (changes.email !== undefined && !user.guest) {
            const email = String(changes.email).trim().toLowerCase();
            if (email && email !== user.email) {
                const { error } = await sb.auth.updateUser({ email }, { emailRedirectTo: siteBase() + "home.html" });
                if (error) throw friendlyError(error);
                emailNote = `Check ${email} to confirm your new email address.`;
            }
        }
        if (Object.keys(patch).length) await saveProfile(patch);
        const fresh = { ...currentUser(), ...(patch.name ? { name: patch.name } : {}), prefs: { ...((currentUser() || {}).prefs || {}), ...(patch.prefs || {}) }, ...(patch.onboarded !== undefined ? { onboarded: patch.onboarded } : {}) };
        if (emailNote) fresh.pendingEmail = String(changes.email).trim().toLowerCase();
        cacheUser(fresh);
        document.dispatchEvent(new CustomEvent("planora:user", { detail: fresh }));
        if (emailNote) toast(emailNote, "success");
        return fresh;
    }

    async function changePassword(current, next) {
        const user = currentUser();
        if (!user || user.guest) throw new Error("Passwords aren't used in guest mode.");
        if (String(next || "").length < 8) throw new Error("New password must be at least 8 characters.");
        if (user.hasPassword) {
            const { error } = await sb.auth.signInWithPassword({ email: user.email, password: String(current || "") });
            if (error) throw new Error("Your current password is incorrect.");
        }
        const { error } = await sb.auth.updateUser({ password: next });
        if (error) throw friendlyError(error);
    }

    async function deleteAccount() {
        const user = currentUser();
        if (user && user.guest) { clearLocalAccountData(); rawRemove.call(store, GUEST_KEY); return; }
        const { error } = await sb.rpc("delete_my_account");
        if (error) throw friendlyError(error);
        leaving = true;
        try { await sb.auth.signOut({ scope: "local" }); } catch {}
        clearLocalAccountData();
    }

    // Used by the login page after any successful sign-in
    async function afterSignIn() {
        rawRemove.call(store, GUEST_KEY);              // a real sign-in always ends development guest mode
        const { user, row } = await loadUser();
        await prepareDataFor(user, row);
        return user;
    }

    // Development only: try the app without an account (data stays in this browser)
    function startGuest() {
        if (!IS_DEV) throw new Error("Please sign in to use Planora.");
        rawSet.call(store, GUEST_KEY, "1");
        const owner = rawGet.call(store, OWNER_KEY);
        if (isUuid(owner)) clearLocalAccountData();   // never show a real account's data to a guest
        rawSet.call(store, OWNER_KEY, GUEST_ID);
        rawSet.call(store, GUEST_KEY, "1");
        const u = { id: GUEST_ID, name: "Guest", email: "", providers: ["guest"], guest: true, prefs: {}, onboarded: true };
        cacheUser(u);
        return u;
    }

    window.PlanoraAuth = {
        api,
        toast,
        get user() { return currentUser(); },
        get client() { return sb; },
        configured,
        isDev: IS_DEV,
        siteBase,
        friendlyError,
        accessToken,
        firstName,
        initials,
        logout,
        refreshUser,
        updateProfile,
        changePassword,
        deleteAccount,
        afterSignIn,
        startGuest,
        isGuest,
        clearLocalAccountData,
        exportData: collectLocalData,
        syncNow: () => { syncBlocked = false; return pushNow(); }
    };


    /* ---------------- Supabase auth events ---------------- */
    if (sb) {
        sb.auth.onAuthStateChange((event, session) => {
            lastToken = session ? session.access_token : null;
            if (event === "SIGNED_OUT") {
                // signed out here or in another tab, or the session could not be refreshed
                if (isAppPage && !leaving && !isGuest()) handleSignedOut(true);
            } else if (event === "USER_UPDATED" && session) {
                const cached = currentUser();
                if (cached && cached.id === session.user.id) {
                    const fresh = buildUser(session.user, profileCache || { name: cached.name, prefs: cached.prefs, onboarded: cached.onboarded });
                    cacheUser(fresh);
                    document.dispatchEvent(new CustomEvent("planora:user", { detail: fresh }));
                }
            } else if (event === "PASSWORD_RECOVERY") {
                if (!isResetPage) location.replace("reset-password.html");
            } else if (event === "SIGNED_IN" && session && isAppPage) {
                const cached = currentUser();
                if (cached && !cached.guest && cached.id !== session.user.id) location.reload();   // another account signed in in another tab
            }
            // TOKEN_REFRESHED: the SDK has stored the new session; nothing else to do
        });
    }


    /* ---------------- app pages: confirm the session ---------------- */

    if (isAppPage) {

        window.PlanoraAuth.ready = (async () => {
            if (isGuest()) {
                const { user } = await loadUser();
                rawSet.call(store, OWNER_KEY, GUEST_ID);
                reveal();
                document.dispatchEvent(new CustomEvent("planora:user", { detail: user }));
                return user;
            }
            if (!sb) { handleSignedOut(false); return null; }

            // 1. Is there a session on this device? (fast, local)
            let session = null;
            try { session = (await sb.auth.getSession()).data.session; } catch {}
            if (!session) { handleSignedOut(false); return null; }
            lastToken = session.access_token;
            const cached = currentUser();
            if (cached && cached.id === session.user.id) reveal();   // show the app straight away

            // 2. Confirm with Supabase and bring this device up to date
            try {
                const { user, row } = await loadUser();
                if (!user.onboarded) { location.replace("index.html?onboard=1"); return user; }
                const owner = rawGet.call(store, OWNER_KEY);
                const record = asRecord(row);
                if (owner !== user.id) {
                    if ((!owner || !isUuid(owner)) && !Object.keys(record.data).length && hasLocalData()) {
                        rawSet.call(store, OWNER_KEY, user.id);
                        syncBlocked = false;
                        await pushNow();
                    } else {
                        applyServerData(record, user.id);
                        location.reload();
                        return user;
                    }
                } else {
                    // Pick up changes made on another device since this page's data was saved.
                    const meta = initialMeta;
                    const unsyncedLocal = meta.dirty && (meta.localChangedAt || 0) > record.updatedAt;
                    if (!unsyncedLocal && record.updatedAt > (meta.updatedAt || 0)) {
                        applyServerData(record, user.id);
                        location.reload();
                        return user;
                    }
                }
                syncBlocked = false;
                reveal();
                if (readJson(META_KEY, {}).dirty) scheduleSync();
                document.dispatchEvent(new CustomEvent("planora:user", { detail: user }));
                return user;
            } catch (error) {
                if (error.status === 401) { handleSignedOut(true); return null; }
                // Offline or Supabase unreachable: keep working locally, sync later
                syncBlocked = false;
                reveal();
                return currentUser();
            }
        })();

        /* Phones and tablets keep the app open in the background for hours.
           - Back online: send anything saved while offline.
           - Back in the app: pick up changes made on another device
             (only when nothing here is waiting to be sent). */
        window.addEventListener("online", () => { if (readJson(META_KEY, {}).dirty) pushNow(); });
        let lastResumeCheck = Date.now();
        document.addEventListener("visibilitychange", async () => {
            if (document.visibilityState !== "visible" || syncBlocked || !sb) return;
            if (Date.now() - lastResumeCheck < 60000 || !navigator.onLine) return;
            lastResumeCheck = Date.now();
            const owner = rawGet.call(store, OWNER_KEY);
            if (!isUuid(owner)) return;
            try {
                const meta = readJson(META_KEY, {});
                if (meta.dirty) { pushNow(); return; }
                const row = await fetchRow(owner);
                const record = asRecord(row);
                if (record.updatedAt > (meta.updatedAt || 0) && !readJson(META_KEY, {}).dirty
                    && !document.querySelector("#planora-sheet, .edit-modal.open, #focus-mode:not([hidden]), textarea:focus, input:focus")) {
                    applyServerData(record, owner);
                    location.reload();
                }
            } catch (error) {
                if (/session has ended/.test(friendlyError(error).message)) handleSignedOut(true);
            }
        });

    } else {
        window.PlanoraAuth.ready = Promise.resolve(currentUser());
    }

})();
