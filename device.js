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
