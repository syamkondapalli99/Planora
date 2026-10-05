/* =========================================================
   PLANORA HOME  (home.js)

   Home answers one question: "What should I do today?"
   - Greeting + one real sentence about today
   - Today's focus: the 3 most important things (shared priority logic)
   - 0-2 recommendations, only when genuinely useful
   - Today's schedule (existing week strip + task list) with empty state
   - First-time "Let's build your first day"
   - Journal nudge if nothing written today
   Nothing here is made up: it's all worked out from the user's data.
   ========================================================= */

(function () {

    const C = () => window.PlanoraCore;
    const $ = id => document.getElementById(id);


    /* ---------------- header sentence ---------------- */

    function sentence() {
        const core = C();
        const tasks = core.getTasks();
        const t = core.today();
        const todays = tasks.filter(x => x.date === t);
        const left = todays.filter(x => !x.completed);
        const done = todays.length - left.length;
        const overdue = tasks.filter(x => !x.completed && x.date && x.date < t);

        if (!tasks.length) return "Let's plan your first day. Tell Planora what you need to get done.";
        if (!todays.length && !overdue.length) return "You have a clear day.";

        let s;
        if (!todays.length) s = "Nothing is scheduled for today";
        else if (!left.length) s = `You've finished all ${todays.length} task${todays.length === 1 ? "" : "s"} for today. Nice work`;
        else if (done) s = `You've completed ${done} of ${todays.length} tasks today`;
        else s = `You have ${left.length} thing${left.length === 1 ? "" : "s"} left today`;
        if (overdue.length) s += `, plus ${overdue.length} unfinished from earlier`;
        s += ".";

        const nowMin = core.nowMin();
        const next = left.filter(x => core.toMin(x.start) !== null && core.toMin(x.start) >= nowMin)
            .sort((a, b) => a.start.localeCompare(b.start))[0];
        if (next) s += ` Next up: ${next.title} at ${core.time12(next.start)}.`;
        return s;
    }

    function renderHeader() {
        const core = C();
        const msg = $("ai-greeting-msg");
        if (msg) msg.textContent = sentence();

        const chip = $("home-week");
        if (chip) {
            const t = core.today();
            const monday = core.addDays(t, -((new Date(t + "T00:00:00").getDay() + 6) % 7));
            const week = core.getTasks().filter(x => x.date >= monday && x.date <= t);
            const done = week.filter(x => x.completed).length;
            chip.hidden = week.length === 0;
            chip.textContent = `This week: ${done}/${week.length} done`;
            const card = $("home-week-card"), fill = $("home-week-fill");
            if (card) card.hidden = week.length === 0;
            if (fill) fill.style.width = (week.length ? Math.round(done / week.length * 100) : 0) + "%";
            chip.setAttribute("aria-label", `This week you've completed ${done} of ${week.length} planned tasks. Open your progress`);
        }
    }

    function currentStreak(tasks, core) {
        const doneDays = new Set(tasks.filter(t => t.completed && t.date).map(t => t.date));
        let d = core.today();
        if (!doneDays.has(d)) d = core.addDays(d, -1);
        let n = 0;
        while (doneDays.has(d)) { n++; d = core.addDays(d, -1); }
        return n;
    }


    /* ---------------- today's focus ---------------- */

    function renderFocus() {
        const core = C();
        const section = $("home-focus");
        const list = $("focus-list");
        if (!section || !list) return;

        const tasks = core.getTasks();
        const focus = core.focusTasks(3);
        const first = $("first-day");

        if (!tasks.length) {
            section.hidden = true;
            if (first) first.hidden = false;
            return;
        }
        if (first) first.hidden = true;

        // "Things to focus on today" is switched off: Today's schedule is the one task list on Home.
        section.hidden = true;
        list.innerHTML = "";
        return;

        if (!focus.length) {
            section.hidden = true;
            return;
        }
        section.hidden = false;
        $("focus-title").textContent = focus.length === 1 ? "1 thing to focus on today" : `${focus.length} things to focus on today`;

        const nowPick = window.PlanoraPriority.whatNow(tasks, core.priorityCtx());
        const nextId = nowPick.task ? String(nowPick.task.id) : null;
        list.innerHTML = focus.map((t, i) => {
            const reason = core.reasonFor(t);
            const goal = t.goalId ? core.goalTitle(t.goalId) : "";
            const bits = [
                t.start && t.date === core.today() && !/^\d/.test(reason) ? core.time12(t.start) : "",
                reason,
                core.durLabel(core.taskDuration(t)),
                t.priority === "high" && reason !== "High priority" ? "High priority" : "",
                goal ? "Goal: " + goal : ""
            ].filter(Boolean);
            return `
            <li class="focus-item${String(t.id) === nextId ? " is-next" : ""}" data-id="${core.esc(t.id)}">
                <button type="button" class="focus-body" data-open="${core.esc(t.id)}">
                    <span class="focus-title">${core.esc(t.title)}</span>
                    <span class="focus-meta">${bits.map(core.esc).join(" · ")}</span>
                </button>
                <div class="focus-row-actions">
                    <button type="button" class="focus-start" data-start="${core.esc(t.id)}" aria-label="Start ${core.esc(t.title)}"><i class="ti ti-player-play" aria-hidden="true"></i></button>
                    <button type="button" class="focus-done" data-done="${core.esc(t.id)}" aria-label="Mark ${core.esc(t.title)} as done"><i class="ti ti-check" aria-hidden="true"></i></button>
                </div>
            </li>`;
        }).join("");
    }


    /* ---------------- next up / what should I do now ---------------- */

    let nowDetail = false;

    function renderNextUp() {
        const core = C();
        const el = $("next-up");
        if (!el) return;
        const tasks = core.getTasks();
        if (!tasks.length) { el.hidden = true; return; }
        const r = window.PlanoraPriority.whatNow(tasks, core.priorityCtx());
        const t = core.today();
        el.hidden = false;
        el.classList.toggle("is-detail", nowDetail);

        if (r.type === "none") {
            const left = tasks.filter(x => x.date === t && !x.completed).length;
            el.innerHTML = `
                <p class="next-label" id="next-label">${nowDetail ? "What to do now" : "Next up"}</p>
                <p class="next-title">${left ? "You have no urgent tasks right now." : "You're done for today."}</p>
                <div class="next-actions"><button type="button" class="btn-secondary" data-plan-rest>${left ? "Plan the rest of my day" : "Plan tomorrow"}</button></div>`;
            return;
        }
        const task = r.task;
        const when = task.start && task.date === t
            ? `${core.time12(task.start)}${task.end ? "–" + core.time12(task.end) : ""}`
            : core.durLabel(core.taskDuration(task));
        const why = r.reasons || [];
        el.innerHTML = `
            <p class="next-label" id="next-label">${nowDetail ? "What to do now" : r.type === "current" ? "Now" : "Next up"}</p>
            <p class="next-title">${core.esc(task.title)}</p>
            <p class="next-meta">${core.esc(when)}${why[0] && !/free|of work/.test(why[0]) ? " · " + core.esc(why[0]) : ""}</p>
            ${nowDetail ? `<ul class="next-why" aria-label="Why">${why.map(x => `<li>${core.esc(x)}</li>`).join("")}</ul>` : ""}
            <div class="next-actions">
                <button type="button" class="btn-primary" data-start="${core.esc(task.id)}" data-minutes="${r.minutes || ""}"><i class="ti ti-player-play" aria-hidden="true"></i> Start${nowDetail ? " " + core.durLabel(r.minutes || core.taskDuration(task)) : ""}</button>
                <button type="button" class="btn-ghost" data-open="${core.esc(task.id)}">Options</button>
            </div>`;
    }

    function renderWorkload() {
        const core = C();
        const bar = $("today-bar");
        if (!bar) return;
        const tasks = core.getTasks();
        bar.hidden = !tasks.length;
        if (!tasks.length) return;
        const w = window.PlanoraPriority.workload(tasks, core.priorityCtx());
        const el = $("home-status");
        el.className = "wl wl-" + w.status;
        el.querySelector(".wl-label").textContent = w.label;
        el.querySelector(".wl-text").textContent = w.text;
        const opt = $("btn-optimize");
        if (opt) opt.hidden = !tasks.some(x => x.date === core.today() && !x.completed);
        const rev = $("btn-review");
        if (rev) rev.hidden = !(core.nowMin() >= 17 * 60 && tasks.some(x => x.date === core.today()));
    }


    /* ---------------- recommendations (max 2, real data only) ---------------- */

    function recommendations() {
        const core = C();
        const t = core.today();
        const now = core.nowMin();
        const tasks = core.getTasks();
        const recs = [];

        // 1. Unfinished tasks from earlier days
        const overdue = tasks.filter(x => !x.completed && x.date && x.date < t);
        if (overdue.length) {
            recs.push({
                id: "overdue",
                icon: "ti-history",
                text: overdue.length === 1
                    ? `"${overdue[0].title}" from ${core.dayLabel(overdue[0].date).toLowerCase()} isn't done yet. Move it to today?`
                    : `${overdue.length} tasks from earlier days aren't done yet. Move them to today?`,
                action: "Move to today",
                run: () => reschedule(overdue, t, "Move to today")
            });
        }

        // 2. Morning: point at the one thing with a close deadline
        if (now < 12 * 60) {
            const urgent = core.focusTasks(1)[0];
            const todayCount = tasks.filter(x => x.date === t && !x.completed).length;
            if (urgent && urgent.deadline && window.PlanoraPriority.daysBetween(t, urgent.deadline) <= 1 && urgent.date >= t) {
                const due = window.PlanoraPriority.daysBetween(t, urgent.deadline) <= 0 ? "due today" : "due tomorrow";
                const needsTime = !urgent.start || urgent.date !== t;
                recs.push({
                    id: "morning",
                    icon: "ti-sun",
                    text: `Good morning. You have ${todayCount} task${todayCount === 1 ? "" : "s"} today. "${urgent.title}" is ${due}, so I'd start with it.`,
                    action: needsTime ? "Plan it" : null,
                    run: needsTime ? () => reschedule([urgent], t, "Plan it") : null
                });
            }
        }

        // 3. Evening: unfinished tasks → organize tomorrow (preview first)
        const todays = tasks.filter(x => x.date === t);
        const leftPassed = todays.filter(x => !x.completed && (core.toMin(x.end) === null ? now >= 20 * 60 : core.toMin(x.end) <= now));
        if (now >= 18 * 60 && leftPassed.length) {
            recs.push({
                id: "evening",
                icon: "ti-moon",
                text: `You have ${leftPassed.length} unfinished task${leftPassed.length === 1 ? "" : "s"}. Would you like me to organize ${leftPassed.length === 1 ? "it" : "them"} for tomorrow?`,
                action: "Organize tomorrow",
                run: () => core.organizeTomorrow(leftPassed),
                secondary: "I'll handle them"
            });
        }

        // 3b. Overloaded day: offer to move the least important flexible task
        const w = window.PlanoraPriority.workload(tasks, core.priorityCtx());
        if (w.status === "red" && now < 20 * 60) {
            const ranked = window.PlanoraPriority.rank(todays.filter(x => !x.completed && core.isMovable(x)), core.priorityCtx());
            const drop = ranked[ranked.length - 1];
            if (drop) recs.push({
                id: "overloaded",
                icon: "ti-alert-triangle",
                text: `Today is overloaded: ${w.text.replace(/^You have /, "")} Move "${drop.title}" to tomorrow?`,
                action: "Move to tomorrow",
                run: () => reschedule([drop], core.addDays(t, 1), "Move to tomorrow")
            });
        }

        // 3c. A goal with a deadline coming up but nothing planned soon
        core.getGoals().filter(g => g.status === "active" && g.date && window.PlanoraPriority.daysBetween(t, g.date) >= 0 && window.PlanoraPriority.daysBetween(t, g.date) <= 21)
            .some(g => {
                const upcoming = core.goalSessions(g.id).filter(x => !x.completed && x.date >= t && x.date <= core.addDays(t, 3));
                if (upcoming.length || core.goalProgress(g) >= 100) return false;
                recs.push({
                    id: "goal-" + g.id,
                    icon: "ti-target-arrow",
                    text: `"${g.title}" is due ${core.dayLabel(g.date).toLowerCase()} and has no session planned in the next few days.`,
                    action: "Plan next session",
                    run: () => core.planGoalSessions(g)
                });
                return true;
            });

        // 4. A real free window + a real task that fits it
        if (now < 21 * 60) {
            const gap = core.freeWindows(t, now + 10, 22 * 60, 45)[0];
            if (gap) {
                const ctx = core.priorityCtx();
                const candidates = window.PlanoraPriority.rank(tasks.filter(x => {
                    if (x.completed || !x.date) return false;
                    const dur = core.taskDuration(x);
                    if (dur > gap.minutes) return false;
                    if (x.date === t && !x.start) return true;                                     // today, no time yet
                    const d = window.PlanoraPriority.daysBetween(t, x.date);
                    if (d >= 1 && d <= 3 && (x.deadline || x.goalId || x.priority === "high")) return true; // due soon
                    return false;
                }), ctx);
                const pick = candidates.find(c => !recs.some(r => r.id === "morning" && r.text.includes(c.title)));
                if (pick) {
                    const when = core.time12(core.toClock(gap.start));
                    const why = pick.deadline
                        ? `"${pick.title}" is ${core.reasonFor(pick).toLowerCase()}.`
                        : pick.date === t ? `"${pick.title}" doesn't have a time yet.` : `You could get ahead on "${pick.title}".`;
                    recs.push({
                        id: "window",
                        icon: "ti-clock-hour-4",
                        text: `You have ${gap.minutes >= 60 ? core.durLabel(Math.min(gap.minutes, 240)).replace(/^(\d+)h$/, "$1-hour") : gap.minutes + " minutes"} free at ${when}. ${why} Want me to schedule it?`,
                        action: "Plan it",
                        run: () => reschedule([pick], t, "Plan it", gap.start)
                    });
                }
            }
        }
        return recs.slice(0, 2);
    }

    // Dismissed suggestions stay dismissed for the rest of the day (no nagging)
    const DISMISS_KEY = "planora_dismissed_recs";
    const dismissed = (() => {
        const saved = C().loadJSON(DISMISS_KEY, {});
        return new Set(saved && saved.date === C().today() ? saved.ids || [] : []);
    })();
    function saveDismissed() {
        C().saveJSON(DISMISS_KEY, { date: C().today(), ids: Array.from(dismissed) });
    }

    async function reschedule(list, date, label, startMin) {
        const core = C();
        try {
            const placed = await core.scheduleItems(list.map(x => ({
                sourceId: x.id,
                title: x.title,
                date,
                start: startMin != null ? core.toClock(startMin) : (date === core.today() ? "" : x.start || ""),
                duration: core.taskDuration(x),
                flexible: startMin == null
            })), { excludeIds: list.map(x => x.id) });
            const byId = {};
            list.forEach(x => { byId[String(x.id)] = x; });
            const updates = placed.map(p => {
                const o = byId[p.sourceId] || {};
                return { id: p.sourceId, title: p.title, date: p.date, start: p.start, end: p.end, duration: p.duration, notes: p.notes, from: { date: o.date, start: o.start, end: o.end } };
            });
            core.openPlanPreview({ tasks: [], goals: [], updates }, { title: label, intro: "Here's what will change. Nothing moves until you confirm." });
        } catch (error) {
            core.toast(error.message || "Planora couldn't plan that right now. Your tasks are safe.", "error");
        }
    }

    let recActions = {};

    function renderRecs() {
        const el = $("home-recs");
        if (!el) return;
        const recs = recommendations().filter(r => !dismissed.has(r.id));
        recActions = {};
        el.innerHTML = recs.map(r => {
            if (r.run) recActions[r.id] = r.run;
            return `
            <div class="rec-card" role="note">
                <i class="ti ${r.icon} rec-icon" aria-hidden="true"></i>
                <p>${C().esc(r.text)}</p>
                <div class="rec-actions">
                    ${r.action ? `<button type="button" class="btn-primary rec-go" data-rec="${r.id}">${C().esc(r.action)}</button>` : ""}
                    ${r.secondary ? `<button type="button" class="btn-ghost" data-dismiss="${r.id}">${C().esc(r.secondary)}</button>`
                                  : `<button type="button" class="rec-x" data-dismiss="${r.id}" aria-label="Dismiss suggestion"><i class="ti ti-x" aria-hidden="true"></i></button>`}
                </div>
            </div>`;
        }).join("");
    }


    /* ---------------- schedule empty state + title ---------------- */

    function renderScheduleEmpty() {
        const core = C();
        const el = $("schedule-empty");
        if (!el || typeof selectedDate === "undefined") return;
        const day = selectedDate || core.today();
        const visible = core.getTasks().filter(x => x.date === day).length + (core.getEvents ? core.getEvents().filter(x => x.date === day).length : 0);
        const isToday = day === core.today();
        const title = $("schedule-title");
        if (title) title.textContent = isToday ? "Today's schedule" : core.dayLabel(day);
        el.hidden = visible > 0;
        if (visible) return;
        const brandNew = !core.getTasks().length;   // the first-day card already offers help
        el.innerHTML = brandNew
            ? `<p>Nothing scheduled yet.</p>`
            : isToday
            ? `<p><strong>You have a clear day.</strong><br>Want Planora to help you plan it?</p>
               <div class="empty-actions"><button type="button" class="btn-primary" data-empty="plan">Plan my day</button><button type="button" class="btn-secondary" data-quick-add-empty>Add a task</button></div>`
            : `<p>Nothing planned for ${core.esc(core.dayLabel(day))}.</p>
               <div class="empty-actions"><button type="button" class="btn-secondary" data-quick-add-empty>Add a task</button></div>`;
    }

    /* Events in Today's schedule: same box, calendar icon, no checkbox */
    function renderScheduleEvents(forDay) {
        const core = C();
        const list = $("task-list");
        if (!list || !core.getEvents) return;
        list.querySelectorAll(".event-item").forEach(el => el.remove());
        const day = forDay || (typeof selectedDate !== "undefined" && selectedDate) || core.today();
        core.getEvents().filter(e => e.date === day).forEach(ev => {
            const cat = core.eventColor ? core.eventColor(ev) : (core.categoryInfo(ev.category) || core.categoryInfo("other"));
            const item = document.createElement("div");
            item.className = "task-item event-item";
            item.dataset.date = ev.date;
            item.dataset.start = ev.start;
            item.dataset.end = ev.end;
            item.dataset.eventId = ev.id;
            item.style.setProperty("--c", cat ? cat.color : "#7F77DD");
            item.style.setProperty("--s", cat ? cat.soft : "#EEEDFE");
            item.innerHTML = `
                <div class="task-open" role="button" tabindex="0" aria-label="Event: ${core.esc(ev.title)}, ${core.esc(core.time12(ev.start))} to ${core.esc(core.time12(ev.end))}">
                    <p class="t-title"><span class="kind-tag"><i class="ti ti-calendar-event" aria-hidden="true"></i>Event</span>${core.esc(ev.title)}${ev.seriesId ? ' <i class="ti ti-repeat t-repeat" aria-label="Repeats"></i>' : ""}</p>
                    <p class="t-time">${core.esc(core.time12(ev.start))} - ${core.esc(core.time12(ev.end))}${ev.location ? " · " + core.esc(ev.location) : ""}</p>
                </div>
                <div class="task-actions">
                    <button type="button" class="task-edit-btn event-edit-btn" aria-label="Edit event"><i class="ti ti-edit"></i></button>
                </div>`;
            const open = () => core.openEventSheet(ev.id);
            item.querySelector(".task-open").addEventListener("click", open);
            item.querySelector(".task-open").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
            item.querySelector(".event-edit-btn").addEventListener("click", () => core.openEventForm({ editId: ev.id }));
            list.appendChild(item);
        });
        // one timeline: events and tasks in time order (no time last)
        const rows = Array.from(list.children).filter(el => el.classList.contains("task-item"));
        rows.sort((a, b) => ((a.dataset.date || "") + (a.dataset.start || "99:99")).localeCompare((b.dataset.date || "") + (b.dataset.start || "99:99")))
            .forEach(el => list.appendChild(el));
    }

    /* ---------------- Ask Planora pop-up (the Planora button) ---------------- */

    let askReturnFocus = null;
    function openAsk() {
        const pop = $("ask-pop");
        if (!pop) return;
        if (pop.hidden) {
            askReturnFocus = document.activeElement;
            pop.hidden = false;
            document.body.classList.add("ask-open");
            const btn = $("open-ask");
            if (btn) btn.setAttribute("aria-expanded", "true");
        }
        setTimeout(() => { const i = pop.querySelector(".sp-input"); if (i && window.innerWidth > 700) i.focus(); }, 30);
    }
    function closeAsk() {
        const pop = $("ask-pop");
        if (!pop || pop.hidden) return;
        pop.hidden = true;
        document.body.classList.remove("ask-open", "sp-reviewing");
        const btn = $("open-ask");
        if (btn) btn.setAttribute("aria-expanded", "false");
        if (askReturnFocus && askReturnFocus.focus) askReturnFocus.focus();
    }
    // Anything on Home that talks to Planora (first day, "What should I do now?",
    // recommendations, goals) opens the pop-up first, so the answer is never hidden.
    function wireAskPopup() {
        const ask = window.PlanoraAsk;
        if (!ask || ask._popup) return;
        ["send", "showPlan", "planForGoal", "fill"].forEach(fn => {
            const orig = ask[fn];
            if (typeof orig !== "function") return;
            ask[fn] = function () { openAsk(); return orig.apply(this, arguments); };
        });
        ask._popup = true;
        document.addEventListener("keydown", e => {
            if (e.key !== "Escape") return;
            const pop = $("ask-pop");
            if (!pop || pop.hidden || document.getElementById("planora-sheet") || document.getElementById("focus-mode")) return;
            e.preventDefault();
            closeAsk();
        });
    }
    window.PlanoraHomeAsk = { open: openAsk, close: closeAsk };

    function patchScheduleFunctions() {
        if (typeof window.showTasksForDate === "function" && !window.showTasksForDate._planora) {
            const orig = window.showTasksForDate;
            window.showTasksForDate = function () {
                try { renderScheduleEvents(arguments[0]); } catch (e) { console.error(e); }
                const r = orig.apply(this, arguments);
                renderScheduleEmpty();
                return r;
            };
            window.showTasksForDate._planora = true;
        }
        if (typeof window.updateScheduleTitle === "function" && !window.updateScheduleTitle._planora) {
            const orig = window.updateScheduleTitle;
            window.updateScheduleTitle = function () {
                const r = orig.apply(this, arguments);
                renderScheduleEmpty();
                return r;
            };
            window.updateScheduleTitle._planora = true;
        }
    }


    /* ---------------- journal nudge ---------------- */

    function renderJournalNudge() {
        const el = $("journal-nudge");
        if (!el) return;
        const core = C();
        const journals = core.loadJSON("planora_journals", []);
        const todayEntry = (Array.isArray(journals) ? journals : []).find(j => j && j.date === core.today());
        const written = todayEntry && ((todayEntry.content || "").trim() || todayEntry.mood || (todayEntry.wins || []).length);
        // Always a way into the Journal (phones have no Journal tab), but not on day one
        el.hidden = false;                       // always on Home: it's the way into the Journal on phones
        const text = el.querySelector("span");
        if (text) text.innerHTML = written
            ? "<strong>You've written in your journal today.</strong><br>Open your journal"
            : "<strong>How are you feeling today?</strong><br>Take a minute to write in your journal.";
    }


    /* ---------------- first day ---------------- */

    function wireFirstDay() {
        const card = $("first-day");
        if (!card) return;
        const btn = $("first-day-plan");
        const update = () => {
            const n = card.querySelectorAll("input:checked").length;
            btn.disabled = n === 0;
            btn.textContent = n ? `Plan ${n === 1 ? "this" : "these " + n} for me` : "Plan these for me";
        };
        card.addEventListener("change", update);
        btn.addEventListener("click", () => {
            const picks = Array.from(card.querySelectorAll("input:checked")).map(i => i.value.toLowerCase());
            if (!picks.length || !window.PlanoraAsk) return;
            const text = picks.length === 1 ? picks[0] : picks.slice(0, -1).join(", ") + " and " + picks[picks.length - 1];
            window.PlanoraAsk.send(`${text.charAt(0).toUpperCase() + text.slice(1)} today`);
        });
    }


    /* ---------------- render all ---------------- */

    function refreshLists() {
        try {
            if (typeof renderStoreTasksToDOM === "function") renderStoreTasksToDOM();
            if (typeof generateWeekCalendar === "function") generateWeekCalendar();
            if (typeof window.showTasksForDate === "function") window.showTasksForDate(typeof selectedDate !== "undefined" ? selectedDate : null);
        } catch (e) { console.error(e); }
    }

    function render() {
        renderHeader();
        renderWorkload();
        renderFocus();
        renderRecs();
        renderScheduleEmpty();
        renderJournalNudge();
    }

    let timer = null;
    function scheduleRender(withLists) {
        clearTimeout(timer);
        timer = setTimeout(() => { if (withLists) refreshLists(); render(); }, 40);
    }

    function start() {
        if (!$("home-focus")) return;
        patchScheduleFunctions();
        wireAskPopup();
        // show events in Today's schedule from the first paint
        try { if (typeof window.showTasksForDate === "function") window.showTasksForDate((typeof selectedDate !== "undefined" && selectedDate) || C().today()); } catch (e) { console.error(e); }
        wireFirstDay();

        document.addEventListener("click", e => {
            // only real Start buttons (task boxes also carry data-start = their start time)
            const start = e.target.closest("button[data-start]");
            if (start && window.PlanoraFocus) { PlanoraFocus.start(start.dataset.start, Number(start.dataset.minutes) || undefined); return; }
            const openT = e.target.closest("[data-open]");
            if (openT) { C().openTaskSheet(openT.dataset.open); return; }
            if (e.target.closest("#btn-what-now")) {
                if (window.PlanoraAsk) window.PlanoraAsk.send("What should I do now?");
                return;
            }
            if (e.target.closest("#open-ask")) { openAsk(); return; }
            if (e.target.closest("#ask-pop-close")) { closeAsk(); return; }
            if (e.target.id === "ask-pop") { closeAsk(); return; }
            if (e.target.closest("#btn-review")) { C().openDailyReview(); return; }
            if (e.target.closest("#btn-optimize")) {
                const b = $("btn-optimize");
                b.disabled = true;
                C().optimizeDay().catch(err => C().toast(err.message || "Planora couldn't do that right now. Your existing tasks are safe.", "error")).finally(() => { b.disabled = false; });
                return;
            }
            if (e.target.closest("[data-plan-rest]") && window.PlanoraAsk) {
                const tomorrow = !C().getTasks().some(x => x.date === C().today() && !x.completed);
                window.PlanoraAsk.send(tomorrow ? "Plan tomorrow" : "Plan my day");
                return;
            }
            const done = e.target.closest("[data-done]");
            if (done) {
                C().updateTask(done.dataset.done, { completed: true });
                C().toast("Nice. One down. ✅", "success");
                scheduleRender(true);
                return;
            }
            const rec = e.target.closest("[data-rec]");
            if (rec && recActions[rec.dataset.rec]) { recActions[rec.dataset.rec](); return; }
            const dis = e.target.closest("[data-dismiss]");
            if (dis) { dismissed.add(dis.dataset.dismiss); saveDismissed(); renderRecs(); return; }
            if (e.target.closest("[data-empty=plan]") && window.PlanoraAsk) {
                window.PlanoraAsk.send("Plan my day");
                return;
            }
            if (e.target.closest("[data-quick-add-empty]")) C().quickAdd();
        });

        // Anything that changes tasks/goals (this page, Planora, the add/edit window) re-renders Home
        document.addEventListener("planora:data-changed", () => scheduleRender(true));
        document.addEventListener("planora:plan-added", () => scheduleRender(true));
        const raw = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
            raw.call(this, k, v);
            if (k === "planora_tasks" || k === "planora_goals") scheduleRender(false);
        };
        window.addEventListener("storage", e => { if (e.key === "planora_tasks") scheduleRender(true); });

        render();
        // keep "now"-based text fresh
        setInterval(render, 5 * 60 * 1000);
    }

    window.PlanoraHome = { render, sentence };

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();

})();
