/* =========================================================
   PLANORA PRIORITY  (planora-priority.js)

   One shared way to decide "what matters most", used by:
   - Home: Today's focus + recommendations   (browser)
   - Planora AI: "what should I do now?"      (server)

   Considers, in order of weight:
   overdue > deadline proximity > explicit priority >
   scheduled time today > goal relevance > duration fit.
   Works in the browser (window.PlanoraPriority) and in Node.
   ========================================================= */

(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.PlanoraPriority = factory();
})(typeof self !== "undefined" ? self : this, function () {

    function daysBetween(a, b) {
        const pa = String(a).split("-").map(Number);
        const pb = String(b).split("-").map(Number);
        return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
    }

    function toMin(hhmm) {
        if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
        const [h, m] = hhmm.split(":").map(Number);
        return h * 60 + m;
    }

    function duration(task) {
        const s = toMin(task.start), e = toMin(task.end);
        if (s !== null && e !== null && e > s) return e - s;
        return Number(task.duration) || 45;
    }

    /*
     * ctx: { today: "YYYY-MM-DD", nowMin: minutes since midnight, goalsById: {id: goal} }
     * Returns a number; higher = more important. Completed tasks score -Infinity.
     */
    function score(task, ctx) {
        if (!task || task.completed) return -Infinity;
        const today = ctx.today;
        const nowMin = ctx.nowMin == null ? 0 : ctx.nowMin;
        let s = 0;

        const dayOffset = task.date ? daysBetween(today, task.date) : 0;

        // 1. overdue
        if (dayOffset < 0) s += 100 + Math.min(7, -dayOffset) * 2;

        // 2. deadline proximity (explicit deadline field)
        if (task.deadline) {
            const d = daysBetween(today, task.deadline);
            if (d <= 0) s += 80;
            else if (d === 1) s += 60;
            else if (d === 2) s += 40;
            else if (d <= 7) s += 20;
        }

        // 3. explicit priority
        if (task.priority === "high") s += 30;
        else if (task.priority === "low") s -= 10;

        // 4. scheduled time
        if (dayOffset === 0) {
            s += 40;
            const start = toMin(task.start), end = toMin(task.end);
            if (start !== null) {
                if (start <= nowMin && (end === null || end > nowMin)) s += 30;       // happening now
                else if (start > nowMin && start - nowMin <= 120) s += 20;            // soon
                else if (start > nowMin) s += 10;                                    // later today
                else s += 5;                                                          // time passed, not done
            } else {
                s += 15;                                                              // today, no time yet
            }
        } else if (dayOffset > 0) {
            s -= dayOffset * 5;
        }

        // 5. goal relevance
        if (task.goalId && ctx.goalsById && ctx.goalsById[task.goalId]) {
            s += 8;
            const g = ctx.goalsById[task.goalId];
            if (g.date) {
                const gd = daysBetween(today, g.date);
                if (gd >= 0 && gd <= 3) s += 10;
            }
        }

        // 6. shorter tasks break ties
        s -= Math.min(10, duration(task) / 30);
        return s;
    }

    function rank(tasks, ctx) {
        return (tasks || [])
            .filter(t => t && !t.completed)
            .map(t => ({ task: t, score: score(t, ctx) }))
            .sort((a, b) => b.score - a.score)
            .map(x => x.task);
    }

    // Tasks worth focusing on today: today's, overdue, or deadlines within 2 days
    function focus(tasks, ctx, limit = 3) {
        return rank((tasks || []).filter(t => {
            if (!t || t.completed || !t.date) return false;
            const d = daysBetween(ctx.today, t.date);
            if (d <= 0) return true;
            if (t.deadline && daysBetween(ctx.today, t.deadline) <= 2) return true;
            return false;
        }), ctx).slice(0, limit);
    }

    function time12(hhmm) {
        const m = toMin(hhmm);
        if (m === null) return "";
        let h = Math.floor(m / 60);
        const mm = m % 60;
        const ap = h >= 12 ? "PM" : "AM";
        h = h % 12 || 12;
        return `${h}:${String(mm).padStart(2, "0")} ${ap}`;
    }

    // Short human reason shown next to a focus task
    function reason(task, ctx) {
        const d = task.date ? daysBetween(ctx.today, task.date) : 0;
        if (d < 0) return d === -1 ? "From yesterday" : `Overdue · ${-d} days`;
        if (task.deadline) {
            const dd = daysBetween(ctx.today, task.deadline);
            if (dd <= 0) return "Due today";
            if (dd === 1) return "Due tomorrow";
            if (dd <= 7) return `Due in ${dd} days`;
        }
        const start = toMin(task.start), end = toMin(task.end);
        if (d === 0 && start !== null) {
            const nowMin = ctx.nowMin || 0;
            if (start <= nowMin && (end === null || end > nowMin)) return "Happening now";
            return time12(task.start);
        }
        if (task.priority === "high") return "High priority";
        if (d === 0) return "Today";
        return "";
    }

    function hoursLabel(min) {
        min = Math.max(0, Math.round(min));
        if (min < 60) return `${min} min`;
        const h = Math.floor(min / 60), m = min % 60;
        return m ? `${h}h ${m}m` : `${h}h`;
    }

    // Free minutes from now until the next scheduled (unfinished) task today, or the end of the day
    function freeNow(tasks, ctx, dayEnd) {
        const now = ctx.nowMin || 0;
        let until = dayEnd, busyWith = null, from = now;
        (tasks || []).forEach(t => {
            if (!t || t.completed || t.date !== ctx.today) return;
            const s = toMin(t.start);
            if (s !== null && s > now && s < until) until = s;
        });
        // Events are fixed commitments: an event happening now means you're busy
        (ctx.events || []).forEach(e => {
            if (!e || e.date !== ctx.today) return;
            const s = toMin(e.start), en = toMin(e.end);
            if (s === null) return;
            const end = en !== null && en > s ? en : s + 60;
            if (s <= now && end > now) { busyWith = e; from = Math.max(from, end); }
            else if (s > now && s < until) until = s;
        });
        if (busyWith) return { minutes: 0, until: from, busyWith };
        return { minutes: Math.max(0, until - now), until };
    }

    /*
     * "What should I do now?" — ONE task, with short reasons.
     * Returns one of:
     *   { type: "current", task }            something is scheduled right now
     *   { type: "task", task, minutes, reasons, free }
     *   { type: "none" }
     */
    function whatNow(tasks, ctx) {
        const today = ctx.today;
        const now = ctx.nowMin || 0;
        const dayEnd = ctx.dayEndMin || 22 * 60;
        const open = (tasks || []).filter(t => t && !t.completed);

        // 1. Something scheduled right now (or starting within 10 minutes)
        const current = open
            .filter(t => t.date === today && toMin(t.start) !== null)
            .filter(t => {
                const s = toMin(t.start), e = toMin(t.end) !== null && toMin(t.end) > s ? toMin(t.end) : s + duration(t);
                return (s <= now && e > now) || (s > now && s - now <= 10);
            })
            .sort((a, b) => a.start.localeCompare(b.start))[0];
        if (current) return { type: "current", task: current, minutes: duration(current), reasons: [toMin(current.start) <= now ? "Scheduled for right now" : `Starts at ${time12(current.start)}`] };

        // 2. Best task to pull in now
        const free = freeNow(tasks, ctx, dayEnd);
        const candidates = rank(open.filter(t => {
            if (!t.date) return false;
            const d = daysBetween(today, t.date);
            if (d < 0) return true;                                              // overdue
            if (d === 0) return true;                                            // today
            if (t.deadline && daysBetween(today, t.deadline) <= 2) return true;  // due very soon
            return false;
        }), ctx);
        if (!candidates.length || free.minutes < 10) return { type: "none", free: free.minutes, busyWith: free.busyWith || null };

        const fits = candidates.find(t => duration(t) <= free.minutes + 5) || candidates[0];
        const minutes = Math.max(10, Math.min(duration(fits), free.minutes));
        const reasons = [];
        const d = daysBetween(today, fits.date);
        if (d < 0) reasons.push(d === -1 ? "Left over from yesterday" : `Overdue by ${-d} days`);
        if (fits.deadline) {
            const dd = daysBetween(today, fits.deadline);
            reasons.push(dd <= 0 ? "Due today" : dd === 1 ? "Due tomorrow" : `Due in ${dd} days`);
        }
        if (fits.priority === "high") reasons.push("High priority");
        if (fits.goalId && ctx.goalsById && ctx.goalsById[fits.goalId]) reasons.push(`Moves "${ctx.goalsById[fits.goalId].title}" forward`);
        reasons.push(`${hoursLabel(duration(fits))} of work`);
        if (free.until < dayEnd) reasons.push(`You have ${hoursLabel(free.minutes)} free before your next task`);
        else reasons.push(`You have ${hoursLabel(free.minutes)} free`);
        return { type: "task", task: fits, minutes, reasons: reasons.slice(0, 4), free: free.minutes };
    }

    /*
     * Workload for today: planned work left vs realistic time left.
     * Available = time left in the day (until dayEnd), capped by a daily
     * focus budget (default 8h) minus what's already been done.
     */
    function workload(tasks, ctx) {
        const today = ctx.today;
        const now = ctx.nowMin || 0;
        const dayStart = ctx.dayStartMin || 7 * 60;
        const dayEnd = ctx.dayEndMin || 22 * 60;
        const budget = ctx.budgetMin || 8 * 60;
        let work = 0, done = 0, left = 0;
        (tasks || []).forEach(t => {
            if (!t || t.date !== today) return;
            const dur = duration(t);
            if (t.completed) { done += dur; return; }
            left++;
            const s = toMin(t.start), e = toMin(t.end);
            if (s !== null && e !== null && e > s && s < now && e > now) work += e - now;   // in progress
            else work += dur;
        });
        let eventMin = 0;
        (ctx.events || []).forEach(e => {
            if (!e || e.date !== today) return;
            const s = toMin(e.start), en = toMin(e.end);
            if (s === null) return;
            const end = en !== null && en > s ? en : s + 60;
            eventMin += Math.max(0, Math.min(end, dayEnd) - Math.max(s, now, dayStart));
        });
        const windowLeft = Math.max(0, dayEnd - Math.max(now, dayStart) - eventMin);
        const available = Math.max(0, Math.min(windowLeft, budget - done));
        let status, label;
        if (!left) { status = "clear"; label = "Clear"; }
        else if (available <= 0 || work > available) { status = "red"; label = "Overloaded"; }
        else if (work > available * 0.75) { status = "yellow"; label = "Getting tight"; }
        else { status = "green"; label = "On track"; }
        const availText = available >= 60 ? `${Math.round(available / 60 * 2) / 2} hour${available >= 90 ? "s" : ""}` : `${available} minutes`;
        let text;
        if (status === "clear") text = done ? "Everything planned for today is done." : "Nothing left planned for today.";
        else if (status === "red") text = available <= 0 ? `You have ${hoursLabel(work)} of work left but no time left today.` : `You have ${hoursLabel(work)} of work but only ${availText} available.`;
        else text = `You have ${hoursLabel(work)} of work across ${availText} available.`;
        return { status, label, text, work, available, done, left };
    }

    /* ---------- Categories (tasks and events) ---------- */
    const CATEGORIES = [
        { id: "work", label: "Work", color: "#3B6FD4", soft: "#E6F0FC" },
        { id: "study", label: "Study", color: "#7F77DD", soft: "#EEEDFE" },
        { id: "personal", label: "Personal", color: "#1D9E75", soft: "#E1F5EE" },
        { id: "health", label: "Health", color: "#D4537E", soft: "#FBEAF0" },
        { id: "other", label: "Other", color: "#7A7686", soft: "#F1EFF4" }
    ];
    const CAT_WORDS = [
        ["health", /\b(doctor|dentist|clinic|hospital|physio|therapy|therapist|check-?up|gym|workout|run|running|jog|yoga|pilates|swim|exercise|training|medication|vaccin\w*)\b/i],
        ["study", /\b(class|lecture|tutorial|seminar|lesson|study|studying|revise|revision|exam|quiz|homework|assignment|essay|course|school|uni|university|read(ing)? chapter|chapter|lab|thesis)\b/i],
        ["work", /\b(meeting|client|call with|conference|interview|webinar|workshop|presentation|report|deadline|project|office|work|standup|stand-up|sync|review with|pitch|proposal|email)\b/i],
        ["personal", /\b(birthday|bday|dinner|lunch|brunch|breakfast|party|wedding|concert|movie|date|coffee|family|mum|mom|dad|friend|friends|shopping|groceries|haircut|trip|holiday|game|match|church|mass)\b/i]
    ];
    function guessCategory(text) {
        const t = String(text || "");
        for (const [id, re] of CAT_WORDS) if (re.test(t)) return id;
        return "other";
    }
    function category(id) {
        return CATEGORIES.find(c => c.id === id) || null;
    }

    /*
     * Task or Event?
     *   Task  = something you complete (finish, submit, study, gym, read…)
     *   Event = something that happens at a time (meeting, class, appointment…)
     * Returns "task" | "event" | "ambiguous".
     */
    const EVENT_WORDS = /\b(appointment|appt|meeting|meet with|meetup|call with|class|lecture|tutorial|seminar|lesson|birthday|bday|conference|dinner|lunch|brunch|breakfast with|party|wedding|concert|flight|interview|webinar|workshop|doctor|dentist|clinic|check-?up|haircut|match|movie|date with|catch up with|catch-up with|coffee with|ceremony|service|church|mass|recital|performance|show at|tuition class|orientation|standup|stand-up|sync with)\b/i;
    const TASK_WORDS = /\b(finish|complete|submit|send|write|read|study|studying|revise|review|prepare|prep|practice|practise|work on|clean|tidy|buy|pay|email|call (?!with)|text|reply|fix|do|draft|plan|organi[sz]e|remind me|to-?do|assignment|homework|report|essay|project|gym|workout|exercise|run|session|chores|laundry|groceries|book (a|an|the)|apply|learn|finish off)\b/i;
    function kindOf(text) {
        const t = String(text || "");
        if (/\bas an? event\b|\badd (it )?to (my )?calendar\b/i.test(t)) return "event";
        if (/\bas an? task\b/i.test(t)) return "task";
        if (/^\s*(remind me|i need to|i have to|i must|i should|need to|have to)\b/i.test(t) && !EVENT_WORDS.test(t)) return "task";
        const ev = EVENT_WORDS.test(t), tk = TASK_WORDS.test(t);
        if (ev && !tk) return "event";
        if (tk && !ev) return "task";
        if (ev && tk) {
            // "prepare for the meeting" is a task; "meeting to review the report" is an event
            const first = t.search(EVENT_WORDS), firstTask = t.search(TASK_WORDS);
            if (/^\s*(i\s+(need|have|must|should)\s+to\s+)?(finish|complete|submit|send|write|prepare|prep|review|read|study|revise|practi[cs]e|work on|email|draft|plan)\b/i.test(t)) return "task";
            return first < firstTask ? "event" : "ambiguous";
        }
        // No clear words: a start–end range ("Sarah 10–11") reads like an event, but ask first
        if (/\b\d{1,2}(:\d{2})?\s*(am|pm)?\s*(-|–|to)\s*\d{1,2}(:\d{2})?\s*(am|pm)?\b/i.test(t)) return "ambiguous";
        return "task";
    }

    return { score, rank, focus, reason, daysBetween, toMin, duration, time12, whatNow, workload, freeNow, hoursLabel, CATEGORIES, guessCategory, category, kindOf };
});
