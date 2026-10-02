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
        const user = PlanoraAuth.user || {};
        const prefs = user.prefs || {};
        const supported = "Notification" in window;
        openSheet("Notifications", "ti-bell", `
            <div class="toggle-row">
                <div>Daily reminder<small>A nudge with today's plan when you open Planora</small></div>
                <label class="switch"><input type="checkbox" id="nt-daily"><span></span></label>
            </div>
            <label for="nt-time">Reminder time</label>
            <input type="time" id="nt-time">
            <p class="auth-sheet-info" style="font-size:12px;">${supported
                ? "Your browser will ask for permission the first time you turn this on."
                : "This browser doesn't support notifications, so reminders will show inside Planora instead."}</p>
            <button type="submit" class="btn-primary">Save</button>
        `, form => {
            form.querySelector("#nt-daily").checked = Boolean(prefs.reminders);
            form.querySelector("#nt-time").value = prefs.reminderTime || "08:00";
            form.addEventListener("submit", async () => {
                const on = form.querySelector("#nt-daily").checked;
                if (on && supported && Notification.permission === "default") {
                    try { await Notification.requestPermission(); } catch {}
                }
                try {
                    await PlanoraAuth.updateProfile({ prefs: { reminders: on, reminderTime: form.querySelector("#nt-time").value || "08:00" } });
                    closeSheet();
                    PlanoraAuth.toast(on ? "Daily reminder is on." : "Daily reminder is off.", "success");
                } catch (e) { PlanoraAuth.toast(e.message, "error"); }
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
            <p class="auth-sheet-info"><strong>Delete account</strong><br>This permanently deletes your account and everything in it. This can't be undone.</p>
            <input type="text" id="pv-confirm" placeholder='Type DELETE to confirm'>
            <p class="auth-error" id="pv-error" hidden></p>
            <button type="button" class="btn-danger" id="pv-delete">Delete my account</button>
        `, form => {
            form.querySelector("#pv-export").addEventListener("click", () => {
                const user = PlanoraAuth.user || {};
                const data = {};
                Object.entries(PlanoraAuth.exportData()).forEach(([k, v]) => {
                    try { data[k] = JSON.parse(v); } catch { data[k] = v; }
                });
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
            <p class="auth-sheet-info"><strong>Plan with AI</strong><br>On Home, tell "Ask Planora" what's on your plate (e.g. "3 client calls, gym 3x, finish the report by Friday"). Review the plan and save it to your calendar.</p>
            <p class="auth-sheet-info"><strong>Study plans</strong><br>AI Planner → Study Planner builds a revision timetable up to your exam date.</p>
            <p class="auth-sheet-info"><strong>Streaks</strong><br>Complete at least one task a day to grow your streak.</p>
            <p class="auth-sheet-info"><strong>Your data</strong><br>Everything saves to your account automatically. Sign in on another browser to pick up where you left off.</p>
            <a class="btn-secondary" style="text-decoration:none;" href="mailto:?subject=Planora%20feedback"><i class="ti ti-mail"></i>Send feedback</a>
        `);
    }

    function wireSettings() {
        const rows = document.querySelectorAll(".settings-list .settings-row");
        const handlers = {
            "Edit personal info": openEditInfo,
            "Account": openEditInfo,
            "Notifications": openNotifications,
            "Appearance": openAppearance,
            "Labels": () => window.PlanoraCore && PlanoraCore.openLabelsManager(),
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
        const edit = document.querySelector(".profile-edit-btn");
        if (edit) edit.addEventListener("click", openEditInfo);
    }

    function renderProfile() {
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
        if (!user || !user.prefs || !user.prefs.reminders) return;
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
