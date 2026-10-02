/* =========================================================
   PLANORA CALENDAR — MONTH · WEEK · DAY  (calendar-views.js)

   Google Calendar-style navigation on top of Planora's own data:
   - [‹] [Today] [›]  ·  date range (tap for a date picker)  ·  [Month][Week][Day]
   - Week / Day: time grid, current-time line, tasks and events at their times
   - Drag to move (up/down = time, sideways = day), drag the bottom edge to resize,
     15-minute snapping, Undo after every change
   - Click an empty slot to create a Task or an Event with the time filled in
   - Month: Mon–Sun grid, compact items, "+N more", tap a day to open it

   Tasks keep their checkbox and white card; events have a calendar icon,
   a soft colour and no checkbox. Uses the shared stores in planora-core.js,
   so Home, Ask Planora and search see the same data.
   ========================================================= */

(function () {

    const C = () => window.PlanoraCore;
    const VIEW_KEY = "planora-calendar-view";          // remembered on this device
    const HOUR = 48;                                   // px per hour in the time grid
    const SNAP = 15;                                   // minutes
    const DEVICE = () => (window.PlanoraDevice && PlanoraDevice.kind) || (window.innerWidth < 700 ? "phone" : "desktop");
    const isPhone = () => window.matchMedia("(max-width: 699px)").matches;

    const state = {
        view: null,
        date: null,          // the selected day (YYYY-MM-DD)
        pickerMonth: null
    };

    /* ---------------- dates ---------------- */
    const parse = ds => new Date(ds + "T00:00:00");
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    function mondayOf(ds) { const d = parse(ds); return C().addDays(ds, -((d.getDay() + 6) % 7)); }
    function monthStart(ds) { return ds.slice(0, 8) + "01"; }
    function addMonths(ds, n) {
        const d = parse(ds); const day = d.getDate();
        d.setDate(1); d.setMonth(d.getMonth() + n);
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        d.setDate(Math.min(day, last));
        return iso(d);
    }
    const fmt = (ds, o) => parse(ds).toLocaleDateString(undefined, o);

    function rangeLabel() {
        const ds = state.date;
        if (state.view === "day") return fmt(ds, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
        if (state.view === "month") return fmt(ds, { month: "long", year: "numeric" });
        const a = mondayOf(ds), b = C().addDays(a, 6);
        const sameYear = a.slice(0, 4) === b.slice(0, 4);
        return `${fmt(a, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })} – ${fmt(b, { month: "short", day: "numeric", year: "numeric" })}`;
    }

    /* ---------------- data ---------------- */
    function itemsFor(from, to) {
        const core = C();
        const tasks = core.getTasks().filter(t => t.date && t.date >= from && t.date <= to).map(t => ({ kind: "task", id: String(t.id), raw: t, date: t.date, start: t.start || "", dur: core.taskDuration(t), title: t.title }));
        const events = core.getEvents().filter(e => e.date >= from && e.date <= to).map(e => ({ kind: "event", id: String(e.id), raw: e, date: e.date, start: e.start, dur: core.eventDuration(e), title: e.title }));
        return tasks.concat(events);
    }
    function colorOf(it) {
        const core = C();
        if (it.kind === "task") return core.taskColor ? core.taskColor(it.raw) : { color: "#7F77DD", soft: "#EEEDFE", label: "" };
        if (it.kind === "event" && core.eventColor) return core.eventColor(it.raw);
        const c = core.categoryInfo(it.kind === "event" ? (it.raw.category || core.categoryOf(it.raw)) : it.raw.category);
        return c || { color: "#7F77DD", soft: "#EEEDFE", label: "" };
    }

    /* ---------------- toolbar ---------------- */
    function renderToolbar() {
        const bar = document.getElementById("cal-toolbar");
        if (!bar) return;
        const views = [["month", "Month"], ["week", "Week"], ["day", "Day"]];
        bar.innerHTML = `
            <div class="cv-nav" role="group" aria-label="Move through the calendar">
                <button type="button" class="cv-btn cv-arrow" data-nav="prev" aria-label="Previous ${state.view}" title="Previous (P)"><i class="ti ti-chevron-left" aria-hidden="true"></i></button>
                <button type="button" class="cv-btn cv-today" data-nav="today" title="Today (T)">Today</button>
                <button type="button" class="cv-btn cv-arrow" data-nav="next" aria-label="Next ${state.view}" title="Next (N)"><i class="ti ti-chevron-right" aria-hidden="true"></i></button>
            </div>
            <button type="button" class="cv-range" data-picker aria-haspopup="dialog" aria-expanded="false" title="Jump to a date">
                <span id="cv-range-label">${C().esc(rangeLabel())}</span><i class="ti ti-chevron-down" aria-hidden="true"></i>
            </button>
            <div class="cv-switch" role="tablist" aria-label="Calendar view">
                ${views.map(([v, l]) => `<button type="button" role="tab" data-view="${v}" aria-selected="${state.view === v}" id="cv-tab-${v}">${l}</button>`).join("")}
            </div>`;
    }

    /* ---------------- date picker ---------------- */
    function openPicker() {
        closePicker();
        const anchor = document.querySelector(".cv-range");
        if (!anchor) return;
        state.pickerMonth = monthStart(state.date);
        const pop = document.createElement("div");
        pop.className = "cv-picker";
        pop.setAttribute("role", "dialog");
        pop.setAttribute("aria-label", "Choose a date");
        document.body.appendChild(pop);
        anchor.setAttribute("aria-expanded", "true");
        drawPicker();
        const r = anchor.getBoundingClientRect();
        const w = 280;
        pop.style.top = (window.scrollY + r.bottom + 6) + "px";
        pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
        pop.addEventListener("click", e => {
            e.stopPropagation();
            const b = e.target.closest("[data-p]");
            if (!b) return;
            const a = b.dataset.p;
            if (a === "prev") { state.pickerMonth = addMonths(state.pickerMonth, -1); drawPicker(); }
            else if (a === "next") { state.pickerMonth = addMonths(state.pickerMonth, 1); drawPicker(); }
            else if (a === "today") { closePicker(); go(C().today()); }
            else if (a === "day") { closePicker(); go(b.dataset.date); }
        });
        setTimeout(() => { const cur = pop.querySelector(".is-selected") || pop.querySelector("[data-p=day]"); cur && cur.focus(); }, 10);
    }
    function drawPicker() {
        const pop = document.querySelector(".cv-picker");
        if (!pop) return;
        const m = state.pickerMonth;
        const first = mondayOf(m);
        const t = C().today();
        let cells = "";
        for (let i = 0; i < 42; i++) {
            const d = C().addDays(first, i);
            const cls = [d.slice(0, 7) !== m.slice(0, 7) ? "is-out" : "", d === t ? "is-today" : "", d === state.date ? "is-selected" : ""].filter(Boolean).join(" ");
            cells += `<button type="button" data-p="day" data-date="${d}" class="${cls}" aria-label="${C().esc(fmt(d, { weekday: "long", month: "long", day: "numeric", year: "numeric" }))}">${Number(d.slice(8))}</button>`;
        }
        pop.innerHTML = `
            <div class="cvp-head">
                <button type="button" data-p="prev" aria-label="Previous month"><i class="ti ti-chevron-left" aria-hidden="true"></i></button>
                <strong>${C().esc(fmt(m, { month: "long", year: "numeric" }))}</strong>
                <button type="button" data-p="next" aria-label="Next month"><i class="ti ti-chevron-right" aria-hidden="true"></i></button>
            </div>
            <div class="cvp-dow">${["M", "T", "W", "T", "F", "S", "S"].map(x => `<span>${x}</span>`).join("")}</div>
            <div class="cvp-grid">${cells}</div>
            <button type="button" class="cvp-today" data-p="today">Today</button>`;
    }
    function closePicker() {
        const p = document.querySelector(".cv-picker");
        if (p) p.remove();
        const a = document.querySelector(".cv-range");
        if (a) a.setAttribute("aria-expanded", "false");
    }

    /* ---------------- navigation ---------------- */
    function setView(v, { save = true } = {}) {
        if (!["month", "week", "day"].includes(v)) v = "week";
        state.view = v;
        if (save) { try { localStorage.setItem(VIEW_KEY, v); } catch {} }
        render();
    }
    function go(ds) { state.date = ds; syncLegacy(); render(); }
    function step(dir) {
        const ds = state.date;
        if (state.view === "month") go(addMonths(ds, dir));
        else if (state.view === "week") go(C().addDays(ds, 7 * dir));
        else go(C().addDays(ds, dir));
    }
    // the older calendar code (edit modal etc.) follows the selected day
    function syncLegacy() {
        try { window.PlanoraCalendarDate = state.date; if (typeof selectedDate !== "undefined") selectedDate = state.date; } catch {}   // eslint-disable-line no-global-assign
    }
    function refreshLegacy() {
        try {
            if (typeof loadTaskStore === "function" && typeof tasks !== "undefined") {
                tasks = loadTaskStore();   // eslint-disable-line no-global-assign
                if (typeof renderCalendar === "function") renderCalendar();
                if (typeof renderSelectedTasks === "function") renderSelectedTasks();
            }
        } catch (e) { console.error(e); }
    }

    /* ---------------- render ---------------- */
    let scrollMemo = null;
    function render() {
        const host = document.getElementById("cal-view");
        if (!host) return;
        const oldScroll = host.querySelector(".tg-scroll");
        if (oldScroll) scrollMemo = { top: oldScroll.scrollTop, left: oldScroll.scrollLeft, view: state.view, key: host.dataset.key };
        renderToolbar();
        host.className = "cal-view is-" + state.view;
        if (state.view === "month") renderMonth(host);
        else renderGrid(host, state.view === "day" ? [state.date] : Array.from({ length: 7 }, (_, i) => C().addDays(mondayOf(state.date), i)));
        const tab = document.getElementById("cv-tab-" + state.view);
        if (tab) host.setAttribute("aria-labelledby", tab.id);
    }

    /* ---------- month ---------- */
    function renderMonth(host) {
        const core = C();
        const m = monthStart(state.date);
        const first = mondayOf(m);
        const lastDay = C().addDays(addMonths(m, 1), -1);
        const weeks = Math.ceil((((parse(m).getDay() + 6) % 7) + Number(lastDay.slice(8))) / 7);
        const days = Array.from({ length: weeks * 7 }, (_, i) => C().addDays(first, i));
        const all = itemsFor(days[0], days[days.length - 1]);
        const t = core.today();
        const phone = isPhone();
        const max = phone ? 0 : 3;
        host.dataset.key = "month";
        host.innerHTML = `
            <div class="mv" role="grid" aria-label="${core.esc(fmt(m, { month: "long", year: "numeric" }))}">
                <div class="mv-dow" role="row">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(x => `<span role="columnheader">${phone ? x[0] : x}</span>`).join("")}</div>
                <div class="mv-grid" style="--weeks:${weeks}">
                    ${days.map(d => {
                        const list = all.filter(x => x.date === d).sort((a, b) => (a.start || "99").localeCompare(b.start || "99") || (a.kind === "event" ? -1 : 1));
                        const shown = list.slice(0, max);
                        const more = list.length - shown.length;
                        const cls = ["mv-day", d.slice(0, 7) !== m.slice(0, 7) ? "is-out" : "", d === t ? "is-today" : "", d === state.date ? "is-selected" : ""].filter(Boolean).join(" ");
                        return `
                        <div class="${cls}" role="gridcell" data-day="${d}">
                            <button type="button" class="mv-num" data-open-day="${d}" aria-label="${core.esc(fmt(d, { weekday: "long", month: "long", day: "numeric" }))}${list.length ? `, ${list.length} item${list.length === 1 ? "" : "s"}` : ""}">${Number(d.slice(8))}</button>
                            ${phone ? (list.length ? `<div class="mv-dots" aria-hidden="true">${list.slice(0, 4).map(x => `<i class="${x.kind === "event" ? "is-event" : "is-task"}${x.raw.completed ? " is-done" : ""}" style="--c:${colorOf(x).color}"></i>`).join("")}${list.length > 4 ? `<b>+${list.length - 4}</b>` : ""}</div>` : "") :
                            shown.map(x => chip(x)).join("") + (more > 0 ? `<button type="button" class="mv-more" data-open-day="${d}">+${more} more</button>` : "")}
                        </div>`;
                    }).join("")}
                </div>
            </div>`;
    }
    function chip(x) {
        const core = C();
        const c = colorOf(x);
        const time = x.start ? core.time12(x.start).replace(":00", "").replace(" ", "").toLowerCase() : "";
        if (x.kind === "event") {
            return `<button type="button" class="mv-item is-event" data-open-event="${core.esc(x.id)}" style="--c:${c.color};--s:${c.soft}" title="Event: ${core.esc(x.title)}"><i class="ti ti-calendar-event" aria-hidden="true"></i><span class="t">${time ? `<b>${core.esc(time)}</b> ` : ""}${core.esc(x.title)}</span><span class="sr-only"> (event)</span></button>`;
        }
        const g = goalLabel(x);
        return `<button type="button" class="mv-item is-task${x.raw.completed ? " is-done" : ""}" data-open-task="${core.esc(x.id)}" style="--c:${c.color}" title="Task: ${core.esc(x.title)}${g ? " · " + core.esc(g.text) : ""}"><i class="ti ${x.raw.completed ? "ti-square-check" : "ti-square"}" aria-hidden="true"></i><span class="t">${time ? `<b>${core.esc(time)}</b> ` : ""}${core.esc(x.title)}</span><span class="sr-only"> (task${x.raw.completed ? ", done" : ""})</span></button>`;
    }

    /* ---------- week / day time grid ---------- */
    function lanes(list) {
        const items = list.map(it => { const s = C().toMin(it.start); return { it, s, e: s + Math.max(SNAP, it.dur) }; })
            .sort((a, b) => a.s - b.s || b.e - a.e);
        const groups = [];
        items.forEach(x => {
            let g = groups.length ? groups[groups.length - 1] : null;
            if (!g || g.end <= x.s) { g = { end: x.e, items: [] }; groups.push(g); }
            g.end = Math.max(g.end, x.e);
            g.items.push(x);
        });
        groups.forEach(g => {
            const cols = [];
            g.items.forEach(x => {
                let c = cols.findIndex(end => end <= x.s);
                if (c === -1) { c = cols.length; cols.push(0); }
                cols[c] = x.e;
                x.col = c;
            });
            g.items.forEach(x => { x.cols = cols.length; });
        });
        return items;
    }

    function renderGrid(host, days) {
        const core = C();
        const t = core.today();
        const all = itemsFor(days[0], days[days.length - 1]);
        const phone = isPhone();
        const single = days.length === 1;
        const key = days.join(",");
        host.dataset.key = key;
        const hours = Array.from({ length: 24 }, (_, h) => h);
        const label = h => h === 0 ? "" : `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;

        host.innerHTML = `
            <div class="tg-scroll" tabindex="-1">
                <div class="tg ${single ? "is-day" : "is-week"}" style="--hour:${HOUR}px;--days:${days.length};--colmin:${single ? 0 : phone ? (DEVICE() === "tablet" ? 76 : 104) : 0}px">
                    <div class="tg-corner"><span>Anytime</span></div>
                    ${days.map(d => {
                        const untimed = all.filter(x => x.date === d && core.toMin(x.start) === null);
                        return `
                        <div class="tg-head${d === t ? " is-today" : ""}${d === state.date && !single ? " is-selected" : ""}" data-head="${d}">
                            <button type="button" class="tg-date" data-open-day="${d}" aria-label="Open ${core.esc(fmt(d, { weekday: "long", month: "long", day: "numeric" }))}">
                                <span class="dow">${core.esc(fmt(d, { weekday: "short" }))}</span><span class="num">${Number(d.slice(8))}</span>
                            </button>
                            <div class="tg-allday" data-allday="${d}">${untimed.map(x => allDayChip(x)).join("")}</div>
                        </div>`;
                    }).join("")}
                    <div class="tg-gutter" aria-hidden="true">${hours.map(h => `<span style="top:${h * HOUR}px">${label(h)}</span>`).join("")}</div>
                    ${days.map(d => {
                        const timed = all.filter(x => x.date === d && core.toMin(x.start) !== null);
                        return `<div class="tg-col${d === t ? " is-today" : ""}" data-col="${d}" role="group" aria-label="${core.esc(fmt(d, { weekday: "long", month: "long", day: "numeric" }))}">
                            ${lanes(timed).map(x => block(x.it, x, single)).join("")}
                        </div>`;
                    }).join("")}
                </div>
            </div>
            ${all.length ? "" : `<p class="tg-empty">${single ? "Nothing planned for this day." : "Nothing planned this week."} Click a time to add a task or event.</p>`}`;

        sizeScroll();
        drawNow();
        const sc = host.querySelector(".tg-scroll");
        if (scrollMemo && scrollMemo.view === state.view) {
            sc.scrollTop = scrollMemo.top;
            if (scrollMemo.key === key) sc.scrollLeft = scrollMemo.left;
        } else {
            // start around 8 AM, or an hour before now when today is on screen
            const nowIn = days.includes(t);
            const firstTimed = all.filter(x => core.toMin(x.start) !== null).map(x => core.toMin(x.start)).sort((a, b) => a - b)[0];
            const visible = Math.max(4, (sc.clientHeight - 80) / HOUR) * 60;     // minutes on screen
            let target = 8 * 60;                                                   // 8 AM by default
            if (firstTimed !== undefined && firstTimed < 8 * 60) target = Math.max(0, firstTimed - 30);
            if (nowIn && core.nowMin() > target + visible - 60) target = Math.max(0, core.nowMin() - 120);
            sc.scrollTop = target / 60 * HOUR;
            if (phone && !single) {
                const idx = days.indexOf(state.date);
                if (idx > 0 && DEVICE() !== "tablet") sc.scrollLeft = Math.max(0, idx * 104 - 20);
            }
        }
        scrollMemo = null;
    }

    function allDayChip(x) {
        const core = C();
        const c = colorOf(x);
        if (x.kind === "event") return `<button type="button" class="ad-item is-event" data-open-event="${core.esc(x.id)}" style="--c:${c.color};--s:${c.soft}"><i class="ti ti-calendar-event" aria-hidden="true"></i><span>${core.esc(x.title)}</span></button>`;
        return `<div class="ad-item is-task${x.raw.completed ? " is-done" : ""}" data-drag="task" data-id="${core.esc(x.id)}" data-dur="${x.dur}" style="--c:${c.color}">
            <button type="button" class="blk-check" data-check="${core.esc(x.id)}" aria-label="${x.raw.completed ? "Mark not done" : "Complete"}: ${core.esc(x.title)}"><i class="ti ti-check" aria-hidden="true"></i></button>
            <button type="button" class="ad-open" data-open-task="${core.esc(x.id)}">${core.esc(x.title)} <small>${core.esc(core.durLabel(x.dur))}</small></button>
        </div>`;
    }

    function block(it, pos, single) {
        const core = C();
        const s = pos.s, e = pos.e;
        const top = s / 60 * HOUR;
        const h = Math.max(20, (e - s) / 60 * HOUR - 2);
        const w = 100 / pos.cols;
        const c = colorOf(it);
        const endClock = core.toClock(Math.min(24 * 60 - 1, s + it.dur));
        const time = `${core.time12(it.start)} – ${core.time12(endClock)}`;
        const short = h < 34;
        const style = `top:${top}px;height:${h}px;left:calc(${pos.col * w}% + 1px);width:calc(${w}% - 3px);--c:${c.color};--s:${c.soft}`;
        const series = it.raw.seriesId;
        const g = goalLabel(it);
        const extra = [g ? g.text : "", single ? c.label : "", single && it.kind === "event" && it.raw.location ? it.raw.location : "", single && it.kind === "task" && it.raw.priority === "high" ? "High priority" : ""].filter(Boolean).join(" · ");
        if (it.kind === "event") {
            return `
            <div class="blk is-event${short ? " is-short" : ""}" data-drag="event" data-id="${core.esc(it.id)}" data-dur="${it.dur}" style="${style}">
                <button type="button" class="blk-body" data-open-event="${core.esc(it.id)}" aria-label="Event: ${core.esc(it.title)}, ${core.esc(time)}">
                    <span class="blk-title"><i class="ti ti-calendar-event" aria-hidden="true"></i>${core.esc(it.title)}${series ? ' <i class="ti ti-repeat" aria-hidden="true"></i>' : ""}</span>
                    <span class="blk-time">${core.esc(time)}${extra ? " · " + core.esc(extra) : ""}</span>
                </button>
                <span class="blk-resize" data-resize aria-hidden="true"></span>
            </div>`;
        }
        const done = Boolean(it.raw.completed);
        return `
            <div class="blk is-task${done ? " is-done" : ""}${short ? " is-short" : ""}${g ? " is-" + g.kind : ""}" data-drag="task" data-id="${core.esc(it.id)}" data-dur="${it.dur}" style="${style}">
                <button type="button" class="blk-check" data-check="${core.esc(it.id)}" aria-label="${done ? "Mark not done" : "Complete"}: ${core.esc(it.title)}"><i class="ti ti-check" aria-hidden="true"></i></button>
                <button type="button" class="blk-body" data-open-task="${core.esc(it.id)}" aria-label="Task: ${core.esc(it.title)}, ${core.esc(time)}${done ? ", done" : ""}">
                    <span class="blk-title">${core.esc(it.title)}${series ? ' <i class="ti ti-repeat" aria-hidden="true"></i>' : ""}</span>
                    <span class="blk-time">${core.esc(time)}${extra ? " · " + core.esc(extra) : ""}</span>
                </button>
                <span class="blk-resize" data-resize aria-hidden="true"></span>
            </div>`;
    }

    // goal sessions and study sessions say which goal they belong to
    function goalLabel(it) {
        if (it.kind !== "task" || !it.raw.goalId) return null;
        const goal = C().getGoal(it.raw.goalId);
        if (!goal) return null;
        const study = /exam|test|study|revis|quiz/i.test(goal.title + " " + it.title) || goal.source === "study-planner";
        return { kind: study ? "study" : "goal", text: `${study ? "Study" : "Goal"}: ${goal.title}` };
    }

    function sizeScroll() {
        const sc = document.querySelector("#cal-view .tg-scroll");
        if (!sc) return;
        const top = sc.getBoundingClientRect().top;
        const bottomNav = isPhone() ? 96 : 24;
        const h = Math.max(360, window.innerHeight - Math.max(top, 0) - bottomNav);
        sc.style.maxHeight = h + "px";
    }

    function drawNow() {
        document.querySelectorAll("#cal-view .tg-now").forEach(n => n.remove());
        const core = C();
        const col = document.querySelector(`#cal-view .tg-col[data-col="${core.today()}"]`);
        if (!col) return;
        const m = core.nowMin();
        const line = document.createElement("div");
        line.className = "tg-now";
        line.style.top = (m / 60 * HOUR) + "px";
        line.setAttribute("aria-hidden", "true");
        line.innerHTML = `<span>Now ${core.esc(core.time12(core.nowClock()))}</span>`;
        col.appendChild(line);
    }

    /* =========================================================
       Pointer interactions: drag · resize · click-to-create
       (mouse: press and move; touch: press and hold, then move)
       ========================================================= */

    let op = null;   // current operation

    function colAt(x, y) {
        const cols = Array.from(document.querySelectorAll("#cal-view .tg-col"));
        if (!cols.length) return null;
        let best = null;
        for (const c of cols) {
            const r = c.getBoundingClientRect();
            if (x >= r.left && x < r.right) { best = c; break; }
        }
        if (!best) {
            const r0 = cols[0].getBoundingClientRect(), rl = cols[cols.length - 1].getBoundingClientRect();
            best = x < r0.left ? cols[0] : x >= rl.right ? cols[cols.length - 1] : cols[0];
        }
        return best;
    }
    function minutesAt(col, y) {
        const r = col.getBoundingClientRect();
        return (y - r.top) / HOUR * 60;
    }
    const snap = m => Math.round(m / SNAP) * SNAP;
    const clampStart = (m, dur) => Math.max(0, Math.min(24 * 60 - Math.max(SNAP, Math.min(dur, 24 * 60 - SNAP)), m));

    function begin(kind, el, x, y, pointerType) {
        const core = C();
        const id = el.dataset.id;
        const type = el.dataset.drag;
        const raw = type === "event" ? core.getEvent(id) : core.getTasks().find(t => String(t.id) === id);
        if (!raw) return null;
        const col = el.closest(".tg-col");
        const startMin = core.toMin(raw.start);
        const dur = type === "event" ? core.eventDuration(raw) : core.taskDuration(raw);
        let grab = 0;
        if (col && startMin !== null) grab = minutesAt(col, y) - startMin;
        else grab = Math.min(15, dur / 2);
        return { kind, el, type, id, raw, dur, grab, x0: x, y0: y, active: false, pointerType, date: raw.date, start: startMin, newDate: raw.date, newStart: startMin, newDur: dur };
    }

    function activate() {
        op.active = true;
        op.el.classList.add("is-dragging");
        document.body.classList.add("cv-dragging");
        const ghost = document.createElement("div");
        ghost.className = `blk blk-ghost is-${op.type}`;
        ghost.style.setProperty("--c", op.el.style.getPropertyValue("--c") || "#7F77DD");
        ghost.style.setProperty("--s", op.el.style.getPropertyValue("--s") || "#EEEDFE");
        ghost.innerHTML = `<span class="blk-title"></span><span class="blk-time"></span>`;
        op.ghost = ghost;
        if (navigator.vibrate && op.pointerType === "touch") { try { navigator.vibrate(12); } catch {} }
    }

    function moveTo(x, y) {
        const core = C();
        autoScroll(x, y);
        const col = colAt(x, y);
        if (!col) return;
        if (op.kind === "resize") {
            const end = snap(minutesAt(col === op.el.closest(".tg-col") ? col : op.el.closest(".tg-col"), y));
            op.newDur = Math.max(SNAP, Math.min(24 * 60 - op.start, end - op.start));
            op.newDate = op.date;
            op.newStart = op.start;
        } else {
            op.newDate = col.dataset.col;
            op.newStart = clampStart(snap(minutesAt(col, y) - op.grab), op.dur);
            op.newDur = op.dur;
        }
        const g = op.ghost;
        const target = document.querySelector(`#cal-view .tg-col[data-col="${op.newDate}"]`);
        if (g.parentElement !== target) target.appendChild(g);
        g.style.top = (op.newStart / 60 * HOUR) + "px";
        g.style.height = Math.max(20, op.newDur / 60 * HOUR - 2) + "px";
        g.style.left = "1px"; g.style.width = "calc(100% - 3px)";
        g.querySelector(".blk-title").textContent = op.raw.title;
        g.querySelector(".blk-time").textContent = `${fmt(op.newDate, { weekday: "short" })} ${core.time12(core.toClock(op.newStart))} – ${core.time12(core.toClock(Math.min(24 * 60 - 1, op.newStart + op.newDur)))}`;
    }

    function autoScroll(x, y) {
        const sc = document.querySelector("#cal-view .tg-scroll");
        if (!sc) return;
        const r = sc.getBoundingClientRect();
        const edge = 24;
        if (y < r.top + edge) sc.scrollTop -= 8; else if (y > r.bottom - edge) sc.scrollTop += 8;
        if (x < r.left + 56 && sc.scrollLeft > 0) sc.scrollLeft -= 8; else if (x > r.right - edge) sc.scrollLeft += 8;
    }

    function finish(cancelled) {
        const o = op;
        op = null;
        document.body.classList.remove("cv-dragging");
        if (!o) return;
        if (o.el) o.el.classList.remove("is-dragging");
        if (o.ghost) o.ghost.remove();
        clearTimeout(o.hold);
        if (cancelled || !o.active) return;
        commit(o);
    }

    function commit(o) {
        const core = C();
        const changed = o.newDate !== o.date || o.newStart !== o.start || o.newDur !== o.dur;
        if (!changed) return;
        const start = core.toClock(o.newStart);
        const end = core.toClock(Math.min(24 * 60 - 1, o.newStart + o.newDur));
        const when = `${fmt(o.newDate, { weekday: "long" })} ${core.time12(start).replace(":00", "")}`;
        if (o.type === "task") {
            const before = { date: o.raw.date, start: o.raw.start || "", end: o.raw.end || "", duration: o.raw.duration };
            core.updateTask(o.id, { date: o.newDate, start, end, duration: o.newDur });
            const msg = o.kind === "resize"
                ? `${o.raw.title} is now ${core.durLabel(o.newDur)} (${core.time12(start)}–${core.time12(end)}).`
                : `Moved ${o.raw.title} to ${when}.`;
            core.toastUndo(msg, () => core.updateTask(o.id, before));
        } else {
            const before = { date: o.raw.date, start: o.raw.start, end: o.raw.end, detached: o.raw.detached };
            core.updateEvent(o.id, { date: o.newDate, start, end, ...(o.raw.seriesId ? { detached: true } : {}) });
            const msg = o.kind === "resize"
                ? `${o.raw.title} now ends at ${core.time12(end)}.`
                : `Moved ${o.raw.title} to ${when}${o.raw.seriesId ? " (this occurrence)" : ""}.`;
            core.toastUndo(msg, () => { const b = { ...before }; if (!b.detached) b.detached = false; core.updateEvent(o.id, b); });
        }
    }

    /* ---- slot click → create ---- */
    let slotGhost = null;
    function openSlot(col, y) {
        const core = C();
        const m = Math.max(0, Math.min(23 * 60 + 30, Math.floor(minutesAt(col, y) / 30) * 30));
        const date = col.dataset.col, start = core.toClock(m);
        showSlotGhost({ type: "task", title: "", date, start, end: core.toClock(m + 30) });
        core.openSlotCreate({ date, start });
    }
    function showSlotGhost(p) {
        const core = C();
        if (!p || !p.date || core.toMin(p.start) === null) return;
        const col = document.querySelector(`#cal-view .tg-col[data-col="${p.date}"]`);
        if (!slotGhost) { slotGhost = document.createElement("div"); }
        if (!col) { slotGhost.remove(); return; }
        const s = core.toMin(p.start);
        let e = core.toMin(p.end);
        if (e === null || e <= s) e = s + 30;
        slotGhost.className = `blk blk-ghost is-new is-${p.type}`;
        slotGhost.style.cssText = `top:${s / 60 * HOUR}px;height:${Math.max(20, (e - s) / 60 * HOUR - 2)}px;left:1px;width:calc(100% - 3px)`;
        slotGhost.innerHTML = `<span class="blk-title">${p.type === "event" ? '<i class="ti ti-calendar-event" aria-hidden="true"></i>' : ""}${core.esc(p.title || (p.type === "event" ? "(New event)" : "(New task)"))}</span><span class="blk-time">${core.esc(core.time12(p.start))} – ${core.esc(core.time12(core.toClock(e)))}</span>`;
        if (slotGhost.parentElement !== col) col.appendChild(slotGhost);
    }
    function clearSlotGhost() { if (slotGhost) { slotGhost.remove(); slotGhost = null; } }

    function onClick(e) {
        const core = C();
        if (e.target.closest(".cv-picker")) return;
        const nav = e.target.closest("[data-nav]");
        if (nav) { closePicker(); if (nav.dataset.nav === "today") go(core.today()); else step(nav.dataset.nav === "next" ? 1 : -1); return; }
        const vb = e.target.closest("[data-view]");
        if (vb && vb.closest("#cal-toolbar")) { closePicker(); setView(vb.dataset.view); return; }
        if (e.target.closest("[data-picker]")) { if (document.querySelector(".cv-picker")) closePicker(); else openPicker(); return; }
        if (document.querySelector(".cv-picker") && !e.target.closest(".cv-picker")) closePicker();
        if (!e.target.closest("#cal-view")) return;
        if (suppressClick) { suppressClick = false; e.preventDefault(); return; }
        const chk = e.target.closest("[data-check]");
        if (chk) {
            const t = core.getTasks().find(x => String(x.id) === chk.dataset.check);
            if (t) { core.updateTask(t.id, { completed: !t.completed }); core.toast(t.completed ? "Marked as not done." : `Done: ${t.title} ✅`, "success"); }
            return;
        }
        const ot = e.target.closest("[data-open-task]");
        if (ot) { core.openTaskSheet(ot.dataset.openTask); return; }
        const oe = e.target.closest("[data-open-event]");
        if (oe) { core.openEventSheet(oe.dataset.openEvent); return; }
        const od = e.target.closest("[data-open-day]");
        if (od) { state.date = od.dataset.openDay; syncLegacy(); setView("day"); return; }
        const cell = e.target.closest(".mv-day");
        if (cell) { state.date = cell.dataset.day; syncLegacy(); setView("day"); return; }
    }
    let suppressClick = false;

    /* mouse / pen */
    function onPointerDown(e) {
        if (e.pointerType === "touch" || e.button !== 0) return;
        const host = e.target.closest("#cal-view");
        if (!host) return;
        if (e.target.closest("[data-check]")) return;
        const rs = e.target.closest("[data-resize]");
        const el = e.target.closest("[data-drag]");
        if (el && !el.classList.contains("blk-ghost")) {
            op = begin(rs ? "resize" : "move", el, e.clientX, e.clientY, e.pointerType);
            if (op && rs) { e.preventDefault(); activate(); moveTo(e.clientX, e.clientY); }
            return;
        }
        const col = e.target.closest(".tg-col");
        if (col && !e.target.closest(".blk")) {
            op = { kind: "slot", col, x0: e.clientX, y0: e.clientY, active: false };
        }
    }
    function onPointerMove(e) {
        if (!op || e.pointerType === "touch") return;
        if (op.kind === "slot") { if (Math.abs(e.clientX - op.x0) + Math.abs(e.clientY - op.y0) > 6) op = null; return; }
        if (!op.active && Math.abs(e.clientX - op.x0) + Math.abs(e.clientY - op.y0) > 4) activate();
        if (op.active) { e.preventDefault(); moveTo(e.clientX, e.clientY); }
    }
    function onPointerUp(e) {
        if (!op || e.pointerType === "touch") return;
        if (op.kind === "slot") { const o = op; op = null; openSlot(o.col, e.clientY); return; }
        if (op.active) suppressClick = true;
        finish(false);
        setTimeout(() => { suppressClick = false; }, 50);
    }

    /* touch: tap = open / create · hold 350ms then move = drag */
    function onTouchStart(e) {
        if (e.touches.length !== 1) { finish(true); return; }
        const tt = e.touches[0];
        const host = e.target.closest("#cal-view");
        if (!host || e.target.closest("[data-check]")) return;
        const rs = e.target.closest("[data-resize]");
        const el = e.target.closest("[data-drag]");
        if (el && !el.classList.contains("blk-ghost")) {
            op = begin(rs ? "resize" : "move", el, tt.clientX, tt.clientY, "touch");
            if (!op) return;
            if (rs) { activate(); moveTo(tt.clientX, tt.clientY); return; }
            op.hold = setTimeout(() => { if (op && !op.active) { activate(); moveTo(op.x0, op.y0); } }, 350);
            return;
        }
        const col = e.target.closest(".tg-col");
        if (col && !e.target.closest(".blk")) op = { kind: "slot", col, x0: tt.clientX, y0: tt.clientY, active: false, t0: Date.now() };
    }
    function onTouchMove(e) {
        if (!op) return;
        const tt = e.touches[0];
        if (op.active) { e.preventDefault(); moveTo(tt.clientX, tt.clientY); return; }
        if (Math.abs(tt.clientX - op.x0) + Math.abs(tt.clientY - op.y0) > 8) { clearTimeout(op.hold); op = null; }   // it's a scroll
    }
    function onTouchEnd(e) {
        if (!op) return;
        if (op.kind === "slot") {
            const o = op; op = null;
            if (Date.now() - o.t0 < 500) { e.preventDefault(); openSlot(o.col, o.y0); }
            return;
        }
        if (op.active) { e.preventDefault(); suppressClick = true; setTimeout(() => { suppressClick = false; }, 400); }
        finish(false);
    }

    /* keyboard: T today · N next · P previous · C create */
    function onKey(e) {
        const typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || "") || (document.activeElement || {}).isContentEditable;
        if (e.key === "Escape") { if (op) { finish(true); } closePicker(); return; }
        if (typing || e.metaKey || e.ctrlKey || e.altKey || document.getElementById("planora-sheet")) return;
        const k = e.key.toLowerCase();
        if (k === "t") { e.preventDefault(); go(C().today()); }
        else if (k === "n") { e.preventDefault(); step(1); }
        else if (k === "p") { e.preventDefault(); step(-1); }
        else if (k === "c") { e.preventDefault(); create(); }
    }

    function create() {
        const core = C();
        const start = state.date === core.today() ? core.toClock(Math.min(22 * 60, Math.ceil((core.nowMin() + 1) / 30) * 30)) : "09:00";
        core.openCreateSheet({ date: state.date, start, end: core.toClock(core.toMin(start) + 60) });
    }

    /* ---------------- start ---------------- */
    function init() {
        if (!document.getElementById("cal-view") || !window.PlanoraCore) return;
        const params = new URLSearchParams(location.search);
        state.date = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") || "") ? params.get("date") : C().today();
        let saved = null;
        try { saved = localStorage.getItem(VIEW_KEY); } catch {}
        const byDevice = DEVICE() === "phone" ? "day" : "week";
        state.view = ["month", "week", "day"].includes(params.get("view")) ? params.get("view") : (["month", "week", "day"].includes(saved) ? saved : byDevice);
        syncLegacy();
        render();

        document.addEventListener("click", onClick);
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("pointermove", onPointerMove, { passive: false });
        document.addEventListener("pointerup", onPointerUp);
        document.addEventListener("pointercancel", () => finish(true));
        const host = document.getElementById("cal-view");
        host.addEventListener("touchstart", onTouchStart, { passive: true });
        host.addEventListener("touchmove", onTouchMove, { passive: false });
        host.addEventListener("touchend", onTouchEnd, { passive: false });
        host.addEventListener("touchcancel", () => finish(true));
        host.addEventListener("contextmenu", e => { if (e.target.closest("[data-drag]")) e.preventDefault(); });
        document.addEventListener("keydown", onKey);

        const redraw = () => { if (!op) { refreshLegacy(); render(); } };
        document.addEventListener("planora:data-changed", redraw);
        document.addEventListener("planora:plan-added", redraw);
        document.addEventListener("planora:slot-preview", e => showSlotGhost(e.detail));
        document.addEventListener("planora:sheet-closed", () => setTimeout(clearSlotGhost, 0));
        let rt = null, lastPhone = isPhone();
        window.addEventListener("resize", () => {
            clearTimeout(rt);
            rt = setTimeout(() => { if (isPhone() !== lastPhone) { lastPhone = isPhone(); render(); } else sizeScroll(); }, 150);
        });
        setInterval(drawNow, 30000);
    }

    window.PlanoraCalendar = {
        get view() { return state.view; },
        get date() { return state.date; },
        setView, go, step, create, render
    };

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(init, 0));
    else setTimeout(init, 0);

})();
