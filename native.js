/* =========================================================
   PLANORA iPHONE APP  (native.js)  — loaded in <head>, right after device.js

   Does nothing in a normal browser. Inside the Planora iPhone app
   (Capacitor), it switches a few things to the phone's own features:
     - the 🎤 mic uses the phone's speech-to-text
     - reminders are scheduled on the phone itself (no server needed)
     - tapping a reminder opens the right page
     - status bar and haptics
   Sign in with Apple / Google is handled in login.js (PlanoraNativeApp.plugin).
   ========================================================= */
(function () {
    var Cap = window.Capacitor;
    var isNative = Boolean(Cap && typeof Cap.isNativePlatform === "function" && Cap.isNativePlatform());
    if (!isNative) { window.PlanoraNativeApp = { isNative: false }; return; }

    var html = document.documentElement;
    html.classList.add("is-native-app", "is-standalone");
    if (window.PlanoraDevice) { window.PlanoraDevice.standalone = true; window.PlanoraDevice.native = true; }

    function plugin(name) {
        try { return (Cap.Plugins && Cap.Plugins[name]) || Cap.registerPlugin(name); } catch (e) { return null; }
    }
    var Native = plugin("PlanoraNative");
    var Local = plugin("LocalNotifications");
    var StatusBar = plugin("StatusBar");
    var Haptics = plugin("Haptics");

    window.PlanoraNativeApp = { isNative: true, platform: Cap.getPlatform ? Cap.getPlatform() : "ios", plugin: Native,
        haptic: function () { try { Haptics && Haptics.impact({ style: "LIGHT" }); } catch (e) {} } };

    try { StatusBar && StatusBar.setStyle({ style: "LIGHT" }); } catch (e) {}   // dark text on Planora's light screens

    /* ---------- 🎤 the phone's own speech-to-text, shaped like the browser's ---------- */
    if (Native) {
        function NativeSpeech() {
            this.lang = "en-US"; this.interimResults = true; this.continuous = false; this.maxAlternatives = 1;
            this.onresult = null; this.onerror = null; this.onend = null; this.onstart = null;
            this._subs = []; this._ended = false;
        }
        NativeSpeech.prototype.start = function () {
            var self = this;
            var done = function (err) {
                if (self._ended) return;
                self._ended = true;
                self._subs.forEach(function (p) { Promise.resolve(p).then(function (h) { h && h.remove && h.remove(); }); });
                self._subs = [];
                if (err && self.onerror) self.onerror({ error: err });
                if (self.onend) self.onend({});
            };
            this._subs.push(Native.addListener("speechResult", function (d) {
                if (self._ended || !self.onresult) return;
                var alt = { transcript: (d && d.text) || "", confidence: 1 };
                var res = [alt]; res.isFinal = Boolean(d && d.isFinal);
                var results = [res];
                self.onresult({ resultIndex: 0, results: results });
            }));
            this._subs.push(Native.addListener("speechEnd", function (d) { done(d && d.error && d.error !== "aborted" ? d.error : null); }));
            Native.speechStart({ lang: this.lang || "en-US" })
                .then(function () { if (self.onstart) self.onstart({}); })
                .catch(function (e) {
                    var code = (e && (e.code || e.message)) || "audio-capture";
                    done(code === "not-allowed" ? "not-allowed" : "audio-capture");
                });
        };
        NativeSpeech.prototype.stop = function () { try { Native.speechStop(); } catch (e) {} };
        NativeSpeech.prototype.abort = NativeSpeech.prototype.stop;
        window.SpeechRecognition = NativeSpeech;
        window.webkitSpeechRecognition = NativeSpeech;
    }

    /* ---------- reminders on this phone ----------
       Same reminders as the website (morning summary + "in 15 min"), from the
       same settings in Profile → Notifications, but scheduled by the phone. */
    if (Local && !window.PlanoraPush) {
        var DEFAULTS = { morning: true, morningTime: "07:30", before: true, minutes: 15 };
        var C = function () { return window.PlanoraCore; };
        var user = function () { return (window.PlanoraAuth && PlanoraAuth.user) || null; };
        var prefs = function () {
            var u = user(), p = (u && u.prefs && u.prefs.push) || null;
            return p ? Object.assign({}, DEFAULTS, p) : Object.assign({}, DEFAULTS, { morning: false, before: false, never: true });
        };
        var wanted = function (p) { return Boolean(p && (p.morning || p.before)); };

        var buildItems = function (p) {
            p = p || prefs();
            var core = C(); if (!core) return [];
            var out = [], now = Date.now(), t = core.today();
            var at = function (d, hhmm) { return new Date(d + "T" + hhmm + ":00"); };
            var tasks = core.getTasks(), events = core.getEvents ? core.getEvents() : [];
            for (var k = 0; k < 14; k++) {
                var d = core.addDays(t, k);
                var dayTasks = tasks.filter(function (x) { return x.date === d && !x.completed; });
                var dayEvents = events.filter(function (e) { return e.date === d; });
                if (p.morning && /^\d{2}:\d{2}$/.test(p.morningTime || "")) {
                    var when = at(d, p.morningTime);
                    if (when.getTime() > now) {
                        var all = dayTasks.map(function (x) { return { title: x.title, start: x.start || "" }; })
                            .concat(dayEvents.map(function (e) { return { title: e.title, start: e.start || "" }; }))
                            .sort(function (a, b) { return (a.start || "99").localeCompare(b.start || "99"); });
                        if (all.length) {
                            var names = all.slice(0, 3).map(function (x) { return x.title + (x.start ? " (" + core.time12(x.start).replace(":00", "") + ")" : ""); }).join(", ");
                            out.push({ at: when, tag: "morning-" + d, url: "/home.html",
                                title: "Good morning! " + all.length + " thing" + (all.length === 1 ? "" : "s") + " today",
                                body: names + (all.length > 3 ? " +" + (all.length - 3) + " more" : "") });
                        } else {
                            out.push({ at: when, tag: "morning-" + d, url: "/home.html?ask=1",
                                title: "Let's plan your day", body: "Nothing planned yet. Tap to tell Planora what you need to do today." });
                        }
                    }
                }
                if (p.before) {
                    var mins = Number(p.minutes) || 15;
                    var timed = dayTasks.filter(function (x) { return /^\d{1,2}:\d{2}$/.test(x.start || ""); }).map(function (x) { return { kind: "task", id: x.id, title: x.title, start: x.start, end: x.end || "" }; })
                        .concat(dayEvents.filter(function (e) { return /^\d{1,2}:\d{2}$/.test(e.start || ""); }).map(function (e) { return { kind: "event", id: e.id, title: e.title, start: e.start, end: e.end || "", where: e.location || "" }; }));
                    timed.forEach(function (x) {
                        var w = new Date(at(d, x.start.padStart(5, "0")).getTime() - mins * 60e3);
                        if (w.getTime() <= now) return;
                        out.push({ at: w, tag: x.kind + "-" + x.id + "-" + d, url: "/home.html",
                            title: "In " + mins + " min: " + x.title,
                            body: core.time12(x.start) + (x.end ? " – " + core.time12(x.end) : "") + (x.where ? " · " + x.where : "") });
                    });
                }
            }
            // iPhone keeps at most 64 waiting notifications per app
            return out.sort(function (a, b) { return a.at - b.at; }).slice(0, 60);
        };

        var idOf = function (tag) {          // a stable whole number for each reminder
            var h = 0;
            for (var i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
            return Math.abs(h) % 2000000000 + 1;
        };
        var granted = function () {
            return Local.checkPermissions().then(function (r) { return r && r.display; }).catch(function () { return "prompt"; });
        };
        var cancelAll = function () {
            return Local.getPending().then(function (r) {
                var list = ((r && r.notifications) || []).map(function (n) { return { id: n.id }; });
                return list.length ? Local.cancel({ notifications: list }) : null;
            }).catch(function () {});
        };

        var lastSig = "";
        var sync = function (force) {
            var u = user(), p = prefs();
            if (!u || u.guest || p.never || !wanted(p)) { lastSig = ""; return cancelAll(); }
            return granted().then(function (g) {
                if (g !== "granted") return;
                var items = buildItems(p);
                var sig = u.id + "|" + JSON.stringify(items.map(function (x) { return [x.tag, +x.at, x.title, x.body]; }));
                if (!force && sig === lastSig) return;
                return cancelAll().then(function () {
                    if (!items.length) { lastSig = sig; return; }
                    return Local.schedule({ notifications: items.map(function (x) {
                        return { id: idOf(x.tag), title: x.title, body: x.body, schedule: { at: x.at, allowWhileIdle: true }, extra: { url: x.url } };
                    }) }).then(function () { lastSig = sig; });
                });
            }).catch(function () { /* try again on the next change */ });
        };

        var status = function () {
            var u = user();
            if (!u || u.guest) return Promise.resolve("guest");
            return granted().then(function (g) {
                if (g === "denied") return "denied";
                return g === "granted" && wanted(prefs()) ? "on" : "off";
            });
        };
        var enable = function () {
            var u = user();
            if (!u || u.guest) return Promise.reject(new Error("Please sign in to get reminders."));
            return Local.requestPermissions().then(function (r) {
                if (!r || r.display !== "granted") throw new Error("Notifications are off for Planora. Turn them on in Settings → Planora → Notifications, then try again.");
                return true;
            });
        };
        var disable = function () { lastSig = ""; return cancelAll(); };
        var test = function () {
            return Local.schedule({ notifications: [{ id: 7, title: "Planora reminders are on ✅", body: "This is how your reminders will look.", schedule: { at: new Date(Date.now() + 3000) } }] });
        };

        var timer = null;
        var soon = function () { clearTimeout(timer); timer = setTimeout(function () { sync(false); }, 2000); };
        document.addEventListener("planora:data-changed", soon);
        document.addEventListener("planora:plan-added", soon);
        window.addEventListener("storage", function (e) { if (e.key === "planora_tasks" || e.key === "planora_events") soon(); });
        var start = function () { setTimeout(function () { sync(false); }, 1500); };
        window.addEventListener("load", function () {
            if (window.PlanoraAuth && PlanoraAuth.ready && PlanoraAuth.ready.then) PlanoraAuth.ready.then(start, start); else start();
        });

        // tap a reminder → open its page
        try {
            Local.addListener("localNotificationActionPerformed", function (e) {
                var url = e && e.notification && e.notification.extra && e.notification.extra.url;
                if (url && /^\/[\w./?=&-]*$/.test(url)) location.href = url;
            });
        } catch (e) {}

        // planora-core.js sees this and keeps it (it skips its web-push version)
        window.PlanoraPush = { supported: function () { return true; }, status: status, enable: enable, disable: disable, test: test,
            sync: sync, buildItems: buildItems, prefs: prefs, DEFAULTS: DEFAULTS, native: true };
    }
})();
