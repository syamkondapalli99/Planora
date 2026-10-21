/* Try Ask Planora's coach with the REAL OpenAI model and a sample profile.
   Run from the Planora folder (uses OPENAI_API_KEY from .env):
       node setup/try-coach.js
       COACH_MODEL=gpt-4.1 node setup/try-coach.js        (compare a stronger model)
   Nothing is saved; it only prints the replies and the checked changes. */
require("dotenv").config();
if (!process.env.OPENAI_API_KEY) { console.log("Add OPENAI_API_KEY to .env first."); process.exit(1); }
const S = require("../smart-plan-server");
const C = require("../coach-server");
const pad = n => String(n).padStart(2, "0");
const d = new Date(), today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, now = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const routine = [{ name: "Classes", days: [2, 6], start: "12:00", end: "15:00", travelBefore: 90, travelAfter: 90 },
                 { name: "Classes", days: [4, 5], start: "15:30", end: "18:30", travelBefore: 90, travelAfter: 90 }];
const week = { wake: "08:00", sleep: "00:00", weekStart: 1, targets: [
    { id: "t1", name: "College", labelId: "col", unit: "hours", min: 8, max: 10 }, { id: "t2", name: "Research", labelId: "res", unit: "hours", min: 5 },
    { id: "t3", name: "Business", labelId: "biz", unit: "hours", min: 10, max: 15 }, { id: "t4", name: "Workouts", labelId: "gym", unit: "sessions", min: 3 }] };
const labels = [{ id: "col", label: "College" }, { id: "res", label: "Research" }, { id: "biz", label: "Business" }, { id: "gym", label: "Workout" }];
const tasks = [
    { id: "m2", title: "Module 2", date: today, start: "", end: "", completed: false, category: "col", duration: 90 },
    { id: "m3", title: "Module 3", date: today, start: "", end: "", completed: false, category: "col", duration: 90 },
    { id: "m4", title: "Module 4", date: S.addDays(today, 1), start: "", end: "", completed: false, category: "col", duration: 90 },
    { id: "wk", title: "Workout", date: today, start: "", end: "", completed: false, category: "gym", duration: 60 },
    { id: "bz", title: "Business: outreach messages", date: today, start: "", end: "", completed: false, category: "biz", duration: 45 }];
const body = { context: { tasks, goals: [], events: [] }, routine, week, moods: [], tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
const { ctx, existing } = S.sanitiseContext(body, today);
ctx.tasks = ctx.tasks.map((t, i) => ({ ...t, category: tasks[i].category }));
const req = { user: { id: "try-coach", guest: true }, headers: {} };
(async () => {
    console.log(`Model: ${process.env.COACH_MODEL || "gpt-4o-mini"} · now ${today} ${now}\n`);
    for (const message of ["plan my day", "I'm going out 10–6 and haven't finished module 2", "add revision for tonight", "what should I do tomorrow?"]) {
        const t0 = Date.now();
        const out = await C.coachTurn({ req, message, ctx, existing, today, now, body, labels });
        console.log("=".repeat(70) + `\nYOU: ${message}   (${((Date.now() - t0) / 1000).toFixed(1)}s)\n\n${out.reply}\n\nSPOKEN: ${out.spoken}`);
        (out.tasks || []).forEach(t => console.log(`  + new   ${t.title} · ${t.date} ${t.start || "anytime"}${t.end ? "–" + t.end : ""}`));
        (out.updates || []).forEach(u => console.log(`  ${u.remove ? "- delete" : "→ move "} ${u.title} · ${u.from.date} ${u.from.start || "anytime"} → ${u.date} ${u.start || "anytime"}`));
        console.log();
    }
})().catch(e => console.error("Failed:", e.message));
