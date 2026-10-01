/* =========================================================
   PLANORA APP  (pwa.js)

   Phones and tablets: Planora installs to the home screen and opens
   full-screen like an app. Laptops keep the website.

   - Registers the service worker (sw.js) so the app opens offline
   - "Get the Planora app" banner on Home (phones/tablets in a browser),
     plus "Install the app" in Profile → Settings
       Android / Chrome: one-tap install
       iPhone / iPad: shows the two steps (Share → Add to Home Screen)
   - Offline notice: changes are kept on the device and sync later
   ========================================================= */

(function () {

    const D = window.PlanoraDevice || { kind: "desktop", app: false, standalone: false };
    const DISMISS_KEY = "planora-install-dismissed";   // this device only
    let deferredPrompt = null;

    /* ---------- service worker ---------- */
    if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
        window.addEventListener("load", () => {
            navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(err => console.warn("Planora offline support unavailable:", err && err.message));
        });
    }

    /* ---------- helpers ---------- */
    const core = () => window.PlanoraCore;
    function toast(msg, type) {
        if (core() && core().toast) core().toast(msg, type);
        else if (window.PlanoraAuth && PlanoraAuth.toast) PlanoraAuth.toast(msg, type);
    }
    function dismissedRecently() {
        try {
            const at = Number(localStorage.getItem(DISMISS_KEY) || 0);
            return at && Date.now() - at < 14 * 86400000;
        } catch { return false; }
    }
    function dismiss() {
        try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {}
        const b = document.getElementById("install-banner");
        if (b) b.remove();
    }
    function canOffer() {
        return D.app && !D.standalone && !document.documentElement.classList.contains("is-standalone");
    }

    /* ---------- install ---------- */
    window.addEventListener("beforeinstallprompt", e => {
        e.preventDefault();          // we show our own, calmer prompt
        deferredPrompt = e;
        renderBanner();
        renderSettingsRow();
    });

    window.addEventListener("appinstalled", () => {
        deferredPrompt = null;
        dismiss();
        toast("Planora is on your home screen.", "success");
    });

    async function install() {
        if (deferredPrompt) {
            const p = deferredPrompt;
            deferredPrompt = null;
            p.prompt();
            try {
                const choice = await p.userChoice;
                if (choice && choice.outcome === "accepted") dismiss();
            } catch {}
            return;
        }
        showSteps();
    }

    function showSteps() {
        const ios = D.ios;
        const shareIcon = `<i class="ti ti-share-2" aria-hidden="true"></i>`;
        const body = ios ? `
            <ol class="install-steps">
                <li><span class="install-num">1</span><span>Tap <strong>Share</strong> ${shareIcon} ${D.iPad ? "at the top of Safari" : "at the bottom of Safari"}.</span></li>
                <li><span class="install-num">2</span><span>Scroll and tap <strong>Add to Home Screen</strong> <i class="ti ti-square-plus" aria-hidden="true"></i>.</span></li>
                <li><span class="install-num">3</span><span>Tap <strong>Add</strong>. Planora opens full-screen from your home screen.</span></li>
            </ol>
            <p class="pl-hint">Using Chrome on iPhone or iPad? Tap ${shareIcon} next to the address bar, then Add to Home Screen.</p>` : `
            <ol class="install-steps">
                <li><span class="install-num">1</span><span>Open your browser menu <i class="ti ti-dots-vertical" aria-hidden="true"></i>.</span></li>
                <li><span class="install-num">2</span><span>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.</span></li>
                <li><span class="install-num">3</span><span>Open Planora from your home screen.</span></li>
            </ol>`;
        if (core() && core().openSheet) {
            core().openSheet({
                title: "Get the Planora app",
                icon: "ti-device-mobile",
                body: body + `<div class="pl-row-actions"><button type="button" class="btn-primary" data-ok>Got it</button></div>`,
                onReady(panel) { panel.querySelector("[data-ok]").onclick = () => core().closeSheet(); }
            });
        }
    }

    function renderBanner() {
        if (!canOffer() || dismissedRecently()) return;
        const home = document.querySelector(".home-main");
        if (!home || document.getElementById("install-banner")) return;
        // iOS can't be prompted; others only once the browser says install is possible
        if (!D.ios && !deferredPrompt) return;
        const el = document.createElement("section");
        el.id = "install-banner";
        el.className = "install-banner";
        el.setAttribute("aria-label", "Get the Planora app");
        el.innerHTML = `
            <img src="/icons/icon-192.png" alt="" width="40" height="40">
            <div class="install-text">
                <strong>Get the Planora app</strong>
                <span>Add it to your home screen. It opens full-screen and works offline.</span>
            </div>
            <div class="install-actions">
                <button type="button" class="btn-primary" data-install>${deferredPrompt ? "Install" : "Show me how"}</button>
                <button type="button" class="install-close" data-dismiss aria-label="Not now"><i class="ti ti-x" aria-hidden="true"></i></button>
            </div>`;
        el.querySelector("[data-install]").onclick = install;
        el.querySelector("[data-dismiss]").onclick = dismiss;
        home.insertBefore(el, home.firstElementChild ? home.firstElementChild.nextSibling : null);
    }

    function renderSettingsRow() {
        if (!canOffer() || document.getElementById("install-row")) return;
        const rows = [...document.querySelectorAll(".settings-row")];
        const help = rows.find(r => /Help and support/i.test(r.textContent)) || rows.find(r => r.classList.contains("danger"));
        if (!help) return;
        const row = document.createElement("div");
        row.className = "settings-row";
        row.id = "install-row";
        row.setAttribute("role", "button");
        row.tabIndex = 0;
        row.innerHTML = `<i class="ti ti-device-mobile" aria-hidden="true"></i><span>Install the app</span><i class="ti ti-chevron-right chev" aria-hidden="true"></i>`;
        row.addEventListener("click", install);
        row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); install(); } });
        help.parentElement.insertBefore(row, help);
    }

    /* ---------- offline notice ---------- */
    function renderOffline() {
        let el = document.getElementById("offline-note");
        if (navigator.onLine) { if (el) el.remove(); return; }
        if (el) return;
        el = document.createElement("div");
        el.id = "offline-note";
        el.className = "offline-note";
        el.setAttribute("role", "status");
        el.innerHTML = `<i class="ti ti-cloud-off" aria-hidden="true"></i> Offline. Changes are saved on this device and will sync later.`;
        document.body.appendChild(el);
    }
    window.addEventListener("offline", renderOffline);
    window.addEventListener("online", () => { renderOffline(); toast("Back online. Your changes are syncing.", "success"); });

    function init() {
        renderOffline();
        // wait a moment so Home has drawn (and never interrupt the first seconds)
        setTimeout(() => { renderBanner(); renderSettingsRow(); }, 1200);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();

    window.PlanoraApp = { install, showSteps };
})();
