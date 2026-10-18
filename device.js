/* =========================================================
   PLANORA DEVICE  (device.js)  — loaded first, in <head>

   Decides how Planora should behave on this device and marks
   <html> before the page draws (no flicker):

     phone   → app      (html.device-phone.app-mode)
     tablet  → app      (html.device-tablet.app-mode)
     laptop / desktop → website (html.device-desktop.web-mode)

   Also: html.is-touch, html.is-standalone (opened from the home
   screen), html.is-ios, html.is-android.
   Window size still controls the layout; this only decides between
   the full-screen app shell and the website card on bigger screens.
   ========================================================= */

(function () {
    var html = document.documentElement;
    var ua = navigator.userAgent || "";
    var touchPoints = navigator.maxTouchPoints || 0;
    var mq = function (q) { try { return window.matchMedia(q).matches; } catch (e) { return false; } };

    // iPadOS reports itself as a Mac; a Mac never has touch points.
    var iPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
    var iOS = iPad || /iPhone|iPod/.test(ua);
    var android = /Android/i.test(ua);
    var mobileUA = /Android|iPhone|iPod|Mobile|Silk|Kindle|webOS|BlackBerry|Opera Mini|IEMobile/i.test(ua);
    var coarse = mq("(pointer: coarse)");
    var fineHover = mq("(hover: hover) and (pointer: fine)");
    var anyFine = mq("(any-pointer: fine)");
    var laptopOS = /Windows NT|CrOS|Macintosh/.test(ua) && !iPad;
    // Touch-screen laptops (Windows, Chromebook) have a mouse/trackpad too, so they stay "website".
    var touchDevice = iPad || mobileUA || (coarse && !fineHover && !anyFine && !laptopOS);

    var shortSide = Math.min(screen.width || window.innerWidth, screen.height || window.innerHeight);
    var kind = !touchDevice ? "desktop" : (shortSide < 600 && !iPad ? "phone" : "tablet");

    var standalone = mq("(display-mode: standalone)") || mq("(display-mode: fullscreen)") || window.navigator.standalone === true;

    var cls = ["device-" + kind, kind === "desktop" ? "web-mode" : "app-mode"];
    if (touchDevice || touchPoints > 0) cls.push("is-touch");
    if (standalone) cls.push("is-standalone");
    if (iOS) cls.push("is-ios");
    if (android) cls.push("is-android");
    html.className += (html.className ? " " : "") + cls.join(" ");

    window.PlanoraDevice = {
        kind: kind,                       // "phone" | "tablet" | "desktop"
        app: kind !== "desktop",          // phones + tablets behave like an app
        standalone: standalone,           // opened from the home screen
        ios: iOS,
        android: android,
        iPad: iPad
    };
})();

/* Show / hide password: an eye button in every password box (18 Oct 2026) */
(function () {
    var EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    var EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a17.7 17.7 0 0 1-3.2 4.1M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></svg>';
    function add(input) {
        if (input.dataset.pwEye || input.closest(".pw-wrap")) return;
        input.dataset.pwEye = "1";
        // an older eye button drawn with the icon font (it didn't always show): replace it
        var old = input.parentNode && input.parentNode.querySelector(":scope > .pw-toggle");
        if (old) old.remove();
        var wrap = document.createElement("span");
        wrap.className = "pw-wrap";
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pw-eye";
        btn.setAttribute("aria-label", "Show password");
        btn.setAttribute("aria-pressed", "false");
        btn.innerHTML = EYE;
        btn.addEventListener("mousedown", function (e) { e.preventDefault(); });   // keep the cursor in the box
        btn.addEventListener("click", function () {
            var show = input.type === "password";
            input.type = show ? "text" : "password";
            btn.innerHTML = show ? EYE_OFF : EYE;
            btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
            btn.setAttribute("aria-pressed", String(show));
        });
        wrap.appendChild(btn);
    }
    function scan(root) { (root.querySelectorAll ? root : document).querySelectorAll('input[type="password"]').forEach(add); }
    function start() {
        scan(document);
        new MutationObserver(function (list) {
            list.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) { if (n.matches && n.matches('input[type="password"]')) add(n); else scan(n); } }); });
        }).observe(document.body, { childList: true, subtree: true });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
