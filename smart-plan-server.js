/* =========================================================
   PLANORA SMART PLANNER  (smart-plan-server.js)

   POST /api/smart-plan
   Body: {
     message:  "I need to finish my report today",
     today:    "YYYY-MM-DD",      (the user's local date)
     now:      "HH:MM",           (the user's local time)
     existing: [ {date,start,end,title} ],   (tasks already planned)
     history:  [ {role, text} ],  (recent chat, for "move it to 7pm")
     draft:    { tasks, goals }   (the plan currently being reviewed)
   }

   Returns: {
     reply:  "Here's what I suggest…",
     tasks:  [ {id,title,date,start,end,duration,notes,goalRef} ],
     goals:  [ {ref,title,date,milestones:[{text,date}]} ],
     source: "openai" | "planora"
   }

   Understands, from one sentence:
   - one-off tasks ("finish my report today", "call mum tomorrow at 6")
   - deadlines ("essay due Friday" -> spread over the days before)
   - repeats ("gym 3x this week", "read every day")
   - goals ("learn Python by next week" -> a goal with milestones
     + daily sessions until the deadline)

   With OPENAI_API_KEY the AI does the understanding; without it a
   built-in planner does. Either way the final timings go through
   the same scheduler, which picks a sensible time, estimates the
   duration and avoids clashing with what's already planned.
   ========================================================= */

const express = require("express");
const Priority = require("./planora-priority");
const rateLimit = require("express-rate-limit");

const DAY_START = 7 * 60;        // earliest time to schedule (7:00 AM)
const DAY_END = 22 * 60 + 30;    // latest end time (10:30 PM)
const BUFFER = 10;               // minutes between tasks
const STEP = 15;                 // time grid


/* ---------------------------------------------------------
   Date / time helpers (all "local" = the user's calendar)
   --------------------------------------------------------- */

function parseDate(str) {
    const [y, m, d] = String(str).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

function fmtDate(date) {
    return date.toISOString().slice(0, 10);
}

function addDays(str, n) {
    const d = parseDate(str);
    d.setUTCDate(d.getUTCDate() + n);
    return fmtDate(d);
}

function dayOfWeek(str) {
    return parseDate(str).getUTCDay(); // 0 = Sunday
}

function daysBetween(a, b) {
    return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

function toMin(hhmm) {
    if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
}

function toClock(min) {
    min = Math.max(0, Math.min(23 * 60 + 59, Math.round(min)));
    return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function roundUp(min, step = STEP) {
    return Math.ceil(min / step) * step;
}

function isDate(str) {
    return typeof str === "string" && /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(parseDate(str));
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_SHORT = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function nextWeekday(today, dow, allowToday = true) {
    let diff = (dow - dayOfWeek(today) + 7) % 7;
    if (diff === 0 && !allowToday) diff = 7;
    return addDays(today, diff);
}

function friendly(dateStr, today) {
    const diff = daysBetween(today, dateStr);
    if (diff === 0) return "today";
    if (diff === 1) return "tomorrow";
    const d = parseDate(dateStr);
    const name = WEEKDAYS[d.getUTCDay()];
    const label = name.charAt(0).toUpperCase() + name.slice(1);
    if (diff > 1 && diff < 7) return label;
    return `${label.slice(0, 3)} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].replace(/^./, c => c.toUpperCase())}`;
}

function clock12(hhmm) {
    const min = toMin(hhmm);
    if (min === null) return "";
    let h = Math.floor(min / 60);
    const m = min % 60;
    const ap = h >= 12 ? "pm" : "am";
    h = h % 12 || 12;
    return m ? `${h}:${String(m).padStart(2, "0")}${ap}` : `${h}${ap}`;
}

function durLabel(min) {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
}


/* ---------------------------------------------------------
   Understanding free text (used when there's no OpenAI key)
   --------------------------------------------------------- */

// Find a date in the text. Returns { date, deadline, match }.
function findDate(text, today) {
    const t = text.toLowerCase();
    let m;

    const deadlineWord = "(?:by|before|due|until|till|no later than)\\s+(?:the\\s+)?";

    const tryPatterns = [
        // relative words
        [/\b(?:the\s+)?day after tomorrow\b/, () => addDays(today, 2)],
        [/\btomorrow\b|\btmr\b|\btmrw\b/, () => addDays(today, 1)],
        [/\btoday\b|\btonight\b|\bthis (?:morning|afternoon|evening)\b|\basap\b|\bnow\b/, () => today],
        [/\bin (\d+|a|one|two|three|four|five|six|seven) (day|days|week|weeks|month|months)\b/, mm => {
            const words = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
            const n = words[mm[1]] || Number(mm[1]);
            const unit = mm[2].startsWith("week") ? 7 : mm[2].startsWith("month") ? 30 : 1;
            return addDays(today, n * unit);
        }],
        [/\b(?:end of (?:the )?week|this week)\b/, () => nextWeekday(today, 0)],
        [/\b(?:this )?weekend\b/, () => nextWeekday(today, 6)],
        [/\bnext week\b/, () => addDays(today, 7)],
        [/\bnext month\b|\bend of (?:the )?month\b/, () => {
            const d = parseDate(today);
            return fmtDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
        }],
        // explicit dates: 2026-10-05, 5/10, 5 oct, oct 5
        [/\b(\d{4})-(\d{2})-(\d{2})\b/, mm => `${mm[1]}-${mm[2]}-${mm[3]}`],
        [/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/, mm => explicitDate(today, Number(mm[1]), MONTHS.indexOf(mm[2]))],
        [/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/, mm => explicitDate(today, Number(mm[2]), MONTHS.indexOf(mm[1]))],
        [/\b(\d{1,2})\/(\d{1,2})\b/, mm => explicitDate(today, Number(mm[1]), Number(mm[2]) - 1)],
        // weekdays
        [/\b(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thur?s?|fri|sat)\b/, mm => {
            const key = mm[1];
            const dow = WEEKDAYS.indexOf(key) >= 0 ? WEEKDAYS.indexOf(key) : WEEKDAY_SHORT[key];
            const isNext = /next\s+$/.test(t.slice(0, mm.index + mm[0].indexOf(key)));
            let date = nextWeekday(today, dow, true);
            if (isNext && daysBetween(today, date) < 7) date = addDays(date, daysBetween(today, date) === 0 ? 7 : 0);
            return date;
        }]
    ];

    for (const [re, build] of tryPatterns) {
        m = t.match(re);
        if (m) {
            const date = build(m);
            if (!isDate(date)) continue;
            const before = t.slice(0, m.index);
            const deadline = new RegExp(deadlineWord + "$").test(before) ||
                /\b(by|before|due|until|till|within)\s+(the\s+)?(next\s+)?$/.test(before) ||
                /^in\s/.test(m[0]);
            return { date, deadline, match: m[0], index: m.index };
        }
    }
    return null;
}

function explicitDate(today, day, monthIndex) {
    if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
    const t = parseDate(today);
    let d = new Date(Date.UTC(t.getUTCFullYear(), monthIndex, day));
    if (d < t) d = new Date(Date.UTC(t.getUTCFullYear() + 1, monthIndex, day));
    return fmtDate(d);
}

function findTime(text) {
    const t = text.toLowerCase();
    let m = t.match(/\b(?:at|@|from|around|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (m) {
        let h = Number(m[1]) % 12;
        if (m[3] === "pm") h += 12;
        return { start: toClock(h * 60 + Number(m[2] || 0)), match: m[0], exact: true };
    }
    m = t.match(/\b(?:at|@|from|around)\s+(\d{1,2}):(\d{2})\b/);
    if (m) {
        let h = Number(m[1]);
        if (h < 7) h += 12; // "at 5:30" almost always means pm
        return { start: toClock(h * 60 + Number(m[2])), match: m[0], exact: true };
    }
    m = t.match(/\b(?:at|@)\s+(\d{1,2})\b(?!\s*(?:min|hour|hr|h\b|x|times))/);
    if (m) {
        let h = Number(m[1]);
        if (h >= 1 && h <= 6) h += 12;
        if (h <= 23) return { start: toClock(h * 60), match: m[0], exact: true };
    }
    const parts = [
        [/\b(early morning|first thing)\b/, "07:30"],
        [/\b(morning|am)\b/, "09:00"],
        [/\b(lunch|lunchtime|noon|midday)\b/, "12:30"],
        [/\b(afternoon)\b/, "14:00"],
        [/\b(after work|after school)\b/, "17:30"],
        [/\b(evening)\b/, "18:30"],
        [/\b(tonight|night)\b/, "20:00"]
    ];
    for (const [re, start] of parts) {
        m = t.match(re);
        if (m) return { start, match: m[0], exact: false };
    }
    return null;
}

function findDuration(text) {
    const t = text.toLowerCase();
    let m = t.match(/\b(\d+(?:\.\d+)?)\s*(?:-|to)?\s*(hours?|hrs?|h)\b(?:\s*(?:and\s*)?(\d+)\s*(?:minutes?|mins?|m)\b)?/);
    if (m) return { minutes: Math.round(Number(m[1]) * 60 + Number(m[3] || 0)), match: m[0] };
    m = t.match(/\b(\d+)\s*(?:minutes?|mins?|m)\b/);
    if (m) return { minutes: Number(m[1]), match: m[0] };
    m = t.match(/\b(half an hour|an hour and a half|an hour|a couple of hours|a few hours)\b/);
    if (m) {
        const map = { "half an hour": 30, "an hour and a half": 90, "an hour": 60, "a couple of hours": 120, "a few hours": 180 };
        return { minutes: map[m[1]], match: m[0] };
    }
    return null;
}

function findRepeat(text) {
    const t = text.toLowerCase();
    let m = t.match(/\b(\d+)\s*(?:x|times)\b(?:\s*(?:a|per|this|every)\s*week)?/);
    if (m) return { count: Math.min(14, Number(m[1])), match: m[0] };
    m = t.match(/\b(twice|three times|four times|five times)\b(?:\s*(?:a|per|this)\s*week)?/);
    if (m) return { count: { twice: 2, "three times": 3, "four times": 4, "five times": 5 }[m[1]], match: m[0] };
    m = t.match(/\b(every ?day|daily|each day|everyday)\b/);
    if (m) return { count: "daily", match: m[0] };
    return null;
}

// Typical length of common activities, in minutes
const DURATIONS = [
    [/\b(standup|stand-up|check-?in)\b/, 15],
    [/\b(meditat\w*|stretch\w*|journal\w*)\b/, 15],
    [/\b(email|emails|inbox|reply|text|message|pay|bill|book an?|schedule|appointment call)\b/, 20],
    [/\b(call|phone|ring)\b/, 30],
    [/\b(walk|laundry|tidy|dishes|water plants)\b/, 30],
    [/\b(read|reading)\b/, 30],
    [/\b(meeting|meet|sync|interview|1:1|one on one)\b/, 60],
    [/\b(gym|workout|work out|training|swim|yoga|pilates|tennis|badminton|football|basketball)\b/, 60],
    [/\b(run|jog|cycle|bike)\b/, 45],
    [/\b(grocer\w*|shopping|errand\w*|cook\w*|meal ?prep|clean\w*)\b/, 45],
    [/\b(homework|revise|revision|study|studying|practice|practise|lecture|tutorial|lesson|class)\b/, 60],
    [/\b(presentation|slides|deck|pitch)\b/, 90],
    [/\b(report|essay|assignment|proposal|thesis|paper|project|coursework|research|write|writing|draft)\b/, 120],
    [/\b(exam|test|quiz)\b/, 90],
    [/\b(movie|film|dinner|lunch with|date)\b/, 90]
];

// A natural time of day for common activities (used when no time is given)
function suggestTime(title, prefStart) {
    const t = title.toLowerCase();
    if (/\b(gym|workout|work out|training|swim|yoga|pilates|run|jog|cycle|bike|tennis|badminton|football|basketball|walk)\b/.test(t)) return "18:00";
    if (/\b(read|reading|journal\w*|meditat\w*|stretch\w*)\b/.test(t)) return "21:00";
    if (/\b(email|emails|inbox|pay|bill|book|admin)\b/.test(t)) return "09:00";
    if (/\b(call|phone|ring)\b/.test(t)) return "12:30";
    if (/\b(grocer\w*|shopping|errand\w*|laundry|clean\w*)\b/.test(t)) return "10:00";
    if (/\b(cook\w*|meal ?prep|dinner)\b/.test(t)) return "18:30";
    if (/\b(report|essay|assignment|proposal|thesis|paper|project|coursework|research|write|writing|study|revise|revision|homework|presentation)\b/.test(t)) return prefStart || "09:00";
    return prefStart || null;
}

function estimateDuration(title) {
    const t = title.toLowerCase();
    for (const [re, min] of DURATIONS) if (re.test(t)) return min;
    return 45;
}

// Words that turn a request into a multi-day goal
const GOAL_VERBS = /\b(learn|master|get better at|improve( my)?|become|train for|prepare for|prep for|get fit|lose|save|build (a|an|my)|launch|start (a|an|my)|pick up|teach myself|become fluent|finish reading|read (a|the) book|practi[cs]e|study for|revise for|get good at|goal)\b/i;

const LEARN_TEMPLATES = [
    {
        test: /\binterview\b/i,
        steps: ["Research the company and role", "Prepare answers to common questions", "Write your STAR examples", "Mock interview practice", "Prepare questions to ask them", "Final review and logistics"],
        milestones: ["Research done", "Answers and examples ready", "Mock interview done", "Ready for the interview"]
    },
    {
        test: /\b(exam|exams|test|quiz|finals|midterm|mid-term|paper|o-?levels?|a-?levels?|psle|ib)\b/i,
        steps: ["Gather notes and list every topic", "Review the first set of topics", "Review the next set of topics", "Review the remaining topics", "Practice questions on weak areas", "Timed past paper", "Go over mistakes", "Final light review"],
        milestones: ["Every topic reviewed once", "Practice questions done", "Timed past paper done", "Ready for the exam"]
    },
    {
        test: /\b(python|javascript|js|typescript|java|c\+\+|c#|swift|kotlin|rust|go(lang)?|sql|html|css|react|coding|programming|code)\b/i,
        steps: ["Set up and learn the basic syntax", "Variables, data types and operators", "Conditions and loops", "Functions", "Lists, dictionaries and other collections", "Files, modules and libraries", "Build a small project", "Review and practise problems"],
        milestones: ["Write and run your first programs", "Comfortable with the core building blocks", "Finish a small project", "Solve practice problems without notes"]
    },
    {
        test: /\b(spanish|french|japanese|korean|mandarin|chinese|german|italian|malay|tamil|hindi|language)\b/i,
        steps: ["Pronunciation and greetings", "Core vocabulary: everyday words", "Basic grammar and sentence structure", "Listening practice", "Speaking practice", "Reading short texts", "Review vocabulary", "Mini conversation practice"],
        milestones: ["Introduce yourself", "Know 200 everyday words", "Hold a short conversation", "Understand a simple article or video"]
    },
    {
        test: /\b(guitar|piano|violin|ukulele|drums|sing|singing|instrument)\b/i,
        steps: ["Basics and posture/technique", "First chords or scales", "Rhythm and timing", "Learn a simple song", "Practise transitions", "Play along with a recording", "Polish a full song", "Review and record yourself"],
        milestones: ["Play basic chords or scales", "Play one full simple song", "Play along at tempo"]
    },
    {
        test: /\b(marathon|half marathon|5k|10k|run|running|fit|fitness|strength|weight|muscle)\b/i,
        steps: ["Easy session and baseline", "Endurance session", "Strength and mobility", "Interval session", "Rest-day stretch and walk", "Longer session", "Recovery session", "Check progress"],
        milestones: ["Complete the first full week", "Increase distance or weight", "Hit your target"]
    }
];

function goalPlanFor(topic) {
    const tpl = LEARN_TEMPLATES.find(t => t.test.test(topic));
    if (tpl) return tpl;
    return {
        steps: ["Overview and fundamentals", "Core concept 1", "Core concept 2", "Hands-on practice", "Deepen one key area", "Apply it in a small project", "Review weak spots", "Final review"],
        milestones: ["Understand the fundamentals", "Complete hands-on practice", "Finish a small project or real use", "Confident review"]
    };
}

const FILLER = /^(and\s+|then\s+|also\s+)?(please\s+)?(can you\s+|could you\s+|help me\s+|i\s+(really\s+)?(need|have|want|got|should|must|would like|'d like|plan)\s+to\s+|i\s+need\s+|i\s+should\s+|i\s+must\s+|i\s+want\s+|i'?m\s+going\s+to\s+|remind me to\s+|plan\s+(for\s+|my\s+)?|schedule\s+|add\s+|let me\s+|gotta\s+|need to\s+|have to\s+|want to\s+|to\s+)+/i;

function cleanTitle(text, removals) {
    let t = " " + text + " ";
    removals.filter(Boolean).sort((a, b) => b.length - a.length).forEach(r => {
        const i = t.toLowerCase().indexOf(r.toLowerCase());
        if (i >= 0) t = t.slice(0, i) + " " + t.slice(i + r.length);
    });
    t = t.replace(/\b(by|before|due|on|at|for|until|till|this|next|every|in|around|from|within)\s*$/i, " ");
    t = t.replace(/\s+(by|before|due|on|at|for|until|till|in|within)\s+(?=[,.]|$)/gi, " ");
    t = t.replace(/\s{2,}/g, " ").trim().replace(/^[,.\-–:]+|[,.\-–:]+$/g, "").trim();
    t = t.replace(FILLER, "").trim();
    t = t.replace(/\b(by|before|due|on|at|for|until|till|this|next|every|in|the)$/i, "").trim();
    t = t.replace(/^(to|a|the)\s+/i, "").trim();
    if (!t) return "";
    return t.charAt(0).toUpperCase() + t.slice(1);
}

function splitItems(message) {
    return message
        .split(/\n|;|\.\s+(?=[A-Za-z])|,\s*(?:and\s+)?|\s+and then\s+|\s+then\s+|\s+also\s+|\s+plus\s+/i)
        .flatMap(part => {
            // split on " and " when both sides are real activities ("call mum at 6 and essay due Monday"),
            // but keep short pairs together ("research and write", "gym and sauna")
            const bits = part.split(/\s+and\s+/i);
            if (bits.length < 2) return [part];
            const out = [bits[0]];
            for (let k = 1; k < bits.length; k++) {
                const left = out[out.length - 1], right = bits[k];
                const words = str => str.trim().split(/\s+/).length;
                const activity = DURATIONS.some(([re]) => re.test(right.toLowerCase()));
                if (words(left) >= 2 && (words(right) >= 2 || activity)) out.push(right);
                else out[out.length - 1] = left + " and " + right;
            }
            return out;
        })
        .map(s => s.trim())
        .filter(s => s && s.replace(/[^a-z]/gi, "").length > 1);
}

function preferredStartFromPrefs(prefs) {
    const times = (prefs && prefs.productiveTimes) || [];
    const map = { "Morning": "09:00", "Early morning": "07:30", "Late morning": "10:00", "Afternoon": "14:00", "Evening": "19:00", "Night owl": "21:00" };
    for (const t of times) if (map[t]) return map[t];
    return null;
}

function localPlan(message, today, prefs, now, forceGoal = false) {
    const items = splitItems(message);
    const nowMin = toMin(now);
    const lateToday = nowMin !== null && DAY_END - nowMin < 90;   // less than 1.5h left today
    const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const activeDays = (prefs && Array.isArray(prefs.activeDays) && prefs.activeDays.length) ? prefs.activeDays : null;
    const tasks = [];
    const goals = [];
    const prefStart = preferredStartFromPrefs(prefs);

    // If the whole message is one sentence mentioning a goal verb + deadline, treat as one goal
    items.forEach((raw, i) => {
        const when = findDate(raw, today);
        const time = findTime(raw);
        const dur = findDuration(raw);
        const rep = findRepeat(raw);

        let title = cleanTitle(raw, [when && when.match, time && time.match, dur && dur.match, rep && rep.match]) || "Task";
        const horizon = when ? daysBetween(today, when.date) : 0;
        // An upcoming exam/test/interview a few days away = something to prepare for (a study goal)
        const isEvent = /\b(exam|exams|test|quiz|finals|midterm|mid-term|interview|presentation|recital|audition|competition)\b/i.test(raw) &&
            when && horizon >= 2 && !/\b(finish|submit|write|send|make|prepare slides)\b/i.test(raw);
        const isGoal = forceGoal || isEvent || (GOAL_VERBS.test(raw) && (horizon >= 3 || !when || /\b(goal|learn|master|become|train for|get fit|lose|save)\b/i.test(raw)) && !rep);

        if (isGoal) {
            const deadline = when ? when.date : addDays(today, 14);
            const ref = "g" + (goals.length + 1);
            const plan = goalPlanFor(raw);
            const topic = title.replace(/^(learn|master|get better at|improve( my)?|study for|prepare for|prep for|revise for|practi[cs]e|pick up|teach myself|get good at)\s+/i, "").replace(/^(my|the|a|an)\s+/i, "");
            let topicText = topic;
            if (isEvent && !/^(prepare|prep|study|revise)/i.test(title)) {
                // "I have an exam next Friday" -> goal "Prepare for exam", sessions "Exam: …"
                const what = title.replace(/^(i\s+)?(have|got|there'?s)\s+/i, "").replace(/^(my|the|a|an)\s+/i, "");
                title = "Prepare for " + what.charAt(0).toLowerCase() + what.slice(1);
                topicText = what;
            }
            const topicCap = topicText.charAt(0).toUpperCase() + topicText.slice(1);

            // sessions: from today (or tomorrow if it's late) up to the day before the deadline
            const totalDays = Math.max(1, Math.min(28, daysBetween(today, deadline)));
            const perSession = dur ? dur.minutes : totalDays <= 7 ? 60 : 45;
            const start = time ? time.start : prefStart || "19:00";
            let dates = [];
            for (let d = lateToday ? 1 : 0; d < Math.max(totalDays, lateToday ? 2 : 1); d++) dates.push(addDays(today, d));
            // longer goals: study on active days only (or take Sundays off)
            if (dates.length > 7) {
                const kept = dates.filter(dt => activeDays ? activeDays.includes(DOW_NAMES[dayOfWeek(dt)]) : dayOfWeek(dt) !== 0);
                if (kept.length >= 3) dates = kept;
            }
            dates = dates.slice(0, 21);
            const n = dates.length;
            const used = {};
            const sessions = dates.map((date, k) => {
                const step = plan.steps[Math.min(plan.steps.length - 1, Math.floor((k / n) * plan.steps.length))];
                used[step] = (used[step] || 0) + 1;
                const label = used[step] === 1 ? step : `${step} (practice)`;
                return { title: `${topicCap}: ${label}`, date, start, duration: perSession, goalRef: ref, flexible: !time, sameDay: true };
            });
            const daysAvail = totalDays;
            tasks.push(...sessions);

            const ms = plan.milestones.map((text, k) => ({
                text,
                date: addDays(today, Math.max(0, Math.round(((k + 1) / plan.milestones.length) * daysAvail) - (k + 1 === plan.milestones.length ? 0 : 1)))
            }));
            goals.push({ ref, title: title, date: deadline, milestones: ms });
            return;
        }

        const duration = dur ? dur.minutes : estimateDuration(title);

        if (rep) {
            // spread repeats over the rest of this week (or the next 7 days)
            const endOfWindow = when && when.deadline ? when.date : addDays(today, 6);
            const first = lateToday ? 1 : 0;
            const days = Math.max(1, daysBetween(today, endOfWindow) + 1 - first);
            const count = rep.count === "daily" ? days : Math.min(rep.count, 14);
            const gap = count >= days ? 1 : days / count;
            for (let k = 0; k < count; k++) {
                tasks.push({
                    title,
                    sameDay: true,
                    date: addDays(today, first + Math.min(days - 1, Math.floor(k * gap))),
                    start: time ? time.start : suggestTime(title, prefStart),
                    duration,
                    flexible: !time
                });
            }
            return;
        }

        if (when && when.deadline && horizon >= 1 && duration > 90) {
            // big task with a deadline: split into focused sessions on the days before it
            const sessions = Math.min(horizon, Math.ceil(duration / 60), 4);
            const each = roundUp(Math.max(45, duration / sessions), 15);
            for (let k = 0; k < sessions; k++) {
                tasks.push({
                    title: sessions > 1 ? `${title} (part ${k + 1} of ${sessions})` : title,
                    date: addDays(today, (lateToday ? 1 : 0) + Math.floor((k * Math.max(1, horizon - (lateToday ? 1 : 0))) / sessions)),
                    start: time ? time.start : suggestTime(title, prefStart),
                    duration: each,
                    deadline: when.date,
                    flexible: true
                });
            }
            return;
        }

        const date = when ? (when.deadline ? (horizon >= 1 ? addDays(today, Math.max(0, horizon - 1)) : today) : when.date) : today;
        // long single tasks today get split into 2 blocks with a break
        if (duration > 120 && !time) {
            const half = roundUp(duration / 2, 15);
            tasks.push({ title: `${title} (part 1)`, date, start: suggestTime(title, prefStart), duration: half, deadline: when && when.deadline ? when.date : null, flexible: true });
            tasks.push({ title: `${title} (part 2)`, date, start: suggestTime(title, prefStart), duration: duration - half, deadline: when && when.deadline ? when.date : null, flexible: true });
            return;
        }
        tasks.push({
            title,
            date,
            start: time ? time.start : suggestTime(title, prefStart),
            duration,
            deadline: when && when.deadline ? when.date : null,
            flexible: !time || !time.exact
        });
    });

    return { tasks, goals };
}


/* ---------------------------------------------------------
   Simple change requests on a draft (built-in planner)
   "move the gym to 7pm", "make them 30 min", "remove reading",
   "put the report on Monday"
   --------------------------------------------------------- */

const CHANGE_WORDS = /\b(move|change|make|shift|instead|earlier|later|shorter|longer|remove|delete|drop|skip|cancel|put|reschedule|push)\b/i;

function refineDraft(message, draft, today) {
    if (!draft || !Array.isArray(draft.tasks) || !draft.tasks.length) return null;
    if (!CHANGE_WORDS.test(message)) return null;

    const text = message.toLowerCase();
    const words = text.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2 &&
        !/^(move|change|make|shift|instead|the|them|all|sessions?|tasks?|to|for|and|please|can|you|into|onto|put|remove|delete|drop|skip|cancel|earlier|later|shorter|longer|min|mins|minutes|hour|hours|reschedule|push|each|every|one)$/.test(w));

    let targets = draft.tasks.filter(t => words.some(w => t.title.toLowerCase().includes(w)));
    if (!targets.length) targets = draft.tasks;
    const ids = new Set(targets.map(t => t.id));

    let tasks = draft.tasks.map(t => ({ ...t }));
    const changes = [];

    if (/\b(remove|delete|drop|skip|cancel)\b/.test(text)) {
        tasks = tasks.filter(t => !ids.has(t.id));
        changes.push(`removed ${targets.length} item${targets.length === 1 ? "" : "s"}`);
        return { tasks, goals: draft.goals || [], changes };
    }

    const dur = findDuration(text);
    const time = findTime(text);
    const when = findDate(text, today);

    tasks.forEach(t => {
        if (!ids.has(t.id)) { t.flexible = false; return; }
        if (dur) t.duration = dur.minutes;
        if (time) { t.start = time.start; t.flexible = false; }
        else if (/\bearlier\b/.test(text)) { t.start = toClock(Math.max(DAY_START, toMin(t.start) - 60)); t.flexible = false; }
        else if (/\blater\b/.test(text)) { t.start = toClock(Math.min(DAY_END - 30, toMin(t.start) + 60)); t.flexible = false; }
        else t.flexible = !dur;
        if (when && !/\b(every|daily)\b/.test(text)) t.date = when.date;
    });
    // keep untouched items where they are
    tasks.forEach(t => { if (!ids.has(t.id)) t.flexible = false; });

    if (dur) changes.push(`set ${targets.length === draft.tasks.length ? "everything" : targets.length + " item" + (targets.length === 1 ? "" : "s")} to ${durLabel(dur.minutes)}`);
    if (time) changes.push(`moved to ${clock12(time.start)}`);
    if (when) changes.push(`moved to ${friendly(when.date, today)}`);
    if (/\bearlier\b/.test(text) && !time) changes.push("moved an hour earlier");
    if (/\blater\b/.test(text) && !time) changes.push("moved an hour later");
    if (!changes.length) return null;

    return { tasks, goals: draft.goals || [], changes };
}


/* ---------------------------------------------------------
   Scheduler: pick real times, avoid clashes
   --------------------------------------------------------- */

function schedule(items, { today, now, existing }) {
    const busy = {}; // date -> [[start,end]]
    const addBusy = (date, s, e) => { (busy[date] = busy[date] || []).push([s, e]); };

    (existing || []).forEach(t => {
        const s = toMin(t.start), e = toMin(t.end);
        if (isDate(t.date) && s !== null) addBusy(t.date, s, e !== null && e > s ? e : s + 30);
    });

    const nowMin = toMin(now);
    const earliest = date => {
        if (date === today && nowMin !== null) return Math.max(DAY_START, roundUp(nowMin + 15));
        return DAY_START;
    };

    const fits = (date, s, d) => {
        if (s < earliest(date) || s + d > DAY_END) return false;
        return !(busy[date] || []).some(([bs, be]) => s < be + BUFFER && s + d + BUFFER > bs);
    };

    const findSlot = (date, pref, d) => {
        const lo = earliest(date);
        const start = Math.max(lo, pref !== null ? roundUp(pref) : lo);
        for (let s = start; s + d <= DAY_END; s += STEP) if (fits(date, s, d)) return s;
        for (let s = roundUp(lo); s < start; s += STEP) if (fits(date, s, d)) return s;
        return null;
    };

    // the free start time closest to `pref` (before or after), or null
    const findNear = (date, pref, d) => {
        const lo = earliest(date), p0 = Math.round(pref / STEP) * STEP;
        for (let k = 0; k * STEP <= DAY_END - DAY_START; k++) {
            for (const s of [p0 + k * STEP, p0 - k * STEP]) {
                if (s >= lo && fits(date, s, d)) return s;
            }
        }
        return null;
    };

    const out = [];
    // fixed-time items first so flexible ones flow around them
    const order = items
        .map((t, i) => ({ t, i }))
        .sort((a, b) => (a.t.flexible === b.t.flexible ? 0 : a.t.flexible ? 1 : -1));

    order.forEach(({ t, i }) => {
        let duration = Math.max(10, Math.min(8 * 60, Math.round(Number(t.duration) || 45)));
        let date = isDate(t.date) ? t.date : today;
        if (daysBetween(today, date) < 0) date = today;

        const pref = toMin(t.start);
        let placed = null, note = t.notes || "";

        if (!t.flexible && pref !== null) {
            // user asked for a specific time: keep it (warn if it clashes or has passed)
            if (date === today && nowMin !== null && pref < nowMin) {
                note = note || "That time has already passed today — moved to the next free slot.";
                placed = findSlot(date, nowMin, duration);
            } else {
                placed = pref;
                const clash = (busy[date] || []).some(([bs, be]) => pref < be && pref + duration > bs);
                if (clash && t.goalRef) {
                    // goal sessions repeat: never stack them on other tasks — take the nearest free time that day
                    const near = findNear(date, pref, duration);
                    if (near !== null) { placed = near; note = note || `Moved to ${clock12(toClock(near))} so it doesn't overlap with something already planned.`; }
                    else note = note || "Overlaps with something already planned — edit if needed.";
                } else if (!fits(date, pref, duration) && pref >= DAY_START && pref + duration <= DAY_END) {
                    if (clash) note = note || "Overlaps with something already planned — edit if needed.";
                }
            }
        } else {
            const defaultPref = pref !== null ? pref : duration >= 90 ? 9 * 60 : null;
            const requested = date;
            const hasDeadline = t.deadline && isDate(t.deadline);
            const lastDay = hasDeadline ? t.deadline : addDays(date, 6);
            for (let k = 0; daysBetween(date, lastDay) - k >= 0 && k < 14; k++) {
                const d = addDays(date, k);
                const s = findSlot(d, defaultPref, duration);
                if (s !== null) { placed = s; date = d; break; }
            }
            if (placed === null && hasDeadline) {
                // no room before the deadline: take the earliest free slot after it
                for (let k = 1; k <= 7 && placed === null; k++) {
                    const d = addDays(lastDay, k);
                    const s = findSlot(d, defaultPref, duration);
                    if (s !== null) { placed = s; date = d; note = "Not enough free time before the deadline — this is the earliest free slot."; }
                }
            }
            if (placed === null) {
                placed = findSlot(date, null, Math.max(30, Math.floor(duration / 2)));
                if (placed !== null) { duration = Math.max(30, Math.floor(duration / 2)); note = "Your day is packed — shortened to fit."; }
                else { placed = Math.max(earliest(date), 9 * 60); note = "Couldn't find a free slot — pick a time that works."; }
            }
            if (!note && date !== requested && requested === today) {
                note = "Not enough time left today — moved to " + friendly(date, today) + ".";
            }
        }

        if (placed === null) placed = earliest(date);
        placed = Math.min(placed, DAY_END - Math.min(duration, 60));
        addBusy(date, placed, placed + duration);

        out[i] = {
            id: "sp-" + Date.now().toString(36) + "-" + i + "-" + Math.random().toString(36).slice(2, 6),
            title: String(t.title || "Task").slice(0, 120),
            date,
            start: toClock(placed),
            end: toClock(placed + duration),
            duration,
            notes: note || "",
            goalRef: t.goalRef || null,
            sourceId: t.sourceId || null,
            deadline: t.deadline && isDate(t.deadline) ? t.deadline : null
        };
    });

    return out.filter(Boolean).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

function summarise(tasks, goals, today) {
    if (!tasks.length && !goals.length) {
        return "I couldn't find anything to plan in that. Try something like \"finish my report today\" or \"learn Python by next week\".";
    }
    const bits = [];
    goals.forEach(g => {
        const sessions = tasks.filter(t => t.goalRef === g.ref);
        bits.push(`🎯 Goal: **${g.title}** by ${friendly(g.date, today)}: ${g.milestones.length} milestones and ${sessions.length} session${sessions.length === 1 ? "" : "s"} (${durLabel(sessions[0] ? sessions[0].duration : 60)} each).`);
    });
    const loose = tasks.filter(t => !t.goalRef);
    if (loose.length === 1) {
        const t = loose[0];
        bits.push(`I've set **${t.title}** for ${friendly(t.date, today)} at ${clock12(t.start)} for ${durLabel(t.duration)}.`);
    } else if (loose.length > 1) {
        const days = [...new Set(loose.map(t => t.date))];
        bits.push(`I've planned ${loose.length} tasks ${days.length === 1 ? "for " + friendly(days[0], today) : "across " + days.length + " days"}, fitted around what's already in your calendar.`);
    }
    bits.push("Check the plan below and tap **Add to my plan** when it looks right, or tell me what to change.");
    return bits.join(" ");
}




/* ---------------------------------------------------------
   Understanding what kind of request this is
   --------------------------------------------------------- */

const STOP = new Set("the a an my to for and or of on at in by with it them those these that this all every please can you could i me is are be do move change make shift put reschedule push delete remove cancel drop skip set earlier later instead sessions session task tasks today tomorrow min mins minutes hour hours pm am".split(" "));

function words(text) {
    return String(text || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
}

function classify(message, hasDraft) {
    const t = message.trim().toLowerCase().replace(/[’]/g, "'");
    if (/^(so\s+)?(what|which)\b.*\b(should|do|can|to)\b.*\b(now|next|right now)\b|^what (now|next)\b|^what'?s next\b|\bmost important thing\b|^what should i (do|work on)\b/.test(t)) return "now";
    if (/\b(plan|organi[sz]e|sort out|schedule)\b.*\b(my|the|this|next)\s+week\b/.test(t)) return "plan_week";
    if (/\b(only|just)\s+(have|got)\s+(\d+(\.\d+)?|an?|one|two|three|four|five|half an?)\s*(hours?|hrs?|h|minutes?|mins?)\b|\bi\s+(have|'ve got|got)\s+(\d+(\.\d+)?|an?|one|two|three)\s*(hours?|hrs?|minutes?|mins?)\s+(left|tonight|today|this (morning|afternoon|evening))\b/.test(t)) return "limited";
    if (/\b(i'?m|i am|im)\s+(so\s+|really\s+|a bit\s+)?behind\b|\bfalling behind\b|\bbehind (on|with)\b/.test(t)) return "behind";
    if (/\b(move|push|shift|reschedule|carry)\b.*\b(everything|all|anything)\b.*\b(unfinished|remaining|undone|left|incomplete|overdue|not done)\b|\b(move|push)\s+(all\s+)?(my\s+)?(unfinished|remaining|incomplete|overdue)\b/.test(t)) return "move_unfinished";
    if (/^(please\s+)?(break|split)\b.*\b(down|into|up|smaller|steps|parts)\b|\bbreak\s+(it|this|that)\s+down\b|\binto smaller tasks\b/.test(t)) return "breakdown";
    if (/^(please\s+)?(create|make|build|give me|i need|help me (make|create|with))\s+(a\s+|me a\s+|my\s+)?(study|revision)\s+(plan|timetable|schedule)\b/.test(t) && !findDate(t, "2000-01-01")) return "study_plan";
    if (/\bon track\b|\bhow am i doing\b|\bprogress (on|with|for)\b/.test(t) && /\bgoal|\bon track for\b|\bprogress\b/.test(t)) return "goal_status";
    if (/^(please\s+)?(plan|organi[sz]e|sort out|arrange|schedule)\s+(out\s+)?(my\s+)?(day|today|tomorrow|morning|afternoon|evening|rest of (my|the) day)\b[.!]?$/.test(t) ||
        /^(help me )?(plan|organi[sz]e) (my|the) (day|today|tomorrow)( for me)?[.!]?$/.test(t) ||
        /^(please\s+)?(plan|organi[sz]e|sort out|arrange)\s+(out\s+)?(my\s+)?(day\s+on\s+|next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)( for me)?[.!]?$/.test(t)) return "plan_day";
    if (!hasDraft && /^(please\s+)?(move|reschedule|push|shift|change|delete|remove|cancel|drop|skip|put|make)\b/.test(t)) return "edit";
    if (/\?$/.test(t) || /^(what|what's|whats|which|should|how|when|where|do i|am i|is there|are there|any|tell me|show me|list|give me)\b/.test(t)) return "question";
    return "plan";
}


/* ---------------------------------------------------------
   Built-in answers and edits (no AI needed, uses real data)
   --------------------------------------------------------- */

function rankCtx(today, now, goals, events) {
    const goalsById = {};
    (goals || []).forEach(g => { goalsById[g.id] = g; });
    return { today, nowMin: toMin(now) || 0, goalsById, events: (events || []).filter(e => e.date === today) };
}

// Tasks + events together, for "when am I free?" questions (events never complete)
function busyItems(ctx) {
    return (ctx.tasks || []).concat((ctx.events || []).map(e => ({ ...e, completed: false })));
}

function describeTask(t, today) {
    const when = t.date === today ? "" : ` ${friendly(t.date, today)}`;
    return `**${t.title}**${t.start ? ` (${clock12(t.start)}${when})` : when ? ` (${when.trim()})` : ""}`;
}

function freeWindowsServer(tasks, date, fromMin) {
    const busy = tasks.filter(t => t.date === date && !t.completed && toMin(t.start) !== null)
        .map(t => [toMin(t.start), toMin(t.end) > toMin(t.start) ? toMin(t.end) : toMin(t.start) + 30])
        .sort((a, b) => a[0] - b[0]);
    const gaps = [];
    let cursor = roundUp(Math.max(fromMin, DAY_START));
    busy.forEach(([s, e]) => { if (s - cursor >= 30) gaps.push([cursor, s]); cursor = Math.max(cursor, e); });
    if (DAY_END - cursor >= 30) gaps.push([cursor, DAY_END]);
    return gaps;
}

function localAnswer(message, ctx, today, now) {
    const t = message.toLowerCase();
    const tasks = ctx.tasks || [];
    const rc = rankCtx(today, now, ctx.goals, ctx.events);
    const open = tasks.filter(x => !x.completed);

    if (/goal/.test(t) && (ctx.goals || []).length) {
        const list = ctx.goals.map(g => `**${g.title}** (${g.progress || 0}%${g.date ? `, by ${friendly(g.date, today)}` : ""})`).join(", ");
        return `You're working on: ${list}. Want me to plan sessions for one of them?`;
    }

    if (/free|available|spare|gap/.test(t)) {
        const gaps = freeWindowsServer(busyItems(ctx), today, (toMin(now) || DAY_START) + 10);
        if (!gaps.length) return "You don't have any free windows left today. Want me to move something to tomorrow?";
        return `You're free ${gaps.slice(0, 3).map(([s, e]) => `${clock12(toClock(s))}–${clock12(toClock(e))}`).join(", ")} today. Tell me what you'd like to fit in.`;
    }

    const dayMatch = /tomorrow/.test(t) ? addDays(today, 1) : today;
    if (/(on|planned|schedule|have|got|doing).*(today|tomorrow)|^what'?s (on|up|planned)/.test(t)) {
        const list = tasks.filter(x => x.date === dayMatch).sort((a, b) => (a.start || "99").localeCompare(b.start || "99"));
        if (!list.length) return `Nothing is planned for ${friendly(dayMatch, today)} yet. Tell me what you need to get done and I'll fit it in.`;
        const left = list.filter(x => !x.completed);
        return `${friendly(dayMatch, today).replace(/^./, c => c.toUpperCase())}: ${list.map(x => `${x.completed ? "✓ " : ""}${x.title}${x.start ? " at " + clock12(x.start) : ""}`).join(", ")}. ${left.length ? `${left.length} still to do.` : "All done!"}`;
    }

    // default: what's most important right now
    const ranked = Priority.focus(open, rc, 3);
    if (!ranked.length) {
        const next = Priority.rank(open.filter(x => x.date > today), rc)[0];
        return next
            ? `You're all caught up for today. Next up is ${describeTask(next, today)}. You could get a head start, or tell me what else you need to do.`
            : "You're all caught up: nothing left on your list. Tell me what you need to get done and I'll plan it.";
    }
    const first = ranked[0];
    const why = Priority.reason(first, rc);
    let reply = `Start with ${describeTask(first, today)}${why && !/^\d/.test(why) ? `: ${why.toLowerCase()}` : ""}.`;
    if (ranked.length > 1) reply += ` After that: ${ranked.slice(1).map(x => x.title).join(", then ")}.`;
    return reply;
}

// Find which existing tasks a change request is about
function findTargets(message, ctx, recent, today) {
    const t = message.toLowerCase();
    const upcoming = (ctx.tasks || []).filter(x => !x.completed && x.date && daysBetween(today, x.date) >= -1);
    const pronoun = /\b(it|them|those|these|that|all of them)\b/.test(t);

    if (pronoun && recent && recent.length) {
        const ids = new Set(recent.map(String));
        const list = upcoming.filter(x => ids.has(String(x.id)));
        if (list.length) return list;
    }

    const w = words(message);
    if (!w.length) return [];
    const scored = upcoming.map(x => {
        const tw = words(x.title);
        const hits = w.filter(q => tw.some(k => k === q || k.startsWith(q) || q.startsWith(k))).length;
        return { x, hits };
    }).filter(s => s.hits > 0);
    if (!scored.length) return [];
    const best = Math.max(...scored.map(s => s.hits));
    let list = scored.filter(s => s.hits === best).map(s => s.x)
        .sort((a, b) => (a.date + (a.start || "99")).localeCompare(b.date + (b.start || "99")));
    if (!/\b(all|every|sessions|them)\b/.test(t)) list = list.slice(0, 1);
    return list;
}

function taskDur(x) {
    const s = toMin(x.start), e = toMin(x.end);
    if (s !== null && e !== null && e > s) return e - s;
    return Number(x.duration) || estimateDuration(x.title || "");
}

function localEdit(message, ctx, recent, today, now, existing) {
    const targets = findTargets(message, ctx, recent, today);
    if (!targets.length) return null;
    const text = message.toLowerCase();

    if (/\b(delete|remove|cancel|drop|skip)\b/.test(text)) {
        return {
            reply: `I'll remove ${targets.length === 1 ? `**${targets[0].title}**` : `${targets.length} tasks`} from your plan. Confirm below.`,
            updates: targets.map(x => ({ id: String(x.id), title: x.title, date: x.date, start: x.start, end: x.end, duration: taskDur(x), remove: true, from: { date: x.date, start: x.start, end: x.end } }))
        };
    }

    const dur = findDuration(text);
    const time = findTime(text);
    const when = findDate(text, today);
    const changes = [];

    const items = targets.map(x => {
        const d = dur ? dur.minutes : taskDur(x);
        let start = x.start || null, flexible = true;
        if (time) { start = time.start; flexible = false; }
        else if (/\bearlier\b/.test(text) && x.start) { start = toClock(Math.max(DAY_START, toMin(x.start) - 60)); flexible = false; }
        else if (/\blater\b/.test(text) && x.start) { start = toClock(Math.min(DAY_END - d, toMin(x.start) + 60)); flexible = false; }
        else if (dur && x.start) { flexible = false; }
        let date = when ? when.date : x.date;
        if (daysBetween(today, date) < 0) date = today;
        return { title: x.title, date, start, duration: d, flexible, sourceId: String(x.id) };
    });
    const name = targets.length === 1 ? `**${targets[0].title}**` : `these ${targets.length} tasks`;
    if (when) changes.push(`to ${friendly(when.date, today)}`);
    if (time) changes.push(`${when ? "at" : "to"} ${clock12(time.start)}`);
    if (/\bearlier\b/.test(text) && !time) changes.push("an hour earlier");
    if (/\blater\b/.test(text) && !time) changes.push("an hour later");
    if (dur) changes.push(`${changes.length ? "and make " + (targets.length === 1 ? "it" : "them") + " " : "__DUR__"}${durLabel(dur.minutes)}`);
    if (!changes.length) return null;

    const ids = new Set(targets.map(x => String(x.id)));
    const busy = existing.filter(e => !ids.has(String(e.id)));
    let placed = schedule(items, { today, now, existing: busy });

    // Events are fixed commitments: never put a task on top of one without asking
    if (time && !/\b(anyway|regardless|still)\b/.test(text)) {
        const events = busy.filter(e => e.kind === "event");
        const clashOf = p => events.find(e => e.date === p.date && toMin(p.start) < toMin(e.end) && toMin(e.start) < toMin(p.start) + p.duration);
        const clash = placed.map(clashOf).find(Boolean);
        if (clash) {
            const alt = schedule(items.map(it => ({ ...it, flexible: true, start: toClock(Math.max(toMin(time.start), toMin(clash.end) + BUFFER)) })), { today, now, existing: busy });
            const byId0 = {};
            targets.forEach(x => { byId0[String(x.id)] = x; });
            return {
                reply: `There's **${clash.title}** from ${clock12(clash.start)}–${clock12(clash.end)}${clash.date !== today ? " " + friendly(clash.date, today) : ""}. I won't move it. ${alt.length ? `The next free time is ${clock12(alt[0].start)}: confirm below, or keep ${clock12(time.start)} anyway.` : "Choose another time?"}`,
                updates: alt.map(p => {
                    const orig = byId0[p.sourceId] || {};
                    return { id: p.sourceId, title: p.title, date: p.date, start: p.start, end: p.end, duration: p.duration, notes: p.notes, from: { date: orig.date, start: orig.start, end: orig.end } };
                }),
                actions: [{ label: `Keep ${clock12(time.start)} anyway`, send: message + " anyway" }]
            };
        }
    }
    const byId = {};
    targets.forEach(x => { byId[String(x.id)] = x; });

    return {
        reply: (changes[0].startsWith("__DUR__")
            ? `I'll make ${name} ${changes[0].replace("__DUR__", "")}.`
            : `I'll move ${name} ${changes.join(" ")}.`) + " Confirm below.",
        updates: placed.map(p => {
            const orig = byId[p.sourceId] || {};
            return { id: p.sourceId, title: p.title, date: p.date, start: p.start, end: p.end, duration: p.duration, notes: p.notes, from: { date: orig.date, start: orig.start, end: orig.end } };
        })
    };
}

/* ---------- "What should I do now?" : one task, short reasons ---------- */
function joinNames(list) {
    const n = list.map(x => `**${x.title}**`);
    return n.length <= 1 ? (n[0] || "") : n.slice(0, -1).join(", ") + " and " + n[n.length - 1];
}

// A natural time for a task being moved (its old time, or a sensible one for its kind)
function naturalStart(x, ctx) {
    return x.start || suggestTime(x.title || "", preferredStartFromPrefs(ctx && ctx.prefs)) || "";
}

function whatNowAnswer(ctx, today, now) {
    const rc = rankCtx(today, now, ctx.goals, ctx.events);
    const r = Priority.whatNow(ctx.tasks || [], rc);
    if (r.type === "current") {
        return {
            reply: `Your next scheduled task is **${r.task.title}**${r.task.start ? ` at ${clock12(r.task.start)}` : ""}.`,
            suggestion: { taskId: String(r.task.id), minutes: r.minutes, reasons: r.reasons }
        };
    }
    if (r.type === "task") {
        return {
            reply: `Work on **${r.task.title}** now.`,
            suggestion: { taskId: String(r.task.id), minutes: r.minutes, reasons: r.reasons }
        };
    }
    if (r.busyWith) {
        return { reply: `You're in **${r.busyWith.title}** until ${clock12(r.busyWith.end)}. I'll have something ready for after that: ask me again then.`, actions: [{ label: "Plan the rest of my day", send: "Plan my day" }] };
    }
    return {
        reply: "You have no urgent tasks right now.",
        actions: [{ label: "Plan the rest of my day", send: "Plan my day" }]
    };
}

/* ---------- "Plan my week" ---------- */
function planWeek(ctx, today, now, existing) {
    const tasks = ctx.tasks || [];
    const end = addDays(today, 6);
    const toPlace = tasks.filter(x => !x.completed && x.date && (
        daysBetween(today, x.date) < 0 ||
        (!x.start && x.date <= end) ||
        (!x.start && x.deadline && x.deadline <= end)
    ));
    const load = {};
    for (let i = 0; i < 7; i++) load[addDays(today, i)] = 0;
    tasks.filter(x => !x.completed && x.start && load[x.date] !== undefined).forEach(x => { load[x.date] += taskDur(x); });

    if (!toPlace.length) {
        const days = Object.keys(load).filter(d => load[d] > 0);
        if (!days.length) return { reply: "Your week is clear. Tell me what you need to get done this week and I'll spread it out.", updates: [] };
        const busiest = days.sort((a, b) => load[b] - load[a])[0];
        return { reply: `Everything this week already has a time. Busiest day: ${friendly(busiest, today)} (${durLabel(load[busiest])}).`, updates: [] };
    }
    const rc = rankCtx(today, now, ctx.goals, ctx.events);
    const ordered = Priority.rank(toPlace, rc);
    const items = ordered.map(x => {
        const dur = taskDur(x);
        const last = x.deadline && x.deadline <= end ? (daysBetween(today, x.deadline) > 0 ? addDays(x.deadline, -1) : today) : end;
        const first = x.date > today ? x.date : today;
        let best = first <= last ? first : today, bestLoad = Infinity;
        for (let d = first; d <= last; d = addDays(d, 1)) {
            if (load[d] !== undefined && load[d] < bestLoad) { best = d; bestLoad = load[d]; }
        }
        load[best] = (load[best] || 0) + dur;
        return { title: x.title, date: best, start: suggestTime(x.title, preferredStartFromPrefs(ctx.prefs)), duration: dur, flexible: true, sourceId: String(x.id), deadline: x.deadline || null };
    });
    const ids = new Set(toPlace.map(x => String(x.id)));
    const placed = schedule(items, { today, now, existing: existing.filter(e => !ids.has(String(e.id))) });
    const byId = {};
    toPlace.forEach(x => { byId[String(x.id)] = x; });
    const days = new Set(placed.map(p => p.date)).size;
    return {
        reply: `Here's your week: ${placed.length} task${placed.length === 1 ? "" : "s"} spread over ${days} day${days === 1 ? "" : "s"}, deadlines first and busy days kept light. Confirm below.`,
        updates: placed.map(p => {
            const o = byId[p.sourceId] || {};
            return { id: p.sourceId, title: p.title, date: p.date, start: p.start, end: p.end, duration: p.duration, notes: p.notes, from: { date: o.date, start: o.start, end: o.end } };
        })
    };
}

/* ---------- "I only have 2 hours tonight" ---------- */
function limitedTime(message, ctx, today, now, existing) {
    const t = message.toLowerCase();
    const m = t.match(/(\d+(?:\.\d+)?|an?|one|two|three|four|five|half an?)\s*(hours?|hrs?|h|minutes?|mins?)\b/);
    const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, "half a": 0.5, "half an": 0.5 };
    let budget = 120;
    if (m) {
        const n = words[m[1]] !== undefined ? words[m[1]] : Number(m[1]);
        budget = Math.round(/^h/.test(m[2]) ? n * 60 : n);
    }
    const nowMin = toMin(now) || DAY_START;
    const startMin = /tonight|evening/.test(t) ? Math.max(nowMin + 10, 18 * 60) : nowMin + 10;
    const tasks = ctx.tasks || [];
    const candidates = tasks.filter(x => !x.completed && x.date && daysBetween(today, x.date) <= 0 &&
        (toMin(x.start) === null || toMin(x.start) >= nowMin || daysBetween(today, x.date) < 0));
    if (!candidates.length) return { reply: `Nothing is left for today, so your ${durLabel(budget)} is free. Want me to get a head start on tomorrow?`, updates: [], actions: [{ label: "Plan my week", send: "Plan my week" }] };

    const rc = rankCtx(today, now, ctx.goals, ctx.events);
    const ranked = Priority.rank(candidates, rc);
    let used = 0;
    const keep = [], later = [];
    ranked.forEach(x => {
        const d = taskDur(x);
        if (used + d <= budget) { keep.push(x); used += d; } else later.push(x);
    });
    if (!keep.length && ranked.length) { keep.push(ranked[0]); later.splice(later.indexOf(ranked[0]), 1); }

    const ids = new Set(candidates.map(x => String(x.id)));
    const busy = existing.filter(e => !ids.has(String(e.id)));
    const start = toClock(roundUp(startMin));
    const placedNow = schedule(keep.map(x => ({ title: x.title, date: today, start, duration: Math.min(taskDur(x), budget), flexible: true, sourceId: String(x.id) })), { today, now, existing: busy });
    const placedLater = later.length ? schedule(later.map(x => ({ title: x.title, date: addDays(today, 1), start: naturalStart(x, ctx), duration: taskDur(x), flexible: true, sourceId: String(x.id), deadline: x.deadline || null })),
        { today, now, existing: busy.concat(placedNow) }) : [];
    const byId = {};
    candidates.forEach(x => { byId[String(x.id)] = x; });
    const toUpdate = p => { const o = byId[p.sourceId] || {}; return { id: p.sourceId, title: p.title, date: p.date, start: p.start, end: p.end, duration: p.duration, notes: p.notes, from: { date: o.date, start: o.start, end: o.end } }; };
    return {
        reply: `With ${durLabel(budget)}${/tonight/.test(t) ? " tonight" : ""}, do ${joinNames(keep)}.${later.length ? ` I'll move ${later.length === 1 ? `**${later[0].title}**` : `${later.length} other tasks`} to tomorrow.` : ""} Confirm below.`,
        updates: placedNow.map(toUpdate).concat(placedLater.map(toUpdate))
    };
}

/* ---------- "I'm behind on my assignment" ---------- */
function behindOn(message, ctx, recent, today, now, existing) {
    const targets = findTargets(message.replace(/\b(i'?m|i am|im|behind|on|with|falling|so|really|a bit)\b/gi, " "), ctx, recent, today);
    const goal = !targets.length ? (ctx.goals || []).find(g => words(g.title).some(w => words(message).includes(w))) : null;
    if (!targets.length && !goal) {
        return { reply: "Which task are you behind on? For example \"I'm behind on my history essay\"." };
    }
    const base = targets[0] || null;
    const title = base ? base.title : goal.title;
    const due = (base && (base.deadline || base.date)) || (goal && goal.date) || addDays(today, 2);
    const lastDay = daysBetween(today, due) > 0 ? addDays(due, -1) : today;
    const n = daysBetween(today, lastDay) >= 1 ? 2 : 1;
    const items = [];
    for (let i = 0; i < n; i++) {
        items.push({ title: `${title.replace(/^([^:]+):.*$/, "$1")}: catch-up session`, date: addDays(today, Math.min(i, Math.max(0, daysBetween(today, lastDay)))), start: "", duration: 60, flexible: true, deadline: lastDay, goalRef: base && base.goalId ? "g1" : goal ? "g1" : null });
    }
    const placed = schedule(items, { today, now, existing });
    const goalId = (base && base.goalId) || (goal && goal.id) || null;
    return {
        reply: `Let's catch up on **${title}**: I've found ${placed.length === 1 ? "an extra hour" : `${placed.length} extra focused hours`} before it's due (${friendly(due, today)}). Confirm below or tell me what to change.`,
        tasks: placed,
        goals: goalId ? [{ ref: "g1", title: (ctx.goals || []).find(g => g.id === goalId) ? (ctx.goals || []).find(g => g.id === goalId).title : title, date: null, milestones: [], existingId: goalId }] : []
    };
}

/* ---------- "Move everything unfinished to tomorrow" ---------- */
function moveUnfinished(ctx, today, now, existing) {
    const nowMin = toMin(now) || 0;
    const list = (ctx.tasks || []).filter(x => !x.completed && x.date && daysBetween(today, x.date) <= 0);
    if (!list.length) return { reply: "Nothing unfinished to move. You're all caught up.", updates: [] };
    const rc = rankCtx(today, now, ctx.goals, ctx.events);
    const ranked = Priority.rank(list, rc);
    const ids = new Set(list.map(x => String(x.id)));
    const placed = schedule(ranked.map(x => ({ title: x.title, date: addDays(today, 1), start: naturalStart(x, ctx), duration: taskDur(x), flexible: true, sourceId: String(x.id), deadline: x.deadline || null })),
        { today, now, existing: existing.filter(e => !ids.has(String(e.id))) });
    const byId = {};
    list.forEach(x => { byId[String(x.id)] = x; });
    return {
        reply: `I'll move ${list.length} unfinished task${list.length === 1 ? "" : "s"} to tomorrow, most important first. Confirm below.`,
        updates: placed.map(p => { const o = byId[p.sourceId] || {}; return { id: p.sourceId, title: p.title, date: p.date, start: p.start, end: p.end, duration: p.duration, notes: p.notes, from: { date: o.date, start: o.start, end: o.end } }; })
    };
}

/* ---------- "Break this task into smaller tasks" ---------- */
const BREAKDOWN = [
    [/essay|report|paper|article|thesis|assignment|coursework|write/i, ["Research and gather sources", "Outline the structure", "Write the first draft", "Revise for clarity", "Proofread and submit"]],
    [/presentation|slides|deck|pitch/i, ["Outline the talk", "Design the slides", "Add content and visuals", "Practise out loud", "Final review"]],
    [/study|exam|revise|revision|test/i, ["Gather notes and materials", "Review key concepts", "Practice questions", "Go over weak areas", "Final review"]],
    [/clean|organi[sz]e|declutter|tidy|move house|pack/i, ["Sort things into keep / donate / bin", "Clean the space", "Put everything in its place", "Take out donations and rubbish"]],
    [/project|app|website|build|launch/i, ["Define what done looks like", "Split into features", "Build the first part", "Test and fix", "Finish and share"]],
    [/event|party|trip|travel|wedding/i, ["Set the date and guest list", "Book venue or transport", "Send invites / confirm bookings", "Prepare what you need", "Day-of checklist"]]
];

function breakDown(message, ctx, recent, today, now, existing) {
    const cleaned = message.replace(/^(please\s+)?(break|split)\s+(down\s+)?/i, "").replace(/\b(down|into smaller tasks|into steps|into parts|up|into smaller parts)\b/gi, " ").replace(/\s+/g, " ").trim();
    const isThis = /^(this|that|it)( task)?$/i.test(cleaned) || !cleaned;
    let target = null;
    if (isThis && recent && recent.length) target = (ctx.tasks || []).find(x => String(x.id) === String(recent[recent.length - 1])) || null;
    if (!target && !isThis) target = findTargets(cleaned, ctx, [], today)[0] || null;
    if (!target && isThis) return { reply: "Which task should I break down? For example \"break down my history essay\"." };
    const title = target ? target.title : cleanTitle(cleaned, []) || cleaned;
    const tpl = (BREAKDOWN.find(([re]) => re.test(title)) || [null, ["Figure out the first step", "Do the main part", "Review and finish"]])[1];
    const total = target ? taskDur(target) : 180;
    const each = Math.max(20, roundUp(Math.min(90, total / tpl.length), 5));
    const due = target && (target.deadline || (target.date >= today ? target.date : null));
    const items = tpl.map((step, i) => ({ title: `${title}: ${step}`, date: today, start: "", duration: each, flexible: true, deadline: due || null, goalRef: target && target.goalId ? "g1" : null }));
    const placed = schedule(items, { today, now, existing });
    return {
        reply: `I've split **${title}** into ${tpl.length} smaller steps${due ? `, all before ${friendly(due, today)}` : ""}. Untick any you don't need.`,
        tasks: placed,
        goals: target && target.goalId ? [{ ref: "g1", title: ((ctx.goals || []).find(g => g.id === target.goalId) || {}).title || title, date: null, milestones: [], existingId: target.goalId }] : []
    };
}

/* ---------- "Am I on track for my goal?" ---------- */
function goalStatus(message, ctx, today) {
    const goals = (ctx.goals || []).filter(g => g.status !== "completed");
    if (!goals.length) return { reply: "You don't have any goals yet. Tell me one, like \"learn Python by next month\".", actions: [] };
    const w = words(message).filter(x => !["track", "goal", "goals", "progress", "doing"].includes(x));
    const goal = goals.find(g => words(g.title).some(k => w.includes(k))) || (goals.length === 1 ? goals[0] : null);
    if (!goal) return { reply: `Which goal? You have ${goals.map(g => `**${g.title}**`).join(", ")}.` };
    const sessions = (ctx.tasks || []).filter(t => t.goalId === goal.id);
    const done = sessions.filter(t => t.completed).length;
    const progress = goal.progress || 0;
    const next = sessions.filter(t => !t.completed && t.date >= today).sort((a, b) => (a.date + (a.start || "")).localeCompare(b.date + (b.start || "")))[0];
    let verdict = "";
    if (goal.date && goal.createdAt) {
        const start = String(goal.createdAt).slice(0, 10);
        const total = Math.max(1, daysBetween(start, goal.date));
        const used = Math.min(100, Math.max(0, Math.round(daysBetween(start, today) / total * 100)));
        verdict = progress >= used - 10 ? `on track (${progress}% done, ${used}% of the time used)` : `a little behind (${progress}% done, ${used}% of the time used)`;
    } else {
        verdict = `${progress}% done`;
    }
    const actions = next ? [{ label: "Start next session", start: String(next.id) }] : [{ label: "Plan next session", planGoal: goal.id }];
    if (!/behind/.test(verdict) && next) actions.length = 1;
    if (/behind/.test(verdict)) actions.push({ label: "Add a catch-up session", send: `I'm behind on ${goal.title}` });
    return {
        reply: `**${goal.title}**: ${verdict}.${sessions.length ? ` ${done}/${sessions.length} sessions done.` : ""} ${next ? `Next session: ${friendly(next.date, today)}${next.start ? " " + clock12(next.start) : ""}.` : "No session planned yet."}`,
        actions
    };
}


function planDay(message, ctx, today, now, existing) {
    const named = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(message) ? findDate(message, today) : null;
    const target = named ? named.date : /tomorrow/i.test(message) ? addDays(today, 1) : today;
    const dayWord = target === today ? "day" : target === addDays(today, 1) ? "day tomorrow" : friendly(target, today);
    const tasks = ctx.tasks || [];
    const toPlace = tasks.filter(x => !x.completed && ((x.date === target && !x.start) || (!named && daysBetween(today, x.date) < 0)));
    const dayTasks = tasks.filter(x => x.date === target && !x.completed && x.start);

    if (!toPlace.length) {
        if (!dayTasks.length) {
            return { reply: `You have a clear ${dayWord}. What do you need to get done? For example "finish my assignment, gym and read 20 pages".`, updates: [] };
        }
        const gaps = freeWindowsServer(busyItems(ctx), target, target === today ? (toMin(now) || DAY_START) + 10 : DAY_START);
        return {
            reply: `Your ${target === today ? "day" : named ? friendly(target, today) : "tomorrow"} is already planned: ${dayTasks.length} task${dayTasks.length === 1 ? "" : "s"}, starting with ${describeTask(dayTasks.sort((a, b) => a.start.localeCompare(b.start))[0], today)}.${gaps.length ? ` You're free ${gaps.slice(0, 2).map(([s, e]) => `${clock12(toClock(s))}–${clock12(toClock(e))}`).join(" and ")}: tell me what to fit in.` : ""}`,
            updates: []
        };
    }

    const rc = rankCtx(today, now, ctx.goals, ctx.events);
    const ordered = Priority.rank(toPlace, rc);
    const items = ordered.map(x => ({ title: x.title, date: target, start: suggestTime(x.title, preferredStartFromPrefs(ctx.prefs)), duration: taskDur(x), flexible: true, sourceId: String(x.id), deadline: x.deadline || null }));
    const ids = new Set(toPlace.map(x => String(x.id)));
    const placed = schedule(items, { today, now, existing: existing.filter(e => !ids.has(String(e.id))) });
    const byId = {};
    toPlace.forEach(x => { byId[String(x.id)] = x; });
    const overdue = toPlace.filter(x => daysBetween(today, x.date) < 0).length;

    return {
        reply: `Here's your ${target === today ? "day" : named ? "plan for " + friendly(target, today) : "plan for tomorrow"}: I've given ${placed.length} task${placed.length === 1 ? "" : "s"} a time${overdue ? `, including ${overdue} carried over from earlier` : ""}, most important first. Confirm below or tell me what to change.`,
        updates: placed.map(p => {
            const o = byId[p.sourceId] || {};
            return { id: p.sourceId, title: p.title, date: p.date, start: p.start, end: p.end, duration: p.duration, notes: p.notes, from: { date: o.date, start: o.start, end: o.end } };
        })
    };
}


/* ---------------------------------------------------------
   OpenAI (when a key is set)
   --------------------------------------------------------- */

async function callOpenAI(messages) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({
            model: process.env.OPENAI_MODEL || "gpt-4o-mini",
            temperature: 0.3,
            response_format: { type: "json_object" },
            messages
        })
    });
    if (!response.ok) {
        console.error("OpenAI error:", await response.text());
        throw new Error("OpenAI request failed");
    }
    const data = await response.json();
    return JSON.parse(data.choices?.[0]?.message?.content || "{}");
}

function contextText(ctx, today) {
    const tasks = (ctx.tasks || [])
        .filter(t => isDate(t.date) && daysBetween(today, t.date) >= -7 && daysBetween(today, t.date) <= 21)
        .slice(0, 120)
        .map(t => `- id=${t.id} | ${t.date} ${t.start || "--:--"}-${t.end || "--:--"} | ${t.completed ? "DONE" : "todo"} | ${t.title}${t.priority ? ` | priority ${t.priority}` : ""}${t.deadline ? ` | deadline ${t.deadline}` : ""}${t.goalId ? ` | goal ${t.goalId}` : ""}`)
        .join("\n") || "(no tasks yet)";
    const goals = (ctx.goals || []).map(g => `- id=${g.id} | ${g.title} | ${g.progress || 0}%${g.date ? ` | by ${g.date}` : ""}`).join("\n") || "(no goals yet)";
    const events = (ctx.events || [])
        .filter(e => daysBetween(today, e.date) >= 0 && daysBetween(today, e.date) <= 21)
        .slice(0, 80)
        .map(e => `- ${e.date} ${e.start}-${e.end} | ${e.title}`)
        .join("\n") || "(no events)";
    return `THE USER'S TASKS (real data, never invent others):\n${tasks}\n\nTHE USER'S EVENTS (fixed commitments: never schedule tasks over them, never move or change them):\n${events}\n\nTHE USER'S GOALS:\n${goals}`;
}

async function aiRequest({ message, mode, today, now, ctx, history, draft, prefs, attachGoal }) {
    const system =
`You are Planora, a calm, practical personal productivity assistant. Today is ${today} (${WEEKDAYS[dayOfWeek(today)]}), the time is ${now || "unknown"} in the user's timezone.
${contextText(ctx, today)}
${prefs && prefs.productiveTimes && prefs.productiveTimes.length ? `The user is most productive: ${prefs.productiveTimes.join(", ")}.` : ""}
${attachGoal ? `The user wants practice sessions for their EXISTING goal "${attachGoal.title}"${attachGoal.date ? ` (target ${attachGoal.date})` : ""}. Put all sessions under goalRef "g1" and return one goal with ref "g1" (same title) plus 3-5 milestones.` : ""}
${draft && (draft.tasks || []).length ? `The user is reviewing this DRAFT plan; if they ask for changes return the FULL revised plan:\n${JSON.stringify(draft)}` : ""}

${mode === "question"
    ? "The user is asking a question. Answer it in 1-3 short sentences using ONLY the real tasks/goals above (e.g. what to do first and why: overdue > deadlines > priority > time today > goal). Return empty tasks, goals and updates unless they explicitly ask you to change something."
    : `Turn the message into a plan:
- TASK (one-off), REPEATING (separate sessions on different days), DEADLINE (split into sessions before the deadline), GOAL (skill/outcome over days: a goal with 3-5 milestones AND regular sessions until the target date, each session with a specific topic).
- To CHANGE or REMOVE an EXISTING task, use "updates" with its real id (never create a duplicate task).
- Realistic durations (email 20m, call 30m, gym 60m, study 60m, big writing 2-3h split into blocks) and sensible times 07:00-22:30. Never schedule today before ${now || "now"}. Avoid clashes with existing tasks and events. Appointments, meetings, classes and other things that happen at a set time are EVENTS, not tasks: never return them in "tasks" (the app adds events separately).`}

Respond with ONLY valid JSON:
{
  "reply": "1-3 short friendly sentences. If you made a plan, end by asking them to confirm or say what to change.",
  "goals": [ { "ref": "g1", "title": "…", "date": "YYYY-MM-DD", "milestones": [ { "text": "…", "date": "YYYY-MM-DD" } ] } ],
  "tasks": [ { "title": "…", "date": "YYYY-MM-DD", "start": "HH:MM", "duration": 60, "goalRef": "g1 or null", "flexible": true, "deadline": "YYYY-MM-DD or null" } ],
  "updates": [ { "id": "existing task id", "date": "YYYY-MM-DD", "start": "HH:MM", "duration": 60, "remove": false } ]
}
"flexible": false ONLY when the user gave an exact time. At most 25 tasks.`;

    const messages = [{ role: "system", content: system }];
    (history || []).slice(-6).forEach(h => {
        if (h && h.text) messages.push({ role: h.role === "user" ? "user" : "assistant", content: String(h.text).slice(0, 1000) });
    });
    messages.push({ role: "user", content: message });

    const parsed = await callOpenAI(messages);
    return {
        reply: typeof parsed.reply === "string" ? parsed.reply : "",
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        goals: Array.isArray(parsed.goals) ? parsed.goals : [],
        updates: Array.isArray(parsed.updates) ? parsed.updates : []
    };
}

// Turn AI "updates" into checked, scheduled changes to real tasks
function resolveUpdates(updates, ctx, today, now, existing) {
    const byId = {};
    (ctx.tasks || []).forEach(t => { byId[String(t.id)] = t; });
    const valid = (updates || []).filter(u => u && byId[String(u.id)]);
    const removals = valid.filter(u => u.remove).map(u => {
        const o = byId[String(u.id)];
        return { id: String(o.id), title: o.title, date: o.date, start: o.start, end: o.end, duration: taskDur(o), remove: true, from: { date: o.date, start: o.start, end: o.end } };
    });
    const moves = valid.filter(u => !u.remove);
    const ids = new Set(moves.map(u => String(u.id)));
    const placed = schedule(moves.map(u => {
        const o = byId[String(u.id)];
        return { title: o.title, date: isDate(u.date) ? u.date : o.date, start: u.start || o.start, duration: Number(u.duration) || taskDur(o), flexible: !u.start, sourceId: String(o.id) };
    }), { today, now, existing: existing.filter(e => !ids.has(String(e.id))) });
    return removals.concat(placed.map(p => {
        const o = byId[p.sourceId];
        return { id: p.sourceId, title: p.title, date: p.date, start: p.start, end: p.end, duration: p.duration, notes: p.notes, from: { date: o.date, start: o.start, end: o.end } };
    }));
}


/* ---------------------------------------------------------
   Routes
   --------------------------------------------------------- */

function sanitiseGoals(goals, today) {
    return (goals || []).slice(0, 5).map((g, i) => ({
        ref: String(g.ref || "g" + (i + 1)),
        title: String(g.title || "New goal").slice(0, 100),
        date: isDate(g.date) && daysBetween(today, g.date) >= 0 ? g.date : null,
        milestones: (Array.isArray(g.milestones) ? g.milestones : []).slice(0, 8).map(m => ({
            text: String((m && m.text) || m || "").slice(0, 120),
            date: m && isDate(m.date) ? m.date : null
        })).filter(m => m.text)
    }));
}

function sanitiseContext(body, today) {
    const ctx = body.context && typeof body.context === "object" ? body.context : {};
    const tasks = (Array.isArray(ctx.tasks) ? ctx.tasks : []).slice(0, 400).filter(t => t && t.id && isDate(t.date)).map(t => ({
        id: String(t.id).slice(0, 80), title: String(t.title || "").slice(0, 140), date: t.date,
        start: /^\d{1,2}:\d{2}$/.test(t.start || "") ? t.start : "", end: /^\d{1,2}:\d{2}$/.test(t.end || "") ? t.end : "",
        completed: Boolean(t.completed), priority: t.priority || "", deadline: isDate(t.deadline) ? t.deadline : "", goalId: t.goalId ? String(t.goalId) : "",
        duration: Number(t.duration) > 0 ? Math.min(600, Number(t.duration)) : undefined
    }));
    const goals = (Array.isArray(ctx.goals) ? ctx.goals : []).slice(0, 30).map(g => ({
        id: String(g.id || ""), title: String(g.title || "").slice(0, 100), date: isDate(g.date) ? g.date : null,
        progress: Number(g.progress) || 0, status: g.status || "active",
        createdAt: typeof g.createdAt === "string" ? g.createdAt.slice(0, 30) : null
    }));
    const clock = v => /^\d{1,2}:\d{2}$/.test(v || "") ? v : "";
    const events = (Array.isArray(ctx.events) ? ctx.events : []).slice(0, 400).filter(e => e && e.id && isDate(e.date) && clock(e.start)).map(e => ({
        id: String(e.id).slice(0, 80), title: String(e.title || "").slice(0, 140), date: e.date,
        start: clock(e.start), end: clock(e.end) || toClock(toMin(e.start) + 60), category: String(e.category || "").slice(0, 20), kind: "event"
    }));
    // busy slots = unfinished timed tasks and events from today on (plus anything the client sent separately)
    const existing = tasks.filter(t => !t.completed && t.start && daysBetween(today, t.date) >= 0)
        .map(t => ({ id: t.id, date: t.date, start: t.start, end: t.end, title: t.title }))
        .concat(events.filter(e => daysBetween(today, e.date) >= 0).map(e => ({ id: e.id, date: e.date, start: e.start, end: e.end, title: e.title, kind: "event" })))
        .concat((Array.isArray(body.existing) ? body.existing : []).slice(0, 600)
            .filter(e => e && isDate(e.date) && /^\d{1,2}:\d{2}$/.test(e.start || ""))
            .map(e => ({ date: e.date, start: e.start, end: /^\d{1,2}:\d{2}$/.test(e.end || "") ? e.end : "", title: String(e.title || "").slice(0, 80) })));
    return { ctx: { tasks, goals, events }, existing };
}

/* ---------------------------------------------------------
   Events vs tasks in Ask Planora
   "I have a dentist appointment Friday at 3"   → Event
   "Meeting with Sarah Friday 10–11"            → Event
   "Finish my assignment Friday afternoon"      → Task
   Unclear ("Sarah 10–11 Friday")               → ask: Task or Event?
   --------------------------------------------------------- */

function findRange(text) {
    const t = text.toLowerCase();
    const m = t.match(/\b(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    if (!m) return null;
    let h1 = Number(m[1]), h2 = Number(m[4]);
    if (h1 > 23 || h2 > 23) return null;
    const m1 = Number(m[2] || 0), m2 = Number(m[5] || 0);
    let a1 = m[3], a2 = m[6];
    if (!a1 && !a2) {
        // "10–11" → morning; "2–4" → afternoon
        a2 = h2 >= 8 && h2 <= 11 && h1 <= h2 ? "am" : h2 === 12 ? "pm" : h2 <= 7 ? "pm" : null;
        a1 = h1 >= 8 && h1 <= 11 ? "am" : h1 === 12 ? "pm" : h1 <= 7 ? "pm" : null;
    } else if (!a1) {
        a1 = a2 === "pm" && h1 > h2 && h1 !== 12 ? "am" : a2;
    } else if (!a2) {
        a2 = a1 === "am" && h2 < h1 ? "pm" : a1;
    }
    const to24 = (h, a) => a === "pm" ? (h % 12) + 12 : a === "am" ? h % 12 : h;
    const s = to24(h1, a1) * 60 + m1;
    let e = to24(h2, a2) * 60 + m2;
    if (e <= s) e = s + 60;
    return { start: toClock(s), end: toClock(Math.min(e, 24 * 60 - 1)), match: m[0] };
}

function eventFromText(raw, today, now) {
    const rep = findRepeatRule(raw);
    const range = findRange(raw);
    const time = range ? null : findTime(raw);
    const dur = range ? null : findDuration(raw);
    let when = rep && rep.rule.type === "custom" ? null : findDate(raw, today);
    let date = when ? when.date : today;
    if (rep && rep.rule.type === "custom") {
        for (let i = 0; i < 7; i++) { const d = addDays(today, i); if (rep.rule.days.includes(dayOfWeek(d))) { date = d; break; } }
    }
    let start = range ? range.start : time ? time.start : null;
    let notes = "";
    if (!start) { start = "09:00"; notes = "No time given: set it before adding."; }
    const end = range ? range.end : toClock(Math.min(24 * 60 - 1, toMin(start) + (dur ? dur.minutes : 60)));
    let title = cleanTitle(raw.replace(/\bas an? event\b|\badd (it )?to (my )?calendar\b/ig, " ")
        .replace(/^\s*(i\s+(have|'ve got|got)|i've got|there'?s|there is|we have|we've got)\s+(an?\s+)?/i, " "),
        [when && when.match, time && time.match, range && range.match, dur && dur.match, rep && rep.match]);
    title = title.replace(/^(an?|my|the)\s+/i, "").replace(/\s+(on|at|from)$/i, "").trim();
    title = title ? title.charAt(0).toUpperCase() + title.slice(1) : "Event";
    return {
        type: "event", title, date, start, end,
        duration: toMin(end) - toMin(start),
        category: Priority.guessCategory(raw),
        ...(rep ? { repeat: rep.rule } : {}),
        ...(notes ? { notes } : {})
    };
}

function extractEvents(message, today, now) {
    const items = splitItems(message);
    const events = [], ambiguous = [], rest = [];
    items.forEach(raw => {
        const kind = Priority.kindOf(raw);
        if (kind === "event") events.push(eventFromText(raw, today, now));
        else if (kind === "ambiguous") ambiguous.push(raw.replace(/\bas an? (task|event)\b/ig, "").trim());
        else rest.push(raw.replace(/\bas an? task\b/ig, "").trim());
    });
    return { events, ambiguous, rest: rest.join(", ") };
}

/* ---------------------------------------------------------
   One task from one sentence (quick add)
   --------------------------------------------------------- */

const DAY_WORDS = { sun: 0, sunday: 0, sundays: 0, mon: 1, monday: 1, mondays: 1, tue: 2, tues: 2, tuesday: 2, tuesdays: 2, wed: 3, wednesday: 3, wednesdays: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4, fri: 5, friday: 5, fridays: 5, sat: 6, saturday: 6, saturdays: 6 };

function findRepeatRule(text) {
    const t = text.toLowerCase();
    let m = t.match(/\b(every\s*day|daily|each day|everyday|every (morning|evening|night|afternoon))\b/);
    if (m) return { rule: { type: "daily" }, match: m[0] };
    m = t.match(/\b(on\s+)?(every\s+)?weekdays?\b|\bevery weekday\b|\bmon(day)?\s*(-|to|through)\s*fri(day)?\b/);
    if (m && /weekday|mon/.test(m[0])) return { rule: { type: "weekdays" }, match: m[0] };
    m = t.match(/\b(every|on|each)\s+((?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*)(?:\s*(?:,|and|&|\/)\s*(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*)*)/);
    if (m && (m[1] === "every" || m[1] === "each" || /,|and|&|\//.test(m[2]))) {
        const days = Array.from(new Set(m[2].split(/\s*(?:,|and|&|\/)\s*/).map(w => DAY_WORDS[w.trim()]).filter(d => d !== undefined)));
        if (days.length) return { rule: { type: "custom", days }, match: m[0] };
    }
    m = t.match(/\b(weekly|every week|once a week)\b/);
    if (m) return { rule: { type: "weekly" }, match: m[0] };
    return null;
}

function parseTask(text, today) {
    const rep = findRepeatRule(text);
    const when = rep && rep.rule.type === "custom" ? null : findDate(text, today);
    const time = findTime(text);
    const dur = findDuration(text);
    const pri = text.match(/\b(urgent|important|asap|high priority|top priority)\b/i);
    let title = cleanTitle(text, [when && when.match, time && time.match, dur && dur.match, rep && rep.match, pri && pri[0]]) || text;
    title = title.replace(/\b(every|each|on)\s*$/i, "").trim() || text;
    let date = when ? when.date : today;
    if (rep && rep.rule.type === "custom") {
        // first matching day from today
        for (let i = 0; i < 7; i++) { const d = addDays(today, i); if (rep.rule.days.includes(dayOfWeek(d))) { date = d; break; } }
    }
    return {
        title: title.charAt(0).toUpperCase() + title.slice(1),
        date,
        deadline: when && when.deadline ? when.date : null,
        start: time ? time.start : "",
        duration: dur ? dur.minutes : estimateDuration(title),
        priority: pri ? "high" : null,
        repeat: rep ? rep.rule : null
    };
}

function install(app, requireAuth) {

    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 60,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "You've sent a lot of requests. Please wait a few minutes and try again." }
    });

    // Give times to a list of items (used by planners, recommendations, Journal)
    app.post("/api/schedule", requireAuth, limiter, express.json({ limit: "1mb" }), (req, res) => {
        const today = isDate(req.body.today) ? req.body.today : new Date().toLocaleDateString("en-CA");
        const now = /^\d{1,2}:\d{2}$/.test(req.body.now || "") ? req.body.now : null;
        const items = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 60).map(it => ({
            title: String(it.title || "Task").slice(0, 140),
            date: isDate(it.date) ? it.date : today,
            // no time given: use time words in the title ("call mum tonight"), else a natural time
            start: /^\d{1,2}:\d{2}$/.test(it.start || "") ? it.start : ((findTime(String(it.title || "")) || {}).start || suggestTime(String(it.title || ""), null)),
            duration: Math.max(10, Math.min(480, Number(it.duration) || estimateDuration(String(it.title || "")))),
            flexible: it.flexible !== false,
            deadline: isDate(it.deadline) ? it.deadline : null,
            goalRef: it.goalRef || null,
            sourceId: it.sourceId ? String(it.sourceId) : null
        }));
        const existing = (Array.isArray(req.body.existing) ? req.body.existing : []).slice(0, 500);
        res.json({ tasks: schedule(items, { today, now, existing }) });
    });

    // Natural-language quick add: "Finish my physics assignment tomorrow for 2 hours"
    app.post("/api/parse-task", requireAuth, express.json({ limit: "20kb" }), (req, res) => {
        const text = String(req.body.text || "").trim().slice(0, 300);
        const today = isDate(req.body.today) ? req.body.today : new Date().toLocaleDateString("en-CA");
        if (!text) return res.json({});
        res.json(parseTask(text, today));
    });

    app.post("/api/smart-plan", requireAuth, limiter, express.json({ limit: "2mb" }), async (req, res) => {
        const message = String(req.body.message || "").trim().slice(0, 2000);
        if (!message) return res.status(400).json({ error: "Tell me what you'd like to get done." });

        const today = isDate(req.body.today) ? req.body.today : new Date().toLocaleDateString("en-CA");
        const now = /^\d{1,2}:\d{2}$/.test(req.body.now || "") ? req.body.now : null;
        const { ctx, existing } = sanitiseContext(req.body, today);
        const prefs = (req.user && req.user.prefs) || {};
        ctx.prefs = prefs;
        const draft = req.body.draft && Array.isArray(req.body.draft.tasks) && req.body.draft.tasks.length ? req.body.draft : null;
        const recent = Array.isArray(req.body.recent) ? req.body.recent.slice(0, 50) : [];
        const attachGoal = req.body.attachGoal && req.body.attachGoal.title ? req.body.attachGoal : null;
        const mode = attachGoal ? "plan" : classify(message, Boolean(draft));

        const respond = (payload) => res.json({ tasks: [], goals: [], updates: [], events: [], actions: [], suggestion: null, ...payload, mode });

        try {
            /* 0. Quick, deterministic answers that use the user's real data */
            if (mode === "now") return respond({ ...whatNowAnswer(ctx, today, now), source: "planora" });
            if (mode === "plan_week") return respond({ ...planWeek(ctx, today, now, existing), source: "planora" });
            if (mode === "limited") return respond({ ...limitedTime(message, ctx, today, now, existing), source: "planora" });
            if (mode === "behind") return respond({ ...behindOn(message, ctx, recent, today, now, existing), source: "planora" });
            if (mode === "move_unfinished") return respond({ ...moveUnfinished(ctx, today, now, existing), source: "planora" });
            if (mode === "breakdown") return respond({ ...breakDown(message, ctx, recent, today, now, existing), source: "planora" });
            if (mode === "goal_status") return respond({ ...goalStatus(message, ctx, today), source: "planora" });
            if (mode === "study_plan") return respond({
                reply: "Tell me the subject and exam date, like \"biology exam on 10 Oct\", or use the Study Planner.",
                actions: [{ label: "Open Study Planner", openTool: "study" }],
                source: "planora"
            });

            /* 0b. Events ("dentist Friday at 3", "meeting with Sarah 10–11") are not tasks */
            if (mode === "plan" && !attachGoal && !draft) {
                const ex = extractEvents(message, today, now);
                if (ex.ambiguous.length && !ex.events.length && !ex.rest) {
                    const item = ex.ambiguous[0];
                    return respond({
                        reply: `Should I add "${item}" as a Task or an Event? A task is something to get done; an event happens at a set time.`,
                        actions: [{ label: "Task", send: `${item} as a task` }, { label: "Event", send: `${item} as an event` }],
                        source: "planora"
                    });
                }
                if (ex.events.length) {
                    const busy = existing.concat(ex.events.map(e => ({ date: e.date, start: e.start, end: e.end, title: e.title, kind: "event" })));
                    let tasks = [], goals = [];
                    if (ex.rest) {
                        const local = localPlan(ex.rest, today, prefs, now);
                        goals = sanitiseGoals(local.goals, today);
                        tasks = schedule(local.tasks.slice(0, 30), { today, now, existing: busy });
                    }
                    const evText = ex.events.map(e => `**${e.title}** ${friendly(e.date, today)} ${clock12(e.start)}–${clock12(e.end)}`).join(", ");
                    const ask = ex.ambiguous.length ? ` I wasn't sure about "${ex.ambiguous[0]}": tell me if it's a task or an event.` : "";
                    return respond({
                        reply: `I'll add ${ex.events.length === 1 ? "an event" : ex.events.length + " events"}: ${evText}${tasks.length ? `, and ${tasks.length} task${tasks.length === 1 ? "" : "s"} planned around ${ex.events.length === 1 ? "it" : "them"}` : ""}. Nothing is added until you confirm.${ask}`,
                        tasks, goals, events: ex.events, source: "planora"
                    });
                }
                if (ex.ambiguous.length) {
                    // the tasks are clear, one item isn't: plan the clear part and ask about the other
                    const local = localPlan(ex.rest, today, prefs, now);
                    const item = ex.ambiguous[0];
                    const tasks = schedule(local.tasks.slice(0, 30), { today, now, existing });
                    return respond({
                        reply: `${summarise(tasks, sanitiseGoals(local.goals, today), today)} Should "${item}" be a Task or an Event?`,
                        tasks, goals: sanitiseGoals(local.goals, today),
                        actions: [{ label: `"${item}" is a task`, send: `${item} as a task` }, { label: `"${item}" is an event`, send: `${item} as an event` }],
                        source: "planora"
                    });
                }
            }

            /* 1. "Plan my day" — always uses the user's real tasks */
            if (mode === "plan_day") {
                const r = planDay(message, ctx, today, now, existing);
                return respond({ reply: r.reply, updates: r.updates, source: "planora" });
            }

            /* 2. Changes to existing tasks: "move the gym to 7pm" */
            if (mode === "edit") {
                const r = localEdit(message, ctx, recent, today, now, existing);
                if (r) return respond({ reply: r.reply, updates: r.updates, actions: r.actions || [], source: "planora" });
                if (!process.env.OPENAI_API_KEY) {
                    return respond({ reply: "I couldn't find that task in your plan. Try using its name, e.g. \"move the gym to 7pm\".", source: "planora" });
                }
            }

            /* 3. Questions: "what's the most important thing to do now?" */
            if (mode === "question") {
                if (process.env.OPENAI_API_KEY) {
                    try {
                        const ai = await aiRequest({ message, mode, today, now, ctx, history: req.body.history, prefs });
                        const updates = resolveUpdates(ai.updates, ctx, today, now, existing);
                        if (ai.reply) return respond({ reply: ai.reply, updates, source: "openai" });
                    } catch (error) {
                        console.error("Planora AI answer failed, using built-in answer:", error.message);
                    }
                }
                return respond({ reply: localAnswer(message, ctx, today, now), source: "planora" });
            }

            /* 4. Planning (new tasks, goals, repeats, deadlines) */
            let understood = null, source = "planora";

            if (process.env.OPENAI_API_KEY) {
                try {
                    understood = await aiRequest({ message, mode: "plan", today, now, ctx, history: req.body.history, draft, prefs, attachGoal });
                    source = "openai";
                } catch (error) {
                    console.error("Planora AI failed, using built-in planner:", error.message);
                }
            }

            if (!understood && draft) {
                const refined = refineDraft(message, draft, today);
                if (refined) {
                    return respond({
                        reply: `Done: I ${refined.changes.join(", ")}. Take another look, then tap **Add to my plan**.`,
                        tasks: schedule(refined.tasks, { today, now, existing }),
                        goals: sanitiseGoals(refined.goals, today),
                        source: "planora"
                    });
                }
            }

            if (!understood || (!understood.tasks.length && !understood.goals.length && !understood.updates.length)) {
                const local = attachGoal
                    ? localPlan(`${attachGoal.title}${attachGoal.date ? " by " + attachGoal.date : " in 2 weeks"}`.replace(/,/g, " "), today, prefs, now, true)
                    : localPlan(message, today, prefs, now);
                understood = { ...local, updates: [], reply: "" };
                source = "planora";
                if (attachGoal && !understood.goals.length && understood.tasks.length) {
                    understood.goals = [{ ref: "g1", title: attachGoal.title, date: attachGoal.date || null, milestones: [] }];
                    understood.tasks.forEach(t => { t.goalRef = "g1"; });
                }
            }

            const goals = sanitiseGoals(understood.goals, today);
            if (source === "openai") {
                // The AI's times are suggestions. A task keeps a fixed time only when the user
                // actually said one ("gym at 6pm"); everything else is fitted around the calendar,
                // so new goal sessions never land on top of existing tasks or other goals.
                const userGaveTime = Boolean(findTime(message)) || /\b\d{1,2}(:\d{2})?\s*(-|–|to)\s*\d{1,2}(:\d{2})?\s*(am|pm)?\b/i.test(message);
                understood.tasks.forEach(t => { if (t && typeof t === "object") t.flexible = !(userGaveTime && t.flexible === false); });
            }
            const tasks = schedule(understood.tasks.slice(0, 30), { today, now, existing });
            const updates = resolveUpdates(understood.updates, ctx, today, now, existing);
            let reply = understood.reply || summarise(tasks, goals, today);
            if (!tasks.length && !goals.length && !updates.length && !understood.reply) {
                reply = "I couldn't find anything to plan in that. Try something like \"finish my report today\" or \"learn Python by next week\".";
            }
            respond({ reply, tasks, goals, updates, source });

        } catch (error) {
            console.error("Smart plan failed:", error);
            res.status(500).json({ error: "Planora couldn't generate your plan right now. Your existing tasks are safe." });
        }
    });
}

module.exports = { install, extractEvents, eventFromText, findRange, localPlan, schedule, classify, localAnswer, localEdit, planDay, parseTask, whatNowAnswer, planWeek, limitedTime, behindOn, moveUnfinished, breakDown, goalStatus };
