/* =========================================================
   PLAN FROM A DOCUMENT  (doc-plan-server.js)

   Ask Planora → 📎 attach a syllabus, timetable, assignment brief or a
   photo of one. Planora reads it, finds the exams, deadlines and events
   that are WRITTEN IN IT, and plans around them (study sessions before
   exams, work sessions before deadlines). Nothing else is planned, and
   nothing is added until you confirm the preview.

   - Images and PDFs are read by OpenAI (needs OPENAI_API_KEY on the server).
   - Text files (.txt .md .csv) and Word files (.docx) are read here; with
     OpenAI they're understood better, without it simple date lines still work.
   - The file is only read in memory to make the plan. It isn't stored.
   - "Only from the document": for text we can check, every item must quote
     a line that really is in the file, or it's dropped.

   POST /api/plan-from-doc  { file: { name, type, data(base64) }, message, today, now, context, existing }
   ========================================================= */

const express = require("express");
const zlib = require("zlib");
const rateLimit = require("express-rate-limit");
const SP = require("./smart-plan-server");

const MAX_BYTES = 8 * 1024 * 1024;
const TEXT_TYPES = /\.(txt|md|csv)$/i;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(new Date(s + "T00:00:00Z"));
const clock = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ""));
const addDays = (ds, n) => { const d = new Date(ds + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMin = (hhmm, n) => { const [h, m] = hhmm.split(":").map(Number); const t = Math.min(23 * 60 + 59, h * 60 + m + n); return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0"); };
const norm = s => String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9]+/g, " ").trim();

/* ---------- .docx → text (a .docx is a zip; we only need word/document.xml) ---------- */
function docxText(buf) {
    // find the central directory entry for word/document.xml
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error("not a zip");
    const count = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
    let p = cdOff;
    for (let i = 0; i < count && p + 46 <= buf.length; i++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) break;
        const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
        const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
        const local = buf.readUInt32LE(p + 42);
        const name = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
        if (name === "word/document.xml") {
            const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
            const data = buf.slice(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
            const xml = (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
            return xml
                .replace(/<w:tab\/>/g, "\t").replace(/<\/w:p>/g, "\n").replace(/<w:br\/>/g, "\n")
                .replace(/<[^>]+>/g, "")
                .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
                .replace(/\n{3,}/g, "\n\n").trim();
        }
        p += 46 + nlen + xlen + clen;
    }
    throw new Error("no document.xml");
}

/* ---------- without AI: lines that have a date and a reason ---------- */
const KIND_WORDS = [
    ["exam", /\b(exam|exams|test|quiz|midterm|mid-term|final|finals|assessment|viva|oral)\b/i],
    ["deadline", /\b(due|deadline|submit|submission|hand in|hand-in|assignment|essay|report|project|homework|coursework|paper)\b/i],
    ["event", /\b(presentation|lecture|meeting|seminar|workshop|class|trip|interview|appointment|event|ceremony)\b/i]
];
function localExtract(text, today) {
    const items = [];
    String(text || "").split(/\n+/).map(l => l.trim()).filter(l => l.length > 3 && l.length < 300).forEach(line => {
        const kindRow = KIND_WORDS.find(([, re]) => re.test(line));
        if (!kindRow) return;
        const when = findDateLoose(line, today);
        if (!when) return;
        const tm = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(line) || /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(line);
        let time = null;
        if (tm) { let h = Number(tm[1]) % (tm[3] ? 12 : 24); if (tm[3] && tm[3].toLowerCase() === "pm") h += 12; time = String(h).padStart(2, "0") + ":" + String(Number(tm[2] || 0)).padStart(2, "0"); }
        // the words before the date are the name: "Midterm exam: 20 Oct, 9am" → "Midterm exam"
        const di = DATE_RES.map(re => { const m = re.exec(line); return m ? m.index : -1; }).filter(i => i >= 0).sort((x, y) => x - y)[0];
        let title = (di > 2 ? line.slice(0, di) : line).replace(/\b(on|by|due|before|at)\s*$/i, "").replace(/[\s\-–—:|,(]+$/, "").trim();
        if (title.length < 3) title = line.replace(/[\s\-–—:|,]+$/, "");
        title = title.slice(0, 80);
        items.push({ title, kind: kindRow[0], date: when, time, end: null, quote: line.slice(0, 200) });
    });
    return items.slice(0, 25);
}
const DATE_RES = [/\b20\d\d-\d{1,2}-\d{1,2}\b/, /\b\d{1,2}(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)/i, /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i, /\b\d{1,2}\/\d{1,2}\b/];
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function findDateLoose(line, today) {
    const ty = Number(today.slice(0, 4));
    const pick = (y, m, d) => {
        if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
        let yy = y || ty;
        let ds = `${yy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        if (!y && ds < addDays(today, -60)) ds = `${yy + 1}-${ds.slice(5)}`;   // "12 Jan" in October means next January
        return isDate(ds) ? ds : null;
    };
    let m = /\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/.exec(line); if (m) return pick(+m[1], +m[2], +m[3]);
    m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?(?:,?\s+(20\d\d))?/i.exec(line); if (m) return pick(m[3] ? +m[3] : 0, MONTHS[m[2].toLowerCase()], +m[1]);
    m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d\d))?/i.exec(line); if (m) return pick(m[3] ? +m[3] : 0, MONTHS[m[1].toLowerCase()], +m[2]);
    m = /\b(\d{1,2})\/(\d{1,2})(?:\/(20\d\d|\d\d))?\b/.exec(line); if (m) { const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : 0; return pick(y, +m[2], +m[1]); }   // dd/mm
    return null;
}

/* ---------- with AI ---------- */
async function aiExtract({ kind, name, mime, b64, text, today, note }) {
    const system = `You read ONE document a student or worker uploaded and list the dated items that are written in it.
Rules:
- Use ONLY what is in the document. Never invent, guess or add items, dates or times that are not written there.
- Items: exams/tests/quizzes ("exam"), assignment/project/essay/report due dates ("deadline"), and other fixed-time things like presentations, classes or meetings ("event").
- date: YYYY-MM-DD. Today is ${today}. If the document gives no year, use the next time that date comes on or after ${addDays(today, -60)}.
- time/end: HH:MM 24-hour only if written in the document, else null.
- title: short and specific, using the document's own words (e.g. "Biology midterm", "Lab report 2").
- quote: the exact short text from the document that shows this item (max 160 characters).
- Skip items with no date. If nothing is dated, return an empty list.
Reply with JSON only: {"about":"one short line saying what the document is","items":[{"title":"","kind":"exam|deadline|event","date":"YYYY-MM-DD","time":null,"end":null,"quote":""}]}`;
    const parts = [{ type: "text", text: `Document name: ${name}.${note ? ` The person also said: "${note.slice(0, 300)}" (use this only to choose which of the document's items they want; never to add new ones).` : ""}` }];
    if (kind === "image") parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}`, detail: "high" } });
    else if (kind === "pdf") parts.push({ type: "file", file: { filename: name.slice(0, 120) || "document.pdf", file_data: `data:application/pdf;base64,${b64}` } });
    else parts.push({ type: "text", text: "DOCUMENT TEXT:\n" + String(text).slice(0, 60000) });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({
            model: process.env.OPENAI_DOC_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [{ role: "system", content: system }, { role: "user", content: parts }]
        })
    });
    if (!response.ok) {
        console.error("OpenAI (document) error:", response.status, (await response.text()).slice(0, 300));
        throw new Error("ai_failed");
    }
    const data = await response.json();
    const parsed = JSON.parse((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "{}");
    return { about: String(parsed.about || "").slice(0, 160), items: Array.isArray(parsed.items) ? parsed.items : [] };
}

/* ---------- make the plan from the items ---------- */
function planFromItems(items, { today, now, prefs, existing }) {
    const tasks = [], goals = [], events = [];
    items.forEach((it, i) => {
        const ref = "d" + (i + 1);
        const from = `From your document: "${it.quote.slice(0, 120)}"`;
        if (it.kind === "event" || ((it.kind === "exam") && it.time)) {
            const start = it.time || "09:00";
            events.push({
                title: it.title, date: it.date, start, end: it.end && it.end > start ? it.end : addMin(start, it.kind === "exam" ? 120 : 60),
                notes: it.time ? from : `No time given in the document — check the time. ${from}`
            });
            if (it.kind === "event") return;
        }
        const phrase = it.kind === "exam"
            ? `${/exam|test|quiz|midterm|final|assessment/i.test(it.title) ? it.title : it.title + " exam"} on ${it.date}`
            : `${it.title} due ${it.date}`;
        const local = SP.localPlan(phrase, today, prefs || {}, now);
        const gs = SP.sanitiseGoals(local.goals, today).map(g => ({ ...g, ref }));
        goals.push(...gs);
        local.tasks.forEach(t => {
            // never plan work after the date in the document
            const due = it.kind === "exam" ? addDays(it.date, -1) : it.date;
            tasks.push({ ...t, goalRef: gs.length ? ref : null, deadline: t.deadline && t.deadline < due ? t.deadline : due, notes: from, flexible: true });
        });
    });
    const busy = (existing || []).concat(events.map(e => ({ date: e.date, start: e.start, end: e.end, title: e.title, kind: "event" })));
    const scheduled = SP.schedule(tasks.slice(0, 40), { today, now, existing: busy })
        .map(t => ({ ...t, notes: t.notes && !/^From your document/.test(t.notes) ? t.notes : (tasks.find(x => x.title === t.title) || {}).notes || t.notes }));
    return { tasks: scheduled, goals: goals.slice(0, 10), events };
}

function install(app, requireAuth) {
    const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
        message: { error: "You've read a lot of documents this hour. Please try again a bit later." } });

    app.post("/api/plan-from-doc", requireAuth, limiter, express.json({ limit: "12mb" }), async (req, res) => {
        const b = req.body || {};
        const f = b.file || {};
        const name = String(f.name || "document").replace(/[\r\n"]/g, "").slice(0, 120);
        const mime = String(f.type || "").toLowerCase();
        const today = isDate(b.today) ? b.today : new Date().toLocaleDateString("en-CA");
        const now = clock(b.now) ? b.now : null;
        const note = String(b.message || "").trim().slice(0, 500);
        let buf;
        try { buf = Buffer.from(String(f.data || ""), "base64"); } catch { buf = Buffer.alloc(0); }
        if (!buf.length) return res.status(400).json({ error: "That file looks empty. Please try another one." });
        if (buf.length > MAX_BYTES) return res.status(413).json({ error: "That file is too big. Please use one under 8 MB." });

        let kind;
        if (/^image\/(png|jpe?g|webp|gif)$/.test(mime)) kind = "image";
        else if (mime === "application/pdf" || /\.pdf$/i.test(name)) kind = "pdf";
        else if (/\.docx$/i.test(name) || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") kind = "docx";
        else if (TEXT_TYPES.test(name) || /^text\//.test(mime)) kind = "text";
        else return res.status(415).json({ error: "Planora can read photos (JPG, PNG), PDFs, Word (.docx) and text files." });

        // check the file really is what it says (magic bytes)
        const head = buf.slice(0, 8);
        const looks = kind === "pdf" ? head.slice(0, 4).toString() === "%PDF"
            : kind === "docx" ? head[0] === 0x50 && head[1] === 0x4b
            : kind === "image" ? (head[0] === 0x89 && head[1] === 0x50) || (head[0] === 0xff && head[1] === 0xd8) || head.slice(0, 4).toString() === "RIFF" || head.slice(0, 3).toString() === "GIF"
            : !buf.slice(0, 2000).includes(0);
        if (!looks) return res.status(415).json({ error: "That file doesn't look like a " + (kind === "image" ? "photo" : kind.toUpperCase()) + ". Please try another one." });

        let text = "";
        try {
            if (kind === "docx") text = docxText(buf);
            else if (kind === "text") text = buf.toString("utf8");
        } catch { return res.status(422).json({ error: "Planora couldn't open that Word file. Try saving it as PDF and attach that." }); }

        const { ctx, existing } = SP.sanitiseContext(b, today);
        const prefs = (req.user && req.user.prefs) || {};
        let about = "", raw = [], source = "planora";
        try {
            if (process.env.OPENAI_API_KEY) {
                const r = await aiExtract({ kind, name, mime: kind === "image" ? mime.replace("jpg", "jpeg") : mime, b64: buf.toString("base64"), text, today, note });
                about = r.about; raw = r.items; source = "openai";
            } else if (kind === "image" || kind === "pdf") {
                return res.status(503).json({ error: "Reading photos and PDFs needs Planora's AI, which isn't switched on here. Try a Word or text file." });
            } else {
                raw = localExtract(text, today);
            }
        } catch (err) {
            if (kind === "docx" || kind === "text") raw = localExtract(text, today);
            else return res.status(502).json({ error: "Planora couldn't read that document right now. Please try again." });
        }

        // keep only clean items; for text we can check, the quote must really be in the file
        const hay = text ? norm(text) : "";
        const seen = new Set(), past = [];
        const items = raw.map(it => ({
            title: String((it && it.title) || "").replace(/\s+/g, " ").trim().slice(0, 80),
            kind: ["exam", "deadline", "event"].includes(it && it.kind) ? it.kind : "deadline",
            date: String((it && it.date) || ""), time: clock(it && it.time) ? it.time : null, end: clock(it && it.end) ? it.end : null,
            quote: String((it && it.quote) || "").replace(/\s+/g, " ").trim().slice(0, 200)
        })).filter(it => {
            if (!it.title || !isDate(it.date) || !it.quote) return false;
            if (hay && !hay.includes(norm(it.quote).slice(0, 60))) return false;      // not in the document → drop
            const key = norm(it.title) + "|" + it.date;
            if (seen.has(key)) return false; seen.add(key);
            if (it.date < today) { past.push(it); return false; }
            return true;
        }).slice(0, 15);

        const fmt = ds => SP.friendly(ds, today);
        if (!items.length) {
            return res.json({
                reply: past.length
                    ? `I read **${name}**. The dates in it have already passed (${past.slice(0, 3).map(p => `${p.title}, ${fmt(p.date)}`).join("; ")}), so there's nothing to plan.`
                    : `I read **${name}** but couldn't find any exams, deadlines or events with a date in it. Check that the dates are written in the document (photos need to be clear and not blurry).`,
                tasks: [], goals: [], events: [], source, doc: { name, about, items: [] }
            });
        }
        const plan = planFromItems(items, { today, now, prefs, existing });
        const list = items.map(it => `**${it.title}** (${it.kind === "exam" ? "exam" : it.kind === "deadline" ? "due" : "event"}, ${fmt(it.date)}${it.time ? " " + it.time : ""})`).join(", ");
        const reply = `I read **${name}**${about ? ` (${about.replace(/\*/g, "")})` : ""} and found ${items.length === 1 ? "1 date" : items.length + " dates"}: ${list}. `
            + `I've planned ${plan.goals.length ? "study sessions before each exam" : ""}${plan.goals.length && plan.tasks.some(t => !t.goalRef) ? " and " : ""}${plan.tasks.some(t => !t.goalRef) ? "work sessions before each deadline" : ""}${plan.events.length ? `${plan.tasks.length ? ", and " : ""}added ${plan.events.length === 1 ? "the event" : "the events"} with a time` : ""}, fitted around your calendar. `
            + `Everything comes only from your document. Nothing is added until you confirm.`
            + (past.length ? ` (Skipped ${past.length} date${past.length === 1 ? "" : "s"} that already passed.)` : "");
        res.json({ reply, tasks: plan.tasks, goals: plan.goals, events: plan.events, source, doc: { name, about, items } });
    });
}

module.exports = { install, docxText, localExtract, findDateLoose, planFromItems };
