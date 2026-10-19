/* =========================================================
   PLANORA — first-time tour (Home)

   A short, skippable walk-through the first time someone reaches Home
   after sign-up. It points at the real controls on the page:
     Ask AI box → mic → attach → Today's schedule → + → Planora → Calendar → Profile

   - Shows once per account (saved as prefs.tourDone, so it doesn't come back
     on another device). A local flag stops it repeating if saving fails.
   - Replay any time: Profile → Help and support → "Take the tour",
     which opens home.html?tour=1.
   - Steps whose target isn't on screen (e.g. phone-only buttons on a laptop)
     are skipped automatically.
   ========================================================= */
(function () {
    "use strict";

    const LOCAL_KEY = "planora_tour_done";
    const $ = s => document.querySelector(s);

    // first matching element that is actually visible on this device
    function visible(selectors) {
        for (const sel of [].concat(selectors)) {
            for (const el of document.querySelectorAll(sel)) {
                if (!el.getClientRects().length) continue;
                const cs = getComputedStyle(el);
                if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
                const r = el.getBoundingClientRect();
                if (r.width < 4 || r.height < 4) continue;
                return el;
            }
        }
        return null;
    }

    const ASK = ["#first-day:not([hidden]) .fd-compose", "#today-bar:not([hidden]) .tb-compose", "#ask-bar:not([hidden]) .fd-compose"];
    const inAsk = sel => ASK.map(a => `${a} ${sel}`);

    const STEPS = [
        { title: "Welcome to Planora 👋", text: "Here's a quick 30-second tour of how Planora plans your day for you.", center: true, next: "Start the tour" },
        { target: ASK, title: "Ask AI to plan your day", text: "Type what's on your plate, like <em>“gym tomorrow morning, finish my report by Friday”</em>. Planora finds the time and shows you the plan before adding anything." },
        { target: inAsk('[data-fd="mic"]'), title: "Or just speak", text: "Tap the mic and say what you need to do. Planora plans it for you." },
        { target: inAsk('[data-fd="attach"]'), title: "Plan from a document", text: "Attach a syllabus, timetable, PDF or photo. Planora reads the dates and plans study or prep sessions before each one." },
        { target: ["#schedule-card"], title: "Today's schedule", text: "Everything planned for the day. Tick tasks off, or use the pencil and bin to edit or delete." },
        { target: [".bottom-nav .nav-add", ".rail-add", ".fab"], title: "Add a task yourself", text: "Prefer to do it by hand? Tap + to add a task or event with a date, time and colour." },
        { target: ['.bottom-nav [data-nav="planora"]', '.side-rail [data-nav="planora"]'], title: "Goals and breakdowns", text: "Set goals, build a revision plan, or break a new skill into small steps." },
        { target: ['.bottom-nav [data-nav="calendar"]', '.side-rail [data-nav="calendar"]'], title: "Your calendar", text: "See your week or month, and connect Google Calendar." },
        { target: ['.bottom-nav [data-nav="profile"]', '.side-rail .rail-user', '.side-rail [data-nav="profile"]'], title: "Make it yours", text: "In Profile, add your work or college hours so Planora never plans on top of them, and turn on reminders." },
        { title: "You're all set! 🎉", text: "Try it now: tell Planora what you need to do today.", center: true, next: "Plan my day", final: true }
    ];

    let root, spot, card, i = 0, steps = [], target = null, lastFocus = null;

    function build() {
        root = document.createElement("div");
        root.className = "tour-root";
        root.innerHTML = `
            <div class="tour-block" aria-hidden="true"></div>
            <div class="tour-spot" aria-hidden="true"></div>
            <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text">
                <div class="tour-top"><span class="tour-count" id="tour-count"></span><button type="button" class="tour-skip" data-tour="skip">Skip tour</button></div>
                <h2 class="tour-title" id="tour-title"></h2>
                <p class="tour-text" id="tour-text"></p>
                <div class="tour-foot">
                    <span class="tour-dots" aria-hidden="true"></span>
                    <div class="tour-btns">
                        <button type="button" class="tour-back" data-tour="back">Back</button>
                        <button type="button" class="tour-next" data-tour="next">Next</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(root);
        spot = root.querySelector(".tour-spot");
        card = root.querySelector(".tour-card");
        root.addEventListener("click", e => {
            const b = e.target.closest("[data-tour]");
            if (!b) return;
            if (b.dataset.tour === "skip") finish(false);
            else if (b.dataset.tour === "back") go(i - 1);
            else if (b.dataset.tour === "next") steps[i].final ? finish(true) : go(i + 1);
        });
        document.addEventListener("keydown", onKey, true);
        window.addEventListener("resize", place);
        window.addEventListener("scroll", place, true);
    }

    function onKey(e) {
        if (!root) return;
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
        else if (e.key === "ArrowRight") { e.preventDefault(); steps[i].final ? finish(true) : go(i + 1); }
        else if (e.key === "ArrowLeft" && i > 0) { e.preventDefault(); go(i - 1); }
        else if (e.key === "Tab") {                       // keep focus inside the tour card
            const f = card.querySelectorAll("button:not([hidden])");
            if (!f.length) return;
            const first = f[0], last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    }

    function go(n) {
        if (n < 0 || n >= steps.length) return;
        i = n;
        const s = steps[i];
        target = s.center ? null : visible(s.target);
        if (!s.center && !target) {                       // disappeared since we started — skip it
            steps.splice(i, 1);
            return go(Math.min(i, steps.length - 1));
        }
        card.querySelector(".tour-title").textContent = s.title;
        card.querySelector(".tour-text").innerHTML = s.text;
        const counted = steps.filter(x => !x.center).length, pos = steps.slice(0, i + 1).filter(x => !x.center).length;
        card.querySelector(".tour-count").textContent = s.center ? "" : `${pos} of ${counted}`;
        card.querySelector(".tour-dots").innerHTML = s.center ? "" : steps.filter(x => !x.center).map((_, k) => `<i${k === pos - 1 ? ' class="on"' : ""}></i>`).join("");
        card.querySelector(".tour-skip").hidden = !!s.final;
        card.querySelector(".tour-back").hidden = i === 0 || !!s.final;
        card.querySelector(".tour-next").textContent = s.next || (i === steps.length - 2 ? "Finish" : "Next");
        root.classList.toggle("is-center", !!s.center);
        if (target) {
            const r = target.getBoundingClientRect();
            if (r.height > innerHeight * 0.45) {                 // tall section: bring its top near the top of the screen
                if (r.top < 60 || r.top > 110) window.scrollBy(0, r.top - 80);
            } else if (r.top < 70 || r.bottom > innerHeight - 220) target.scrollIntoView({ block: "center" });
        }
        place();
        card.classList.remove("tour-in"); void card.offsetWidth; card.classList.add("tour-in");
        setTimeout(() => card.querySelector(".tour-next").focus({ preventScroll: true }), 0);
    }

    function place() {
        if (!root) return;
        const vw = document.documentElement.clientWidth, vh = innerHeight, gap = 14, pad = 8;
        const cw = Math.min(360, vw - 32);
        card.style.width = cw + "px";
        if (!target) {
            spot.style.display = "none";
            card.style.left = Math.round((vw - cw) / 2) + "px";
            card.style.top = Math.max(16, Math.round((vh - card.offsetHeight) / 2)) + "px";
            card.removeAttribute("data-side");
            return;
        }
        let r = target.getBoundingClientRect();
        const ch0 = card.offsetHeight;
        const top0 = Math.max(r.top, 12);
        const maxH = vh - 14 - ch0 - gap - pad * 2 - top0;      // tall sections: highlight only the top part,
        if (r.bottom - top0 > maxH && maxH > 120) {              // so the tip can sit underneath it
            r = { top: top0, left: r.left, width: r.width, height: maxH, right: r.right, bottom: top0 + maxH };
        }
        const radius = parseFloat(getComputedStyle(target).borderRadius) || 12;
        Object.assign(spot.style, {
            display: "block",
            left: (r.left - pad) + "px", top: (r.top - pad) + "px",
            width: (r.width + pad * 2) + "px", height: (r.height + pad * 2) + "px",
            borderRadius: Math.min(radius + pad, 28) + "px"
        });
        const ch = card.offsetHeight;
        const below = r.bottom + pad + gap, above = r.top - pad - gap - ch;
        let top, side;
        if (below + ch <= vh - 12) { top = below; side = "below"; }
        else if (above >= 12) { top = above; side = "above"; }
        else { top = Math.max(12, Math.min(vh - ch - 12, below)); side = "below"; }
        let left = r.left + r.width / 2 - cw / 2;
        left = Math.max(16, Math.min(vw - cw - 16, left));
        card.style.left = Math.round(left) + "px";
        card.style.top = Math.round(top) + "px";
        card.setAttribute("data-side", side);
        card.style.setProperty("--arrow-x", Math.round(Math.max(22, Math.min(cw - 22, r.left + r.width / 2 - left))) + "px");
    }

    function markDone() {
        try { localStorage.setItem(LOCAL_KEY, "1"); } catch {}
        try {
            const A = window.PlanoraAuth;
            if (A && A.updateProfile && A.user) A.updateProfile({ prefs: { tourDone: true } }).catch(() => {});
        } catch {}
    }

    function finish(planNow) {
        if (!root) return;
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", place);
        window.removeEventListener("scroll", place, true);
        root.remove(); root = null;
        document.body.classList.remove("tour-open");
        markDone();
        if (planNow && window.PlanoraHomeAsk) window.PlanoraHomeAsk.open();
        else if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    function start() {
        if (root) return;
        if (document.querySelector("#planora-sheet, #focus-mode, .auth-sheet-backdrop:not([hidden])")) return;
        const pop = $("#ask-pop");
        if (pop && !pop.hidden) return;
        steps = STEPS.filter(s => s.center || visible(s.target));
        if (steps.length < 3) return;
        lastFocus = document.activeElement;
        document.body.classList.add("tour-open");
        build();
        go(0);
    }

    function shouldShow(user) {
        const params = new URLSearchParams(location.search);
        if (params.get("tour") === "1") return true;
        if (params.get("ask") === "1") return false;           // came to ask something — don't interrupt
        if (!user || !user.onboarded) return false;
        if (user.prefs && user.prefs.tourDone) return false;
        try { if (localStorage.getItem(LOCAL_KEY) === "1") return false; } catch {}
        return true;
    }

    function boot() {
        if (!/home\.html$|\/$/.test(location.pathname)) return;
        const ready = (window.PlanoraAuth && window.PlanoraAuth.ready) || Promise.resolve(null);
        Promise.resolve(ready).then(user => {
            user = user || (window.PlanoraAuth && window.PlanoraAuth.user) || null;
            if (!shouldShow(user)) return;
            if (new URLSearchParams(location.search).get("tour") === "1") {
                try { history.replaceState(null, "", location.pathname); } catch {}
            }
            setTimeout(start, 900);                               // let Home finish drawing first
        }).catch(() => {});
    }

    window.PlanoraTour = { start, reset() { try { localStorage.removeItem(LOCAL_KEY); } catch {} } };

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
})();
