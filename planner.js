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
        examInput.value = d.toISOString().slice(0, 10);
    }

    renderDPTasks();
    renderTBList();
    renderGTList();
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
    return new Date().toISOString().slice(0, 10);
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

    document.querySelectorAll(".planner-tab").forEach(function (btn) {
        btn.classList.toggle("active", btn.dataset.tab === tab);
    });

    document.querySelectorAll(".tab-panel").forEach(function (panel) {
        panel.classList.toggle("active", panel.id === "tab-" + tab);
    });
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

    renderDPSchedule(scheduled, unscheduled);
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
                    <span class="subtask-text ${s.done ? "done" : ""}">${escapeHTML(s.text)}</span>
                    <button class="icon-btn-sm" onclick="startEditSubtask('${g.id}','${s.id}')"><i class="ti ti-pencil"></i></button>
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
                    <input type="text" id="add-input-${g.id}" placeholder="Add a subtask...">
                    <button class="icon-btn-sm" onclick="addSubtaskToGroup('${g.id}', document.getElementById('add-input-${g.id}'))"><i class="ti ti-plus"></i></button>
                </div>
            </div>
        `;
    }).join("");
}


/* =======================================================================
   3. GOAL TRACKER
   ======================================================================= */

function getGoals() {
    return loadJSON("planora_goals", []);
}

function setGoals(goals) {
    saveJSON("planora_goals", goals);
}

function addMilestoneInputRow() {
    const wrap = document.getElementById("gt-milestone-inputs");
    const row = document.createElement("div");
    row.className = "milestone-input-row";
    row.innerHTML = `<input type="text" placeholder="Milestone ${wrap.children.length + 1}">`;
    wrap.appendChild(row);
}

function createGoal() {

    const titleEl = document.getElementById("gt-title");
    const dateEl = document.getElementById("gt-date");

    const title = titleEl.value.trim();
    const date = dateEl.value;

    if (!title || !date) {
        (title ? dateEl : titleEl).focus();
        return;
    }

    const milestoneInputs = document.querySelectorAll("#gt-milestone-inputs input");
    const milestones = Array.from(milestoneInputs)
        .map(function (i) { return i.value.trim(); })
        .filter(Boolean)
        .map(function (text) { return { id: uid(), text: text, done: false }; });

    const goals = getGoals();
    goals.unshift({ id: uid(), title: title, date: date, milestones: milestones });
    setGoals(goals);

    titleEl.value = "";
    dateEl.value = "";
    document.getElementById("gt-milestone-inputs").innerHTML = `
        <div class="milestone-input-row"><input type="text" placeholder="Milestone 1"></div>
        <div class="milestone-input-row"><input type="text" placeholder="Milestone 2"></div>
    `;

    renderGTList();
}

function deleteGoal(goalId) {
    setGoals(getGoals().filter(function (g) { return g.id !== goalId; }));
    renderGTList();
}

function toggleMilestone(goalId, msId) {
    const goals = getGoals();
    const g = goals.find(function (x) { return x.id === goalId; });
    if (!g) return;
    const m = g.milestones.find(function (x) { return x.id === msId; });
    if (m) m.done = !m.done;
    setGoals(goals);
    renderGTList();
}

function addMilestoneToGoal(goalId, inputEl) {
    const value = inputEl.value.trim();
    if (!value) return;
    const goals = getGoals();
    const g = goals.find(function (x) { return x.id === goalId; });
    if (!g) return;
    g.milestones.push({ id: uid(), text: value, done: false });
    setGoals(goals);
    inputEl.value = "";
    renderGTList();
}

function goalProgress(goal) {
    if (!goal.milestones.length) return 0;
    const done = goal.milestones.filter(function (m) { return m.done; }).length;
    return Math.round((done / goal.milestones.length) * 100);
}

function renderGTList() {

    const el = document.getElementById("gt-list");
    if (!el) return;

    const goals = getGoals();

    if (goals.length === 0) {
        el.innerHTML = '<div class="empty-state">No goals yet — create one above.</div>';
        return;
    }

    el.innerHTML = goals.map(function (g) {

        const pct = goalProgress(g);
        const daysUntil = daysBetween(g.date, todayISO());
        let dateLabel;

        if (daysUntil > 0) dateLabel = `Due in ${daysUntil} day${daysUntil === 1 ? "" : "s"} · ${formatFriendlyDate(g.date)}`;
        else if (daysUntil === 0) dateLabel = `Due today · ${formatFriendlyDate(g.date)}`;
        else dateLabel = `Overdue by ${Math.abs(daysUntil)} day${Math.abs(daysUntil) === 1 ? "" : "s"} · ${formatFriendlyDate(g.date)}`;

        const barColor = pct === 100 ? "var(--blue-400)" : "var(--purple-400)";

        const milestoneHTML = g.milestones.map(function (m) {
            return `
                <div class="subtask-row">
                    <button class="subtask-check ${m.done ? "done" : ""}" onclick="toggleMilestone('${g.id}','${m.id}')">
                        <i class="ti ti-check"></i>
                    </button>
                    <span class="subtask-text ${m.done ? "done" : ""}">${escapeHTML(m.text)}</span>
                </div>
            `;
        }).join("");

        return `
            <div class="card">
                <div class="goal-header">
                    <div>
                        <div class="goal-title">${escapeHTML(g.title)}</div>
                        <div class="goal-date">${dateLabel}</div>
                    </div>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span class="goal-pct">${pct}%</span>
                        <button class="icon-btn-sm danger" onclick="deleteGoal('${g.id}')"><i class="ti ti-trash"></i></button>
                    </div>
                </div>

                <div class="cat-track" style="margin-top:10px;">
                    <div class="cat-fill" style="width:${pct}%; background:${barColor};"></div>
                </div>

                <div class="goal-milestones">
                    ${milestoneHTML || '<p class="dp-task-meta">No milestones yet.</p>'}
                </div>

                <div class="add-subtask-row">
                    <input type="text" id="gt-add-${g.id}" placeholder="Add a milestone...">
                    <button class="icon-btn-sm" onclick="addMilestoneToGoal('${g.id}', document.getElementById('gt-add-${g.id}'))"><i class="ti ti-plus"></i></button>
                </div>
            </div>
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
        renderStudyPlan(data.sessions || [], data.source);

    } catch (err) {
        console.error("Study plan generation failed:", err);
        outputEl.innerHTML = `
            <div class="ai-tip" style="margin-top:14px;">
                <i class="ti ti-alert-triangle"></i>
                <span>Couldn't generate a plan right now. Please try again in a moment.</span>
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

    outputEl.innerHTML = `
        <div class="card" style="margin-top:14px;">
            <div class="card-header"><span>Your revision schedule</span><i class="ti ti-calendar-time"></i></div>
            ${html}
            <p class="ai-source-note">${source === "openai" ? "Generated with AI" : "Generated locally"} · harder topics get more time, with revision and practice sessions built in.</p>
        </div>
    `;
}
