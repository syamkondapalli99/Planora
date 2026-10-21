/* =========================================================
   PLANORA APP EXTRAS  (app-extras.js)

   Loaded on the app pages after the existing scripts.
   Adds, without changing existing features:
   - real streak number on the dashboard badge
   - Profile page filled from your account + your real tasks
     (stats, weekly chart, heatmap, categories, insights)
   - working Profile settings (edit info, password,
     notifications, export, delete account, log out)
   - Streak page
   - daily reminder notification (if turned on)
   ========================================================= */

(function () {

    const $ = id => document.getElementById(id);
    const DAY = 24 * 60 * 60 * 1000;


    /* ---------------- data helpers ---------------- */

    function dateKey(date) {
        return date.getFullYear() + "-" +
            String(date.getMonth() + 1).padStart(2, "0") + "-" +
            String(date.getDate()).padStart(2, "0");
    }

    function tasks() {
        try { return JSON.parse(localStorage.getItem("planora_tasks")) || []; } catch { return []; }
    }

    function byDate(list) {
        const map = {};
        list.forEach(t => {
            if (!t || !t.date) return;
            (map[t.date] = map[t.date] || { total: 0, done: 0, tasks: [] });
            map[t.date].total++;
            if (t.completed) map[t.date].done++;
            map[t.date].tasks.push(t);
        });
        return map;
    }

    function weekStats() {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const monday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * DAY);
        const from = dateKey(monday), to = dateKey(today);
        const list = tasks().filter(t => t.date >= from && t.date <= to);
        return { planned: list.length, done: list.filter(t => t.completed).length };
    }

    function goalAverage() {
        if (!window.PlanoraCore) return null;
        const goals = PlanoraCore.getGoals().filter(g => g.status === "active");
        if (!goals.length) return null;
        return Math.round(goals.reduce((a, g) => a + PlanoraCore.goalProgress(g), 0) / goals.length);
    }

    function computeStreaks(map) {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const active = d => (map[dateKey(d)] || {}).done > 0;

        // current streak: count back from today (or yesterday if today isn't done yet)
        let cursor = new Date(today);
        if (!active(cursor)) cursor = new Date(today.getTime() - DAY);
        let current = 0;
        while (active(cursor)) {
            current++;
            cursor = new Date(cursor.getTime() - DAY);
        }

        // best streak ever
        const doneDates = Object.keys(map).filter(k => map[k].done > 0).sort();
        let best = 0, run = 0, prev = null;
        doneDates.forEach(k => {
            const d = new Date(k + "T00:00:00");
            run = prev && Math.round((d - prev) / DAY) === 1 ? run + 1 : 1;
            best = Math.max(best, run);
            prev = d;
        });

        return { current, best: Math.max(best, current), activeDays: doneDates.length, doneToday: active(today) };
    }

    function stats() {
        const list = tasks();
        const map = byDate(list);
        const done = list.filter(t => t.completed).length;
        const past = list.filter(t => t.date && t.date <= dateKey(new Date()));
        const pastDone = past.filter(t => t.completed).length;
        return {
            list,
            map,
            total: list.length,
            done,
            daysPlanned: Object.keys(map).filter(k => k <= dateKey(new Date())).length,   // days so far, not future sessions
            completionRate: past.length ? Math.round((pastDone / past.length) * 100) : 0,
            ...computeStreaks(map)
        };
    }

    const CATEGORIES = [
        { label: "Work", color: "var(--purple-400)", words: /meet|call|client|report|standup|stand-up|email|project|work|present|deadline|office|team|review|interview|proposal|invoice/i },
        { label: "Health", color: "var(--pink-400)", words: /gym|run|workout|yoga|walk|doctor|sleep|meditat|exercise|swim|stretch|cardio|health|dentist|therapy|jog|bike|cycling|pilates/i },
        { label: "Learning", color: "var(--amber-800)", words: /study|read|learn|course|revis|practice|exam|homework|lecture|class|tutor|assignment|essay|quiz|chapter|notes|book/i },
        { label: "Personal", color: "var(--blue-400)", words: /./ }
    ];

    function categorise(title) {
        return CATEGORIES.find(c => c.words.test(title || "")) || CATEGORIES[3];
    }


    /* ---------------- streak badge (dashboard) ---------------- */

    function renderStreakBadges() {
        const s = stats();
        document.querySelectorAll(".streak-badge span").forEach(el => { el.textContent = s.current; });
        document.querySelectorAll(".streak-badge").forEach(el => {
            el.title = s.current === 1 ? "1 day streak" : `${s.current} day streak`;
        });
    }


    /* ---------------- sheets (small dialogs) ---------------- */

    function openSheet(title, icon, bodyHtml, onReady) {
        closeSheet();
        const backdrop = document.createElement("div");
        backdrop.className = "auth-sheet-backdrop";
        backdrop.id = "planora-sheet";
        backdrop.innerHTML = `
            <form class="auth-sheet" novalidate>
                <div class="auth-sheet-head">
                    <i class="ti ${icon}"></i>
                    <div><h3></h3></div>
                    <button type="button" class="auth-sheet-close" aria-label="Close"><i class="ti ti-x"></i></button>
                </div>
                ${bodyHtml}
            </form>`;
        backdrop.querySelector("h3").textContent = title;
        backdrop.addEventListener("click", e => { if (e.target === backdrop) closeSheet(); });
        backdrop.querySelector(".auth-sheet-close").addEventListener("click", closeSheet);
        backdrop.querySelector("form").addEventListener("submit", e => e.preventDefault());
        document.body.appendChild(backdrop);
        if (onReady) onReady(backdrop.querySelector("form"));
    }

    function closeSheet() {
        const existing = $("planora-sheet");
        if (existing) existing.remove();
    }

    document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

    function escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text == null ? "" : String(text);
        return div.innerHTML;
    }


    /* ---------------- profile page ---------------- */

    function providerLabel(user) {
        const p = (user.providers || [])[0] || "";
        if (p.startsWith("google")) return { icon: "ti-brand-google", text: "Google" + (user.demo ? " (demo)" : "") };
        if (p === "guest") return { icon: "ti-user-question", text: "Guest (not signed in)" };
        if (p.startsWith("apple")) return { icon: "ti-brand-apple-filled", text: "Apple" + (user.demo ? " (demo)" : "") };
        return { icon: "ti-mail", text: "Email" };
    }

    function renderProfileHeader() {
        const user = window.PlanoraAuth && PlanoraAuth.user;
        if (!user) return;
        const s = stats();

        const avatar = document.querySelector(".profile-avatar");
        const name = document.querySelector(".profile-info h2");
        const email = document.querySelector(".profile-info p");
        if (avatar) avatar.textContent = PlanoraAuth.initials();
        if (name) name.textContent = user.name;
        if (email) {
            const via = providerLabel(user);
            email.innerHTML = `${escapeHtml(user.email || "")}<br><span class="provider-pill"><i class="ti ${via.icon}"></i>${escapeHtml(via.text)}</span>`;
        }

        const badges = document.querySelectorAll(".profile-badge");
        const since = new Date(user.createdAt || Date.now()).toLocaleDateString("en-US", { month: "short", year: "numeric" });
        if (badges[0]) badges[0].hidden = true;
        if (badges[1]) badges[1].innerHTML = `<i class="ti ti-calendar-event" aria-hidden="true"></i>Member since ${escapeHtml(since)}`;
        if (badges[2]) {
            const goal = user.prefs && user.prefs.goal;
            badges[2].innerHTML = `<i class="ti ti-target-arrow" aria-hidden="true"></i>${goal ? "Planora helps with: " + escapeHtml(goal) : "What should Planora help with?"}`;
            badges[2].style.cursor = "pointer";
            badges[2].setAttribute("role", "button");
            badges[2].tabIndex = 0;
            badges[2].onclick = openGoalSheet;
            badges[2].onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openGoalSheet(); } };
        }

        const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
        const wk = weekStats();
        const ga = goalAverage();
        set("pf-week", wk.planned ? `${wk.done}/${wk.planned}` : "0");
        set("pf-done", s.done);
        set("pf-goals", ga === null ? "–" : ga + "%");
        set("pf-streak", s.current);
        set("pf-days", s.daysPlanned);
        set("pf-rate", s.completionRate + "%");

        // older profile layout (kept for compatibility)
        const values = document.querySelectorAll(".stat-grid-3:not(.profile-progress) .stat-mini .value");
        if (values[0]) values[0].textContent = s.daysPlanned;
        if (values[1]) values[1].textContent = s.done;
        if (values[2]) values[2].textContent = s.completionRate + "%";
    }

    function renderWeekChart() {
        const chart = $("weekly-bar-chart");
        if (!chart) return;
        const map = byDate(tasks());
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const monday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * DAY);

        chart.innerHTML = "";
        ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((dow, i) => {
            const d = new Date(monday.getTime() + i * DAY);
            const info = map[dateKey(d)] || { total: 0, done: 0 };
            const pct = info.total ? Math.round((info.done / info.total) * 100) : 0;

            const col = document.createElement("div");
            col.className = "bar-col";
            const bar = document.createElement("div");
            bar.className = "bar";
            bar.style.height = Math.max(pct, 4) + "%";
            if (pct > 0) bar.style.background = d.getTime() === today.getTime() ? "var(--purple-400)" : "var(--purple-200)";
            bar.title = info.total ? `${dow}: ${info.done}/${info.total} done (${pct}%)` : `${dow}: no tasks`;
            const label = document.createElement("span");
            label.className = "dow";
            label.textContent = dow;
            if (d.getTime() === today.getTime()) label.style.color = "var(--purple-600)";
            col.appendChild(bar);
            col.appendChild(label);
            chart.appendChild(col);
        });
    }

    function renderRealHeatmap() {
        const grid = $("heat-grid");
        if (!grid) return;
        const map = byDate(tasks());
        const today = new Date(); today.setHours(0, 0, 0, 0);
        // 13 columns (weeks, oldest -> newest) x 7 rows (Mon -> Sun)
        const thisMonday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * DAY);
        const firstMonday = new Date(thisMonday.getTime() - 12 * 7 * DAY);

        grid.innerHTML = "";
        for (let row = 0; row < 7; row++) {
            for (let week = 0; week < 13; week++) {
                const d = new Date(firstMonday.getTime() + (week * 7 + row) * DAY);
                const done = (map[dateKey(d)] || {}).done || 0;
                const level = done === 0 ? "" : done === 1 ? "l1" : done === 2 ? "l2" : done <= 4 ? "l3" : "l4";
                const cell = document.createElement("div");
                cell.className = "heat-cell" + (level ? " " + level : "");
                if (d > today) cell.style.opacity = "0.35";
                cell.title = `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}: ${done} task${done === 1 ? "" : "s"} done`;
                grid.appendChild(cell);
            }
        }
    }

    function renderRealCategories() {
        const wrapper = $("category-bars");
        if (!wrapper) return;
        const list = tasks();
        wrapper.innerHTML = "";
        if (!list.length) {
            wrapper.innerHTML = `<p class="subtitle" style="font-size:13px;">Add a few tasks and Planora will show where your time goes.</p>`;
            return;
        }
        const minutes = {};
        list.forEach(t => {
            const c = categorise(t.title);
            let m = 30;
            if (t.start && t.end) {
                const [sh, sm] = t.start.split(":").map(Number);
                const [eh, em] = t.end.split(":").map(Number);
                const diff = (eh * 60 + em) - (sh * 60 + sm);
                if (diff > 0) m = diff;
            }
            minutes[c.label] = (minutes[c.label] || 0) + m;
        });
        const total = Object.values(minutes).reduce((a, b) => a + b, 0) || 1;
        CATEGORIES
            .map(c => ({ ...c, pct: Math.round(((minutes[c.label] || 0) / total) * 100) }))
            .sort((a, b) => b.pct - a.pct)
            .forEach(c => {
                const row = document.createElement("div");
                row.className = "cat-row";
                row.innerHTML = `
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span class="cat-dot" style="background:${c.color};"></span>
                        <span class="cat-label"></span>
                        <span class="cat-pct"></span>
                    </div>
                    <div class="cat-track"><div class="cat-fill" style="width:${c.pct}%;background:${c.color};"></div></div>`;
                row.querySelector(".cat-label").textContent = c.label;
                row.querySelector(".cat-pct").textContent = c.pct + "%";
                wrapper.appendChild(row);
            });
    }

    function renderInsights() {
        const tips = document.querySelectorAll(".card .ai-tip span");
        if (tips.length < 2) return;
        const s = stats();
        if (!s.total) {
            tips[0].textContent = "Add your first tasks and Planora will start spotting patterns in how you work.";
            tips[1].textContent = "Tip: ask Planora on the Home screen to turn your week into a schedule.";
            return;
        }

        // best weekday by completed tasks
        const perDow = [0, 0, 0, 0, 0, 0, 0], dowCount = [0, 0, 0, 0, 0, 0, 0];
        Object.entries(s.map).forEach(([k, v]) => {
            const dow = new Date(k + "T00:00:00").getDay();
            perDow[dow] += v.done;
            dowCount[dow] += 1;
        });
        const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        let best = 0;
        perDow.forEach((v, i) => { if (v / (dowCount[i] || 1) > perDow[best] / (dowCount[best] || 1)) best = i; });
        const avg = Math.round((perDow[best] / (dowCount[best] || 1)) * 10) / 10;

        // morning vs later completion
        const timed = s.list.filter(t => t.start);
        const morning = timed.filter(t => t.start < "12:00");
        const later = timed.filter(t => t.start >= "12:00");
        const rate = arr => arr.length ? arr.filter(t => t.completed).length / arr.length : 0;

        if (morning.length >= 3 && later.length >= 3) {
            const m = Math.round(rate(morning) * 100), l = Math.round(rate(later) * 100);
            tips[0].textContent = m >= l
                ? `You finish ${m}% of morning tasks vs ${l}% later in the day. Put important work before noon.`
                : `You finish ${l}% of afternoon/evening tasks vs ${m}% in the morning. Schedule deep work later.`;
        } else {
            tips[0].textContent = `You've completed ${s.done} of ${s.total} tasks so far. Keep going!`;
        }

        tips[1].textContent = perDow[best] > 0
            ? `Your best day is ${names[best]}, averaging ${avg} completed task${avg === 1 ? "" : "s"}.`
            : `Complete a few tasks to discover your most productive day.`;
    }

    /* ---- settings ---- */

    function openEditInfo() {
        const user = PlanoraAuth.user || {};
        const canEditEmail = user.hasPassword && !user.guest;
        openSheet("Edit personal info", "ti-user-circle", `
            <label for="ep-name">Name</label>
            <input type="text" id="ep-name" autocomplete="name">
            <label for="ep-email">Email</label>
            <input type="email" id="ep-email" ${canEditEmail ? "" : "disabled"}>
            ${canEditEmail ? "" : `<p class="auth-sheet-info" style="font-size:12px;">Your email comes from ${escapeHtml(providerLabel(user).text)} and can't be changed here.</p>`}
            <p class="auth-error" id="ep-error" hidden></p>
            <button type="submit" class="btn-primary" id="ep-save">Save changes</button>
            ${user.hasPassword ? `<div class="sheet-divider"></div>
            <label for="ep-current">Change password</label>
            <input type="password" id="ep-current" placeholder="Current password" autocomplete="current-password">
            <input type="password" id="ep-new" placeholder="New password (at least 8 characters)" autocomplete="new-password">
            <p class="auth-error" id="pw-error" hidden></p>
            <button type="button" class="btn-secondary" id="ep-pw">Update password</button>` : ""}
        `, form => {
            form.querySelector("#ep-name").value = user.name || "";
            form.querySelector("#ep-email").value = user.email || "";
            form.addEventListener("submit", async () => {
                const err = form.querySelector("#ep-error");
                const btn = form.querySelector("#ep-save");
                btn.disabled = true;
                try {
                    const changes = { name: form.querySelector("#ep-name").value };
                    if (canEditEmail) changes.email = form.querySelector("#ep-email").value;
                    await PlanoraAuth.updateProfile(changes);
                    closeSheet();
                    renderProfile();
                    PlanoraAuth.toast("Profile updated.", "success");
                } catch (e) {
                    err.textContent = e.message; err.hidden = false;
                } finally { btn.disabled = false; }
            });
            const pwBtn = form.querySelector("#ep-pw");
            if (pwBtn) pwBtn.addEventListener("click", async () => {
                const err = form.querySelector("#pw-error");
                pwBtn.disabled = true;
                try {
                    await PlanoraAuth.changePassword(form.querySelector("#ep-current").value, form.querySelector("#ep-new").value);
                    form.querySelector("#ep-current").value = "";
                    form.querySelector("#ep-new").value = "";
                    err.hidden = true;
                    PlanoraAuth.toast("Password updated.", "success");
                } catch (e) {
                    err.textContent = e.message; err.hidden = false;
                } finally { pwBtn.disabled = false; }
            });
        });
    }

    function openGoalSheet() {
        const user = PlanoraAuth.user || {};
        const goals = ["Stay organized", "Study", "Build habits", "Reach goals", "Manage workload"];
        openSheet("What should Planora help with?", "ti-target-arrow", `
            <div class="option-list">
                ${goals.map(g => `<button type="button" class="option-card${user.prefs && user.prefs.goal === g ? " selected" : ""}" data-goal="${escapeHtml(g)}">${escapeHtml(g)}<i class="ti ti-circle-check-filled check"></i></button>`).join("")}
            </div>
        `, form => {
            form.querySelectorAll("[data-goal]").forEach(btn => btn.addEventListener("click", async () => {
                try {
                    await PlanoraAuth.updateProfile({ prefs: { goal: btn.dataset.goal } });
                    closeSheet();
                    renderProfile();
                    PlanoraAuth.toast("Saved.", "success");
                } catch (e) { PlanoraAuth.toast(e.message, "error"); }
            }));
        });
    }

    function openNotifications() {
        const P = window.PlanoraPush;
        const cur = P ? P.prefs() : { morning: false, morningTime: "07:30", before: false };
        const first = !(PlanoraAuth.user && PlanoraAuth.user.prefs && PlanoraAuth.user.prefs.push);
        openSheet("Reminders", "ti-bell", `
            <p class="auth-sheet-info nt-status" id="nt-status">Checking this device…</p>
            <div class="toggle-row">
                <div>Morning summary<small>Your tasks for the day, or a nudge to plan it if nothing's planned yet</small></div>
                <label class="switch"><input type="checkbox" id="nt-morning"><span></span></label>
            </div>
            <label for="nt-time">Morning summary time</label>
            <input type="time" id="nt-time" step="900">
            <div class="toggle-row">
                <div>15 minutes before<small>A heads-up before each task and event that has a time</small></div>
                <label class="switch"><input type="checkbox" id="nt-before"><span></span></label>
            </div>
            <p class="auth-error" id="nt-error" hidden></p>
            <button type="submit" class="btn-primary" id="nt-save">Save</button>
            <button type="button" class="btn-secondary" id="nt-test" hidden><i class="ti ti-send"></i>Send a test notification</button>
        `, form => {
            const $f = id => form.querySelector(id);
            $f("#nt-morning").checked = first ? true : Boolean(cur.morning);
            $f("#nt-before").checked = first ? true : Boolean(cur.before);
            $f("#nt-time").value = cur.morningTime || "07:30";
            const err = $f("#nt-error"), st = $f("#nt-status"), testBtn = $f("#nt-test");
            const say = s => {
                const map = {
                    on: "✅ Reminders are on for this device.",
                    off: "Reminders are off on this device. Turn them on below and tap Save.",
                    denied: "Notifications are blocked for Planora on this device. Allow them in your phone or browser settings, then come back here.",
                    guest: "Sign in to get reminders on your phone and computer.",
                    unsupported: "This browser can't show reminders. Use Chrome or Edge, or the Planora app."
                };
                st.textContent = map[s] || "";
                testBtn.hidden = s !== "on";
            };
            if (P) P.status().then(say).catch(() => say("off")); else say("unsupported");
            testBtn.addEventListener("click", async () => {
                testBtn.disabled = true;
                try { await P.test(); PlanoraAuth.toast("Test sent. It should arrive in a few seconds.", "success"); }
                catch (e) { PlanoraAuth.toast(e.message, "error"); }
                finally { testBtn.disabled = false; }
            });
            form.addEventListener("submit", async () => {
                err.hidden = true;
                const push = { morning: $f("#nt-morning").checked, before: $f("#nt-before").checked, morningTime: $f("#nt-time").value || "07:30", minutes: 15 };
                const btn = $f("#nt-save"); btn.disabled = true;
                try {
                    if (push.morning || push.before) { if (!P) throw new Error("This browser can't show reminders."); await P.enable(); }
                    else if (P) await P.disable();
                    await PlanoraAuth.updateProfile({ prefs: { push } });
                    if (P) await P.sync(true);
                    closeSheet();
                    PlanoraAuth.toast(push.morning || push.before ? "Reminders are on." : "Reminders are off.", "success");
                } catch (e) {
                    err.textContent = e.message; err.hidden = false;
                    if (P) P.status().then(say).catch(() => {});
                } finally { btn.disabled = false; }
            });
        });
    }

    function openAppearance() {
        const current = localStorage.getItem("planora_pref_start_page") || "home.html";
        openSheet("Appearance & start page", "ti-palette", `
            <label>Open Planora on</label>
            <div class="option-list">
                ${[["home.html", "Home dashboard", "ti-home"], ["planner.html", "AI Planner", "ti-list-check"], ["calendar.html", "Calendar", "ti-calendar"], ["journal.html", "Journal", "ti-notebook"]]
                    .map(([v, l, i]) => `<button type="button" class="option-card${current === v ? " selected" : ""}" data-page="${v}"><i class="ti ${i}" style="color:var(--purple-600);"></i>${l}<i class="ti ti-circle-check-filled check"></i></button>`).join("")}
            </div>
        `, form => {
            form.querySelectorAll("[data-page]").forEach(btn => btn.addEventListener("click", () => {
                localStorage.setItem("planora_pref_start_page", btn.dataset.page);
                form.querySelectorAll("[data-page]").forEach(b => b.classList.toggle("selected", b === btn));
                PlanoraAuth.toast("Saved. Planora will open here next time you sign in.", "success");
            }));
        });
    }

    function openPrivacy() {
        openSheet("Privacy and data", "ti-lock", `
            <p class="auth-sheet-info">Your tasks, journal, goals and plans are saved to your Planora account so they're there on any browser you sign in on. Only you can see them.</p>
            <button type="button" class="btn-secondary" id="pv-export"><i class="ti ti-download"></i>Download my data</button>
            <div class="sheet-divider"></div>
            <p class="auth-sheet-info"><strong>Ask Planora chat history</strong><br>Planora remembers your recent chat (the last 20 messages and a short summary) so it can follow up, like "I haven't finished module 2". Only you can see it.</p>
            <button type="button" class="btn-secondary" id="pv-chat"><i class="ti ti-message-x"></i>Clear chat history</button>
            <div class="sheet-divider"></div>
            <p class="auth-sheet-info"><strong>Delete account</strong><br>This permanently deletes your account and everything in it. This can't be undone.</p>
            <input type="text" id="pv-confirm" placeholder='Type DELETE to confirm'>
            <p class="auth-error" id="pv-error" hidden></p>
            <button type="button" class="btn-danger" id="pv-delete">Delete my account</button>
        `, form => {
            form.querySelector("#pv-chat").addEventListener("click", async () => {
                const ok = await PlanoraCore.confirm({ title: "Clear chat history?", message: "Planora will forget your Ask Planora conversation. Your tasks and plans stay as they are.", confirmText: "Clear", danger: true }).catch(() => window.confirm("Clear chat history?"));
                if (!ok) return;
                try {
                    const r = await fetch("/api/coach/history", { method: "DELETE" });
                    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Planora couldn't clear the chat right now.");
                    if (window.PlanoraAsk && PlanoraAsk.reset) PlanoraAsk.reset();
                    PlanoraAuth.toast("Chat history cleared.", "success");
                } catch (e) { PlanoraAuth.toast(e.message, "error"); }
            });
            form.querySelector("#pv-export").addEventListener("click", async () => {
                const user = PlanoraAuth.user || {};
                const data = {};
                Object.entries(PlanoraAuth.exportData()).forEach(([k, v]) => {
                    try { data[k] = JSON.parse(v); } catch { data[k] = v; }
                });
                try { const r = await fetch("/api/coach/history"); if (r.ok) data.ask_planora_chat = await r.json(); } catch {}
                const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), account: { name: user.name, email: user.email }, data }, null, 2)], { type: "application/json" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `planora-data-${dateKey(new Date())}.json`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            });
            form.querySelector("#pv-delete").addEventListener("click", async () => {
                const err = form.querySelector("#pv-error");
                if (form.querySelector("#pv-confirm").value.trim().toUpperCase() !== "DELETE") {
                    err.textContent = "Type DELETE in the box to confirm."; err.hidden = false; return;
                }
                try {
                    await PlanoraAuth.deleteAccount();
                    location.replace("index.html?deleted=1");
                } catch (e) { err.textContent = e.message; err.hidden = false; }
            });
        });
    }

    function openHelp() {
        openSheet("Help and support", "ti-help-circle", `
            <a class="btn-primary" style="text-decoration:none;margin-bottom:6px;" href="home.html?tour=1"><i class="ti ti-route"></i>Take the tour</a>
            <p class="auth-sheet-info"><strong>Plan with AI</strong><br>On Home, tell "Ask Planora" what's on your plate (e.g. "3 client calls, gym 3x, finish the report by Friday"). Review the plan and save it to your calendar.</p>
            <p class="auth-sheet-info"><strong>Study plans</strong><br>AI Planner → Study Planner builds a revision timetable up to your exam date.</p>
            <p class="auth-sheet-info"><strong>Streaks</strong><br>Complete at least one task a day to grow your streak.</p>
            <p class="auth-sheet-info"><strong>Your data</strong><br>Everything saves to your account automatically. Sign in on another browser to pick up where you left off.</p>
            <button type="button" class="btn-secondary" id="help-feedback"><i class="ti ti-mail"></i>Send feedback</button>
        `, form => {
            form.querySelector("#help-feedback").addEventListener("click", openFeedback);
        });
    }

    // Send feedback: name, email and enquiry → Planora's server → info@jkssofttech.com
    function openFeedback() {
        const user = PlanoraAuth.user || {};
        openSheet("Send feedback", "ti-mail", `
            <p class="auth-sheet-info">Questions, ideas or something not working? Tell us and we'll reply by email.</p>
            <label for="fb-name">Name</label>
            <input type="text" id="fb-name" autocomplete="name" maxlength="80" required>
            <label for="fb-email">Email</label>
            <input type="email" id="fb-email" autocomplete="email" maxlength="254" required>
            <label for="fb-message">Your enquiry</label>
            <textarea id="fb-message" class="fb-message" rows="5" maxlength="4000" placeholder="How can we help?" required></textarea>
            <div class="fb-hp" aria-hidden="true"><label for="fb-website">Leave this empty</label><input type="text" id="fb-website" tabindex="-1" autocomplete="off"></div>
            <p class="auth-error" id="fb-error" role="alert" hidden></p>
            <button type="submit" class="btn-primary" id="fb-send">Send</button>
        `, form => {
            const $f = id => form.querySelector("#" + id);
            $f("fb-name").value = user.guest ? "" : (user.name || "");
            $f("fb-email").value = user.email || "";
            setTimeout(() => ($f("fb-name").value ? $f("fb-message") : $f("fb-name")).focus(), 30);
            form.addEventListener("submit", async () => {
                const err = $f("fb-error"), btn = $f("fb-send");
                const name = $f("fb-name").value.trim(), email = $f("fb-email").value.trim(), message = $f("fb-message").value.trim();
                const fail = (text, el) => { err.textContent = text; err.hidden = false; if (el) el.focus(); };
                err.hidden = true;
                if (!name) return fail("Please enter your name.", $f("fb-name"));
                if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return fail("Please enter a valid email address so we can reply.", $f("fb-email"));
                if (message.length < 5) return fail("Please write a little more about your enquiry.", $f("fb-message"));
                btn.disabled = true; btn.textContent = "Sending…";
                try {
                    const res = await fetch("/api/feedback", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name, email, message, website: $f("fb-website").value, page: location.pathname, app: document.documentElement.classList.contains("app-mode") ? "app" : "web" })
                    });
                    let body = {}; try { body = await res.json(); } catch {}
                    if (!res.ok || !body.ok) throw new Error(body.error || "Your message couldn't be sent right now.");
                    form.innerHTML = `
                        <div class="fb-done">
                            <span class="fb-done-icon"><i class="ti ti-circle-check" aria-hidden="true"></i></span>
                            <h3>Thanks, ${escapeHtml(name.split(" ")[0])}!</h3>
                            <p class="auth-sheet-info">We've received your message and will reply to <strong>${escapeHtml(email)}</strong>.</p>
                            <button type="button" class="btn-primary" id="fb-close">Done</button>
                        </div>`;
                    form.querySelector("#fb-close").addEventListener("click", closeSheet);
                    form.querySelector("#fb-close").focus();
                } catch (e) {
                    const offline = e instanceof TypeError || !navigator.onLine;
                    fail(offline ? "You seem to be offline. Please check your connection and try again." : e.message);
                    if (!/info@jkssofttech\.com/.test(err.textContent)) err.insertAdjacentHTML("beforeend", ` You can also email <a href="mailto:info@jkssofttech.com?subject=Planora%20feedback">info@jkssofttech.com</a>.`);
                    btn.disabled = false; btn.textContent = "Send";
                }
            });
        });
    }

    function wireSettings() {
        const rows = document.querySelectorAll(".settings-list .settings-row");
        const handlers = {
            "Edit personal info": openEditInfo,
            "Account": openEditInfo,
            "Notifications": openNotifications,
            "Appearance": openAppearance,
            "Labels": () => window.PlanoraCore && PlanoraCore.openLabelsManager(),
            "Google Calendar": () => window.PlanoraGCal ? PlanoraGCal.openPanel() : (location.href = "calendar.html?gcal=1"),
            "Privacy and data": openPrivacy,
            "Help and support": openHelp,
            "Log out": () => PlanoraAuth.logout()
        };
        rows.forEach(row => {
            const label = (row.querySelector("span") || {}).textContent;
            const fn = handlers[label && label.trim()];
            if (!fn) return;
            row.setAttribute("role", "button");
            row.tabIndex = 0;
            row.addEventListener("click", fn);
            row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } });
        });
        const addBusy = $("busy-add");
        if (addBusy) addBusy.addEventListener("click", () => openBusySheet(-1));
        const edit = document.querySelector(".profile-edit-btn");
        if (edit) edit.addEventListener("click", openEditInfo);
    }

    /* ---- busy hours (work, college, regular meetings) ---- */
    const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];          // Mon first
    function busyList() {
        const u = window.PlanoraAuth && PlanoraAuth.user;
        return u && u.prefs && Array.isArray(u.prefs.routine) ? u.prefs.routine.slice() : [];
    }
    function daysText(days) {
        const d = [...days].map(Number).sort((a, b) => a - b).join(",");
        if (d === "1,2,3,4,5") return "Mon–Fri";
        if (d === "0,1,2,3,4,5,6") return "Every day";
        if (d === "0,6") return "Weekends";
        return DAY_ORDER.filter(x => days.map(Number).includes(x)).map(x => DAY_SHORT[x]).join(", ");
    }
    function time12(hhmm) {
        const [h, m] = String(hhmm).split(":").map(Number);
        return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "AM" : "PM"}`;
    }
    const TRAVEL = [0, 15, 30, 45, 60, 90, 120, 150, 180];
    const minsText = m => m < 60 ? `${m} min` : `${m / 60 % 1 ? (m / 60).toFixed(1).replace(/\.0$/, "") : m / 60}h`;
    function travelText(r) {
        const b = Number(r.travelBefore) || 0, a = Number(r.travelAfter) || 0;
        if (!b && !a) return "";
        return b === a ? ` · ${minsText(b)} travel each way` : ` · travel ${b ? minsText(b) + " before" : ""}${b && a ? ", " : ""}${a ? minsText(a) + " after" : ""}`;
    }
    function busyIcon(name) {
        const n = String(name).toLowerCase();
        return /college|uni|school|class|lecture|study/.test(n) ? "ti-school" : /meeting|call/.test(n) ? "ti-users" : /commute|travel|drive/.test(n) ? "ti-bus" : /gym|sport|training/.test(n) ? "ti-barbell" : "ti-briefcase";
    }
    function renderBusy() {
        const box = $("busy-list");
        if (!box) return;
        const list = busyList();
        box.innerHTML = list.length ? list.map((r, i) => `
            <button type="button" class="busy-row" data-busy="${i}" aria-label="Edit ${escapeHtml(r.name)}">
                <i class="ti ${busyIcon(r.name)} busy-ico" aria-hidden="true"></i>
                <span class="busy-text"><strong>${escapeHtml(r.name)}</strong><small>${escapeHtml(daysText(r.days))} · ${time12(r.start)} – ${time12(r.end)}${travelText(r)}</small></span>
                <i class="ti ti-pencil busy-edit" aria-hidden="true"></i>
            </button>`).join("")
            : `<p class="busy-empty">Nothing added yet. For example: Work, Mon–Fri, 9 AM – 6 PM.</p>`;
        box.querySelectorAll("[data-busy]").forEach(b => b.addEventListener("click", () => openBusySheet(Number(b.dataset.busy))));
    }
    async function saveBusy(list) {
        await PlanoraAuth.updateProfile({ prefs: { routine: list } });
        renderBusy();
        document.dispatchEvent(new CustomEvent("planora:data-changed"));
    }
    function openBusySheet(index) {
        const list = busyList();
        const editing = index >= 0 && list[index];
        const cur = editing ? { ...list[index], days: list[index].days.map(Number) } : { name: "", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };
        const kinds = ["Work", "College", "School", "Meetings", "Classes", "Commute"];
        openSheet(editing ? "Edit busy time" : "Add busy time", "ti-briefcase", `
            <label for="bz-name">What is it?</label>
            <div class="busy-kinds">${kinds.map(k => `<button type="button" class="busy-chip" data-kind="${k}">${k}</button>`).join("")}</div>
            <input type="text" id="bz-name" maxlength="40" placeholder="e.g. Work, College, Team meeting">
            <label>Which days?</label>
            <div class="busy-days" role="group" aria-label="Days">${DAY_ORDER.map(d => `<button type="button" class="busy-day" data-day="${d}" aria-pressed="false" aria-label="${DAY_SHORT[d]}">${DAY_SHORT[d].slice(0, 2)}</button>`).join("")}</div>
            <div class="busy-presets"><button type="button" data-preset="1,2,3,4,5">Weekdays</button><button type="button" data-preset="0,1,2,3,4,5,6">Every day</button><button type="button" data-preset="0,6">Weekends</button></div>
            <div class="busy-times">
                <div><label for="bz-start">From</label><input type="time" id="bz-start" step="900"></div>
                <div><label for="bz-end">To</label><input type="time" id="bz-end" step="900"></div>
            </div>
            <div class="busy-times">
                <div><label for="bz-tb">Travel before</label><select id="bz-tb">${TRAVEL.map(m => `<option value="${m}">${m ? minsText(m) : "None"}</option>`).join("")}</select></div>
                <div><label for="bz-ta">Travel after</label><select id="bz-ta">${TRAVEL.map(m => `<option value="${m}">${m ? minsText(m) : "None"}</option>`).join("")}</select></div>
            </div>
            <p class="busy-hint">Planora keeps travel time free too, and may suggest phone-friendly things for it.</p>
            <p class="auth-error" id="bz-error" hidden></p>
            <button type="submit" class="btn-primary">${editing ? "Save" : "Add"}</button>
            ${editing ? `<button type="button" class="btn-secondary busy-del" id="bz-del"><i class="ti ti-trash"></i>Remove</button>` : ""}
        `, form => {
            const name = form.querySelector("#bz-name");
            let days = new Set(cur.days);
            name.value = cur.name;
            form.querySelector("#bz-start").value = cur.start;
            form.querySelector("#bz-end").value = cur.end;
            const nearest = v => TRAVEL.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a, 0);
            form.querySelector("#bz-tb").value = String(nearest(Number(cur.travelBefore) || 0));
            form.querySelector("#bz-ta").value = String(nearest(Number(cur.travelAfter) || 0));
            const paint = () => {
                form.querySelectorAll("[data-day]").forEach(b => { const on = days.has(Number(b.dataset.day)); b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
                form.querySelectorAll("[data-kind]").forEach(b => b.classList.toggle("on", b.dataset.kind.toLowerCase() === name.value.trim().toLowerCase()));
            };
            form.querySelectorAll("[data-kind]").forEach(b => b.addEventListener("click", () => { name.value = b.dataset.kind; paint(); }));
            name.addEventListener("input", paint);
            form.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => { const d = Number(b.dataset.day); days.has(d) ? days.delete(d) : days.add(d); paint(); }));
            form.querySelectorAll("[data-preset]").forEach(b => b.addEventListener("click", () => { days = new Set(b.dataset.preset.split(",").map(Number)); paint(); }));
            paint();
            form.addEventListener("submit", async () => {
                const err = form.querySelector("#bz-error");
                const start = form.querySelector("#bz-start").value, end = form.querySelector("#bz-end").value;
                const show = m => { err.textContent = m; err.hidden = false; };
                if (!name.value.trim()) return show("Give it a name, like Work or College.");
                if (!days.size) return show("Pick at least one day.");
                if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return show("Choose a start and end time.");
                if (start === end) return show("The end time must be different from the start time.");
                const item = { id: cur.id || "b-" + Math.random().toString(36).slice(2, 9), name: name.value.trim().slice(0, 40), days: [...days].sort((a, b) => a - b), start, end,
                    travelBefore: Number(form.querySelector("#bz-tb").value) || 0, travelAfter: Number(form.querySelector("#bz-ta").value) || 0 };
                const next = busyList();
                if (editing) next[index] = item; else next.push(item);
                if (next.length > 12) return show("You can add up to 12 busy times.");
                try { await saveBusy(next); closeSheet(); PlanoraAuth.toast(editing ? "Saved." : `Added. Planora won't plan tasks during ${item.name}.`, "success"); }
                catch (e) { show(e.message); }
            });
            const del = form.querySelector("#bz-del");
            if (del) del.addEventListener("click", async () => {
                const next = busyList(); next.splice(index, 1);
                try { await saveBusy(next); closeSheet(); PlanoraAuth.toast("Removed.", "success"); }
                catch (e) { PlanoraAuth.toast(e.message, "error"); }
            });
        });
    }

    /* ---------------- My week: wake / sleep, weekly targets ---------------- */
    function myWeek() {
        const u = window.PlanoraAuth && PlanoraAuth.user;
        const w = u && u.prefs && u.prefs.week && typeof u.prefs.week === "object" ? u.prefs.week : {};
        return { wake: w.wake || "", sleep: w.sleep || "", weekStart: w.weekStart === 0 ? 0 : 1, targets: Array.isArray(w.targets) ? w.targets.slice() : [] };
    }
    async function saveWeek(week) {
        await PlanoraAuth.updateProfile({ prefs: { week } });
        renderWeek();
        document.dispatchEvent(new CustomEvent("planora:data-changed"));
    }
    function labelsList() { return window.PlanoraCore && PlanoraCore.customCategories ? PlanoraCore.customCategories() : []; }
    function weekProgress(t, weekStart) {
        const C = window.PlanoraCore;
        if (!C || !t.labelId) return null;
        const todayStr = C.today();
        const back = (new Date(todayStr + "T00:00:00").getDay() - weekStart + 7) % 7;
        const from = C.addDays(todayStr, -back), to = C.addDays(from, 6);
        const done = C.getTasks().filter(x => x.completed && x.category === t.labelId && x.date >= from && x.date <= to);
        return t.unit === "sessions" ? done.length : Math.round(done.reduce((n, x) => n + (C.taskDuration(x) || 30), 0) / 6) / 10;
    }
    function renderWeek() {
        const box = $("week-box");
        if (!box) return;
        const w = myWeek(), labels = labelsList();
        const lab = id => labels.find(l => l.id === id);
        const dayText = w.wake || w.sleep ? `${w.wake ? time12(w.wake) : "—"} – ${w.sleep ? time12(w.sleep) : "—"}` : "Not set";
        box.innerHTML = `
            <button type="button" class="busy-row" id="wk-day"><i class="ti ti-sun-moon busy-ico" aria-hidden="true"></i>
                <span class="busy-text"><strong>Wake up and sleep</strong><small>${escapeHtml(dayText)} · week starts ${w.weekStart === 0 ? "Sunday" : "Monday"}</small></span>
                <i class="ti ti-pencil busy-edit" aria-hidden="true"></i></button>
            <p class="week-sub">Weekly targets</p>
            ${w.targets.length ? w.targets.map((t, i) => {
                const l = lab(t.labelId), done = weekProgress(t, w.weekStart), goal = Number(t.min) || Number(t.max) || 0;
                const pct = done === null || !goal ? 0 : Math.min(100, Math.round(done / goal * 100));
                const range = `${t.min && t.max && t.max !== t.min ? `${t.min}–${t.max}` : (t.min || t.max)} ${t.unit === "sessions" ? "sessions" : "h"} a week`;
                return `<button type="button" class="busy-row week-target" data-target="${i}" aria-label="Edit ${escapeHtml(t.name)}">
                    <span class="wt-dot" style="background:${l ? l.color : "#B9B3D9"}" aria-hidden="true"></span>
                    <span class="busy-text"><strong>${escapeHtml(t.name)}</strong><small>${escapeHtml(range)}${done === null ? " · link a label to track it" : ` · ${done} done this week`}</small>
                        ${done === null ? "" : `<span class="wt-bar" aria-hidden="true"><span style="width:${pct}%;background:${l ? l.color : "var(--purple-400)"}"></span></span>`}</span>
                    <i class="ti ti-pencil busy-edit" aria-hidden="true"></i></button>`;
            }).join("") : `<p class="busy-empty">No targets yet. For example: College 8–10h a week, Workouts 3 sessions.</p>`}
            <button type="button" class="btn-secondary busy-add" id="wk-add"><i class="ti ti-plus" aria-hidden="true"></i>Add weekly target</button>`;
        $("wk-day").addEventListener("click", openDaySheet);
        $("wk-add").addEventListener("click", () => openTargetSheet(-1));
        box.querySelectorAll("[data-target]").forEach(b => b.addEventListener("click", () => openTargetSheet(Number(b.dataset.target))));
    }
    function openDaySheet() {
        const w = myWeek();
        openSheet("Wake up and sleep", "ti-sun-moon", `
            <p class="auth-sheet-info">Planora only plans between these times.</p>
            <div class="busy-times">
                <div><label for="wk-wake">Wake up</label><input type="time" id="wk-wake" step="900"></div>
                <div><label for="wk-sleep">Sleep</label><input type="time" id="wk-sleep" step="900"></div>
            </div>
            <label for="wk-start">Week starts on</label>
            <select id="wk-start"><option value="1">Monday</option><option value="0">Sunday</option></select>
            <p class="auth-error" id="wk-err" hidden></p>
            <button type="submit" class="btn-primary">Save</button>
            ${w.wake || w.sleep ? `<button type="button" class="btn-secondary" id="wk-clear">Clear times</button>` : ""}
        `, form => {
            form.querySelector("#wk-wake").value = w.wake || "08:00";
            form.querySelector("#wk-sleep").value = w.sleep || "23:00";
            form.querySelector("#wk-start").value = String(w.weekStart);
            form.addEventListener("submit", async () => {
                const wake = form.querySelector("#wk-wake").value, sleep = form.querySelector("#wk-sleep").value;
                const err = form.querySelector("#wk-err");
                if (!/^\d{2}:\d{2}$/.test(wake) || !/^\d{2}:\d{2}$/.test(sleep)) { err.textContent = "Choose both times."; err.hidden = false; return; }
                if (wake === sleep) { err.textContent = "Wake-up and sleep times must be different."; err.hidden = false; return; }
                try { await saveWeek({ ...w, wake, sleep, weekStart: Number(form.querySelector("#wk-start").value) }); closeSheet(); PlanoraAuth.toast("Saved. Planora will plan between these times.", "success"); }
                catch (e) { err.textContent = e.message; err.hidden = false; }
            });
            const c = form.querySelector("#wk-clear");
            if (c) c.addEventListener("click", async () => { try { await saveWeek({ ...w, wake: "", sleep: "" }); closeSheet(); } catch (e) { PlanoraAuth.toast(e.message, "error"); } });
        });
    }
    function openTargetSheet(index) {
        const w = myWeek(), labels = labelsList();
        const editing = index >= 0 && w.targets[index];
        const cur = editing ? { ...w.targets[index] } : { name: "", labelId: "", unit: "hours", min: "", max: "" };
        openSheet(editing ? "Edit weekly target" : "Add weekly target", "ti-target-arrow", `
            <label for="wt-name">Area</label>
            <input type="text" id="wt-name" maxlength="40" placeholder="e.g. College, Research, Business, Workouts">
            <label for="wt-label">Label (counts finished tasks with this label)</label>
            <select id="wt-label"><option value="">No label</option>${labels.map(l => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.label)}</option>`).join("")}</select>
            ${labels.length ? "" : `<p class="busy-hint">You have no labels yet. <button type="button" class="link-btn" id="wt-labels">Create labels</button></p>`}
            <label>Measure in</label>
            <div class="seg" role="tablist"><button type="button" role="tab" data-u="hours">Hours</button><button type="button" role="tab" data-u="sessions">Sessions</button></div>
            <div class="busy-times">
                <div><label for="wt-min">At least</label><input type="number" id="wt-min" min="0" max="100" step="0.5" inputmode="decimal"></div>
                <div><label for="wt-max">Up to (optional)</label><input type="number" id="wt-max" min="0" max="100" step="0.5" inputmode="decimal"></div>
            </div>
            <p class="auth-error" id="wt-err" hidden></p>
            <button type="submit" class="btn-primary">${editing ? "Save" : "Add"}</button>
            ${editing ? `<button type="button" class="btn-secondary busy-del" id="wt-del"><i class="ti ti-trash"></i>Remove</button>` : ""}
        `, form => {
            const name = form.querySelector("#wt-name"), sel = form.querySelector("#wt-label");
            let unit = cur.unit === "sessions" ? "sessions" : "hours";
            name.value = cur.name; sel.value = cur.labelId || "";
            form.querySelector("#wt-min").value = cur.min || ""; form.querySelector("#wt-max").value = cur.max || "";
            const paint = () => form.querySelectorAll("[data-u]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.u === unit)));
            form.querySelectorAll("[data-u]").forEach(b => b.addEventListener("click", () => { unit = b.dataset.u; paint(); }));
            paint();
            // pick the label with the same name automatically
            name.addEventListener("input", () => { if (sel.value) return; const m = labels.find(l => l.label.toLowerCase() === name.value.trim().toLowerCase()); if (m) sel.value = m.id; });
            const lb = form.querySelector("#wt-labels");
            if (lb) lb.addEventListener("click", () => { closeSheet(); window.PlanoraCore && PlanoraCore.openLabelsManager(); });
            form.addEventListener("submit", async () => {
                const err = form.querySelector("#wt-err");
                const show = m => { err.textContent = m; err.hidden = false; };
                const min = Number(form.querySelector("#wt-min").value) || 0, max = Number(form.querySelector("#wt-max").value) || 0;
                if (!name.value.trim()) return show("Name the area, like College or Workouts.");
                if (!min && !max) return show("Add how many hours or sessions a week.");
                if (max && min > max) return show("\"Up to\" should be more than \"At least\".");
                const item = { id: cur.id || "t-" + Math.random().toString(36).slice(2, 9), name: name.value.trim().slice(0, 40), labelId: sel.value, unit, min: min || max, max: max || 0 };
                const targets = myWeek().targets;
                if (editing) targets[index] = item; else targets.push(item);
                if (targets.length > 12) return show("You can add up to 12 targets.");
                try { await saveWeek({ ...myWeek(), targets }); closeSheet(); PlanoraAuth.toast(editing ? "Saved." : `Added. Planora will keep an eye on ${item.name} each week.`, "success"); }
                catch (e) { show(e.message); }
            });
            const del = form.querySelector("#wt-del");
            if (del) del.addEventListener("click", async () => {
                const targets = myWeek().targets; targets.splice(index, 1);
                try { await saveWeek({ ...myWeek(), targets }); closeSheet(); PlanoraAuth.toast("Removed.", "success"); }
                catch (e) { PlanoraAuth.toast(e.message, "error"); }
            });
        });
    }

    function renderProfile() {
        renderBusy();
        renderWeek();
        renderProfileHeader();
        renderWeekChart();
        renderRealHeatmap();
        renderRealCategories();
        renderInsights();
    }


    /* ---------------- streak page ---------------- */

    function renderStreakPage() {
        const root = $("streak-page");
        if (!root) return;
        const s = stats();

        $("streak-current").textContent = s.current;
        $("streak-current-label").textContent = s.current === 1 ? "day streak" : "day streak";
        $("streak-best").textContent = s.best;
        $("streak-active").textContent = s.activeDays;
        $("streak-done").textContent = s.done;

        const msg = $("streak-message");
        // Consistency first, streak second, and never guilt
        const wk = weekStats();
        const weekText = wk.planned ? `You've completed ${wk.done} of ${wk.planned} planned tasks this week.` : "Nothing planned this week yet.";
        msg.textContent = s.current > 1 ? `${weekText} You've also been active ${s.current} days in a row.` : weekText;

        // month grid
        const grid = $("streak-month");
        const title = $("streak-month-title");
        const view = new Date(); view.setDate(1); view.setHours(0, 0, 0, 0);
        const offset = Number(grid.dataset.offset || 0);
        view.setMonth(view.getMonth() + offset);
        title.textContent = view.toLocaleDateString("en-US", { month: "long", year: "numeric" });

        const today = new Date(); today.setHours(0, 0, 0, 0);
        grid.innerHTML = ["M", "T", "W", "T", "F", "S", "S"].map(d => `<div class="dow">${d}</div>`).join("");
        const lead = (view.getDay() + 6) % 7;
        for (let i = 0; i < lead; i++) grid.insertAdjacentHTML("beforeend", `<div class="streak-day blank"></div>`);
        const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
        for (let day = 1; day <= daysInMonth; day++) {
            const d = new Date(view.getFullYear(), view.getMonth(), day);
            const info = s.map[dateKey(d)];
            let cls = "streak-day";
            if (info && info.done > 0) cls += info.done >= info.total ? " done" : " partial";
            if (d.getTime() === today.getTime()) cls += " today";
            if (d > today) cls += " future";
            const tip = info ? `${info.done}/${info.total} tasks done` : "No tasks";
            grid.insertAdjacentHTML("beforeend", `<div class="${cls}" title="${tip}">${day}</div>`);
        }
    }

    window.changeStreakMonth = function (dir) {
        const grid = $("streak-month");
        if (!grid) return;
        grid.dataset.offset = Number(grid.dataset.offset || 0) + dir;
        renderStreakPage();
    };


    /* ---------------- daily reminder ---------------- */

    function maybeRemind() {
        const user = PlanoraAuth.user;
        if (!user || !user.prefs) return;
        const push = user.prefs.push;
        if (push) {
            // real reminders on this device: nothing to do here
            if (!push.morning || ("Notification" in window && Notification.permission === "granted")) return;
            user.prefs.reminderTime = push.morningTime;
        } else if (!user.prefs.reminders) return;
        const now = new Date();
        const today = dateKey(now);
        const [h, m] = (user.prefs.reminderTime || "08:00").split(":").map(Number);
        if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
        const key = "planora_last_reminder";
        if (localStorage.getItem(key) === today) return;

        const todays = tasks().filter(t => t.date === today && !t.completed);
        const text = todays.length
            ? `You have ${todays.length} task${todays.length === 1 ? "" : "s"} today. First up: ${todays.sort((a, b) => (a.start || "99").localeCompare(b.start || "99"))[0].title}.`
            : "Nothing planned yet today. Add a task or ask Planora when you're ready.";

        localStorage.setItem(key, today);
        if ("Notification" in window && Notification.permission === "granted") {
            try { new Notification("Planora", { body: text }); return; } catch {}
        }
        PlanoraAuth.toast(text);
    }


    /* ---------------- start ---------------- */

    function refreshAll() {
        renderStreakBadges();
        if (document.getElementById("profile-screen")) renderProfile();
        renderStreakPage();
    }

    function start() {
        refreshAll();
        wireSettings();

        if (window.PlanoraAuth && PlanoraAuth.ready) {
            PlanoraAuth.ready.then(() => {
                refreshAll();
                if (typeof renderGreeting === "function") renderGreeting();
                maybeRemind();
            });
        }

        document.addEventListener("planora:user", () => {
            if (document.getElementById("profile-screen")) renderProfileHeader();
            if (typeof renderGreeting === "function") renderGreeting();
        });

        // Keep the streak badge right when tasks are ticked off or added
        const origSet = Storage.prototype.setItem;
        let pending = null;
        Storage.prototype.setItem = function (key, value) {
            origSet.call(this, key, value);
            if (key === "planora_tasks") {
                clearTimeout(pending);
                pending = setTimeout(refreshAll, 50);
            }
        };

        // Another tab changed the data
        window.addEventListener("storage", e => { if (e.key === "planora_tasks") refreshAll(); });
    }

    // Run after the existing page scripts have finished their own DOMContentLoaded work
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => setTimeout(start, 0));
    } else {
        setTimeout(start, 0);
    }

})();
