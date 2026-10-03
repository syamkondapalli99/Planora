require("dotenv").config();

const express = require("express");
const path = require("path");
const rateLimit = require("express-rate-limit");

const app = express();
// On a hosting service (Render, Railway, Fly…) requests arrive through its proxy:
// trust it so rate limits count each visitor, not the proxy. Render sets RENDER=true.
if (process.env.TRUST_PROXY || process.env.RENDER) app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

// Accounts (email/password, Google, Apple), sessions, per-user data
// and page protection. Must come before express.json() and static files.
const auth = require("./auth-server");
auth.install(app);

// One-box AI planner: tasks, deadlines, repeats and goals -> a scheduled plan
require("./smart-plan-server").install(app, auth.requireAuth);
require("./gcal-server").install(app, auth.requireAuth, auth.config);   // Google Calendar (read-only)

app.use(express.json());

// Installable app (phones + tablets): the service worker must always be fresh,
// and the manifest needs its proper type.
app.get("/sw.js", (req, res) => {
    res.set({ "Cache-Control": "no-cache", "Service-Worker-Allowed": "/", "Content-Type": "application/javascript; charset=utf-8" });
    res.sendFile(path.join(__dirname, "sw.js"));
});
app.get("/manifest.webmanifest", (req, res) => {
    res.set({ "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-cache" });
    res.sendFile(path.join(__dirname, "manifest.webmanifest"));
});

// Serves your existing site (dashboard.html, calendar.html, style.css, etc.)
// Pages and scripts are revalidated each time so phones pick up updates.
app.use(express.static(__dirname, {
    setHeaders(res, file) {
        if (/\.(html|js|css)$/.test(file)) res.setHeader("Cache-Control", "no-cache");
    }
}));


// Rate limiter for the AI endpoints only (10 requests per 15 minutes per IP).
// Not applied globally — attached only to /api/plan and /api/study-plan below.
const aiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    standardHeaders: true,
    legacyHeaders: false
});


/* =========================================
   POST /api/plan
   Body: { message: "...", today: "YYYY-MM-DD" }
   Returns: { tasks: [ { title, date, start, end } ] }

   MODE SWITCH:
   - No OPENAI_API_KEY in .env  -> uses the built-in mock
     generator below. No account, no internet call, works
     right now.
   - OPENAI_API_KEY present     -> calls the real OpenAI API
     automatically. Nothing else needs to change.
   ========================================= */

app.post("/api/plan", auth.requireAuth, aiLimiter, async (req, res) => {

    const { message, today } = req.body;

    if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "A message is required." });
    }

    const todayDate = today || new Date().toLocaleDateString("en-CA");

    try {

        const plan = process.env.OPENAI_API_KEY
            ? await getPlanFromOpenAI(message, todayDate)
            : getMockPlan(message, todayDate);

        res.json(plan);

    } catch (error) {

        console.error("Plan generation failed:", error);
        res.status(500).json({ error: "Something went wrong generating your plan." });
    }

});


/* =========================================
   MOCK PLAN GENERATOR (no AI, no account)

   Splits the message into rough "tasks" on commas, " and ",
   or newlines, then spreads them across the next few days
   with sensible-looking times. Good enough to test the full
   chat -> review -> save -> calendar flow end to end.
   ========================================= */

function getMockPlan(message, todayDate) {

    console.log("[MOCK MODE] No OPENAI_API_KEY set — generating a fake plan for testing.");

    const pieces = message
        .split(/,| and |\n/i)
        .map(s => s.trim())
        .filter(Boolean);

    const titles = pieces.length > 0 ? pieces : [message.trim()];

    const startHours = [9, 11, 14, 16, 18];

    const tasks = titles.slice(0, 6).map((title, index) => {

        const date = new Date(todayDate + "T00:00:00");
        date.setDate(date.getDate() + index); // spread across consecutive days

        const hour = startHours[index % startHours.length];

        return {
            title: capitalize(title),
            date: date.toLocaleDateString("en-CA"),
            start: `${String(hour).padStart(2, "0")}:00`,
            end: `${String(hour + 1).padStart(2, "0")}:00`
        };
    });

    return { tasks };
}

function capitalize(text) {

    const trimmed = text.trim();

    if (!trimmed) return "Task";

    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}


/* =========================================
   REAL OPENAI CALL
   (only used once OPENAI_API_KEY is set in .env)
   ========================================= */

async function getPlanFromOpenAI(message, todayDate) {

    const systemPrompt =
`You are Planora, a weekly planning assistant. Today's date is ${todayDate}.
Turn the user's request into a structured schedule.
Respond with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:

{
  "tasks": [
    {
      "title": "Short task title",
      "date": "YYYY-MM-DD",
      "start": "HH:MM",
      "end": "HH:MM"
    }
  ]
}

Rules:
- "date" must be an actual calendar date (YYYY-MM-DD), computed relative to today (${todayDate}). Never return a weekday name alone.
- "start" and "end" are 24-hour "HH:MM". Pick sensible times if the user didn't specify any.
- Keep titles short and human, e.g. "Client call" not "Client_Call_1".`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
            model: "gpt-4o-mini",
            temperature: 0.4,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: message }
            ]
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error("OpenAI error:", errText);
        throw new Error("OpenAI request failed");
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || "{}";

    return JSON.parse(raw);
}


/* =========================================
   POST /api/study-plan
   Body: { subject, examDate, hoursPerDay, topics: [{name, difficulty}], today }
   Returns: { sessions: [ { date, topic, type, start, end } ], source: "mock"|"openai" }

   Used by the Study Planner tool on planner.html. Harder topics get
   more/longer sessions, and dedicated revision + practice sessions
   are woven in as the exam date approaches.

   Same MODE SWITCH as /api/plan above:
   - No OPENAI_API_KEY -> built-in rule-based mock generator.
   - OPENAI_API_KEY set -> real OpenAI call, same shape returned.
   ========================================= */

app.post("/api/study-plan", auth.requireAuth, aiLimiter, async (req, res) => {

    const { subject, examDate, hoursPerDay, topics, today } = req.body;

    if (!subject || typeof subject !== "string") {
        return res.status(400).json({ error: "A subject is required." });
    }

    if (!examDate) {
        return res.status(400).json({ error: "An exam date is required." });
    }

    if (!Array.isArray(topics) || topics.length === 0) {
        return res.status(400).json({ error: "At least one topic is required." });
    }

    const todayDate = today || new Date().toLocaleDateString("en-CA");
    const hours = Number(hoursPerDay) > 0 ? Number(hoursPerDay) : 2;

    try {

        const plan = process.env.OPENAI_API_KEY
            ? await getStudyPlanFromOpenAI(subject, examDate, hours, topics, todayDate)
            : getMockStudyPlan(subject, examDate, hours, topics, todayDate);

        res.json(plan);

    } catch (error) {

        console.error("Study plan generation failed:", error);
        res.status(500).json({ error: "Something went wrong generating your study plan." });
    }

});


/* =========================================
   MOCK STUDY PLAN GENERATOR (no AI, no account)

   Uses a weighted round-robin so harder topics come up more often
   (and get longer sessions), spreads sessions across the days
   between today and the exam date, and turns the final stretch of
   days into dedicated practice/revision days.
   ========================================= */

const STUDY_DIFFICULTY_WEIGHT = { easy: 1, medium: 2, hard: 3 };
const STUDY_DIFFICULTY_MINUTES = { easy: 30, medium: 45, hard: 60 };

function getMockStudyPlan(subject, examDate, hoursPerDay, topics, todayDate) {

    console.log("[MOCK MODE] No OPENAI_API_KEY set — generating a rule-based study plan for testing.");

    const MS_DAY = 24 * 60 * 60 * 1000;

    const start = new Date(todayDate + "T00:00:00");
    const end = new Date(examDate + "T00:00:00");

    let totalDays = Math.round((end - start) / MS_DAY);
    if (!isFinite(totalDays) || totalDays < 1) totalDays = 1;
    totalDays = Math.min(totalDays, 21); // cap how far out we plan

    const cleanTopics = topics
        .filter(t => t && t.name)
        .map(t => ({
            name: String(t.name).trim(),
            difficulty: STUDY_DIFFICULTY_WEIGHT[t.difficulty] ? t.difficulty : "medium"
        }));

    // last ~15% of days (min 1) become dedicated practice/revision days
    const practiceDays = totalDays <= 3 ? 1 : Math.max(1, Math.round(totalDays * 0.15));
    const normalDays = Math.max(0, totalDays - practiceDays);

    const studyOrder = weightedRoundRobin(
        cleanTopics,
        t => STUDY_DIFFICULTY_WEIGHT[t.difficulty] || 2,
        normalDays
    );

    const sessions = [];
    const studiedSoFar = [];

    for (let d = 0; d < totalDays; d++) {

        const date = new Date(start.getTime() + d * MS_DAY).toLocaleDateString("en-CA");

        let minutesLeft = Math.round(hoursPerDay * 60);
        if (minutesLeft < 15) minutesLeft = 15;

        let clock = 16 * 60; // sessions default to starting at 4:00 PM

        if (d >= normalDays) {
            // PRACTICE / REVISION DAY — cycle through every topic
            const isFinalDay = d === totalDays - 1;
            let idx = 0;

            while (minutesLeft > 10 && idx < cleanTopics.length) {

                const topic = cleanTopics[idx % cleanTopics.length];
                const duration = Math.min(minutesLeft, STUDY_DIFFICULTY_WEIGHT[topic.difficulty] >= 3 ? 40 : 30);

                sessions.push(buildStudySession(date, topic.name, isFinalDay ? "revision" : "practice", clock, duration));

                clock += duration + 10;
                minutesLeft -= duration + 10;
                idx++;
            }

        } else {
            // NORMAL STUDY DAY — one primary session on the day's rotated topic
            const topic = studyOrder[d] || cleanTopics[d % cleanTopics.length];

            const primaryDuration = Math.min(minutesLeft, STUDY_DIFFICULTY_MINUTES[topic.difficulty] || 45);

            sessions.push(buildStudySession(date, topic.name, "study", clock, primaryDuration));

            clock += primaryDuration + 10;
            minutesLeft -= primaryDuration + 10;

            if (!studiedSoFar.includes(topic.name)) studiedSoFar.push(topic.name);

            // every third day, if time remains, add a short revision session on an earlier topic
            const previousTopics = studiedSoFar.filter(name => name !== topic.name);

            if (minutesLeft > 15 && d > 0 && d % 3 === 0 && previousTopics.length > 0) {

                const revisionTopic = previousTopics[d % previousTopics.length];
                const revisionDuration = Math.min(minutesLeft, 25);

                sessions.push(buildStudySession(date, revisionTopic, "revision", clock, revisionDuration));
            }
        }
    }

    return { sessions, source: "mock" };
}

function weightedRoundRobin(items, weightFn, totalSlots) {

    if (items.length === 0 || totalSlots <= 0) return [];

    const counters = items.map(() => 0);
    const result = [];

    for (let i = 0; i < totalSlots; i++) {

        let bestIndex = 0;
        let bestValue = Infinity;

        items.forEach((item, idx) => {
            const weight = weightFn(item) || 1;
            const value = counters[idx] / weight;
            if (value < bestValue) {
                bestValue = value;
                bestIndex = idx;
            }
        });

        result.push(items[bestIndex]);
        counters[bestIndex] += 1;
    }

    return result;
}

function buildStudySession(date, topicName, type, startMinuteOfDay, durationMinutes) {
    return {
        date,
        topic: topicName,
        type,
        start: minutesToClock(startMinuteOfDay),
        end: minutesToClock(startMinuteOfDay + durationMinutes)
    };
}

function minutesToClock(totalMinutes) {
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}


/* =========================================
   REAL OPENAI CALL FOR STUDY PLAN
   (only used once OPENAI_API_KEY is set in .env)
   ========================================= */

async function getStudyPlanFromOpenAI(subject, examDate, hoursPerDay, topics, todayDate) {

    const topicList = topics
        .filter(t => t && t.name)
        .map(t => `- ${t.name} (difficulty: ${t.difficulty || "medium"})`)
        .join("\n");

    const systemPrompt =
`You are Planora, a study-planning assistant. Today's date is ${todayDate}.
The user is studying "${subject}" for an exam on ${examDate}, with about ${hoursPerDay} hour(s) available to study per day.

Topics to cover:
${topicList}

Build a day-by-day revision schedule from today until the exam date. Rules:
- Harder topics should get more total time and more sessions than easier ones.
- Spread sessions across the available days rather than cramming everything on one day.
- Respect the daily time budget of about ${hoursPerDay} hour(s) per day.
- Include dedicated "revision" sessions (reviewing topics already studied) throughout, and weight the final days before the exam toward "revision" and "practice" (mock questions / active recall) sessions covering all topics.
- Session "type" must be one of: "study", "revision", "practice".

Respond with ONLY valid JSON, no markdown fences, no commentary, in exactly this shape:

{
  "sessions": [
    {
      "date": "YYYY-MM-DD",
      "topic": "Topic name",
      "type": "study",
      "start": "HH:MM",
      "end": "HH:MM"
    }
  ]
}`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
            model: "gpt-4o-mini",
            temperature: 0.4,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Plan my revision for ${subject}.` }
            ]
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error("OpenAI error:", errText);
        throw new Error("OpenAI request failed");
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);

    return { sessions: parsed.sessions || [], source: "openai" };
}


app.listen(PORT, () => {

    console.log(`Planora server running on http://localhost:${PORT}`);

    // Same Wi-Fi: open this on a phone or tablet
    try {
        const nets = require("os").networkInterfaces();
        const lan = Object.values(nets).flat().find(n => n && n.family === "IPv4" && !n.internal);
        if (lan) console.log(`On your phone/tablet (same Wi-Fi): http://${lan.address}:${PORT}`);
    } catch {}

    console.log(
        process.env.OPENAI_API_KEY
            ? "Mode: real OpenAI (key found in .env)"
            : "Mode: MOCK (no OPENAI_API_KEY set — add one to .env later to switch to real AI)"
    );

    console.log(auth.supabaseReady()
        ? `Sign-in: Supabase (${auth.config.url})`
        : "Sign-in: Supabase NOT configured yet: add supabaseUrl + supabaseAnonKey to planora-config.js (local guest mode only)");
});