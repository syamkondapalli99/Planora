/* =========================================================
   PLANORA COACH (coach-server.js)

   Ask Planora as a personal planning assistant and advisor.
   Used by /api/smart-plan for day planning, re-planning ("I'm out 10–6,
   haven't finished module 2"), weekly progress and advice. Quick commands
   ("move it to 7pm") keep the existing, cheaper path.

   - Knows the person's week: busy hours + travel, wake/sleep, weekly
     targets (from Profile → My week), goals, tasks and events, and the
     last 7 days (planned vs done, journal MOOD only — never entry text).
   - Remembers the conversation (table planora_chat, one row per user,
     Row Level Security). The server reads/writes it with the person's OWN
     sign-in token, so RLS applies here too. Older turns are folded into a
     short running summary.
   - The model answers in a strict JSON schema: reply (markdown), spoken
     (1–3 sentences for voice) and changes (create / move / update / delete).
   - Every change is checked here (real task ids, valid dates/times, never
     over events, busy hours, travel, or outside wake–sleep) and then goes
     to the app's Preview → Edit → Confirm. Nothing is saved without approval.

   Settings (Render → Environment):
     OPENAI_API_KEY      – already set
     COACH_MODEL         – default gpt-4o-mini (switch to a stronger model if needed)
     COACH_DAILY_LIMIT   – coach replies per person per day, default 40
   ========================================================= */

const S = require("./smart-plan-server");
const { isDate, addDays, dayOfWeek, daysBetween, toMin, toClock, clock12, friendly, schedule } = S;

const D3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_TURNS = 20;                 // messages kept word for word
const TABLE = "planora_chat";

/* ---------------- My week (Profile) ---------------- */
const hhmm = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ""));
function sanitiseWeek(w) {
    w = w && typeof w === "object" ? w : {};
    const targets = (Array.isArray(w.targets) ? w.targets : []).slice(0, 12).map(t => ({
        id: String(t.id || "").slice(0, 40),
        name: String(t.name || "").replace(/[\r\n]/g, " ").trim().slice(0, 40),
        labelId: String(t.labelId || "").slice(0, 40),
        unit: t.unit === "sessions" ? "sessions" : "hours",
        min: Math.max(0, Math.min(100, Number(t.min) || 0)),
        max: Math.max(0, Math.min(100, Number(t.max) || 0))
    })).filter(t => t.name && (t.min || t.max));
    targets.forEach(t => { if (t.max && t.min > t.max) [t.min, t.max] = [t.max, t.min]; if (!t.min) t.min = t.max; });
    return {
        wake: hhmm(w.wake) ? w.wake : "",
        sleep: hhmm(w.sleep) ? w.sleep : "",
        weekStart: Number(w.weekStart) === 0 ? 0 : 1,
        targets
    };
}
// day bounds in minutes (sleep at/after midnight = end of the day)
function dayBounds(week) {
    const wake = week.wake ? toMin(week.wake) : 7 * 60;
    let sleep = week.sleep ? toMin(week.sleep) : 23 * 60;
    if (sleep <= wake) sleep = 24 * 60 - 1;          // 00:00 or 01:00 → plan until just before midnight
    return { wake, sleep };
}
function weekRange(today, weekStart) {
    const back = (dayOfWeek(today) - weekStart + 7) % 7;
    const from = addDays(today, -back);
    return { from, to: addDays(from, 6), dayNo: back + 1 };
}
function durOf(t) {
    const s = toMin(t.start), e = toMin(t.end);
    if (s !== null && e !== null && e > s) return e - s;
    return Number(t.duration) > 0 ? Number(t.duration) : 30;
}
// hours / sessions done this week, from completed tasks with the target's label
function targetProgress(week, tasks, today) {
    const { from, to, dayNo } = weekRange(today, week.weekStart);
    return {
        from, to, dayNo,
        rows: week.targets.map(t => {
            const mine = tasks.filter(x => x.date >= from && x.date <= to && t.labelId && x.category === t.labelId);
            const done = mine.filter(x => x.completed), planned = mine.filter(x => !x.completed && x.date >= today);
            const val = list => t.unit === "sessions" ? list.length : Math.round(list.reduce((n, x) => n + durOf(x), 0) / 6) / 10;
            const expected = t.min * dayNo / 7;
            const doneV = val(done);
            return { ...t, done: doneV, planned: val(planned), status: doneV >= t.min ? "met" : doneV + 0.01 >= expected ? "on track" : "behind" };
        })
    };
}

/* ---------------- fixed blocks for one date (busy hours, travel, events, sleep) ---------------- */
function dayBlocks(existing, date) {
    return existing.filter(b => b.date === date && (b.kind === "event" || b.routine) && toMin(b.start) !== null)
        .map(b => ({ start: b.start, end: b.end || b.start, title: b.title || "Busy", kind: b.kind === "event" ? "event" : b.travel ? "travel" : b.title === "Asleep" ? "sleep" : "busy" }))
        .sort((a, b) => a.start.localeCompare(b.start));
}

/* ---------------- compact context for the model ---------------- */
function coachContext({ ctx, existing, week, labels, moods, today, now, tz }) {
    const L = {};
    (labels || []).forEach(l => { L[l.id] = l.label; });
    const lines = [];
    const dow = dayOfWeek(today);
    const { wake, sleep } = dayBounds(week);
    lines.push(`NOW: ${D3[dow]} ${today} ${now || "?"}${tz ? ` (${tz})` : ""}. When planning today, start from ${now || "now"}.`);
    lines.push(`DAY: wake ${week.wake || "not set (assume 07:00)"}, sleep ${week.sleep || "not set (assume 23:00)"}. Plan only between ${toClock(wake)} and ${toClock(sleep)}.`);
    // Day by day: busy hours, travel and events already worked out for each date (models get weekdays wrong)
    const end7 = addDays(today, 7);
    lines.push("DAY BY DAY — fixed times already worked out (never plan over them; a day not listed as busy is free):");
    for (let i = 0; i <= 7; i++) {
        const date = addDays(today, i);
        const blocks = dayBlocks(existing || [], date).filter(b => b.kind !== "sleep");
        lines.push(`- ${D3[dayOfWeek(date)]} ${date}${i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : ""}: ${blocks.length ? blocks.map(b => `${b.start}-${b.end} ${b.title}${b.kind === "travel" ? " (phone-friendly only)" : ""}`).join("; ") : "no busy hours or events"}`);
    }
    const tasks = (ctx.tasks || []);
    const soon = tasks.filter(t => t.date >= today && t.date <= end7).slice(0, 80);
    const overdue = tasks.filter(t => !t.completed && t.date < today && t.date >= addDays(today, -7)).slice(0, 20);
    const tl = t => `- id=${t.id} | ${t.date} ${t.start ? `${t.start}-${t.end || "?"}` : "anytime"} | ${t.completed ? "DONE" : "todo"} | ${t.title}${t.category && L[t.category] ? ` | ${L[t.category]}` : ""}${t.goalId ? ` | goal=${t.goalId}` : ""}${t.priority === "high" ? " | high priority" : ""}${t.deadline ? ` | due ${t.deadline}` : ""} | ${durOf(t)}m`;
    lines.push(soon.length ? "TASKS today → next 7 days:" : "TASKS: none planned in the next 7 days.");
    soon.forEach(t => lines.push(tl(t)));
    if (overdue.length) { lines.push("UNFINISHED from the last 7 days:"); overdue.forEach(t => lines.push(tl(t))); }
    if (week.targets.length) {
        const p = targetProgress(week, tasks, today);
        lines.push(`WEEKLY TARGETS (week ${p.from} to ${p.to}, today is day ${p.dayNo} of 7):`);
        p.rows.forEach(r => lines.push(`- ${r.name}${r.labelId && L[r.labelId] ? ` (label ${r.labelId})` : ""}: target ${r.min}${r.max && r.max !== r.min ? "-" + r.max : ""} ${r.unit}/week; done ${r.done}; still planned ${r.planned}; ${r.status}`));
    } else lines.push("WEEKLY TARGETS: none set.");
    const goals = (ctx.goals || []).filter(g => g.status !== "done" && g.status !== "archived").slice(0, 10);
    if (goals.length) {
        lines.push("GOALS:");
        goals.forEach(g => lines.push(`- id=${g.id} | ${g.title}${g.date ? ` by ${g.date}` : ""} | ${g.progress || 0}%${(g.milestones || []).length ? ` | next: ${(g.milestones || []).filter(m => !m.done).slice(0, 3).map(m => m.text).join("; ") || "all milestones done"}` : ""}`));
    }
    const days = [];
    for (let i = 7; i >= 1; i--) {
        const d = addDays(today, -i);
        const dt = tasks.filter(t => t.date === d);
        const mood = (moods || []).find(m => m.date === d);
        if (dt.length || mood) days.push(`${D3[dayOfWeek(d)]} ${dt.filter(t => t.completed).length}/${dt.length} done${mood ? `, mood ${mood.mood}` : ""}`);
    }
    if (days.length) lines.push("LAST 7 DAYS: " + days.join("; "));
    if (labels && labels.length) lines.push("LABELS (use label_id): " + labels.map(l => `${l.id}=${l.label}`).join(", "));
    return lines.join("\n").slice(0, 9000);
}

const SYSTEM = `You are Planora, a calm, encouraging personal planning assistant and advisor for students and working professionals. You help the person plan their days around their real schedule and make steady progress on their goals in study, work, health and personal life.

Use only the context provided: the current local date and time, busy hours, travel time, wake and sleep times, existing tasks and events, weekly targets with progress, goals, recent days and the conversation. Never plan over events, busy hours or travel time. When planning the rest of today, start from the current time. Never invent tasks, deadlines or data the person didn't give you.

When asked to plan:
1. One short line acknowledging the situation.
2. A Time | Task table. Hardest or most important work first, while energy is high. Use travel time for phone-friendly tasks (messages, reading, planning). Include meals, breaks and the sleep time.
3. 'Done today if:' with 2–4 concrete outcomes.
4. 'Moved:' listing anything moved to another day and where.
5. At most 2 short tips.

Be realistic. If there is too much, keep the most important things and move the rest to the next free slots; never cram. When the person falls behind or a day goes wrong, don't scold them. Adjust the plan and keep them moving: missing once is normal, the goal is getting back on track the next day. Mention weekly targets when it helps ('You're ahead on college this week, so tonight can go to research').

For health, diet and fitness, give general, practical guidance: consistent sleep, protein at breakfast, water, balanced meals, regular exercise and walking. Introduce new habits gradually rather than all at once. Don't give medical diagnoses, extreme diets or calorie targets; suggest a professional for medical concerns.

If key information is missing, ask one short question, or make a reasonable assumption and say so. Keep replies short, warm and scannable, with tables and bullets, not long paragraphs. All task changes go into \`changes\` for the person to preview and approve.

Output format (Planora builds the final table from your answer, so fill the fields exactly):
- "intro": the one short acknowledging line.
- "plan_date": the YYYY-MM-DD you are planning (today or another day), or "" if you are only answering/advising.
- "rows": the plan for that day in time order. Each row: start/end in 24-HOUR "HH:MM" (2 PM = "14:00", 7:45 PM = "19:45"), "text", "kind", "task_id", "label_id".
  kind "task" = an existing task from TASKS/UNFINISHED (task_id required); "new_task" = new work the person asked for or clearly implied (task_id ""); "meal", "break" = meals and breaks; "out" = time the person said they're out or busy (e.g. 10:00-18:00), with phone-friendly ideas in the text; "other" = anything else that isn't a task.
  Don't add rows for the busy hours, travel, events or sleep listed in DAY BY DAY — Planora adds those itself. No "free time" rows. Use an existing task instead of a new_task with the same name.
- "done_if": 2–4 concrete outcomes for the day (empty if not planning).
- "moved": existing tasks you move to ANOTHER day (task_id, date, start/end 24-hour or "" for anytime).
- "tips": at most 2 short tips.
- "answer": for questions, progress or advice without a day plan: a short markdown answer (bullets fine, no tables). Otherwise "".
- "spoken": 1–3 short sentences to read aloud, no tables or markdown.
Never change events. Every existing task you schedule must be a "task" row or in "moved" — that is how the change is shown to the person for approval.`;

const ROW = {
    type: "object", additionalProperties: false,
    required: ["start", "end", "text", "kind", "task_id", "label_id"],
    properties: {
        start: { type: "string" }, end: { type: "string" }, text: { type: "string" },
        kind: { type: "string", enum: ["task", "new_task", "meal", "break", "out", "other"] },
        task_id: { type: "string" }, label_id: { type: "string" }
    }
};
const SCHEMA = {
    name: "planora_coach",
    strict: true,
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["intro", "plan_date", "rows", "done_if", "moved", "tips", "answer", "spoken"],
        properties: {
            intro: { type: "string" },
            plan_date: { type: "string" },
            rows: { type: "array", items: ROW },
            done_if: { type: "array", items: { type: "string" } },
            moved: {
                type: "array",
                items: { type: "object", additionalProperties: false, required: ["task_id", "date", "start", "end"],
                    properties: { task_id: { type: "string" }, date: { type: "string" }, start: { type: "string" }, end: { type: "string" } } }
            },
            tips: { type: "array", items: { type: "string" } },
            answer: { type: "string" },
            spoken: { type: "string" }
        }
    }
};

async function callModel(messages, { model, schema = SCHEMA, temperature = 0.4, maxTokens = 1400 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 40000);
    try {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
            body: JSON.stringify({
                model: model || process.env.COACH_MODEL || "gpt-4o-mini",
                temperature,
                max_tokens: maxTokens,
                response_format: schema ? { type: "json_schema", json_schema: schema } : { type: "text" },
                messages
            }),
            signal: ctrl.signal
        });
        if (!r.ok) throw new Error("OpenAI " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200));
        const data = await r.json();
        const text = data.choices?.[0]?.message?.content || "";
        return schema ? JSON.parse(text || "{}") : text;
    } finally { clearTimeout(timer); }
}

/* ---------------- checking the model's changes ---------------- */
const NOT_A_TASK = /^(breakfast|lunch|dinner|brunch|snack|meal|eat|coffee|tea|break|short break|rest|relax|wind down|sleep|bed|bedtime|nap|travel|commute|journey|out\b|going out|free time|shower)\b/i;
const norm = t => String(t || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function validateChanges(raw, { ctx, existing, today, now, week, labels, message, extraFixed = [] }) {
    const notes = [];
    const tasksById = {};
    (ctx.tasks || []).forEach(t => { tasksById[String(t.id)] = t; });
    const labelIds = new Set((labels || []).map(l => l.id));
    const goalIds = new Set((ctx.goals || []).map(g => String(g.id)));
    const { wake, sleep } = dayBounds(week);
    const nowMin = toMin(now);
    const askedForMeals = /\b(add|schedule|plan|remind|put)\b.*\b(lunch|dinner|breakfast|meal|break|nap|rest)\b/i.test(message || "");
    const touched = new Set();
    const creates = [], updates = [];
    const seenNew = new Set();

    // busy = events, busy hours, travel, sleep, and other timed tasks that aren't being changed
    const fixed = (existing || []).filter(e => e.kind === "event" || e.routine).concat(extraFixed);
    const accepted = [];                                    // timed items already accepted in this answer
    const changingIds = new Set((raw || []).filter(c => c && c.task_id && tasksById[c.task_id]).map(c => c.task_id));
    const otherTasks = (existing || []).filter(e => !e.kind && !e.routine && e.id && !changingIds.has(String(e.id)));
    const clash = (date, s, e) => fixed.concat(otherTasks).concat(accepted).find(b => b.date === date && toMin(b.start) !== null &&
        s < (toMin(b.end) !== null && toMin(b.end) > toMin(b.start) ? toMin(b.end) : toMin(b.start) + 30) && e > toMin(b.start));

    function placeTime(c, title, base) {
        const date = isDate(c.date) ? c.date : base.date || today;
        if (daysBetween(today, date) < 0) return { error: "a date in the past" };
        let dur = Number(c.duration_min) > 0 ? Math.min(600, Number(c.duration_min)) : durOf(base);
        let s = hhmm(c.start) ? toMin(c.start) : null;
        let e = hhmm(c.end) ? toMin(c.end) : null;
        if (s === null) return { date, start: "", end: "", duration: dur };           // anytime
        [s, e] = pmFix(s, e, wake, sleep);
        if (e !== null && e > s) dur = e - s; else e = s + dur;
        const lateStart = date === today && nowMin !== null && s < nowMin - 5;
        const outside = s < wake || e > sleep;
        const hit = clash(date, s, e);
        if (lateStart || outside || hit) {
            const why = hit ? `it clashed with ${hit.title || "something else"}` : outside ? "it was outside your waking hours" : "that time has passed";
            const placed = schedule([{ title, date, start: toClock(s), duration: dur, flexible: true }],
                { today, now, existing: fixed.concat(otherTasks).concat(accepted), dayStart: wake, dayEnd: sleep });
            const p = placed[0];
            if (!p || !p.start || p.date !== date && daysBetween(date, p.date) > 3) return { error: `${why} and there was no free time nearby` };
            notes.push(`**${title}** went to ${p.date === date ? clock12(p.start) : `${friendly(p.date, today)} ${clock12(p.start)}`} because ${why}.`);
            return { date: p.date, start: p.start, end: p.end, duration: p.duration };
        }
        return { date, start: toClock(s), end: toClock(e), duration: dur };
    }

    for (const c of (Array.isArray(raw) ? raw : []).slice(0, 30)) {
        if (!c || !c.action) continue;
        const title = String(c.title || "").replace(/[\r\n]/g, " ").trim().slice(0, 140);
        if (c.action === "create") {
            if (!title) continue;
            if (NOT_A_TASK.test(title) && !askedForMeals) continue;                     // meals, breaks, sleep, travel
            const key = norm(title);
            if (seenNew.has(key)) continue;
            // already a task? move that one instead of making a duplicate
            const dup = (ctx.tasks || []).find(t => !t.completed && norm(t.title) === key && daysBetween(today, t.date) >= -7);
            if (dup && touched.has(String(dup.id))) continue;            // already moved in this answer
            if (dup) { c.action = "move"; c.task_id = String(dup.id); }
            else {
                seenNew.add(key);
                const t = placeTime(c, title, { date: today });
                if (t.error) { notes.push(`I left out **${title}** (${t.error}).`); continue; }
                if (t.start) accepted.push({ date: t.date, start: t.start, end: t.end, title });
                creates.push({
                    title, date: t.date, start: t.start, end: t.end, duration: t.duration,
                    ...(labelIds.has(c.label_id) ? { category: c.label_id } : {}),
                    ...(goalIds.has(String(c.goal_id)) ? { goalId: String(c.goal_id) } : {}),
                    source: "planora-coach"
                });
                continue;
            }
        }
        const o = tasksById[String(c.task_id)];
        if (!o || touched.has(String(o.id))) continue;                                  // only the person's real tasks, once each
        touched.add(String(o.id));
        if (c.action === "delete") {
            updates.push({ id: String(o.id), title: o.title, date: o.date, start: o.start, end: o.end, duration: durOf(o), remove: true, from: { date: o.date, start: o.start, end: o.end } });
            continue;
        }
        const t = placeTime(c, o.title, o);
        if (t.error) { notes.push(`I kept **${o.title}** where it is (${t.error}).`); continue; }
        if (t.date === o.date && t.start === (o.start || "") && t.end === (o.end || "") && !(c.action === "update" && title && title !== o.title)) continue;   // no real change
        if (t.start) accepted.push({ date: t.date, start: t.start, end: t.end, title: o.title });
        updates.push({
            id: String(o.id), title: c.action === "update" && title ? title : o.title, rename: c.action === "update" && title && title !== o.title,
            date: t.date, start: t.start, end: t.end, duration: t.duration, from: { date: o.date, start: o.start, end: o.end }
        });
    }
    return { tasks: creates, updates, notes };
}

// "02:00" before wake-up that only makes sense as 2 PM (models sometimes write 12-hour times)
function pmFix(s, e, wake, sleep) {
    if (s !== null && s < wake && s < 12 * 60 && s + 720 >= wake && s + 720 < sleep) {
        s += 720;
        if (e !== null && e + 720 <= 24 * 60 && e < wake + 1) e += 720;
    }
    return [s, e];
}

/* ---------------- turn the model's day plan into checked changes + the reply ---------------- */
const fmt12 = hm => { const m = toMin(hm); if (m === null) return ""; const h = Math.floor(m / 60) % 24, mi = m % 60; return `${h % 12 || 12}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const span = (a, b) => b && b !== a ? `${fmt12(a)}–${fmt12(b)}` : fmt12(a);
const clean1 = t => String(t || "").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
function composePlan(ai, { ctx, existing, today, now, week, labels, message }) {
    const { wake, sleep } = dayBounds(week);
    const day = isDate(ai.plan_date) && daysBetween(today, ai.plan_date) >= 0 && daysBetween(today, ai.plan_date) <= 14 ? ai.plan_date : "";
    const rows = (Array.isArray(ai.rows) ? ai.rows : []).slice(0, 30);
    const times = r => { let s = hhmm(r.start) ? toMin(r.start) : null, e = hhmm(r.end) ? toMin(r.end) : null; [s, e] = pmFix(s, e, wake, sleep); return { s, e }; };
    // time the person is out/busy counts as busy for this plan
    const outBlocks = day ? rows.filter(r => r.kind === "out").map(r => ({ ...times(r), r })).filter(x => x.s !== null && x.e !== null && x.e > x.s)
        .map(x => ({ date: day, start: toClock(x.s), end: toClock(x.e), title: clean1(x.r.text) || "Out", kind: "event", out: true })) : [];
    const changes = [];
    if (day) rows.forEach(r => {
        const t = times(r);
        const st = t.s === null ? "" : toClock(t.s), en = t.e === null ? "" : toClock(t.e);
        if (r.kind === "task" && r.task_id) changes.push({ action: "move", task_id: r.task_id, title: "", date: day, start: st, end: en, duration_min: 0, label_id: "", goal_id: "" });
        else if (r.kind === "new_task" && clean1(r.text)) changes.push({ action: "create", task_id: "", title: clean1(r.text), date: day, start: st, end: en, duration_min: 0, label_id: r.label_id || "", goal_id: "" });
    });
    (Array.isArray(ai.moved) ? ai.moved : []).slice(0, 15).forEach(m => {
        if (m && m.task_id && isDate(m.date)) changes.push({ action: "move", task_id: m.task_id, title: "", date: m.date, start: hhmm(m.start) ? m.start : "", end: hhmm(m.end) ? m.end : "", duration_min: 0, label_id: "", goal_id: "" });
    });
    const checked = validateChanges(changes, { ctx, existing, today, now, week, labels, message, extraFixed: outBlocks });

    // the table: checked tasks + the model's meals/breaks/out rows + Planora's own busy/travel/event rows
    const parts = [];
    if (String(ai.intro || "").trim()) parts.push(clean1(ai.intro).slice(0, 300));
    if (day) {
        const nowMin = day === today ? toMin(now) : null;
        const table = [];
        checked.updates.filter(u => !u.remove && u.date === day).forEach(u => table.push({ s: u.start, e: u.end, text: u.title }));
        checked.tasks.filter(t => t.date === day).forEach(t => table.push({ s: t.start, e: t.end, text: t.title }));
        // the day's other unfinished tasks stay in the table where they already are
        const changedIds = new Set(checked.updates.map(u => String(u.id)));
        (ctx.tasks || []).filter(t => t.date === day && !t.completed && !changedIds.has(String(t.id)))
            .forEach(t => table.push({ s: t.start || "", e: t.end || "", text: t.title }));
        // busy hours, travel and sleep come from Planora's own data, never from the model
        const routineNames = new Set((ctx.routine || []).map(r => r.name.toLowerCase()));
        const notDisplay = r => routineNames.has(clean1(r.text).toLowerCase()) || /\b(class(es)?|lecture|college|work shift|travel|commute|journey|sleep|bed ?time|go to bed|wake up|free time|prepare for bed)\b/i.test(r.text || "");
        rows.filter(r => ["meal", "break", "out", "other"].includes(r.kind) && (r.kind === "out" || !notDisplay(r))).forEach(r => {
            const t = times(r);
            if (t.s === null || !clean1(r.text)) return;
            table.push({ s: toClock(t.s), e: t.e === null ? "" : toClock(t.e), text: clean1(r.text) });
        });
        dayBlocks(existing || [], day).forEach(b => {
            if (b.kind === "sleep") return;
            table.push({ s: b.start, e: b.end, text: b.kind === "travel" ? `${b.title} (phone-friendly tasks)` : b.title });
        });
        if (week.sleep) table.push({ s: week.sleep === "00:00" ? "23:59" : week.sleep, e: "", text: "Sleep", sleep: true });
        const timed = table.filter(r => r.s && (nowMin === null || toMin(r.e || r.s) > nowMin - 1 || r.sleep))
            .sort((a, b) => (a.sleep ? 1 : 0) - (b.sleep ? 1 : 0) || a.s.localeCompare(b.s));
        const anytime = table.filter(r => !r.s);
        if (timed.length || anytime.length) {
            parts.push(["| Time | Task |", "|---|---|"].concat(timed.map(r => `| ${r.sleep ? (week.sleep === "00:00" ? "12:00 AM" : fmt12(r.s)) : span(r.s, r.e)} | ${r.text} |`))
                .concat(anytime.map(r => `| Anytime | ${r.text} |`)).join("\n"));
        }
        const done = (Array.isArray(ai.done_if) ? ai.done_if : []).map(clean1).filter(Boolean).slice(0, 4);
        if (done.length) parts.push(`**Done ${day === today ? "today" : "that day"} if:** ${done.join(", ")}.`.replace(/\.\.$/, "."));
    }
    const movedOut = checked.updates.filter(u => !u.remove && (!day || u.date !== day));
    if (movedOut.length) parts.push(`**Moved:** ${movedOut.map(u => `${u.title} → ${friendly(u.date, today)}${u.start ? " " + fmt12(u.start) : ""}`).join(", ")}.`);
    if (String(ai.answer || "").trim()) parts.push(String(ai.answer).trim().slice(0, 2500));
    if (checked.notes.length) parts.push(checked.notes.map(n => "- " + n).join("\n"));
    const tips = (Array.isArray(ai.tips) ? ai.tips : []).map(clean1).filter(Boolean).slice(0, 2);
    if (tips.length) parts.push(tips.map(t => "- Tip: " + t.replace(/^tip:\s*/i, "")).join("\n"));
    return { reply: parts.join("\n\n") || "Here's what I suggest.", tasks: checked.tasks, updates: checked.updates };
}

/* ---------------- conversation memory ---------------- */
const devMemory = new Map();            // local development without Supabase only
let CONFIG = null;                      // Supabase URL + public anon key (set by install)
function memoryApi(supa, req) {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/, "").trim();
    const uid = req.user && req.user.id;
    const real = Boolean(supa && supa.url && supa.key && token && uid && !req.user.guest);
    const base = real ? `${supa.url.replace(/\/$/, "")}/rest/v1/${TABLE}` : "";
    const headers = real ? { apikey: supa.key, Authorization: "Bearer " + token, "Content-Type": "application/json" } : {};
    return {
        async load() {
            if (!real) return devMemory.get(uid) || { messages: [], summary: "" };
            const r = await fetch(`${base}?user_id=eq.${encodeURIComponent(uid)}&select=messages,summary`, { headers });
            if (!r.ok) throw new Error("chat load " + r.status);
            const rows = await r.json();
            return rows[0] ? { messages: Array.isArray(rows[0].messages) ? rows[0].messages : [], summary: rows[0].summary || "" } : { messages: [], summary: "" };
        },
        async save(mem) {
            if (!real) { devMemory.set(uid, mem); return; }
            const r = await fetch(`${base}?on_conflict=user_id`, {
                method: "POST", headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
                body: JSON.stringify({ user_id: uid, messages: mem.messages, summary: mem.summary, updated_at: new Date().toISOString() })
            });
            if (!r.ok) throw new Error("chat save " + r.status);
        },
        async clear() {
            if (!real) { devMemory.delete(uid); return; }
            const r = await fetch(`${base}?user_id=eq.${encodeURIComponent(uid)}`, { method: "DELETE", headers: { ...headers, Prefer: "return=minimal" } });
            if (!r.ok) throw new Error("chat clear " + r.status);
        }
    };
}
async function trimMemory(mem) {
    if (mem.messages.length <= MAX_TURNS) return mem;
    const old = mem.messages.slice(0, mem.messages.length - MAX_TURNS);
    const keep = mem.messages.slice(-MAX_TURNS);
    let summary = mem.summary;
    try {
        if (!process.env.OPENAI_API_KEY) throw new Error("no key");
        summary = await callModel([
            { role: "system", content: "Update a running summary of a planning chat. Max 90 words, plain text. Keep only facts useful for future planning: unfinished work, commitments, preferences, how the person is doing. No greetings." },
            { role: "user", content: `CURRENT SUMMARY: ${summary || "(none)"}\nOLDER MESSAGES:\n${old.map(m => `${m.role}: ${String(m.text).slice(0, 400)}`).join("\n")}` }
        ], { model: process.env.OPENAI_MODEL || "gpt-4o-mini", schema: null, temperature: 0.2, maxTokens: 220 });
    } catch {
        summary = (summary + " " + old.filter(m => m.role === "user").map(m => String(m.text).slice(0, 120)).join(" | ")).slice(-700);
    }
    return { messages: keep, summary: String(summary || "").trim().slice(0, 900) };
}

/* ---------------- daily limit (per person) ---------------- */
const usage = new Map();
function overLimit(uid, today) {
    const limit = Math.max(1, Number(process.env.COACH_DAILY_LIMIT) || 40);
    const u = usage.get(uid);
    if (!u || u.date !== today) { usage.set(uid, { date: today, n: 0 }); return false; }
    return u.n >= limit;
}
function countUse(uid, today) { const u = usage.get(uid) || { date: today, n: 0 }; u.n++; usage.set(uid, u); }

/* ---------------- when to use the coach ---------------- */
// re-planning a day that changed, or progress / advice — new goals and simple adds keep the existing path
const REPLAN = /\b(going out|i'?m out|i'?ll be out|out (from|between|all day|today|tonight|until|till)|away (from|today|tomorrow|until|till)|busy (from|between|until|till)|haven'?t (finished|done|started)|didn'?t (finish|get to|manage)|not (finished|done) (yet|with)|fell behind|running (late|behind)|woke up late|overslept|feeling (sick|ill|unwell|tired|exhausted)|i'?m (sick|ill|tired|exhausted|burnt out|overwhelmed)|rest of (the|my) day|re-?plan|reschedule my (day|week|evening)|what should i (do|focus on|work on)|how am i doing|am i on track|on track (this|for the) week)\b/i;
const ADVICE = /^(please\s+)?(help me (focus|study better|stay on track|build|improve|get better|be more)|how (do|can|should) i\b|any (tips|advice)\b|tips? (for|on)\b|advice (for|on)\b|give me (some )?(tips|advice)\b|i want to (build|improve|get better|be more)\b)/i;
function wantsCoach(message, mode) {
    if (["plan_day", "behind", "limited", "move_unfinished", "now", "question"].includes(mode)) return true;
    if (mode === "goal_status") return true;
    if (ADVICE.test(message.trim())) return true;
    if (mode === "edit") return REPLAN.test(message) && /\b(day|today|tomorrow|week|evening)\b/i.test(message);
    return REPLAN.test(message);
}

/* ---------------- the coach turn ---------------- */
async function coachTurn({ req, supa = CONFIG, message, ctx, existing, today, now, body, labels }) {
    const uid = (req.user && req.user.id) || "anon";
    if (overLimit(uid, today)) return { limited: true };
    const week = sanitiseWeek(body.week);
    const moods = (Array.isArray(body.moods) ? body.moods : []).slice(0, 10)
        .filter(m => m && isDate(m.date) && m.mood).map(m => ({ date: m.date, mood: String(m.mood).slice(0, 20) }));
    const tz = String(body.tz || "").replace(/[^A-Za-z0-9_/+-]/g, "").slice(0, 40);
    const mem = memoryApi(supa, req);
    let memory = { messages: [], summary: "" };
    try { memory = await mem.load(); } catch (e) { console.error("Coach memory:", e.message); memory = { messages: (body.history || []).slice(-6).map(h => ({ role: h.role === "assistant" ? "assistant" : "user", text: String(h.text || "").slice(0, 800) })), summary: "" }; }

    const context = coachContext({ ctx, existing, week, labels, moods, today, now, tz });
    const messages = [{ role: "system", content: SYSTEM }, { role: "system", content: "CONTEXT\n" + context }];
    if (memory.summary) messages.push({ role: "system", content: "EARLIER IN THIS CHAT: " + memory.summary });
    memory.messages.slice(-MAX_TURNS).forEach(m => messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.text || "").slice(0, 1500) }));
    messages.push({ role: "user", content: message });

    const ai = await callModel(messages);
    countUse(uid, today);
    const checked = composePlan(ai, { ctx, existing, today, now, week, labels, message });
    const reply = checked.reply.slice(0, 5000);
    const spoken = String(ai.spoken || "").replace(/[*_#|`]/g, "").trim().slice(0, 400);

    // remember this turn
    try {
        const next = await trimMemory({
            summary: memory.summary,
            messages: memory.messages.concat([{ role: "user", text: message.slice(0, 1500), at: new Date().toISOString() }, { role: "assistant", text: reply.slice(0, 2500), at: new Date().toISOString() }])
        });
        await mem.save(next);
    } catch (e) { console.error("Coach memory save:", e.message); }

    return { reply, spoken, tasks: checked.tasks, updates: checked.updates, source: "coach" };
}

/* ---------------- routes: chat history ---------------- */
function install(app, requireAuth, supa) {
    CONFIG = supa || null;
    app.get("/api/coach/history", requireAuth, async (req, res) => {
        try { const m = await memoryApi(supa, req).load(); res.json({ messages: m.messages.slice(-MAX_TURNS), summary: m.summary }); }
        catch (e) { console.error("Coach history:", e.message); res.json({ messages: [], summary: "", unavailable: true }); }
    });
    app.delete("/api/coach/history", requireAuth, async (req, res) => {
        try { await memoryApi(supa, req).clear(); res.json({ ok: true }); }
        catch (e) { console.error("Coach clear:", e.message); res.status(500).json({ error: "Planora couldn't clear the chat right now. Please try again." }); }
    });
}

module.exports = { install, coachTurn, wantsCoach, sanitiseWeek, dayBounds, targetProgress, coachContext, validateChanges, composePlan, pmFix, dayBlocks, trimMemory, SYSTEM, SCHEMA };
