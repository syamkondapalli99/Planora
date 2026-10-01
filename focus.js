/* =========================================================
   PLANORA FOCUS MODE  (focus.js)

   PlanoraFocus.start(taskId[, minutes])
   - Full-screen timer for one task: pause · resume · complete · exit
   - Keeps running if you change page or reload (stored in this
     browser only, under "planora-focus-timer"; no server needed)
   - Completing marks the real task done (same task everywhere)
     and shows what's next, without forcing you into it.
   ========================================================= */

(function () {

    const KEY = "planora-focus-timer";     // local to this browser (not synced)
    const C = () => window.PlanoraCore;
    let tick = null;
    let baseTitle = document.title;

    function load() {
        try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
    }
    function save(state) {
        try {
            if (state) localStorage.setItem(KEY, JSON.stringify(state));
            else localStorage.removeItem(KEY);
        } catch { /* storage blocked: timer still works on this page */ }
    }

    function elapsed(st) {
        return st.accumulated + (st.running ? Date.now() - st.resumedAt : 0);
    }

    function fmt(ms) {
        const neg = ms < 0;
        let s = Math.round(Math.abs(ms) / 1000);
        const h = Math.floor(s / 3600); s -= h * 3600;
        const m = Math.floor(s / 60); s -= m * 60;
        const core = h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        return (neg ? "+" : "") + core;
    }

    function taskOf(st) {
        return st && C().getTasks().find(t => String(t.id) === String(st.taskId));
    }

    function shortSessionsToday() {
        const u = window.PlanoraAuth && PlanoraAuth.user;
        const p = (u && u.prefs) || {};
        return p.shortSessionsDate === C().today();
    }


    /* ---------------- start ---------------- */

    function start(taskId, minutes) {
        const task = C().getTasks().find(t => String(t.id) === String(taskId));
        if (!task) { C().toast("That task no longer exists."); return; }
        const current = load();
        if (current && String(current.taskId) !== String(taskId) && taskOf(current)) {
            C().confirm({
                title: "Switch focus?",
                message: `You're focusing on "${current.title}". Stop that and start "${task.title}"?`,
                confirmText: "Switch"
            }).then(ok => { if (ok) { save(null); start(taskId, minutes); } });
            return;
        }
        if (current && String(current.taskId) === String(taskId)) { open(); return; }

        let mins = Math.max(5, Math.round(minutes || C().taskDuration(task)));
        const short = shortSessionsToday() && mins > 25;
        if (short) mins = 25;
        save({
            taskId: String(task.id),
            title: task.title,
            planned: mins * 60000,
            accumulated: 0,
            running: true,
            resumedAt: Date.now(),
            startedAt: Date.now(),
            short
        });
        open();
    }


    /* ---------------- the full-screen view ---------------- */

    function open() {
        const st = load();
        if (!st) return;
        const task = taskOf(st);
        if (!task) { save(null); removePill(); C().toast("That task no longer exists, so focus ended."); return; }
        removePill();
        let el = document.getElementById("focus-mode");
        if (!el) {
            el = document.createElement("div");
            el.id = "focus-mode";
            el.className = "focus-mode";
            el.setAttribute("role", "dialog");
            el.setAttribute("aria-modal", "true");
            el.setAttribute("aria-labelledby", "focus-title");
            document.body.appendChild(el);
        }
        const goal = task.goalId ? C().goalTitle(task.goalId) : "";
        el.innerHTML = `
            <div class="focus-inner">
                <div class="focus-top">
                    <span class="focus-label"><i class="ti ti-focus-2" aria-hidden="true"></i> Focus</span>
                    <button type="button" class="focus-icon" data-f="hide" aria-label="Minimise (timer keeps running)"><i class="ti ti-chevron-down" aria-hidden="true"></i></button>
                </div>
                <h2 class="focus-task" id="focus-title">${C().esc(task.title)}</h2>
                ${goal ? `<p class="focus-goal"><i class="ti ti-target-arrow" aria-hidden="true"></i> ${C().esc(goal)}</p>` : ""}
                ${st.short ? `<p class="focus-goal">Short session today (25 min)</p>` : ""}
                <div class="focus-ring" aria-hidden="true"><svg viewBox="0 0 120 120"><circle class="bg" cx="60" cy="60" r="54"/><circle class="fg" cx="60" cy="60" r="54"/></svg></div>
                <div class="focus-time" role="timer" aria-live="off"></div>
                <p class="focus-status" aria-live="polite"></p>
                <div class="focus-actions">
                    <button type="button" class="btn-secondary" data-f="toggle"></button>
                    <button type="button" class="btn-primary" data-f="complete"><i class="ti ti-check" aria-hidden="true"></i> Complete</button>
                </div>
                <button type="button" class="focus-exit" data-f="exit">Stop focusing</button>
            </div>`;
        el.hidden = false;
        document.body.classList.add("focus-open");
        el.onclick = e => {
            const b = e.target.closest("[data-f]");
            if (!b) return;
            const a = b.dataset.f;
            if (a === "toggle") toggle();
            if (a === "complete") complete();
            if (a === "hide") hide();
            if (a === "exit") exit();
            if (a === "done") closeView();
            if (a === "next-start") { closeView(); start(b.dataset.id); }
        };
        render();
        startTick();
        setTimeout(() => { const b = el.querySelector("[data-f=complete]"); if (b) b.focus(); }, 50);
    }

    function render() {
        const st = load();
        const el = document.getElementById("focus-mode");
        if (!st) { stopTick(); return; }
        const left = st.planned - elapsed(st);
        if (el && !el.hidden && el.querySelector(".focus-time")) {
            el.querySelector(".focus-time").textContent = fmt(left);
            el.querySelector(".focus-time").setAttribute("aria-label", left >= 0 ? `${Math.ceil(left / 60000)} minutes left` : "Time is up");
            const frac = Math.max(0, Math.min(1, elapsed(st) / st.planned));
            const fg = el.querySelector(".focus-ring .fg");
            if (fg) fg.style.strokeDashoffset = String(339.3 * (1 - frac));
            const toggleBtn = el.querySelector("[data-f=toggle]");
            if (toggleBtn) toggleBtn.innerHTML = st.running
                ? `<i class="ti ti-player-pause" aria-hidden="true"></i> Pause`
                : `<i class="ti ti-player-play" aria-hidden="true"></i> Resume`;
            const status = el.querySelector(".focus-status");
            if (status) status.textContent = !st.running ? "Paused" : left < 0 ? "Time's up. Complete it, or keep going." : "";
            el.classList.toggle("is-paused", !st.running);
            el.classList.toggle("is-over", left < 0);
        }
        const pill = document.getElementById("focus-pill");
        if (pill) {
            pill.querySelector(".fp-time").textContent = fmt(left);
            pill.classList.toggle("is-paused", !st.running);
        }
        document.title = `${st.running ? "" : "⏸ "}${fmt(left)} · ${st.title}`;
    }

    function startTick() {
        stopTick();
        tick = setInterval(render, 1000);
    }
    function stopTick() {
        clearInterval(tick);
        tick = null;
        document.title = baseTitle;
    }

    function toggle() {
        const st = load();
        if (!st) return;
        if (st.running) { st.accumulated = elapsed(st); st.running = false; }
        else { st.running = true; st.resumedAt = Date.now(); }
        save(st);
        render();
    }

    function hide() {
        const el = document.getElementById("focus-mode");
        if (el) el.hidden = true;
        document.body.classList.remove("focus-open");
        showPill();
    }

    function closeView() {
        const el = document.getElementById("focus-mode");
        if (el) el.remove();
        document.body.classList.remove("focus-open");
    }

    async function exit() {
        const st = load();
        const mins = st ? Math.round(elapsed(st) / 60000) : 0;
        const ok = mins < 1 || await C().confirm({
            title: "Stop focusing?",
            message: `You've focused for ${C().durLabel(mins)}. The task stays on your list, not completed.`,
            confirmText: "Stop"
        });
        if (!ok) return;
        save(null);
        stopTick();
        removePill();
        closeView();
    }

    function complete() {
        const st = load();
        if (!st) return;
        const task = taskOf(st);
        const mins = Math.max(1, Math.round(elapsed(st) / 60000));
        // Completion is saved first, so nothing is lost even if the view fails
        if (task) C().updateTask(task.id, { completed: true, focusMinutes: mins });
        save(null);
        stopTick();
        removePill();
        showDone(st.title, mins);
    }

    function showDone(title, mins) {
        const el = document.getElementById("focus-mode");
        if (!el) return;
        const core = C();
        const ctx = core.priorityCtx();
        const next = window.PlanoraPriority ? PlanoraPriority.whatNow(core.getTasks(), ctx) : { type: "none" };
        const nextTask = next.type !== "none" ? next.task : null;
        el.innerHTML = `
            <div class="focus-inner focus-done">
                <div class="focus-check" aria-hidden="true"><i class="ti ti-circle-check"></i></div>
                <h2 class="focus-task" id="focus-title">Nice work. ${core.esc(title)} completed.</h2>
                <p class="focus-goal">${core.durLabel(mins)} of focus</p>
                ${nextTask ? `
                <div class="focus-next">
                    <p class="focus-label">Next up</p>
                    <p class="focus-next-title">${core.esc(nextTask.title)}${nextTask.start && nextTask.date === core.today() ? ` · ${core.time12(nextTask.start)}` : ""}</p>
                </div>
                <div class="focus-actions">
                    <button type="button" class="btn-secondary" data-f="done">Done</button>
                    <button type="button" class="btn-primary" data-f="next-start" data-id="${core.esc(nextTask.id)}"><i class="ti ti-player-play" aria-hidden="true"></i> Start</button>
                </div>` : `
                <p class="focus-goal">Nothing else urgent right now.</p>
                <div class="focus-actions"><button type="button" class="btn-primary" data-f="done">Done</button></div>`}
            </div>`;
        const b = el.querySelector("[data-f=done]");
        if (b) b.focus();
        document.dispatchEvent(new CustomEvent("planora:data-changed"));
    }


    /* ---------------- minimised pill (any page) ---------------- */

    function showPill() {
        const st = load();
        if (!st || document.getElementById("focus-pill")) { render(); return; }
        const pill = document.createElement("button");
        pill.type = "button";
        pill.id = "focus-pill";
        pill.className = "focus-pill";
        pill.setAttribute("aria-label", `Focus: ${st.title}. Open timer`);
        pill.innerHTML = `<i class="ti ti-focus-2" aria-hidden="true"></i><span class="fp-title"></span><span class="fp-time"></span>`;
        pill.querySelector(".fp-title").textContent = st.title;
        pill.onclick = open;
        document.body.appendChild(pill);
        render();
        startTick();
    }

    function removePill() {
        const p = document.getElementById("focus-pill");
        if (p) p.remove();
    }

    document.addEventListener("keydown", e => {
        const el = document.getElementById("focus-mode");
        if (!el || el.hidden) return;
        if (e.key === "Escape") { e.preventDefault(); if (load()) hide(); else closeView(); }
        if (e.key === " " && e.target === document.body && load()) { e.preventDefault(); toggle(); }
    });

    // Another tab paused/finished the timer
    window.addEventListener("storage", e => { if (e.key === KEY) { if (!load()) { removePill(); stopTick(); } else render(); } });

    window.PlanoraFocus = { start, open, toggle, complete, exit, hide, state: load };

    function init() {
        baseTitle = document.title;
        if (load()) showPill();
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();

})();
