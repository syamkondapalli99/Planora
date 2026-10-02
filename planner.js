// ======================================================
// PLANORA — PLANNER TOOLS
// Smart Daily Planner · Task Breakdown · Goal Tracker · Study Planner
//
// Self-contained: only touches its own localStorage keys
// (planora_dp_tasks, planora_tb_groups, planora_goals) so
// nothing on the existing dashboard/calendar is affected.
// ======================================================

document.addEventListener("DOMContentLoaded", function () {

    // default the date inputs to today so users don't have to think about it
    const todayStr = todayISO();
    const dueInput = document.getElementById("dp-due");
    if (dueInput) dueInput.value = todayStr;
    const examInput = document.getElementById("sp-exam-date");
    if (examInput) {
        const d = new Date();
        d.setDate(d.getDate() + 14);
        examInput.value = d.toLocaleDateString("en-CA");
    }

    renderDPTasks();
    renderTBList();
    renderGTList();

    // Deep links from old pages and other screens:
    // #goals, #daily, #breakdown, #study, ?plan-goal=<id>
    const hash = location.hash.replace("#", "");
    if (["daily", "breakdown", "study"].includes(hash)) switchPlannerTab(hash);
    if (hash === "goals") setTimeout(function () { const g = document.getElementById("goals"); if (g) g.scrollIntoView({ block: "start" }); }, 100);
    const openGoal = new URLSearchParams(location.search).get("goal");
    if (openGoal) { openGoalIds.add(openGoal); renderGTList(); }
    const planGoal = new URLSearchParams(location.search).get("plan-goal");
    if (planGoal) {
        setTimeout(function () {
            const goal = PlanoraCore.getGoal(planGoal);
            if (goal && window.PlanoraAsk) window.PlanoraAsk.planForGoal(goal);
        }, 300);
    }

    // Anything that changes tasks or goals (Ask Planora, other tabs) refreshes the goal list
    document.addEventListener("planora:data-changed", renderGTList);
    document.addEventListener("planora:plan-added", renderGTList);

    // Restore a previously generated Study Planner result, if one exists.
    const savedStudyPlan = loadJSON("planora_study_plan", null);
    if (savedStudyPlan && Array.isArray(savedStudyPlan.sessions) && savedStudyPlan.sessions.length) {
        renderStudyPlan(savedStudyPlan.sessions, savedStudyPlan.source);
    }
});


// ======================================================
// SHARED HELPERS
// ======================================================

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
}

function saveJSON(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        console.error("Could not save", key, e);
    }
}

function todayISO() {
    return new Date().toLocaleDateString("en-CA");
}

function daysBetween(dateStr, fromStr) {
    const a = new Date(dateStr + "T00:00:00");
    const b = new Date((fromStr || todayISO()) + "T00:00:00");
    return Math.round((a - b) / 86400000);
}

function formatFriendlyDate(dateStr) {
    if (!dateStr) return "No date";
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function minutesToLabel(mins) {
    let h = Math.floor(mins / 60);
    const m = mins % 60;
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

function timeToMinutes(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
}

function escapeHTML(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}


// ======================================================
// TAB SWITCHING
// ======================================================

function switchPlannerTab(tab) {

    // "goals" lives on the page itself now (Your goals)
    if (tab === "goals") {
        const goals = document.getElementById("goals");
        if (goals) goals.scrollIntoView({ behavior: "smooth", block: "start" });
        if (!PlanoraCore.getGoals().length) createGoal();
        return;
    }

    const area = document.getElementById("tool-area");
    const current = document.querySelector(".tab-panel.active");
    const same = current && current.id === "tab-" + tab && area && !area.hidden;

    document.querySelectorAll(".planner-tab").forEach(function (btn) {
        const on = !same && btn.dataset.tab === tab;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
    });

    document.querySelectorAll(".tab-panel").forEach(function (panel) {
        panel.classList.toggle("active", !same && panel.id === "tab-" + tab);
    });

    if (area) {
        area.hidden = same;
        if (!same) {
            area.scrollIntoView({ behavior: "smooth", block: "start" });
            const first = area.querySelector(".tab-panel.active input, .tab-panel.active textarea");
            if (first && window.innerWidth > 700) setTimeout(function () { first.focus(); }, 250);
        }
    }
}

function closePlannerTool() {
    const area = document.getElementById("tool-area");
    if (area) area.hidden = true;
    document.querySelectorAll(".planner-tab").forEach(function (btn) { btn.classList.remove("active"); btn.setAttribute("aria-pressed", "false"); });
    document.querySelectorAll(".tab-panel").forEach(function (panel) { panel.classList.remove("active"); });
}


/* =======================================================================
   1. SMART DAILY PLANNER
   ======================================================================= */

let dpEditingId = null;

function getDPTasks() {
    return loadJSON("planora_dp_tasks", []);
}

function setDPTasks(tasks) {
    saveJSON("planora_dp_tasks", tasks);
}

function addPlannerTask() {

    const titleEl = document.getElementById("dp-title");
    const priorityEl = document.getElementById("dp-priority");
    const durationEl = document.getElementById("dp-duration");
    const dueEl = document.getElementById("dp-due");

    const title = titleEl.value.trim();
    const duration = Math.max(5, parseInt(durationEl.value, 10) || 30);
    const priority = priorityEl.value;
    const due = dueEl.value || todayISO();

    if (!title) {
        titleEl.focus();
        return;
    }

    const tasks = getDPTasks();

    if (dpEditingId) {
        const t = tasks.find(function (x) { return x.id === dpEditingId; });
        if (t) {
            t.title = title;
            t.priority = priority;
            t.duration = duration;
            t.due = due;
        }
        dpEditingId = null;
        const btn = document.getElementById("dp-add-btn");
        btn.innerHTML = '<i class="ti ti-plus"></i> Add task';
    } else {
        tasks.push({
            id: uid(),
            title: title,
            priority: priority,
            duration: duration,
            due: due,
            done: false
        });
    }

    setDPTasks(tasks);

    titleEl.value = "";
    durationEl.value = 30;
    priorityEl.value = "medium";
    dueEl.value = todayISO();

    renderDPTasks();
}

function editDPTask(id) {

    const tasks = getDPTasks();
    const t = tasks.find(function (x) { return x.id === id; });
    if (!t) return;

    document.getElementById("dp-title").value = t.title;
    document.getElementById("dp-priority").value = t.priority;
    document.getElementById("dp-duration").value = t.duration;
    document.getElementById("dp-due").value = t.due;

    dpEditingId = id;
    const btn = document.getElementById("dp-add-btn");
    btn.innerHTML = '<i class="ti ti-check"></i> Update task';

    document.getElementById("dp-title").focus();
}

function deleteDPTask(id) {
    const tasks = getDPTasks().filter(function (x) { return x.id !== id; });
    setDPTasks(tasks);
    renderDPTasks();
}

function toggleDPDone(id) {
    const tasks = getDPTasks();
    const t = tasks.find(function (x) { return x.id === id; });
    if (t) t.done = !t.done;
    setDPTasks(tasks);
    renderDPTasks();
}

function renderDPTasks() {

    const list = document.getElementById("dp-task-list");
    if (!list) return;

    const tasks = getDPTasks();

    if (tasks.length === 0) {
        list.innerHTML = '<div class="empty-state">No tasks yet. Add one to get started.</div>';
        return;
    }

    list.innerHTML = tasks.map(function (t) {
        return `
            <div class="dp-task-item ${t.priority}" style="${t.done ? "opacity:0.6;" : ""}">
                <div>
                    <div class="t-title" style="${t.done ? "text-decoration:line-through;color:var(--gray-400);" : ""}">${escapeHTML(t.title)}</div>
                    <div class="dp-task-meta">
                        <span class="badge ${t.priority}">${t.priority}</span>
                        <span><i class="ti ti-clock" style="font-size:12px;"></i> ${t.duration}m</span>
                        <span><i class="ti ti-calendar" style="font-size:12px;"></i> ${formatFriendlyDate(t.due)}</span>
                    </div>
                </div>
                <div class="dp-task-actions">
                    <button class="icon-btn-sm" onclick="toggleDPDone('${t.id}')" title="Mark done"><i class="ti ti-check"></i></button>
                    <button class="icon-btn-sm" onclick="editDPTask('${t.id}')" title="Edit"><i class="ti ti-pencil"></i></button>
                    <button class="icon-btn-sm danger" onclick="deleteDPTask('${t.id}')" title="Delete"><i class="ti ti-trash"></i></button>
                </div>
            </div>
        `;
    }).join("");
}

/**
 * AUTO PLAN
 * Arranges tasks into today's available window based on:
 *  - priority (high > medium > low)
 *  - how soon the task is due (overdue / due today weighted heaviest)
 *  - duration (used to greedily fit as many tasks as possible)
 */
function autoPlanTasks() {

    const tasks = getDPTasks().filter(function (t) { return !t.done; });

    const scheduleEl = document.getElementById("dp-schedule");

    if (tasks.length === 0) {
        scheduleEl.innerHTML = '<div class="empty-state">Add some tasks first, then hit Auto Plan.</div>';
        return;
    }

    const startStr = document.getElementById("dp-window-start").value || "09:00";
    const endStr = document.getElementById("dp-window-end").value || "21:00";

    const windowStart = timeToMinutes(startStr);
    const windowEnd = timeToMinutes(endStr);

    const priorityWeight = { high: 3, medium: 2, low: 1 };
    const today = todayISO();

    const scored = tasks.map(function (t) {

        const daysUntil = daysBetween(t.due, today);
        let urgency;

        if (daysUntil <= 0) {
            urgency = 500; // overdue or due today — most urgent
        } else {
            urgency = Math.max(0, 100 - daysUntil * 8);
        }

        const score = (priorityWeight[t.priority] || 2) * 100 + urgency;

        return Object.assign({}, t, { score: score, daysUntil: daysUntil });
    });

    scored.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return a.duration - b.duration; // shorter tasks first on ties, fits more in
    });

    let cursor = windowStart;
    const scheduled = [];
    const unscheduled = [];

    scored.forEach(function (t) {
        if (cursor + t.duration <= windowEnd) {
            scheduled.push({ task: t, start: cursor, end: cursor + t.duration });
            cursor += t.duration + 5; // 5 min buffer between tasks
        } else {
            unscheduled.push(t);
        }
    });

    dpLastSchedule = scheduled;
    renderDPSchedule(scheduled, unscheduled);
}

let dpLastSchedule = [];

// Preview the generated schedule, then create real tasks (Home, Calendar, stats)
async function dpAddToPlan() {
    if (!dpLastSchedule.length) return;
    const btn = document.getElementById("dp-add-plan");
    if (btn) { btn.disabled = true; btn.textContent = "Checking your calendar…"; }
    const priorityMap = { high: "high", medium: null, low: "low" };
    try {
        const placed = await PlanoraCore.scheduleItems(dpLastSchedule.map(function (s) {
            return {
                title: s.task.title,
                date: todayISO(),
                start: PlanoraCore.toClock(s.start),
                duration: s.task.duration,
                flexible: true,
                deadline: s.task.due || null,
                sourceId: s.task.id
            };
        }));
        const byId = {};
        dpLastSchedule.forEach(function (s) { byId[s.task.id] = s.task; });
        const tasks = placed.map(function (p) {
            const t = byId[p.sourceId] || {};
            return Object.assign({}, p, { priority: priorityMap[t.priority] || null, deadline: t.due || null, source: "daily-planner" });
        });
        PlanoraCore.openPlanPreview({ tasks: tasks, goals: [], updates: [] }, {
            title: "Add today's schedule",
            intro: "Planora fitted these around what's already in your calendar. Edit anything, then add them to your plan.",
            source: "daily-planner",
            onDone: function (result) {
                // the planned items are now real tasks, so they leave this draft list
                const addedTitles = new Set(tasks.map(function (t) { return t.title; }));
                setDPTasks(getDPTasks().filter(function (t) { return !addedTitles.has(t.title); }));
                dpLastSchedule = [];
                renderDPTasks();
                document.getElementById("dp-schedule").innerHTML = '<div class="empty-state">Added to your plan. You\'ll find these on Home and in your Calendar.</div>';
            }
        });
    } catch (error) {
        PlanoraCore.toast(error.message || "Planora couldn't plan that right now. Your tasks are safe.", "error");
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Review & add to my plan'; }
    }
}

function renderDPSchedule(scheduled, unscheduled) {

    const el = document.getElementById("dp-schedule");

    if (scheduled.length === 0) {
        el.innerHTML = '<div class="empty-state">Nothing fit in the available window — try widening it.</div>';
        return;
    }

    let html = scheduled.map(function (s) {
        return `
            <div class="schedule-block">
                <div class="schedule-time">${minutesToLabel(s.start)}<br>${minutesToLabel(s.end)}</div>
                <div class="schedule-info">
                    <div class="t-title">${escapeHTML(s.task.title)}</div>
                    <div class="dp-task-meta">
                        <span class="badge ${s.task.priority}">${s.task.priority}</span>
                        <span>${s.task.duration}m</span>
                        ${s.task.daysUntil <= 0 ? '<span class="badge high">due today</span>' : ""}
                    </div>
                </div>
            </div>
        `;
    }).join("");

    if (unscheduled.length > 0) {
        html += `
            <div class="ai-tip" style="margin-top:12px;margin-bottom:0;">
                <i class="ti ti-alert-triangle"></i>
                <span>${unscheduled.length} task(s) didn't fit in this window: ${unscheduled.map(function (t) { return escapeHTML(t.title); }).join(", ")}. Try widening your available hours or moving them to another day.</span>
            </div>
        `;
    }

    html += `
        <button type="button" class="btn-primary tool-confirm" id="dp-add-plan" onclick="dpAddToPlan()">
            <i class="ti ti-check" aria-hidden="true"></i> Review &amp; add to my plan
        </button>`;

    el.innerHTML = html;
}


/* =======================================================================
   2. TASK BREAKDOWN (rule-based)
   ======================================================================= */

function getTBGroups() {
    return loadJSON("planora_tb_groups", []);
}

function setTBGroups(groups) {
    saveJSON("planora_tb_groups", groups);
}

// Category templates, checked in order — first keyword match wins.
const TB_CATEGORIES = [
    {
        test: /essay|report|paper|article|thesis/i,
        build: function (text) {
            return [
                `Research and gather sources for "${text}"`,
                "Create an outline / structure",
                "Write the first draft",
                "Revise for clarity and flow",
                "Proofread and finalize"
            ];
        }
    },
    {
        test: /presentation|slide|deck|pitch/i,
        build: function () {
            return [
                "Outline the presentation structure",
                "Design slides and visuals",
                "Add content, data, and talking points",
                "Practice the delivery out loud",
                "Do a final review and polish"
            ];
        }
    },
    {
        test: /clean|organi[sz]e|declutter|tidy/i,
        build: function () {
            return [
                "Sort items into keep / donate / discard",
                "Deep clean the space",
                "Organize what's left into place",
                "Dispose of or donate the extras",
                "Final tidy-up and walkthrough"
            ];
        }
    },
    {
        test: /study|exam|revise|revision|test\b/i,
        build: function () {
            return [
                "Gather notes and study materials",
                "Review the key concepts",
                "Do practice questions",
                "Summarize weak areas",
                "Final revision pass"
            ];
        }
    },
    {
        test: /event|party|wedding|trip|travel|vacation/i,
        build: function () {
            return [
                "Set the date and guest / participant list",
                "Book venue, vendors, or transport",
                "Send invitations or confirm bookings",
                "Prepare supplies and logistics",
                "Day-of coordination checklist"
            ];
        }
    },
    {
        test: /app|website|code|program|build|develop|feature/i,
        build: function (text) {
            return [
                `Define requirements for "${text}"`,
                "Design the structure / architecture",
                "Implement the core functionality",
                "Test and debug",
                "Polish and ship it"
            ];
        }
    },
    {
        test: /.*/,
        build: function (text) {
            return [
                `Research and plan "${text}"`,
                "Gather what you need",
                "Start on the first chunk of work",
                "Review progress and adjust",
                "Finish and wrap up"
            ];
        }
    }
];

function ruleBasedSubtasks(text) {
    const category = TB_CATEGORIES.find(function (c) { return c.test.test(text); });
    return category.build(text);
}

function generateBreakdown() {

    const input = document.getElementById("tb-input");
    const text = input.value.trim();

    if (!text) {
        input.focus();
        return;
    }

    const subtaskTexts = ruleBasedSubtasks(text);

    const group = {
        id: uid(),
        title: text,
        subtasks: subtaskTexts.map(function (s) {
            return { id: uid(), text: s, done: false };
        })
    };

    const groups = getTBGroups();
    groups.unshift(group);
    setTBGroups(groups);

    input.value = "";
    renderTBList();
}

function deleteTBGroup(groupId) {
    setTBGroups(getTBGroups().filter(function (g) { return g.id !== groupId; }));
    renderTBList();
}

function toggleSubtask(groupId, subId) {
    const groups = getTBGroups();
    const g = groups.find(function (x) { return x.id === groupId; });
    if (!g) return;
    const s = g.subtasks.find(function (x) { return x.id === subId; });
    if (s) s.done = !s.done;
    setTBGroups(groups);
    renderTBList();
}

function deleteSubtask(groupId, subId) {
    const groups = getTBGroups();
    const g = groups.find(function (x) { return x.id === groupId; });
    if (!g) return;
    g.subtasks = g.subtasks.filter(function (x) { return x.id !== subId; });
    setTBGroups(groups);
    renderTBList();
}

function startEditSubtask(groupId, subId) {
    const groups = getTBGroups();
    const g = groups.find(function (x) { return x.id === groupId; });
    if (!g) return;
    const s = g.subtasks.find(function (x) { return x.id === subId; });
    if (!s) return;
    s._editing = true;
    setTBGroups(groups);
    renderTBList();
}

function saveEditSubtask(groupId, subId, value) {
    const groups = getTBGroups();
    const g = groups.find(function (x) { return x.id === groupId; });
    if (!g) return;
    const s = g.subtasks.find(function (x) { return x.id === subId; });
    if (!s) return;
    if (value.trim()) s.text = value.trim();
    delete s._editing;
    setTBGroups(groups);
    renderTBList();
}

function addSubtaskToGroup(groupId, inputEl) {
    const value = inputEl.value.trim();
    if (!value) return;
    const groups = getTBGroups();
    const g = groups.find(function (x) { return x.id === groupId; });
    if (!g) return;
    g.subtasks.push({ id: uid(), text: value, done: false });
    setTBGroups(groups);
    inputEl.value = "";
    renderTBList();
}

// Turn breakdown steps into real tasks (preview first)
async function tbAddToPlan(groupId, subId) {
    const group = getTBGroups().find(function (g) { return g.id === groupId; });
    if (!group) return;
    const steps = group.subtasks.filter(function (s) {
        return (subId ? s.id === subId : true) && !s.done && !s.addedTaskId;
    });
    if (!steps.length) { PlanoraCore.toast("These steps are already in your plan."); return; }
    try {
        const placed = await PlanoraCore.scheduleItems(steps.map(function (s) {
            return { title: s.text, date: todayISO(), flexible: true, sourceId: s.id };
        }));
        PlanoraCore.openPlanPreview({ tasks: placed.map(function (p) { return Object.assign({}, p, { source: "breakdown" }); }), goals: [], updates: [] }, {
            title: subId ? "Add this step" : "Add steps to my plan",
            intro: `Steps for "${group.title}", fitted into your free time. Change anything, then add them.`,
            source: "breakdown",
            onDone: function (result) {
                const groups = getTBGroups();
                const g = groups.find(function (x) { return x.id === groupId; });
                if (g) {
                    const ids = result.taskIds || [];
                    let k = 0;
                    g.subtasks.forEach(function (s) {
                        if (steps.some(function (x) { return x.id === s.id; }) && k < ids.length) s.addedTaskId = ids[k++];
                    });
                    setTBGroups(groups);
                }
                renderTBList();
            }
        });
    } catch (error) {
        PlanoraCore.toast(error.message || "Planora couldn't plan that right now. Your tasks are safe.", "error");
    }
}

function renderTBList() {

    const el = document.getElementById("tb-list");
    if (!el) return;

    const groups = getTBGroups();

    if (groups.length === 0) {
        el.innerHTML = "";
        return;
    }

    el.innerHTML = groups.map(function (g) {

        const done = g.subtasks.filter(function (s) { return s.done; }).length;

        const subtaskHTML = g.subtasks.map(function (s) {

            if (s._editing) {
                return `
                    <div class="subtask-row">
                        <input class="subtask-edit-input" id="edit-${s.id}" value="${escapeHTML(s.text)}">
                        <button class="icon-btn-sm" onclick="saveEditSubtask('${g.id}','${s.id}', document.getElementById('edit-${s.id}').value)"><i class="ti ti-check"></i></button>
                    </div>
                `;
            }

            return `
                <div class="subtask-row">
                    <button class="subtask-check ${s.done ? "done" : ""}" onclick="toggleSubtask('${g.id}','${s.id}')">
                        <i class="ti ti-check"></i>
                    </button>
                    <span class="subtask-text ${s.done ? "done" : ""}">${escapeHTML(s.text)}${s.addedTaskId ? ' <span class="in-plan">In your plan</span>' : ""}</span>
                    ${s.addedTaskId || s.done ? "" : `<button class="icon-btn-sm" onclick="tbAddToPlan('${g.id}','${s.id}')" aria-label="Add ${escapeHTML(s.text)} to my plan" title="Add to my plan"><i class="ti ti-calendar-plus"></i></button>`}
                    <button class="icon-btn-sm" onclick="startEditSubtask('${g.id}','${s.id}')" aria-label="Edit step"><i class="ti ti-pencil"></i></button>
                    <button class="icon-btn-sm danger" onclick="deleteSubtask('${g.id}','${s.id}')"><i class="ti ti-trash"></i></button>
                </div>
            `;
        }).join("");

        return `
            <div class="card">
                <div class="tb-group-header">
                    <h3>${escapeHTML(g.title)}</h3>
                    <button class="icon-btn-sm danger" onclick="deleteTBGroup('${g.id}')" title="Delete"><i class="ti ti-trash"></i></button>
                </div>
                <p class="dp-task-meta" style="margin-bottom:8px;">${done}/${g.subtasks.length} complete</p>
                ${subtaskHTML}
                <div class="add-subtask-row">
                    <input type="text" id="add-input-${g.id}" placeholder="Add a step..." aria-label="Add a step">
                    <button class="icon-btn-sm" onclick="addSubtaskToGroup('${g.id}', document.getElementById('add-input-${g.id}'))" aria-label="Add step"><i class="ti ti-plus"></i></button>
                </div>
                ${g.subtasks.some(function (s) { return !s.done && !s.addedTaskId; }) ? `<button type="button" class="btn-primary tool-confirm" onclick="tbAddToPlan('${g.id}')"><i class="ti ti-calendar-plus" aria-hidden="true"></i> Add all to my tasks</button>` : ""}
            </div>
        `;
    }).join("");
}


/* =======================================================================
   3. GOALS  (one shared goal model: PlanoraCore — same goals as Journal,
      Ask Planora and Calendar. Sessions are tasks with goalId.)
   ======================================================================= */

function getGoals() {
    return PlanoraCore.getGoals();
}

function setGoals(goals) {
    const tasks = PlanoraCore.getTasks();
    saveJSON("planora_goals", goals.map(function (g) {
        const n = PlanoraCore.normaliseGoal(g);
        return Object.assign({}, n, { progress: PlanoraCore.goalProgress(n, tasks) });
    }));
}

function addMilestoneInputRow() {
    const wrap = document.getElementById("gt-milestone-inputs");
    if (!wrap) return;
    const row = document.createElement("div");
    row.className = "milestone-input-row";
    row.innerHTML = `<input type="text" placeholder="Milestone ${wrap.children.length + 1}">`;
    wrap.appendChild(row);
}

// New goal: same goal editor used everywhere (with "let Planora schedule sessions")
function createGoal() {
    PlanoraCore.openGoalSheet(null, { onSaved: renderGTList });
}

function editGoal(goalId) {
    PlanoraCore.openGoalSheet({ id: goalId }, { onSaved: renderGTList });
}

async function deleteGoal(goalId) {
    const goal = PlanoraCore.getGoal(goalId);
    if (!goal) return;
    const open = PlanoraCore.goalSessions(goalId).filter(function (t) { return !t.completed; }).length;
    const ok = await PlanoraCore.confirm({
        title: "Delete this goal?",
        message: `"${goal.title}" will be deleted.${open ? ` Its ${open} unfinished session${open === 1 ? "" : "s"} will be removed from your schedule.` : ""} Completed sessions stay in your history.`,
        confirmText: "Delete goal",
        danger: true
    });
    if (!ok) return;
    PlanoraCore.deleteGoal(goalId);
    PlanoraCore.toast("Goal deleted.");
    renderGTList();
}

function toggleMilestone(goalId, msId) {
    PlanoraCore.toggleMilestone(goalId, msId);
    renderGTList();
}

function addMilestoneToGoal(goalId, inputEl) {
    const value = inputEl.value.trim();
    if (!value) return;
    const goal = PlanoraCore.getGoal(goalId);
    if (!goal) return;
    PlanoraCore.updateGoal(goalId, { milestones: goal.milestones.concat([{ id: uid(), text: value, done: false }]) });
    inputEl.value = "";
    openGoalIds.add(goalId);
    renderGTList();
}

function planGoal(goalId) {
    const goal = PlanoraCore.getGoal(goalId);
    if (goal) PlanoraCore.planGoalSessions(goal);
}

function goalProgress(goal) {
    return PlanoraCore.goalProgress(goal);
}

// Sessions Planora scheduled for a goal (tasks with goalId)
function nextSessionOf(goal) {
    const now = todayISO();
    return PlanoraCore.goalSessions(goal.id)
        .filter(function (t) { return !t.completed && t.date >= now; })
        .sort(function (a, b) { return (a.date + (a.start || "")).localeCompare(b.date + (b.start || "")); })[0] || null;
}

function goalSessionsHTML(goal) {
    const sessions = PlanoraCore.goalSessions(goal.id);
    const done = sessions.filter(function (t) { return t.completed; }).length;
    const next = nextSessionOf(goal);
    const nextBlock = next ? `
        <div class="goal-next">
            <p class="next-label">Next session</p>
            <p class="goal-next-when">${escapeHTML(PlanoraCore.dayLabel(next.date))}${next.start ? " · " + PlanoraCore.time12(next.start) : ""}</p>
            <p class="goal-next-what">${escapeHTML(next.title.replace(/^[^:]+:\s*/, ""))} · ${PlanoraCore.durLabel(PlanoraCore.taskDuration(next))}</p>
            <button type="button" class="btn-primary" onclick="PlanoraFocus.start('${escapeHTML(String(next.id))}')"><i class="ti ti-player-play" aria-hidden="true"></i> Start session</button>
        </div>` : (goal.status === "completed" ? "" : `
        <div class="goal-next">
            <p class="next-label">Next session</p>
            <p class="goal-next-what">Nothing planned yet.</p>
            <button type="button" class="btn-primary" onclick="planGoal('${goal.id}')"><i class="ti ti-sparkles" aria-hidden="true"></i> Plan next session</button>
        </div>`);
    return `
        ${nextBlock}
        ${sessions.length ? `<div class="goal-sessions"><span class="pill"><i class="ti ti-calendar-check" aria-hidden="true"></i> ${done}/${sessions.length} sessions done</span></div>` : ""}`;
}

const openGoalIds = new Set();

function toggleGoalOpen(goalId) {
    if (openGoalIds.has(goalId)) openGoalIds.delete(goalId); else openGoalIds.add(goalId);
    renderGTList();
}

function renderGTList() {

    const el = document.getElementById("gt-list");
    if (!el) return;

    const goals = PlanoraCore.getGoals({ includeArchived: false });

    if (goals.length === 0) {
        el.innerHTML = `
            <div class="pl-empty">
                <i class="ti ti-target-arrow" aria-hidden="true"></i>
                <p><strong>Set something you're working toward.</strong><br>Planora will break it into milestones and schedule practice sessions for you.</p>
                <button type="button" class="btn-primary" onclick="createGoal()">Create a goal</button>
            </div>`;
        return;
    }

    // active first, then achieved
    goals.sort(function (a, b) { return (a.status === "completed") - (b.status === "completed"); });

    el.innerHTML = goals.map(function (g) {

        const pct = PlanoraCore.goalProgress(g);
        const open = openGoalIds.has(g.id);
        let dateLabel = "No target date";
        if (g.status === "completed") dateLabel = "Achieved 🎉";
        else if (g.date) {
            const daysUntil = daysBetween(g.date, todayISO());
            if (daysUntil > 0) dateLabel = `${daysUntil} day${daysUntil === 1 ? "" : "s"} left · ${formatFriendlyDate(g.date)}`;
            else if (daysUntil === 0) dateLabel = `Due today`;
            else dateLabel = `${Math.abs(daysUntil)} day${Math.abs(daysUntil) === 1 ? "" : "s"} past target · ${formatFriendlyDate(g.date)}`;
        }
        const sessions = PlanoraCore.goalSessions(g.id);

        const milestoneHTML = g.milestones.map(function (m) {
            return `
                <div class="subtask-row">
                    <button class="subtask-check ${m.done ? "done" : ""}" onclick="toggleMilestone('${g.id}','${m.id}')" aria-pressed="${m.done}" aria-label="${m.done ? "Mark not done" : "Mark done"}: ${escapeHTML(m.text)}">
                        <i class="ti ti-check" aria-hidden="true"></i>
                    </button>
                    <span class="subtask-text ${m.done ? "done" : ""}">${escapeHTML(m.text)}</span>
                    ${m.date ? `<span class="ms-date">${formatFriendlyDate(m.date)}</span>` : ""}
                </div>`;
        }).join("");

        return `
            <article class="goal-card ${g.status === "completed" ? "achieved" : ""}" style="--goal-c:${PlanoraCore.goalColor(g).color};--goal-s:${PlanoraCore.goalColor(g).soft}">
                <button type="button" class="goal-summary" onclick="toggleGoalOpen('${g.id}')" aria-expanded="${open}">
                    <span class="goal-ring" style="--p:${pct}" aria-hidden="true"><span>${pct}%</span></span>
                    <span class="goal-text">
                        <span class="goal-title">${escapeHTML(g.title)}</span>
                        <span class="goal-date">${dateLabel}${sessions.length ? ` · ${sessions.filter(function (t) { return t.completed; }).length}/${sessions.length} sessions` : ""}</span>
                        ${(function () { const n = nextSessionOf(g); return n && g.status !== "completed" ? `<span class="goal-date goal-next-line">Next: ${escapeHTML(PlanoraCore.dayLabel(n.date))}${n.start ? " " + PlanoraCore.time12(n.start) : ""} · ${escapeHTML(n.title.replace(/^[^:]+:\s*/, ""))}</span>` : ""; })()}
                    </span>
                    <i class="ti ti-chevron-down goal-chev" aria-hidden="true"></i>
                </button>
                ${open ? `
                <div class="goal-detail">
                    ${goalSessionsHTML(g)}
                    <div class="goal-milestones">
                        ${milestoneHTML || '<p class="dp-task-meta">No milestones yet. Add the steps that mark real progress.</p>'}
                    </div>
                    <div class="add-subtask-row">
                        <input type="text" id="gt-add-${g.id}" placeholder="Add a milestone..." aria-label="Add a milestone" onkeydown="if(event.key==='Enter'){addMilestoneToGoal('${g.id}', this)}">
                        <button class="icon-btn-sm" onclick="addMilestoneToGoal('${g.id}', document.getElementById('gt-add-${g.id}'))" aria-label="Add milestone"><i class="ti ti-plus"></i></button>
                    </div>
                    <div class="goal-actions">
                        ${g.status === "completed" ? "" : `<button type="button" class="btn-secondary" onclick="planGoal('${g.id}')"><i class="ti ti-sparkles" aria-hidden="true"></i> Plan more sessions</button>`}
                        <button type="button" class="btn-secondary" onclick="editGoal('${g.id}')"><i class="ti ti-pencil" aria-hidden="true"></i> Edit</button>
                        <button type="button" class="btn-secondary danger" onclick="deleteGoal('${g.id}')" aria-label="Delete goal ${escapeHTML(g.title)}"><i class="ti ti-trash" aria-hidden="true"></i></button>
                    </div>
                </div>` : ""}
            </article>
        `;
    }).join("");
}


/* =======================================================================
   4. STUDY PLANNER  (sends the request to the backend, which calls OpenAI)
   ======================================================================= */

function addTopicRow() {
    const wrap = document.getElementById("sp-topic-rows");
    const row = document.createElement("div");
    row.className = "topic-row";
    row.innerHTML = `
        <input type="text" placeholder="Topic name">
        <select>
            <option value="easy">Easy</option>
            <option value="medium" selected>Medium</option>
            <option value="hard">Hard</option>
        </select>
        <button class="icon-btn-sm danger" onclick="removeTopicRow(this)"><i class="ti ti-trash"></i></button>
    `;
    wrap.appendChild(row);
}

function removeTopicRow(btn) {
    const wrap = document.getElementById("sp-topic-rows");
    const row = btn.closest(".topic-row");
    if (wrap.children.length > 1) {
        row.remove();
    } else {
        row.querySelector("input").value = "";
    }
}

async function generateStudyPlan() {

    const subject = document.getElementById("sp-subject").value.trim();
    const examDate = document.getElementById("sp-exam-date").value;
    const hoursPerDay = parseFloat(document.getElementById("sp-hours").value) || 2;

    const topics = Array.from(document.querySelectorAll("#sp-topic-rows .topic-row")).map(function (row) {
        const [nameInput, difficultySelect] = row.querySelectorAll("input, select");
        return { name: nameInput.value.trim(), difficulty: difficultySelect.value };
    }).filter(function (t) { return t.name; });

    const outputEl = document.getElementById("sp-output");

    if (!subject || !examDate || topics.length === 0) {
        outputEl.innerHTML = '<div class="ai-tip" style="margin-top:12px;"><i class="ti ti-alert-triangle"></i><span>Add a subject, exam date, and at least one topic first.</span></div>';
        return;
    }

    outputEl.innerHTML = `
        <div class="card" style="margin-top:14px;">
            <div class="loading-row">
                <i class="ti ti-loader-2 spin"></i> Building your revision schedule...
            </div>
        </div>
    `;

    try {

        const response = await fetch("/api/study-plan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                subject: subject,
                examDate: examDate,
                hoursPerDay: hoursPerDay,
                topics: topics,
                today: todayISO()
            })
        });

        if (!response.ok) throw new Error("Request failed");

        const data = await response.json();
        const meta = { subject: subject, examDate: examDate, hoursPerDay: hoursPerDay, topics: topics };
        saveJSON("planora_study_plan", { sessions: data.sessions || [], source: data.source, meta: meta });
        renderStudyPlan(data.sessions || [], data.source);

    } catch (err) {
        console.error("Study plan generation failed:", err);
        outputEl.innerHTML = `
            <div class="ai-tip" style="margin-top:14px;">
                <i class="ti ti-alert-triangle"></i>
                <span>Planora couldn't build your study plan right now. Your existing tasks are safe. Please try again in a moment.</span>
            </div>
        `;
    }
}

function renderStudyPlan(sessions, source) {

    const outputEl = document.getElementById("sp-output");

    if (!sessions.length) {
        outputEl.innerHTML = '<div class="ai-tip" style="margin-top:14px;"><i class="ti ti-alert-triangle"></i><span>No sessions were generated — try adjusting your inputs.</span></div>';
        return;
    }

    // group sessions by date
    const byDate = {};
    sessions.forEach(function (s) {
        if (!byDate[s.date]) byDate[s.date] = [];
        byDate[s.date].push(s);
    });

    const dates = Object.keys(byDate).sort();

    const html = dates.map(function (date) {

        const sessionsHTML = byDate[date].map(function (s) {
            return `
                <div class="study-session">
                    <div>
                        <div class="s-title">${escapeHTML(s.topic)}</div>
                        <div class="s-time">${escapeHTML(s.start || "")} – ${escapeHTML(s.end || "")}</div>
                    </div>
                    <span class="badge ${escapeHTML(s.type || "study")}">${escapeHTML(s.type || "study")}</span>
                </div>
            `;
        }).join("");

        return `
            <div class="study-day-group">
                <div class="study-day-label">${formatFriendlyDate(date)}</div>
                ${sessionsHTML}
            </div>
        `;
    }).join("");

    const saved = loadJSON("planora_study_plan", {}) || {};
    const added = saved.addedGoalId && PlanoraCore.getGoal(saved.addedGoalId);

    outputEl.innerHTML = `
        <div class="card" style="margin-top:14px;">
            <div class="card-header"><span>Your revision schedule</span><i class="ti ti-calendar-time"></i></div>
            ${html}
            <p class="ai-source-note">${source === "openai" ? "Generated with AI" : "Generated locally"} · harder topics get more time, with revision and practice sessions built in.</p>
            ${added
                ? `<p class="in-plan-note"><i class="ti ti-circle-check" aria-hidden="true"></i> Added to your plan as the goal "${escapeHTML(added.title)}". Sessions are on Home and in your Calendar.</p>`
                : `<button type="button" class="btn-primary tool-confirm" id="sp-add-plan" onclick="studyAddToPlan()"><i class="ti ti-check" aria-hidden="true"></i> Review &amp; add to my plan</button>
                   <p class="pl-hint" style="margin-top:8px;">Creates a study goal with each topic as a milestone, and puts the sessions in your calendar.</p>`}
        </div>
    `;
}

// Study timetable -> a study goal + milestones (topics) + real sessions
async function studyAddToPlan() {
    const saved = loadJSON("planora_study_plan", null);
    if (!saved || !Array.isArray(saved.sessions) || !saved.sessions.length) return;
    const meta = saved.meta || {
        subject: (document.getElementById("sp-subject").value || "Study").trim(),
        examDate: document.getElementById("sp-exam-date").value || null,
        topics: []
    };
    const subject = meta.subject || "Study";
    const topics = (meta.topics || []).map(function (t) { return t.name; }).filter(Boolean);
    const sessionTopics = Array.from(new Set(saved.sessions.map(function (s) { return s.topic; })));
    const btn = document.getElementById("sp-add-plan");
    if (btn) { btn.disabled = true; btn.textContent = "Checking your calendar…"; }

    try {
        const placed = await PlanoraCore.scheduleItems(saved.sessions
            .filter(function (s) { return s.date >= todayISO(); })
            .map(function (s) {
                const start = s.start || "16:00";
                const dur = s.start && s.end ? Math.max(15, timeToMinutes(s.end) - timeToMinutes(s.start)) : 45;
                const kind = s.type && s.type !== "study" ? ` (${s.type})` : "";
                return { title: `${subject}: ${s.topic}${kind}`, date: s.date, start: start, duration: dur, flexible: true, goalRef: "g1", deadline: meta.examDate || null };
            }));

        const goal = {
            ref: "g1",
            title: /exam|test/i.test(subject) ? subject : `${subject} exam`,
            date: meta.examDate || null,
            category: "learning",
            milestones: (topics.length ? topics : sessionTopics).map(function (name) { return { text: `Revise ${name}` }; })
                .concat([{ text: "Final review done", date: meta.examDate ? PlanoraCore.addDays(meta.examDate, -1) : null }])
        };

        PlanoraCore.openPlanPreview({ tasks: placed.map(function (p) { return Object.assign({}, p, { source: "study-planner" }); }), goals: [goal], updates: [] }, {
            title: "Add your study plan",
            intro: "This creates a study goal and puts each session in your calendar. Edit or untick sessions first if you like.",
            source: "study-planner",
            onDone: function (result) {
                const s2 = loadJSON("planora_study_plan", {}) || {};
                s2.addedGoalId = (result.goalIds || [])[0] || null;
                saveJSON("planora_study_plan", s2);
                renderStudyPlan(s2.sessions || [], s2.source);
                renderGTList();
            }
        });
    } catch (error) {
        PlanoraCore.toast(error.message || "Planora couldn't plan that right now. Your tasks are safe.", "error");
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Review &amp; add to my plan'; }
    }
}