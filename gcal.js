/* =========================================================
   PLANORA ⇄ GOOGLE CALENDAR — in the app  (gcal.js)

   - "Google" button on the Calendar toolbar (and Profile → Google Calendar)
     opens a small panel: link / choose calendars / refresh / unlink.
   - Linking uses Google's own popup. The browser only ever gets a one-time
     code, which it hands to Planora's server (gcal-server.js). Google's
     tokens never reach this page or localStorage.
   - Google events show in Month / Week / Day with Google's colours and a
     Google icon. They're read-only here: tap one to see it, or open it in
     Google Calendar to change it.
   - The events last shown are remembered on this device (per account), so
     the calendar fills in instantly while it refreshes.
   ========================================================= */

(function () {
    const CACHE_KEY = "planora-gcal-cache";          // not "planora_" → never uploaded with the app data
    const FRESH_MS = 5 * 60 * 1000;
    const GIS_SRC = "https://accounts.google.com/gsi/client";
    const C = () => window.PlanoraCore;
    const A = () => window.PlanoraAuth;
    const esc = s => (C() && C().esc ? C().esc(s) : String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]));
    const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };

    const st = {
        uid: "",
        status: null,           // { configured, connected, email, clientId, scope, reason }
        connected: false,
        email: "",
        calendars: [],
        events: {},             // date -> [items]
        fetched: [],            // [{ from, to, at }]
        inflight: new Map(),
        lastSync: 0,
        syncing: 0,
        error: "",
        push: { busy: false, last: 0, error: "", count: 0 }
    };

    /* ---------------- who ---------------- */
    function user() { try { return A() && A().user; } catch { return null; } }
    const signedIn = () => { const u = user(); return Boolean(u && u.id && !u.guest); };

    /* ---------------- cache on this device ---------------- */
    function loadCache() {
        const u = user();
        const uid = u && u.id ? String(u.id) : "";
        if (uid !== st.uid) {                       // someone else signed in: forget the last person's events
            st.connected = false; st.email = ""; st.calendars = []; st.events = {}; st.fetched = []; st.lastSync = 0; st.status = null;
        }
        st.uid = uid;
        try {
            const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
            if (c && c.uid && c.uid === st.uid && signedIn()) {
                st.connected = Boolean(c.connected); st.email = c.email || ""; st.calendars = c.calendars || [];
                st.events = c.events || {}; st.lastSync = c.lastSync || 0;
            }
        } catch {}
    }
    function saveCache() {
        if (!st.uid) return;
        try {
            const keep = {};
            const today = C() ? C().today() : new Date().toISOString().slice(0, 10);
            const lo = C() ? C().addDays(today, -60) : "", hi = C() ? C().addDays(today, 120) : "9999";
            Object.keys(st.events).forEach(d => { if (d >= lo && d <= hi && st.events[d].length) keep[d] = st.events[d]; });
            localStorage.setItem(CACHE_KEY, JSON.stringify({ uid: st.uid, connected: st.connected, email: st.email, calendars: st.calendars, events: keep, lastSync: st.lastSync }));
        } catch {}
    }
    function clearAll() {
        st.connected = false; st.email = ""; st.calendars = []; st.events = {}; st.fetched = []; st.lastSync = 0;
        try { localStorage.removeItem(CACHE_KEY); } catch {}
    }

    /* ---------------- server ---------------- */
    async function call(path, options) {
        let res;
        try {
            res = await fetch("/api/gcal" + path, {
                ...(options || {}),
                headers: { ...((options && options.body) ? { "Content-Type": "application/json" } : {}) }
            });
        } catch {
            const e = new Error("Can't reach Planora right now. Check your internet connection."); e.code = "offline"; throw e;
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { const e = new Error(body.error || "Something went wrong. Please try again."); e.code = body.code || ""; e.status = res.status; throw e; }
        return body;
    }

    async function refreshStatus() {
        if (!signedIn()) { st.status = { configured: false, connected: false, reason: "sign_in" }; return st.status; }
        try {
            st.status = await call("/status");
            if (st.status.connected !== st.connected) {
                if (!st.status.connected) clearAll();
                st.connected = Boolean(st.status.connected);
                st.fetched = [];
                saveCache(); redraw();
            }
            st.email = st.status.email || st.email;
        } catch (e) {
            st.status = { configured: st.connected, connected: st.connected, offline: e.code === "offline", reason: e.code, error: e.message };
        }
        return st.status;
    }

    /* ---------------- events for the calendar ---------------- */
    const covered = (from, to) => st.fetched.some(r => r.from <= from && r.to >= to && Date.now() - r.at < FRESH_MS);

    function fetchRange(from, to, { force = false } = {}) {
        if (!st.connected || !signedIn()) return Promise.resolve();
        if (!force && covered(from, to)) return Promise.resolve();
        const key = from + "|" + to;
        if (st.inflight.has(key)) return st.inflight.get(key);
        st.syncing++; paintButton();
        const p = call(`/events?from=${from}&to=${to}&tz=${encodeURIComponent(tz())}`)
            .then(body => {
                const before = JSON.stringify(slice(from, to));
                for (let d = from; d <= to; d = C().addDays(d, 1)) delete st.events[d];
                (body.events || []).forEach(ev => { (st.events[ev.date] = st.events[ev.date] || []).push(ev); });
                st.calendars = body.calendars || st.calendars;
                st.email = body.email || st.email;
                st.fetched = st.fetched.filter(r => !(r.from >= from && r.to <= to)).concat({ from, to, at: Date.now() });
                st.lastSync = Date.now(); st.error = "";
                saveCache();
                if (JSON.stringify(slice(from, to)) !== before) redraw();
            })
            .catch(e => {
                st.error = e.message;
                st.fetched.push({ from, to, at: Date.now() - FRESH_MS + 60 * 1000 });   // don't hammer: try again in a minute
                if (e.code === "reconnect" || e.code === "not_connected") {
                    clearAll(); saveCache(); redraw();
                    if (C()) C().toast(e.message, "error");
                }
            })
            .finally(() => { st.inflight.delete(key); st.syncing--; paintButton(); paintPanel(); });
        st.inflight.set(key, p);
        return p;
    }
    function slice(from, to) {
        const out = [];
        for (let d = from; d <= to; d = C().addDays(d, 1)) (st.events[d] || []).forEach(e => out.push(e));
        return out;
    }

    // calendar-views.js asks for the items on screen
    function itemsFor(from, to) {
        if (!st.connected || !signedIn() || !C()) return [];
        setTimeout(() => fetchRange(from, to), 0);
        return slice(from, to).map(ev => {
            const s = C().toMin(ev.start), e = C().toMin(ev.end);
            return {
                kind: "gevent", id: String(ev.id), raw: ev, date: ev.date,
                start: ev.allDay ? "" : ev.start,
                dur: ev.allDay ? 0 : Math.max(15, (e === null || s === null ? 60 : e - s)),
                title: ev.title
            };
        });
    }
    function find(id) {
        for (const d of Object.keys(st.events)) { const hit = st.events[d].find(e => String(e.id) === String(id)); if (hit) return hit; }
        return null;
    }
    function redraw() { if (window.PlanoraCalendar && PlanoraCalendar.render) PlanoraCalendar.render(); }

    /* ---------------- toolbar button ---------------- */
    function buttonHTML() {
        const on = st.connected && signedIn();
        return `<button type="button" class="cv-btn cv-gcal${on ? " is-on" : ""}${st.syncing ? " is-syncing" : ""}" data-gcal aria-haspopup="dialog" title="${on ? "Google Calendar is linked" : "Link Google Calendar"}">
            <i class="ti ${st.syncing ? "ti-refresh" : "ti-brand-google"}" aria-hidden="true"></i><span class="cv-gcal-t">${on ? "Google" : "Link Google"}</span>${on ? '<span class="cv-gcal-dot" aria-hidden="true"></span>' : ""}<span class="sr-only">${on ? " Calendar linked" : " Calendar"}</span>
        </button>`;
    }
    function paintButton() {
        const b = document.querySelector("[data-gcal]");
        if (b) b.outerHTML = buttonHTML();
    }

    /* ---------------- Google's popup (one-time code) ---------------- */
    let gisPromise = null, codeClient = null, syncClient = null, linkWithSync = true;
    function loadGis() {
        if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
        if (gisPromise) return gisPromise;
        gisPromise = new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = GIS_SRC; s.async = true; s.defer = true;
            s.onload = () => resolve(); s.onerror = () => { gisPromise = null; reject(new Error("Couldn't load Google's sign-in window. Check your connection and try again.")); };
            document.head.appendChild(s);
        });
        return gisPromise;
    }
    // withSync: also ask for permission to keep a "Planora" calendar in Google
    function makeCodeClient(withSync) {
        const s = st.status || {};
        if (!(window.google && google.accounts && google.accounts.oauth2) || !s.clientId) return null;
        const u = user() || {};
        return google.accounts.oauth2.initCodeClient({
            client_id: s.clientId,
            scope: (withSync && s.scopeSync) || s.scope || "openid email https://www.googleapis.com/auth/calendar.readonly",
            include_granted_scopes: true,
            ux_mode: "popup",
            select_account: true,
            ...(u.email ? { login_hint: u.email } : {}),
            callback: async resp => {
                if (!resp || resp.error || !resp.code) { showError(resp && resp.error === "access_denied" ? "Google Calendar wasn't linked." : "Google didn't finish linking. Please try again."); return; }
                const wasLinked = st.connected;
                busy(wasLinked ? "Turning on…" : "Linking…");
                try {
                    let r;
                    try { r = await call("/connect", { method: "POST", body: JSON.stringify({ code: resp.code, sync: Boolean(withSync) }) }); }
                    catch (e) {
                        if (e.code !== "scope_write") throw e;
                        // linked, but the "add to Google" box wasn't ticked
                        st.connected = true; st.status = { ...(st.status || {}), connected: true, canWrite: false, sync: false };
                        st.syncNote = e.message;
                        saveCache(); paintButton(); redraw(); paintPanel(); return;
                    }
                    if (!wasLinked) { st.fetched = []; st.events = {}; }
                    st.connected = true; st.email = r.email || st.email;
                    st.status = { ...(st.status || {}), connected: true, email: st.email, canWrite: Boolean(r.canWrite) || Boolean(st.status && st.status.canWrite), sync: Boolean(r.sync) };
                    saveCache();
                    st.syncNote = r.syncNote || "";
                    if (r.sync) { resetSnapshot(); schedulePush(0); }
                    if (C() && !r.syncNote) C().toast(r.sync ? (wasLinked ? "Your Planora tasks will now show in Google Calendar ✅" : "Google Calendar linked, and your Planora tasks will show there too ✅") : "Google Calendar linked ✅", "success");
                    if (C() && r.syncNote) C().toast("Google Calendar linked ✅", "success");
                    paintButton(); paintPanel(); redraw();
                    const cal = window.PlanoraCalendar;
                    if (!cal) fetchRange(C().today(), C().addDays(C().today(), 6)).then(paintPanel);
                } catch (e) { showError(e.message); }
            },
            error_callback: err => {
                if (err && err.type === "popup_closed") { paintPanel(); return; }
                showError(err && err.type === "popup_failed_to_open" ? "Your browser blocked Google's window. Allow pop-ups for Planora and try again." : "Google didn't finish linking. Please try again.");
            }
        });
    }

    /* ---------------- Planora → Google Calendar ----------------
       Timed tasks and events from a week ago to 3 months ahead are copied into the
       "Planora" calendar in Google. This device remembers what it last sent (no tokens,
       just a fingerprint per item), so only changes go up. Deleting in Planora deletes
       the copy in Google. */
    const SNAP_KEY = "planora-gcal-sync";
    const syncOn = () => Boolean(st.connected && signedIn() && st.status && st.status.sync);
    function loadSnap() {
        try { const s = JSON.parse(localStorage.getItem(SNAP_KEY) || "null"); if (s && s.uid === st.uid) return s.items || {}; } catch {}
        return {};
    }
    function saveSnap(items) { try { localStorage.setItem(SNAP_KEY, JSON.stringify({ uid: st.uid, items })); } catch {} }
    function resetSnapshot() { try { localStorage.removeItem(SNAP_KEY); } catch {} }
    function currentItems() {
        const core = C(); if (!core) return {};
        const t = core.today(), lo = core.addDays(t, -7), hi = core.addDays(t, 90);
        const out = {};
        const endOf = (start, end, dur) => (core.toMin(end) !== null && core.toMin(end) > core.toMin(start)) ? end : core.toClock(core.toMin(start) + Math.max(15, dur || 30));
        core.getTasks().forEach(x => {
            if (!x.date || x.date < lo || x.date > hi || core.toMin(x.start) === null) return;
            out["t:" + x.id] = { key: "t:" + x.id, title: String(x.title || "Task"), date: x.date, start: x.start, end: endOf(x.start, x.end, core.taskDuration(x)), done: Boolean(x.completed) };
        });
        core.getEvents().forEach(e => {
            if (!e.date || e.date < lo || e.date > hi || core.toMin(e.start) === null) return;
            out["e:" + e.id] = { key: "e:" + e.id, title: String(e.title || "Event"), date: e.date, start: e.start, end: endOf(e.start, e.end, core.eventDuration(e)), done: false };
        });
        return out;
    }
    let pushTimer = null;
    function schedulePush(ms) { clearTimeout(pushTimer); pushTimer = setTimeout(pushChanges, ms == null ? 1500 : ms); }
    async function pushChanges() {
        if (!syncOn() || st.push.busy || !C()) return;
        const core = C();
        const cur = currentItems(), snap = loadSnap();
        const fp = it => [it.title, it.date, it.start, it.end, it.done ? 1 : 0].join("|");
        const allIds = new Set(core.getTasks().map(x => "t:" + x.id).concat(core.getEvents().map(e => "e:" + e.id)));
        const upserts = Object.values(cur).filter(it => snap[it.key] !== fp(it));
        // removed in Planora (not just moved out of the 3-month window) → remove from Google
        const deletes = Object.keys(snap).filter(k => !cur[k] && !allIds.has(k));
        // forget very old fingerprints without touching Google
        const old = core.addDays(core.today(), -30);
        Object.keys(snap).forEach(k => { if (!cur[k] && allIds.has(k) && snap[k].split("|")[1] < old) delete snap[k]; });
        if (!upserts.length && !deletes.length) return;
        st.push.busy = true;
        try {
            for (let i = 0; i < Math.max(upserts.length, deletes.length); i += 100) {
                const u = upserts.slice(i, i + 100), d = deletes.slice(i, i + 100);
                if (!u.length && !d.length) break;
                const r = await call("/push", { method: "POST", body: JSON.stringify({ tz: tz(), upserts: u, deletes: d }) });
                (r.done || []).forEach(k => { if (cur[k]) snap[k] = fp(cur[k]); else delete snap[k]; });
                saveSnap(snap);
                st.push.count += (r.done || []).length;
            }
            st.push.last = Date.now(); st.push.error = "";
        } catch (e) {
            st.push.error = e.message;
            if (e.code === "scope_write") st.syncNote = e.message;
            if (e.code === "sync_off" || e.code === "scope_write" || e.code === "needs_update") st.status = { ...(st.status || {}), sync: false, canWrite: e.code === "sync_off" ? (st.status || {}).canWrite : false };
            if (e.code === "reconnect" || e.code === "not_connected") { clearAll(); saveCache(); paintButton(); redraw(); }
        } finally {
            st.push.busy = false;
            paintPanel();
        }
    }
    function syncSection() {
        const s = st.status || {};
        if (!s.scopeSync) return "";
        if (s.needsUpdate) return `<div class="gcal-sync"><p class="gcal-note"><i class="ti ti-info-circle" aria-hidden="true"></i> Adding Planora tasks to Google Calendar isn't switched on yet.</p></div>`;
        if (s.sync) return `<div class="gcal-sync is-on">
                <p class="gcal-sync-t"><i class="ti ti-arrows-exchange" aria-hidden="true"></i><span><strong>Planora tasks → Google Calendar is on.</strong> They're in the "Planora" calendar in Google, and update when you change them here.</span></p>
                <p class="gcal-sub">${st.push.busy ? "Updating Google…" : st.push.last ? "Updated " + esc(ago(st.push.last)) : "Up to date"}${st.push.error ? ` · <span class="gcal-warn">${esc(st.push.error)}</span>` : ""}</p>
                <button type="button" class="gcal-linkbtn" data-g="sync-off">Stop adding tasks to Google</button>
            </div>`;
        const ready = Boolean(s.canWrite || syncClient);
        return `<div class="gcal-sync">
                <p class="gcal-sync-t"><i class="ti ti-arrows-exchange" aria-hidden="true"></i><span><strong>Add your Planora tasks to Google Calendar</strong> — they go in a separate "Planora" calendar and update when you change them here. Your own Google events aren't touched.</span></p>
                ${st.syncNote ? `<p class="gcal-sub gcal-warn" role="alert">${esc(st.syncNote)}</p>` : ""}
                <button type="button" class="btn-secondary gcal-sync-on" data-g="sync-on" ${ready ? "" : "disabled"}>${ready ? "Turn on" : "Loading Google…"}</button>
            </div>`;
    }

    /* ---------------- panel ---------------- */
    let overlay = null, lastFocus = null, confirmUnlink = false;
    function openPanel() {
        closePanel();
        lastFocus = document.activeElement;
        overlay = document.createElement("div");
        overlay.className = "labels-overlay gcal-overlay";
        overlay.innerHTML = `
            <div class="labels-dialog gcal-dialog" role="dialog" aria-modal="true" aria-labelledby="gcal-title">
                <div class="gcal-head">
                    <span class="gcal-logo" aria-hidden="true"><i class="ti ti-brand-google"></i></span>
                    <h2 id="gcal-title">Google Calendar</h2>
                    <button type="button" class="gcal-x" data-g="close" aria-label="Close"><i class="ti ti-x" aria-hidden="true"></i></button>
                </div>
                <div class="gcal-body" aria-live="polite"></div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener("click", onPanelClick);
        overlay.addEventListener("change", onPanelChange);
        document.addEventListener("keydown", onPanelKey, true);
        confirmUnlink = false;
        paintPanel({ loading: true });
        const t = overlay.querySelector("[data-g=close]"); if (t) t.focus();
        refreshStatus().then(s => {
            paintPanel();
            if (s && s.configured && !s.connected) loadGis().then(() => { codeClient = makeCodeClient(false); syncClient = makeCodeClient(true); paintPanel(); }).catch(e => showError(e.message));
            if (s && s.connected && !s.canWrite && !s.needsUpdate) loadGis().then(() => { syncClient = makeCodeClient(true); paintPanel(); }).catch(() => {});
            if (s && s.connected && C()) fetchRange(C().today(), C().addDays(C().today(), 6), { force: !st.calendars.length });
        });
    }
    function closePanel() {
        if (!overlay) return;
        overlay.remove(); overlay = null;
        document.removeEventListener("keydown", onPanelKey, true);
        if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
    }
    function onPanelKey(e) {
        if (e.key === "Escape") { e.stopPropagation(); closePanel(); }
        if (e.key === "Tab" && overlay) {           // keep focus inside the panel
            const f = [...overlay.querySelectorAll("button:not([disabled]), input, a[href]")];
            if (!f.length) return;
            if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
            else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
        }
    }
    function busy(text) { const b = overlay && overlay.querySelector(".gcal-body"); if (b) b.innerHTML = `<p class="gcal-note"><i class="ti ti-loader-2 gcal-spin" aria-hidden="true"></i> ${esc(text)}</p>`; }
    function showError(msg) { paintPanel(); const b = overlay && overlay.querySelector(".gcal-err"); if (b) { b.textContent = msg; b.hidden = false; } else if (C()) C().toast(msg, "error"); }
    function ago(t) {
        if (!t) return "not yet";
        const m = Math.round((Date.now() - t) / 60000);
        return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
    }

    function paintPanel(opts) {
        const body = overlay && overlay.querySelector(".gcal-body");
        if (!body) return;
        const s = st.status;
        const err = `<p class="auth-error gcal-err" role="alert" hidden></p>`;
        if ((opts && opts.loading) || !s) { body.innerHTML = `<p class="gcal-note"><i class="ti ti-loader-2 gcal-spin" aria-hidden="true"></i> Checking…</p>`; return; }
        if (!signedIn() || s.reason === "sign_in") {
            body.innerHTML = `<p class="gcal-lead">Sign in with your Planora account to see your Google Calendar events here.</p>
                <div class="gcal-actions"><a class="btn-primary gcal-cta" href="index.html">Sign in</a></div>`;
            return;
        }
        if (s.offline && !st.connected) {
            body.innerHTML = `<p class="gcal-lead">${esc(s.error || "Can't reach Planora right now.")}</p>
                <div class="gcal-actions"><button type="button" class="btn-secondary" data-g="retry">Try again</button></div>`;
            return;
        }
        if (!s.configured && !st.connected) {
            body.innerHTML = `<p class="gcal-lead">Linking Google Calendar isn't switched on for Planora yet. Please check back soon.</p>`;
            return;
        }
        if (!st.connected) {
            const ready = Boolean(codeClient && syncClient);
            body.innerHTML = `
                <p class="gcal-lead">See your Google Calendar events in Planora, next to your tasks. Ask Planora will plan around them too.</p>
                <ul class="gcal-points">
                    <li><i class="ti ti-eye" aria-hidden="true"></i><span>Your own Google events are only <strong>read</strong>. Planora never changes or deletes them.</span></li>
                    <li><i class="ti ti-lock" aria-hidden="true"></i><span>Only you can see them. Unlink any time.</span></li>
                </ul>
                ${s.scopeSync && !s.needsUpdate ? `<label class="gcal-opt"><input type="checkbox" data-g-opt="sync" ${linkWithSync ? "checked" : ""}><span class="gcal-box" style="--c:#534AB7"><i class="ti ti-check" aria-hidden="true"></i></span>
                    <span>Also add my Planora tasks and events to Google Calendar <small>(in a separate "Planora" calendar)</small></span></label>` : ""}
                ${err}
                <div class="gcal-actions">
                    <button type="button" class="gcal-google" data-g="link" ${ready ? "" : "disabled aria-busy=\"true\""}>
                        <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.2C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.2z"/><path fill="#FBBC05" d="M10.6 28.5c-.5-1.4-.8-2.9-.8-4.5s.3-3.1.8-4.5l-7.9-6.2C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.7l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>
                        <span>${ready ? "Link Google Calendar" : "Loading Google…"}</span>
                    </button>
                </div>`;
            return;
        }
        const cals = st.calendars || [];
        body.innerHTML = `
            <p class="gcal-who"><i class="ti ti-circle-check-filled" aria-hidden="true"></i><span>Linked${st.email ? ` to <strong>${esc(st.email)}</strong>` : ""}</span></p>
            <p class="gcal-sub">Synced ${esc(ago(st.lastSync))}${st.syncing ? " · syncing…" : ""}</p>
            ${st.error ? `<p class="auth-error gcal-err" role="alert">${esc(st.error)}</p>` : err}
            <fieldset class="gcal-cals">
                <legend>Show these calendars</legend>
                ${cals.length ? cals.map(c => `
                    <label class="gcal-cal">
                        <input type="checkbox" value="${esc(c.id)}" ${c.selected ? "checked" : ""}>
                        <span class="gcal-box" style="--c:${esc(c.color)}"><i class="ti ti-check" aria-hidden="true"></i></span>
                        <span class="gcal-name">${esc(c.name)}${c.primary ? ' <small>(main)</small>' : ""}</span>
                    </label>`).join("") : `<p class="gcal-note">${st.syncing ? "Loading your calendars…" : "Your calendars will show here after the first sync."}</p>`}
            </fieldset>
            ${syncSection()}
            <p class="gcal-hint">Google events are read-only in Planora. To change one, open it in Google Calendar.</p>
            <div class="gcal-actions">
                <button type="button" class="gcal-unlink${confirmUnlink ? " is-confirm" : ""}" data-g="unlink">${confirmUnlink ? "Tap again to unlink" : "Unlink"}</button>
                <span class="labels-spacer"></span>
                <button type="button" class="btn-secondary" data-g="sync"${st.syncing ? " disabled" : ""}><i class="ti ti-refresh" aria-hidden="true"></i> Sync now</button>
                <button type="button" class="btn-primary" data-g="close">Done</button>
            </div>`;
    }

    function visibleRange() {
        const cal = window.PlanoraCalendar;
        const host = document.getElementById("cal-view");
        if (cal && host) {
            const d = [...host.querySelectorAll("[data-day],[data-col]")].map(x => x.dataset.day || x.dataset.col).filter(Boolean).sort();
            if (d.length) return [d[0], d[d.length - 1]];
        }
        const t = C().today();
        return [t, C().addDays(t, 6)];
    }

    async function onPanelClick(e) {
        if (e.target === overlay) { closePanel(); return; }
        const b = e.target.closest("[data-g]");
        if (!b) return;
        const act = b.dataset.g;
        if (act !== "unlink") confirmUnlink = false;
        if (act === "close") closePanel();
        else if (act === "retry") { paintPanel({ loading: true }); refreshStatus().then(() => paintPanel()); }
        else if (act === "link") {
            const opt = overlay.querySelector("[data-g-opt=sync]");
            linkWithSync = Boolean(opt && opt.checked);
            const client = linkWithSync ? (syncClient || (syncClient = makeCodeClient(true))) : (codeClient || (codeClient = makeCodeClient(false)));
            if (!client) { showError("Google's window isn't ready yet. Please try again in a moment."); return; }
            client.requestCode();                           // must run straight from the tap (pop-up blockers)
        }
        else if (act === "sync-on") {
            const s = st.status || {};
            if (s.canWrite) {
                busy("Turning on…");
                try { await call("/sync-setting", { method: "POST", body: JSON.stringify({ on: true }) }); st.status = { ...s, sync: true }; resetSnapshot(); schedulePush(0); if (C()) C().toast("Your Planora tasks will now show in Google Calendar ✅", "success"); }
                catch (err) { if (err.code === "scope_write") st.status = { ...s, canWrite: false }; showError(err.message); return; }
                paintPanel(); return;
            }
            if (!syncClient) syncClient = makeCodeClient(true);
            if (!syncClient) { showError("Google's window isn't ready yet. Please try again in a moment."); return; }
            syncClient.requestCode();
        }
        else if (act === "sync-off") {
            busy("Turning off…");
            try { await call("/sync-setting", { method: "POST", body: JSON.stringify({ on: false }) }); st.status = { ...(st.status || {}), sync: false }; if (C()) C().toast("Stopped adding Planora tasks to Google Calendar.", "success"); }
            catch (err) { showError(err.message); return; }
            paintPanel();
        }
        else if (act === "sync") {
            st.fetched = [];
            const [f, t] = visibleRange();
            paintPanel();
            await fetchRange(f, t, { force: true });
            paintPanel();
            if (!st.error && C()) C().toast("Google Calendar is up to date.", "success");
        }
        else if (act === "unlink") {
            if (!confirmUnlink) { confirmUnlink = true; paintPanel(); const u = overlay.querySelector("[data-g=unlink]"); if (u) u.focus(); return; }
            busy("Unlinking…");
            try {
                await call("/disconnect", { method: "POST", body: "{}" });
                clearAll(); st.status = { ...(st.status || {}), connected: false, email: "" };
                confirmUnlink = false;
                paintButton(); redraw();
                if (C()) C().toast("Google Calendar unlinked.", "success");
                await loadGis().catch(() => {});
                codeClient = makeCodeClient(false); syncClient = makeCodeClient(true);
                paintPanel();
            } catch (err) { showError(err.message); }
        }
    }
    let saveTimer = null;
    function onPanelChange(e) {
        if (!e.target.matches(".gcal-cal input")) return;
        const ids = [...overlay.querySelectorAll(".gcal-cal input:checked")].map(i => i.value);   // [] = show none
        st.calendars = st.calendars.map(c => ({ ...c, selected: ids.includes(c.id) }));
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            try {
                await call("/calendars", { method: "POST", body: JSON.stringify({ ids }) });
                st.fetched = [];
                const [f, t] = visibleRange();
                await fetchRange(f, t, { force: true });
                redraw();
            } catch (err) { showError(err.message); }
        }, 400);
    }

    /* ---------------- one Google event (read-only) ---------------- */
    function openEvent(id) {
        const ev = find(id);
        if (!ev) return;
        closePanel();
        lastFocus = document.activeElement;
        const core = C();
        const day = new Date(ev.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
        const when = ev.allDay ? `${day} · All day` : `${day} · ${core.time12(ev.start)} – ${core.time12(ev.end)}`;
        overlay = document.createElement("div");
        overlay.className = "labels-overlay gcal-overlay";
        overlay.innerHTML = `
            <div class="labels-dialog gcal-dialog gcal-event" role="dialog" aria-modal="true" aria-labelledby="gcal-ev-title" style="--c:${esc(ev.color)}">
                <div class="gcal-head">
                    <span class="gcal-swatch" aria-hidden="true"></span>
                    <h2 id="gcal-ev-title">${esc(ev.title)}</h2>
                    <button type="button" class="gcal-x" data-g="close" aria-label="Close"><i class="ti ti-x" aria-hidden="true"></i></button>
                </div>
                <div class="gcal-body">
                    <p class="gcal-row"><i class="ti ti-clock" aria-hidden="true"></i><span>${esc(when)}</span></p>
                    ${ev.location ? `<p class="gcal-row"><i class="ti ti-map-pin" aria-hidden="true"></i><span>${esc(ev.location)}</span></p>` : ""}
                    <p class="gcal-row"><i class="ti ti-brand-google" aria-hidden="true"></i><span>${esc(ev.calName || "Google Calendar")}</span></p>
                    <p class="gcal-hint">From Google Calendar. Change it there and it updates here.</p>
                    <div class="gcal-actions">
                        <span class="labels-spacer"></span>
                        ${ev.link ? `<a class="btn-secondary gcal-open" href="${esc(ev.link)}" target="_blank" rel="noopener noreferrer"><i class="ti ti-external-link" aria-hidden="true"></i> Open in Google Calendar</a>` : ""}
                        <button type="button" class="btn-primary" data-g="close">Close</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener("click", onPanelClick);
        document.addEventListener("keydown", onPanelKey, true);
        const x = overlay.querySelector("[data-g=close]"); if (x) x.focus();
    }

    /* ---------------- start ---------------- */
    function init() {
        loadCache();
        document.addEventListener("click", e => {
            const b = e.target.closest("[data-gcal]");
            if (b) { e.preventDefault(); openPanel(); return; }
            const g = e.target.closest("[data-open-gevent]");
            if (g) { e.preventDefault(); e.stopPropagation(); openEvent(g.dataset.openGevent); }
        }, true);
        // keep fresh: when you come back to the tab
        document.addEventListener("visibilitychange", () => { if (!document.hidden && st.connected) { redraw(); schedulePush(500); } });
        document.addEventListener("planora:data-changed", () => schedulePush());
        document.addEventListener("planora:plan-added", () => schedulePush());
        setInterval(() => { if (!document.hidden) pushChanges(); }, 20000);   // also catches changes saved without an event
        document.addEventListener("planora:user", () => { const before = st.uid; loadCache(); if (before !== st.uid) { st.fetched = []; redraw(); } });
        const ready = A() && A().ready;
        Promise.resolve(ready).catch(() => {}).then(() => {
            loadCache(); paintButton(); redraw();
            if (signedIn()) refreshStatus().then(() => {
                paintButton();
                schedulePush(800);
                // the next month, so Ask Planora and "free time" can plan around Google events
                if (st.connected && Date.now() - st.lastSync > 15 * 60 * 1000 && C()) fetchRange(C().today(), C().addDays(C().today(), 30));
            });
            if (new URLSearchParams(location.search).get("gcal") === "1") openPanel();
        });
    }

    window.PlanoraGCal = {
        itemsFor, openPanel, openEvent, buttonHTML,
        get connected() { return st.connected && signedIn(); },
        _state: st
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();
