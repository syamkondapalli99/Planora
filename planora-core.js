/* =========================================================
   PLANORA CORE  (planora-core.js)

   The one shared layer every app page uses:

   - ONE task store   : localStorage "planora_tasks"
                        (Home, Calendar, Planora, Journal, planners,
                         goal & study sessions all live here)
   - ONE goal model   : localStorage "planora_goals"
                        { id, title, description, date (deadline),
                          createdAt, updatedAt, status, category, source,
                          milestones[{id,text,done,date,completedAt}],
                          manualProgress, progress }
                        Sessions are tasks with goalId = goal.id.
   - Data migration   : old Journal goals, old Goal Tracker goals and
                        AI goals become the same shape; untouched sample
                        tasks from old versions are removed.
   - Plan preview     : Preview -> Edit -> Confirm, used by Ask Planora,
                        recommendations, planners and Journal.
   - Quick add, goal editor, confirm dialog, navigation.

   Loaded on every app page after auth.js and before page scripts.
   ========================================================= */

(function () {

    const TASK_KEY = "planora_tasks";
    const GOAL_KEY = "planora_goals";
    const MIGRATION_KEY = "planora_migrations";
    const DAY = 86400000;


    /* =====================================================
       Basic helpers
       ===================================================== */

    function loadJSON(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (raw === null || raw === undefined) return fallback;
            const value = JSON.parse(raw);
            return value === null ? fallback : value;
        } catch { return fallback; }
    }

    function saveJSON(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }

    function uid(prefix) {
        return (prefix || "id") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    }

    function dateStr(d = new Date()) {
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }

    function today() { return dateStr(new Date()); }

    function addDays(str, n) {
        const d = new Date(str + "T00:00:00");
        d.setDate(d.getDate() + n);
        return dateStr(d);
    }

    function nowMin() {
        const d = new Date();
        return d.getHours() * 60 + d.getMinutes();
    }

    function nowClock() {
        const d = new Date();
        return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }

    function toMin(hhmm) {
        if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
        const [h, m] = hhmm.split(":").map(Number);
        return h * 60 + m;
    }

    function toClock(min) {
        min = Math.max(0, Math.min(23 * 60 + 59, Math.round(min)));
        return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
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

    function durLabel(min) {
        min = Math.round(min || 0);
        if (min < 60) return `${min} min`;
        const h = Math.floor(min / 60), m = min % 60;
        return m ? `${h}h ${m}m` : `${h}h`;
    }

    function dayLabel(ds) {
        const t = today();
        if (ds === t) return "Today";
        if (ds === addDays(t, 1)) return "Tomorrow";
        if (ds === addDays(t, -1)) return "Yesterday";
        return new Date(ds + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
    }

    function shortDate(ds) {
        if (!ds) return "";
        return new Date(ds + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    }

    function esc(text) {
        return String(text == null ? "" : text)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function toast(message, type) {
        if (window.PlanoraAuth && PlanoraAuth.toast) PlanoraAuth.toast(message, type);
    }

    function taskDuration(t) {
        const s = toMin(t.start), e = toMin(t.end);
        if (s !== null && e !== null && e > s) return e - s;
        return Number(t.duration) || 30;
    }


    /* =====================================================
       Tasks (the one task store)
       ===================================================== */

    function getTasks() {
        const list = loadJSON(TASK_KEY, []);
        return Array.isArray(list) ? list.filter(t => t && typeof t === "object") : [];
    }

    function saveTasks(list) {
        saveJSON(TASK_KEY, list);
    }

    function normaliseNewTask(t) {
        const start = t.start || "";
        const duration = Number(t.duration) || (toMin(t.start) !== null && toMin(t.end) !== null ? toMin(t.end) - toMin(t.start) : 0);
        const task = {
            id: t.id || uid("task"),
            title: String(t.title || "Untitled task").trim().slice(0, 140),
            date: t.date || today(),
            start,
            end: t.end || (start && duration ? toClock(toMin(start) + duration) : ""),
            completed: Boolean(t.completed)
        };
        if (duration) task.duration = duration;
        if (t.priority && t.priority !== "normal") task.priority = t.priority;
        if (t.deadline) task.deadline = t.deadline;
        if (t.goalId) task.goalId = t.goalId;
        if (t.source) task.source = t.source;
        if (t.notes) task.notes = t.notes;
        if (t.fixed) task.fixed = true;
        if (t.seriesId) task.seriesId = t.seriesId;
        if (t.category) task.category = t.category;
        if (validColor(t.color)) task.color = t.color;
        return task;
    }

    function addTasks(list) {
        const store = getTasks();
        const added = list.map(normaliseNewTask);
        saveTasks(store.concat(added));
        notifyChange();
        return added;
    }

    function updateTask(id, patch) {
        const store = getTasks();
        const i = store.findIndex(t => String(t.id) === String(id));
        if (i === -1) return null;
        const next = { ...store[i], ...patch };
        if (patch.completed === true && !store[i].completed) next.completedAt = new Date().toISOString();
        if (patch.completed === false) delete next.completedAt;
        if (patch.start !== undefined && patch.duration && !patch.end) next.end = toClock(toMin(patch.start) + Number(patch.duration));
        store[i] = next;
        saveTasks(store);
        notifyChange();
        return next;
    }

    function removeTask(id) {
        saveTasks(getTasks().filter(t => String(t.id) !== String(id)));
        notifyChange();
    }

    let changeTimer = null;
    function notifyChange() {
        clearTimeout(changeTimer);
        changeTimer = setTimeout(() => document.dispatchEvent(new CustomEvent("planora:data-changed")), 30);
    }


    /* =====================================================
       Goals (the one goal model)
       ===================================================== */

    /* =====================================================
       Colours
       - each goal has its own colour; all of a goal's tasks use it
       - other tasks use their category's colour
       - no category: Planora purple
       ===================================================== */

    const DEFAULT_COLOR = { color: "#7F77DD", soft: "#EEEDFE" };
    const GOAL_COLORS = [
        { color: "#F07A54", soft: "#FDEEE8" },   // coral
        { color: "#14A3A3", soft: "#E0F5F5" },   // teal
        { color: "#E09A1A", soft: "#FCF3DF" },   // amber
        { color: "#C2489B", soft: "#F9E8F3" },   // magenta
        { color: "#4F5BD5", soft: "#E9EBFB" },   // indigo
        { color: "#5E9E2F", soft: "#EBF5E1" },   // leaf
        { color: "#D64545", soft: "#FBE9E9" },   // red
        { color: "#2B9ED8", soft: "#E3F3FB" }    // sky
    ];
    // Colours to choose from for goals and for your own categories
    const SWATCHES = [
        "#7F77DD", "#3B6FD4", "#2B9ED8", "#14A3A3", "#1D9E75", "#5E9E2F",
        "#E09A1A", "#F07A54", "#D64545", "#D4537E", "#C2489B", "#4F5BD5"
    ];

    function validColor(c) { return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c); }
    function softOf(hex) {
        const known = GOAL_COLORS.find(x => x.color.toLowerCase() === String(hex).toLowerCase());
        if (known) return known.soft;
        const n = parseInt(String(hex).slice(1), 16);
        const mix = v => Math.round(v + (255 - v) * 0.87);
        return "#" + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => mix(v).toString(16).padStart(2, "0")).join("");
    }
    function nextGoalColor(used) {
        const taken = (used || []).filter(validColor).map(c => c.toLowerCase());
        const free = GOAL_COLORS.find(x => !taken.includes(x.color.toLowerCase()));
        return (free || GOAL_COLORS[taken.length % GOAL_COLORS.length]).color;
    }
    function goalColor(goal) {
        const color = goal && validColor(goal.color) ? goal.color : DEFAULT_COLOR.color;
        return { color, soft: softOf(color) };
    }

    // Goal colours, read once per change of the saved goals (tasks are drawn often)
    let goalColorCache = { raw: null, map: new Map() };
    function goalColorMap() {
        const raw = localStorage.getItem(GOAL_KEY);
        if (raw !== goalColorCache.raw || !goalColorCache.map.size) {
            const map = new Map();
            getGoals({ includeArchived: true }).forEach(g => map.set(g.id, g));
            goalColorCache = { raw: localStorage.getItem(GOAL_KEY), map };
        }
        return goalColorCache.map;
    }

    /* The colour of a task: { color, soft, label, kind: "goal" | "category" | "none" } */
    function taskColor(task) {
        if (task && task.goalId) {
            const goal = goalColorMap().get(String(task.goalId));
            if (goal) return { ...goalColor(goal), label: goal.title, kind: "goal" };
        }
        if (task && validColor(task.color)) return { color: task.color, soft: softOf(task.color), label: "", kind: "custom" };
        const cat = task && task.category ? categoryInfo(task.category) : null;
        if (cat) return { color: cat.color, soft: cat.soft || softOf(cat.color), label: cat.label, kind: "category" };
        return { ...DEFAULT_COLOR, label: "", kind: "none" };
    }

    /* The colour of an event: its own colour, otherwise its category's */
    function eventColor(ev) {
        if (ev && validColor(ev.color)) return { color: ev.color, soft: softOf(ev.color), label: "" };
        const cat = ev && ev.category ? categoryInfo(ev.category) : null;
        return cat ? { color: cat.color, soft: cat.soft || softOf(cat.color), label: cat.label } : { ...DEFAULT_COLOR, label: "" };
    }

    /* Give a task's element its colour (--task-c / --task-s) */
    function paintTask(el, task) {
        if (!el) return;
        const c = taskColor(task);
        el.style.setProperty("--task-c", c.color);
        el.style.setProperty("--task-s", c.soft);
        el.dataset.colorKind = c.kind;
        return c;
    }

    /* Task card: colour stripe + a small label (goal name or category) under the time */
    function decorateTaskItem(item, task) {
        const c = paintTask(item, task);
        if (!c || c.kind === "none") return c;
        const time = item.querySelector(".t-time");
        if (!time) return c;
        if (c.kind === "goal" && !item.querySelector(".t-goal")) {
            const tag = document.createElement("p");
            tag.className = "t-goal";
            tag.innerHTML = '<i class="ti ti-target-arrow" aria-hidden="true"></i>';
            tag.appendChild(document.createTextNode(c.label));
            time.after(tag);
        } else if (c.kind === "category" && !item.querySelector(".t-cat")) {
            const tag = document.createElement("p");
            tag.className = "t-cat";
            tag.innerHTML = '<span class="cat-dot" aria-hidden="true"></span>';
            tag.appendChild(document.createTextNode(c.label));
            time.after(tag);
        }
        return c;
    }

    // the chosen category (never the "+ New category…" placeholder)
    function catValue(sel) {
        if (!sel) return "";
        if (sel.value && sel.value !== "__new") return sel.value;
        return sel.dataset.prev && sel.dataset.prev !== "__new" ? sel.dataset.prev : "";
    }

    /* Colour picker for task and event forms (like Google Calendar):
       - category chips (Work, Study… and your own), each with its colour
       - a row of plain colours for just this task / event, and "Default"
       - goal tasks show their goal's colour instead (all of a goal's tasks match)
       The form gets select[name=category] and input[name=color]. */
    function mountColorChips(field, { selected = "", color = "", goal = null, allowNone = true, autoFrom = null, onChangeGoalColor } = {}) {
        if (!field) return () => {};
        const chips = field.querySelector(".edit-color-chips");
        const dots = field.querySelector(".edit-color-dots");
        const select = field.querySelector("select[name=category]");
        const colorInput = field.querySelector("input[name=color]");
        const goalBox = field.querySelector(".edit-goal-color");
        const valid = selected && categoryInfo(selected) ? categoryInfo(selected).id : "";
        select.innerHTML = categoryOptions(valid, { allowNone });
        select.value = valid || (allowNone ? "" : (select.options[0] ? select.options[0].value : ""));
        select.dataset.prev = select.value;
        if (colorInput) colorInput.value = validColor(color) ? color : "";
        let touched = Boolean(valid || (colorInput && colorInput.value));

        if (goal && goalBox) {
            const gc = goalColor(goal);
            goalBox.hidden = false;
            goalBox.innerHTML = `<p><span class="cat-dot" style="background:${gc.color}" aria-hidden="true"></span>Part of the goal <strong>\u201C${esc(goal.title)}\u201D</strong>, so it uses the goal's colour.</p>
                <button type="button" class="btn-secondary" data-goal-color><i class="ti ti-palette" aria-hidden="true"></i> Change goal colour</button>`;
            goalBox.querySelector("[data-goal-color]").onclick = () => {
                if (onChangeGoalColor) onChangeGoalColor(goal);
                else { closeSheet(); openGoalSheet({ id: goal.id }); }
            };
            chips.hidden = true;
            if (dots) dots.hidden = true;
            return () => {};
        }
        if (goalBox) { goalBox.hidden = true; goalBox.innerHTML = ""; }
        chips.hidden = false;
        if (dots) dots.hidden = false;

        const guessFor = () => {
            const words = autoFrom ? autoFrom.value.trim() : "";
            const g = words.length > 2 ? categoryOf({ title: words }) : "";
            if (allowNone) return g && g !== "other" ? g : "";
            return g || "other";
        };
        const custom = () => (colorInput && validColor(colorInput.value) ? colorInput.value : "");
        const cat = () => (select.value === "__new" ? (select.dataset.prev || "") : select.value);

        const draw = () => {
            const c = custom(), current = cat();
            const opts = Array.from(select.options).filter(o => o.value !== "__new" && o.value !== "");
            chips.innerHTML = opts.map(o => {
                const info = categoryInfo(o.value);
                const on = !c && o.value === current;
                return `<button type="button" class="color-chip${on ? " on" : ""}" role="radio" aria-checked="${on}" data-cat="${esc(o.value)}" style="--chip:${info ? info.color : DEFAULT_COLOR.color}"><span class="dot" aria-hidden="true"></span>${esc(o.textContent)}</button>`;
            }).join("") + (opts.length
                ? `<button type="button" class="color-chip edit-labels" data-labels="1" aria-label="Edit labels" title="Edit labels"><i class="ti ti-pencil" aria-hidden="true"></i></button>`
                : `<button type="button" class="color-chip add" data-labels="1"><i class="ti ti-plus" aria-hidden="true"></i>Create a label</button>`);
            if (dots) {
                const isDefault = !c && (allowNone ? !current : current === guessFor());
                dots.innerHTML = `<div class="color-dot-row" role="radiogroup" aria-label="Colour for this item">${SWATCHES.map(hex => {
                    const on = c.toLowerCase() === hex.toLowerCase();
                    return `<button type="button" class="color-dot${on ? " on" : ""}" role="radio" aria-checked="${on}" data-color="${hex}" style="--sw:${hex}" aria-label="Colour ${hex}" title="Just this colour"><i class="ti ti-check" aria-hidden="true"></i></button>`;
                }).join("")}</div>
                    <button type="button" class="color-default${isDefault ? " on" : ""}" data-default="1" aria-pressed="${isDefault}"><i class="ti ti-${isDefault ? "circle-check-filled" : "circle"}" aria-hidden="true"></i> Default</button>`;
            }
            field.querySelectorAll(".color-chip, .color-dot, .color-default").forEach(btn => {
                btn.onclick = () => {
                    if (btn.dataset.labels) {
                        // Edit labels (rename, colour, delete, add) without leaving this form
                        openLabelsManager({
                            addFirst: !opts.length,
                            onSaved: () => {
                                const keep = categoryInfo(cat()) ? categoryInfo(cat()).id : "";
                                select.innerHTML = categoryOptions(keep, { allowNone });
                                select.value = keep;
                                select.dataset.prev = keep;
                                draw();
                            }
                        });
                        return;
                    }
                    touched = true;
                    if (btn.dataset.new) {
                        select.dataset.prev = select.value;
                        select.value = "__new";
                        select.dispatchEvent(new Event("change", { bubbles: true }));   // opens "New category" right here
                        return;
                    }
                    if (btn.dataset.cat !== undefined) { select.value = btn.dataset.cat; if (colorInput) colorInput.value = ""; }
                    else if (btn.dataset.color) { if (colorInput) colorInput.value = btn.dataset.color; if (allowNone) select.value = ""; keepColor = true; }
                    else if (btn.dataset.default) { if (colorInput) colorInput.value = ""; select.value = guessFor(); touched = false; }
                    select.dataset.prev = select.value;
                    select.dispatchEvent(new Event("change", { bubbles: true }));
                };
            });
        };
        let keepColor = false;   // set when a plain colour was just picked
        select.addEventListener("change", () => {
            if (select.value === "__new") return;
            if (!keepColor && colorInput && select.value) colorInput.value = "";   // a category was chosen
            keepColor = false;
            draw();
        });
        if (autoFrom) autoFrom.addEventListener("input", () => {
            if (touched) return;
            select.value = guessFor();
            select.dataset.prev = select.value;
            draw();
        });
        draw();
        return draw;
    }
    const COLOR_FIELD_HTML = `
        <div class="sp-lbl edit-color-field">
            <span class="edit-color-title">Colour</span>
            <div class="edit-color-chips" role="radiogroup" aria-label="Category"></div>
            <div class="edit-color-dots"></div>
            <select name="category" class="edit-category-select" tabindex="-1" aria-hidden="true"></select>
            <input type="hidden" name="color" value="">
            <div class="edit-goal-color" hidden></div>
        </div>`;
    const colorValue = form => { const el = form.querySelector("input[name=color]"); return el && validColor(el.value) ? el.value : null; };

    /* =====================================================
       Voice typing: a 🎤 button next to a text box. Speak and the
       words appear in the box (uses the browser's own speech
       recognition: Chrome, Edge, Safari on iPhone/iPad/Mac).
       Where the browser can't do it (e.g. Firefox), tapping it says so.
       ===================================================== */
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    let activeVoice = null;

    function voiceSupported() { return Boolean(SpeechRec) && window.isSecureContext !== false; }

    /* Add a mic button for `input`. Options:
         onFinal(text)  called when you stop speaking (e.g. send to Ask Planora)
         place(btn)     where to put the button (default: right after the input) */
    function attachMic(input, { onFinal, place, label = "Speak instead of typing" } = {}) {
        if (!input || input.dataset.mic) return null;
        input.dataset.mic = "1";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mic-btn";
        btn.setAttribute("aria-label", label);
        btn.setAttribute("aria-pressed", "false");
        btn.title = label;
        btn.innerHTML = '<i class="ti ti-microphone" aria-hidden="true"></i><span class="mic-pulse" aria-hidden="true"></span>';
        if (place) place(btn); else input.insertAdjacentElement("afterend", btn);

        let rec = null, base = "", finalText = "", stoppedByUser = false;
        const setText = t => {
            input.value = t;
            input.dispatchEvent(new Event("input", { bubbles: true }));   // autosize, live preview, colour suggestion…
        };
        const ui = on => {
            btn.classList.toggle("listening", on);
            btn.setAttribute("aria-pressed", String(on));
            btn.setAttribute("aria-label", on ? "Stop listening" : label);
            btn.title = on ? "Listening… tap to stop" : label;
            btn.querySelector("i").className = "ti " + (on ? "ti-player-stop-filled" : "ti-microphone");
            input.classList.toggle("is-listening", on);
            if (on) { input.dataset.ph = input.placeholder; input.placeholder = "Listening… say what you need to do"; }
            else if (input.dataset.ph !== undefined) { input.placeholder = input.dataset.ph; delete input.dataset.ph; }
        };
        const stop = () => { stoppedByUser = true; try { rec && rec.stop(); } catch {} };

        btn.addEventListener("click", () => {
            if (rec) { stop(); return; }
            if (!voiceSupported()) {
                toast(window.isSecureContext === false
                    ? "Voice typing only works on the secure (https) site."
                    : "This browser can't do voice typing yet. Try Chrome, Edge or Safari, or use your keyboard's mic button.", "error");
                return;
            }
            if (activeVoice && activeVoice !== stop) activeVoice();   // only one mic at a time
            rec = new SpeechRec();
            rec.lang = document.documentElement.lang && document.documentElement.lang.length > 2 ? document.documentElement.lang : (navigator.language || "en-US");
            rec.interimResults = true;
            rec.continuous = false;
            rec.maxAlternatives = 1;
            base = input.value.trim(); finalText = ""; stoppedByUser = false;
            rec.onresult = e => {
                let interim = "";
                for (let i = e.resultIndex; i < e.results.length; i++) {
                    const r = e.results[i];
                    if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
                }
                setText([base, (finalText + " " + interim).trim()].filter(Boolean).join(" "));
            };
            rec.onerror = e => {
                const msg = {
                    "not-allowed": "Planora can't use the microphone. Allow microphone access for this site in your browser settings, then try again.",
                    "service-not-allowed": "Voice typing isn't available in this browser. Try Chrome or Safari, or type instead.",
                    "no-speech": "Didn't catch that. Tap the mic and try again.",
                    "audio-capture": "No microphone found.",
                    "network": "Voice typing needs an internet connection."
                }[e.error];
                if (msg && e.error !== "aborted") toast(msg, e.error === "no-speech" ? undefined : "error");
            };
            rec.onend = () => {
                const said = finalText.trim();
                rec = null; activeVoice = null;
                ui(false);
                if (said) {
                    setText([base, said].filter(Boolean).join(" "));
                    input.focus();
                    if (onFinal) onFinal(input.value.trim());
                }
            };
            try {
                rec.start();
                activeVoice = stop;
                ui(true);
            } catch (error) {
                rec = null;
                toast("Couldn't start voice typing. Please try again.", "error");
            }
        });
        return btn;
    }

    /* =====================================================
       Labels editor (like Google Calendar's): your own labels,
       each with a name and a colour. Add, rename, recolour, delete.
       Opens on top of whatever form you're in.
       ===================================================== */
    function openLabelsManager({ onSaved, addFirst } = {}) {
        document.querySelectorAll(".labels-overlay").forEach(x => x.remove());
        let rows = customCategories().map(c => ({ id: c.id, label: c.label, color: c.color }));
        const startIds = new Set(rows.map(r => r.id));
        const lastFocus = document.activeElement;
        const overlay = document.createElement("div");
        overlay.className = "labels-overlay";
        overlay.innerHTML = `
            <div class="labels-dialog" role="dialog" aria-modal="true" aria-labelledby="labels-title">
                <h2 id="labels-title">Labels</h2>
                <p class="labels-hint">Make your own labels and give each one a colour. Use them on tasks and events.</p>
                <div class="labels-list"></div>
                <p class="auth-error" hidden></p>
                <div class="labels-foot">
                    <button type="button" class="labels-add" data-l="add" aria-label="Add a label" title="Add a label"><i class="ti ti-plus" aria-hidden="true"></i></button>
                    <span class="labels-spacer"></span>
                    <button type="button" class="btn-secondary" data-l="cancel">Cancel</button>
                    <button type="button" class="btn-primary" data-l="save">Save</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const list = overlay.querySelector(".labels-list");
        const err = overlay.querySelector(".auth-error");
        const freeColor = () => SWATCHES.find(c => !rows.some(r => r.color.toLowerCase() === c.toLowerCase())) || SWATCHES[rows.length % SWATCHES.length];

        const render = focusIndex => {
            list.innerHTML = rows.length ? rows.map((r, i) => `
                <div class="label-row" data-i="${i}">
                    <button type="button" class="label-color" data-act="palette" aria-haspopup="true" aria-expanded="false" aria-label="Colour for ${esc(r.label || "new label")}">
                        <span class="dot" style="background:${r.color}"></span><i class="ti ti-chevron-down" aria-hidden="true"></i>
                    </button>
                    <div class="label-name">
                        <input type="text" maxlength="24" value="${esc(r.label)}" placeholder="Label name" aria-label="Label name">
                        <button type="button" class="label-clear" data-act="clear" aria-label="Clear name"><i class="ti ti-x" aria-hidden="true"></i></button>
                    </div>
                    <button type="button" class="label-del" data-act="delete" aria-label="Delete label ${esc(r.label)}" title="Delete label"><i class="ti ti-trash" aria-hidden="true"></i></button>
                    <div class="label-palette" hidden>${SWATCHES.map(c => `<button type="button" class="color-dot${c.toLowerCase() === r.color.toLowerCase() ? " on" : ""}" data-pick="${c}" style="--sw:${c}" aria-label="Colour ${c}"><i class="ti ti-check" aria-hidden="true"></i></button>`).join("")}</div>
                </div>`).join("")
                : `<p class="labels-empty">No labels yet. Tap <strong>+</strong> to make your first one, like "Uni", "Work" or "Gym".</p>`;
            list.querySelectorAll(".label-row").forEach(row => {
                const i = Number(row.dataset.i);
                const input = row.querySelector("input");
                input.oninput = () => { rows[i].label = input.value; err.hidden = true; };
                input.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); save(); } };
                row.querySelector("[data-act=clear]").onclick = () => { rows[i].label = ""; input.value = ""; input.focus(); };
                row.querySelector("[data-act=delete]").onclick = () => { rows.splice(i, 1); render(); };
                const pal = row.querySelector(".label-palette"), btn = row.querySelector("[data-act=palette]");
                btn.onclick = () => {
                    const open = pal.hidden;
                    list.querySelectorAll(".label-palette").forEach(p => { p.hidden = true; });
                    list.querySelectorAll("[data-act=palette]").forEach(b => b.setAttribute("aria-expanded", "false"));
                    pal.hidden = !open; btn.setAttribute("aria-expanded", String(open));
                };
                pal.querySelectorAll("[data-pick]").forEach(d => d.onclick = () => { rows[i].color = d.dataset.pick; render(); });
            });
            if (focusIndex !== undefined) { const el = list.querySelectorAll(".label-row input")[focusIndex]; if (el) el.focus(); }
        };
        const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); if (lastFocus && lastFocus.focus) lastFocus.focus(); };
        const add = () => { rows.push({ id: "c-" + Math.random().toString(36).slice(2, 10), label: "", color: freeColor() }); render(rows.length - 1); };
        const save = () => {
            const clean = rows.map(r => ({ ...r, label: String(r.label || "").trim().slice(0, 24) }));
            if (clean.some(r => !r.label)) { err.textContent = "Give every label a name, or delete it."; err.hidden = false; return; }
            const names = clean.map(r => r.label.toLowerCase());
            if (names.some((n, i) => names.indexOf(n) !== i)) { err.textContent = "Two labels have the same name."; err.hidden = false; return; }
            saveJSON(CAT_KEY, clean.map(r => ({ id: r.id, label: r.label, color: r.color })));
            // tasks and events that used a deleted label go back to no label
            const gone = new Set([...startIds].filter(id => !clean.some(r => r.id === id)));
            if (gone.size) {
                const tasks = getTasks(); let t = false;
                tasks.forEach(x => { if (gone.has(x.category)) { delete x.category; t = true; } });
                if (t) saveTasks(tasks);
                const evs = getEvents(); let e = false;
                evs.forEach(x => { if (gone.has(x.category)) { x.category = ""; e = true; } });
                if (e) saveEvents(evs);
                const series = getSeries(); let r = false;
                series.forEach(x => { if (gone.has(x.category)) { delete x.category; r = true; } });
                if (r) saveSeries(series);
            }
            notifyChange();
            close();
            toast("Labels saved.", "success");
            onSaved && onSaved();
        };
        const onKey = e => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
            if (e.key === "Tab") {   // keep focus inside the dialog
                const f = Array.from(overlay.querySelectorAll("button, input")).filter(x => x.offsetParent !== null);
                if (!f.length) return;
                if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
                else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
            }
        };
        document.addEventListener("keydown", onKey, true);
        overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
        overlay.querySelector("[data-l=add]").onclick = add;
        overlay.querySelector("[data-l=cancel]").onclick = close;
        overlay.querySelector("[data-l=save]").onclick = save;
        render();
        if (addFirst && !rows.length) add();
        else { const first = overlay.querySelector("input, [data-l=add]"); if (first) first.focus(); }
    }

    /* Your own categories (name + colour), saved with your account */
    const CAT_KEY = "planora_categories";
    function customCategories() {
        const list = loadJSON(CAT_KEY, []);
        return (Array.isArray(list) ? list : [])
            .filter(c => c && c.id && c.label && validColor(c.color))
            .map(c => ({ id: String(c.id), label: String(c.label).slice(0, 24), color: c.color, soft: softOf(c.color), custom: true }));
    }
    function addCategory(label, color) {
        const name = String(label || "").trim().slice(0, 24);
        if (!name) throw new Error("Please name the category.");
        const existing = CATS().find(c => c.label.toLowerCase() === name.toLowerCase());
        if (existing) return existing;
        const cat = { id: "c-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 16) + "-" + Math.random().toString(36).slice(2, 6), label: name, color: validColor(color) ? color : SWATCHES[0] };
        const list = loadJSON(CAT_KEY, []);
        saveJSON(CAT_KEY, (Array.isArray(list) ? list : []).concat(cat));
        notifyChange();
        return { ...cat, soft: softOf(cat.color), custom: true };
    }
    function swatchesHTML(name, selected) {
        return `<div class="color-swatches" role="radiogroup" aria-label="Colour">${SWATCHES.map(c =>
            `<label class="color-swatch" style="--sw:${c}"><input type="radio" name="${name}" value="${c}" ${String(selected).toLowerCase() === c.toLowerCase() ? "checked" : ""} aria-label="Colour ${c}"><span></span></label>`).join("")}</div>`;
    }

    function normaliseGoal(g) {
        if (!g || typeof g !== "object") return null;
        const legacyProgress = typeof g.progress === "number" && !Array.isArray(g.milestones);
        const milestones = (Array.isArray(g.milestones) ? g.milestones : []).map(m => {
            if (typeof m === "string") m = { text: m };
            return {
                id: String(m.id || uid("ms")),
                text: String(m.text || m.title || "").trim(),
                done: Boolean(m.done || m.completed),
                date: m.date || null,
                completedAt: m.completedAt || null
            };
        }).filter(m => m.text);

        const goal = {
            id: String(g.id || uid("goal")),
            title: String(g.title || "Untitled goal").trim(),
            description: g.description || "",
            date: g.date || g.deadline || null,
            createdAt: g.createdAt || new Date().toISOString(),
            updatedAt: g.updatedAt || g.createdAt || new Date().toISOString(),
            status: ["active", "completed", "archived"].includes(g.status) ? g.status : "active",
            category: g.category || guessCategory(g.title || ""),
            color: validColor(g.color) ? g.color : null,
            source: g.source || (legacyProgress ? "journal" : "manual"),
            milestones,
            manualProgress: typeof g.manualProgress === "number" ? g.manualProgress : (legacyProgress ? g.progress : null)
        };
        return goal;
    }

    function guessCategory(title) {
        const t = title.toLowerCase();
        if (/exam|test|study|revise|learn|course|class|python|language|spanish|read/.test(t)) return "learning";
        if (/gym|run|fit|weight|health|marathon|sleep|yoga/.test(t)) return "health";
        if (/work|project|launch|client|career|job|business/.test(t)) return "work";
        return "personal";
    }

    function getGoals(opts = {}) {
        const raw = loadJSON(GOAL_KEY, []);
        const arr = Array.isArray(raw) ? raw : [];
        // Every goal gets its own colour once, and keeps it (its sessions share it)
        const missing = arr.filter(g => g && typeof g === "object" && !validColor(g.color));
        if (missing.length) {
            const used = arr.map(g => g && g.color).filter(validColor);
            missing.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
                .forEach(g => { g.color = nextGoalColor(used); used.push(g.color); });
            try { saveJSON(GOAL_KEY, arr); } catch {}
        }
        const list = arr.map(normaliseGoal).filter(Boolean);
        return opts.includeArchived ? list : list.filter(g => g.status !== "archived");
    }

    function saveGoals(list) {
        const tasks = getTasks();
        saveJSON(GOAL_KEY, list.map(g => ({ ...g, progress: goalProgress(g, tasks) })));
        notifyChange();
    }

    function getGoal(id) {
        return getGoals({ includeArchived: true }).find(g => g.id === String(id)) || null;
    }

    function goalTitle(id) {
        const g = id ? getGoal(id) : null;
        return g ? g.title : "";
    }

    function goalSessions(id, tasks) {
        return (tasks || getTasks()).filter(t => t.goalId && String(t.goalId) === String(id));
    }

    function goalProgress(goal, tasks) {
        if (!goal) return 0;
        if (goal.status === "completed") return 100;
        // Milestones and sessions both count: finishing a session moves the goal forward
        const sessions = goalSessions(goal.id, tasks);
        const ms = goal.milestones && goal.milestones.length ? goal.milestones.filter(m => m.done).length / goal.milestones.length : null;
        const ss = sessions.length ? sessions.filter(t => t.completed).length / sessions.length : null;
        if (ms !== null && ss !== null) return Math.round((ms + ss) / 2 * 100);
        if (ms !== null) return Math.round(ms * 100);
        if (ss !== null) return Math.round(ss * 100);
        return Math.max(0, Math.min(100, Math.round(goal.manualProgress || 0)));
    }

    function createGoal(data) {
        const goals = getGoals({ includeArchived: true });
        const goal = normaliseGoal({
            ...data,
            id: data.id || uid("goal"),
            color: validColor(data.color) ? data.color : nextGoalColor(goals.map(g => g.color)),
            createdAt: new Date().toISOString(),
            milestones: (data.milestones || []).map(m => (typeof m === "string" ? { text: m } : m))
        });
        goals.unshift(goal);
        saveGoals(goals);
        return goal;
    }

    function updateGoal(id, patch) {
        const goals = getGoals({ includeArchived: true });
        const i = goals.findIndex(g => g.id === String(id));
        if (i === -1) return null;
        goals[i] = normaliseGoal({ ...goals[i], ...patch, updatedAt: new Date().toISOString() });
        saveGoals(goals);
        return goals[i];
    }

    function toggleMilestone(goalId, msId) {
        const goal = getGoal(goalId);
        if (!goal) return;
        const ms = goal.milestones.find(m => m.id === String(msId));
        if (!ms) return;
        ms.done = !ms.done;
        ms.completedAt = ms.done ? new Date().toISOString() : null;
        updateGoal(goalId, { milestones: goal.milestones });
    }

    /*
     * Delete a goal: its unfinished sessions are removed from the schedule,
     * completed sessions stay as history.
     */
    function deleteGoal(id) {
        const goals = getGoals({ includeArchived: true }).filter(g => g.id !== String(id));
        saveGoals(goals);
        const tasks = getTasks();
        const kept = tasks.filter(t => !(t.goalId && String(t.goalId) === String(id) && !t.completed));
        if (kept.length !== tasks.length) saveTasks(kept);
        notifyChange();
        return tasks.length - kept.length;
    }


    /* =====================================================
       Migration (safe to run on every load)
       ===================================================== */

    const SAMPLE_TASKS = { "seed-1": "Team standup", "seed-2": "Gym session", "seed-3": "Read 20 pages" };

    function migrate() {
        const done = loadJSON(MIGRATION_KEY, {});

        // 1. Goals: one shape for Journal, Goal Tracker and AI goals
        const raw = loadJSON(GOAL_KEY, null);
        if (Array.isArray(raw) && raw.length) {
            const needs = raw.some(g => !g || typeof g.id !== "string" || !Array.isArray(g.milestones) || !("status" in g) || !("manualProgress" in g));
            if (needs) saveJSON(GOAL_KEY, raw.map(normaliseGoal).filter(Boolean).map(g => ({ ...g, progress: goalProgress(g) })));
        }

        // 2. Remove the old sample tasks that every new account got, but only
        //    if they were never touched (not completed, same title).
        if (!done.sampleTasksRemoved) {
            const tasks = getTasks();
            const kept = tasks.filter(t => !(SAMPLE_TASKS[t.id] && SAMPLE_TASKS[t.id] === t.title && !t.completed));
            if (kept.length !== tasks.length) saveTasks(kept);
            done.sampleTasksRemoved = true;
        }

        // 3. Every task gets a string id
        if (!done.taskIds) {
            const tasks = getTasks();
            if (tasks.some(t => typeof t.id !== "string" || !t.id)) {
                saveTasks(tasks.map(t => ({ ...t, id: t.id ? String(t.id) : uid("task") })));
            }
            done.taskIds = true;
        }

        done.version = 2;
        saveJSON(MIGRATION_KEY, done);
    }


    /* =====================================================
       Context for AI + priorities
       ===================================================== */

    function priorityCtx() {
        const goalsById = {};
        getGoals().forEach(g => { goalsById[g.id] = g; });
        const t = today();
        return { today: t, nowMin: nowMin(), goalsById, events: getEvents().filter(e => e.date === t) };
    }

    function focusTasks(limit = 3) {
        if (!window.PlanoraPriority) return [];
        return PlanoraPriority.focus(getTasks(), priorityCtx(), limit);
    }

    function reasonFor(task) {
        return window.PlanoraPriority ? PlanoraPriority.reason(task, priorityCtx()) : "";
    }

    // What the AI is allowed to know about the user's plan
    function aiContext() {
        const t = today();
        const from = addDays(t, -7), to = addDays(t, 30);
        const tasks = getTasks()
            .filter(x => x.date && x.date >= from && x.date <= to)
            .slice(0, 300)
            .map(x => ({
                id: String(x.id), title: x.title, date: x.date, start: x.start || "", end: x.end || "",
                completed: Boolean(x.completed), priority: x.priority || "", deadline: x.deadline || "", goalId: x.goalId || "",
                duration: taskDuration(x)
            }));
        const goals = getGoals().slice(0, 20).map(g => ({
            id: g.id, title: g.title, date: g.date, status: g.status, progress: goalProgress(g), createdAt: g.createdAt,
            milestones: g.milestones.map(m => ({ text: m.text, done: m.done }))
        }));
        const events = getEvents()
            .filter(x => x.date >= addDays(t, -1) && x.date <= to)
            .slice(0, 300)
            .map(x => ({ id: String(x.id), title: x.title, date: x.date, start: x.start, end: x.end, category: x.category || "" }));
        return { tasks, goals, events };
    }

    // Free windows on a date (minutes), after `fromMin`
    function freeWindows(date, fromMin = 7 * 60, untilMin = 22 * 60, minLen = 30) {
        const busy = getTasks()
            .filter(t => t.date === date && toMin(t.start) !== null)
            .map(t => [toMin(t.start), toMin(t.end) !== null && toMin(t.end) > toMin(t.start) ? toMin(t.end) : toMin(t.start) + 30])
            .concat(getEvents().filter(e => e.date === date && toMin(e.start) !== null).map(e => [toMin(e.start), toMin(e.start) + eventDuration(e)]))
            .sort((a, b) => a[0] - b[0]);
        const gaps = [];
        let cursor = Math.max(fromMin, 7 * 60);
        cursor = Math.ceil(cursor / 15) * 15;
        busy.forEach(([s, e]) => {
            if (s - 10 - cursor >= minLen) gaps.push({ start: cursor, end: s - 10, minutes: s - 10 - cursor });
            cursor = Math.max(cursor, Math.ceil((e + 10) / 15) * 15);
        });
        if (untilMin - cursor >= minLen) gaps.push({ start: cursor, end: untilMin, minutes: untilMin - cursor });
        return gaps;
    }


    /* =====================================================
       Scheduling through the server (same scheduler as AI)
       ===================================================== */

    async function scheduleItems(items, { excludeIds = [] } = {}) {
        const exclude = new Set(excludeIds.map(String));
        const existing = getTasks()
            .filter(t => !t.completed && t.date && t.date >= today() && t.start && !exclude.has(String(t.id)))
            .map(t => ({ date: t.date, start: t.start, end: t.end, title: t.title }))
            .concat(getEvents().filter(e => e.date >= today()).map(e => ({ date: e.date, start: e.start, end: e.end, title: e.title, kind: "event" })));
        const response = await fetch("/api/schedule", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items, today: today(), now: nowClock(), existing })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Planora couldn't schedule that right now. Your existing tasks are safe.");
        return data.tasks || [];
    }


    /* =====================================================
       Apply a confirmed plan (tasks + goals + changes)
       ===================================================== */

    function applyPlan(plan, { source = "planora" } = {}) {
        const goalIds = {};
        let createdGoals = 0;

        (plan.goals || []).forEach(g => {
            if (g.existingId) {
                goalIds[g.ref] = g.existingId;
                const existing = getGoal(g.existingId);
                if (existing && !existing.milestones.length && (g.milestones || []).length) {
                    updateGoal(existing.id, { milestones: g.milestones.map(m => ({ text: m.text, date: m.date || null })) });
                }
                return;
            }
            const goal = createGoal({
                title: g.title,
                date: g.date || null,
                milestones: (g.milestones || []).map(m => ({ text: m.text, date: m.date || null })),
                source: g.source || source,
                category: g.category,
                color: g.color || null          // the colour shown in the preview
            });
            goalIds[g.ref] = goal.id;
            createdGoals++;
        });

        const chosen = (plan.tasks || []).filter(t => t.include !== false);
        const newEvents = chosen.filter(t => t.type === "event");
        let createdEvents = 0;
        const addedEvents = [];
        newEvents.forEach(e => {
            const data = { title: e.title, date: e.date, start: e.start, end: e.end || toClock(toMin(e.start) + (Number(e.duration) || 60)), category: e.category, location: e.location, notes: e.eventNotes || "", source: e.source || source };
            if (e.repeat && e.repeat.type) createEventSeries({ ...data, repeat: e.repeat });
            else addedEvents.push(...addEvents([data]));
            createdEvents++;
        });
        const newTasks = chosen.filter(t => t.type !== "event").map(t => ({
            title: t.title,
            date: t.date,
            start: t.start,
            end: t.end,
            duration: t.duration,
            goalId: (t.goalRef && goalIds[t.goalRef]) || t.goalId || null,
            deadline: t.deadline || null,
            priority: t.priority || null,
            category: t.category || null,
            source: t.source || source
        }));
        const added = newTasks.length ? addTasks(newTasks) : [];

        let changed = 0, removed = 0;
        (plan.updates || []).filter(u => u.include !== false).forEach(u => {
            if (u.remove) { removeTask(u.id); removed++; return; }
            if (updateTask(u.id, { date: u.date, start: u.start, end: u.end, duration: u.duration })) changed++;
        });

        const result = { tasks: added.length, events: createdEvents, goals: createdGoals, updates: changed, removed, taskIds: added.map(t => t.id), eventIds: addedEvents.map(e => e.id), goalIds: Object.values(goalIds) };
        document.dispatchEvent(new CustomEvent("planora:plan-added", { detail: result }));
        return result;
    }

    function summariseResult(r) {
        const bits = [];
        if (r.tasks) bits.push(`${r.tasks} task${r.tasks === 1 ? "" : "s"}`);
        if (r.events) bits.push(`${r.events} event${r.events === 1 ? "" : "s"}`);
        if (r.goals) bits.push(`${r.goals} goal${r.goals === 1 ? "" : "s"}`);
        let text = bits.length ? `Added ${bits.join(" and ")} to your ${r.events && !r.tasks && !r.goals ? "calendar" : "plan"}.` : "";
        if (r.updates) text += `${text ? " " : ""}Updated ${r.updates} task${r.updates === 1 ? "" : "s"}.`;
        if (r.removed) text += `${text ? " " : ""}Removed ${r.removed} task${r.removed === 1 ? "" : "s"}.`;
        return text || "Nothing was changed.";
    }


    /* =====================================================
       Plan review (Preview -> Edit -> Confirm)
       plan = { tasks:[{id,title,date,start,end,duration,notes,goalRef}],
                goals:[{ref,title,date,milestones,existingId}],
                updates:[{id,title,date,start,end,duration,from:{date,start,end}}] }
       ===================================================== */

    const DURATIONS = [15, 20, 30, 45, 60, 75, 90, 120, 150, 180, 240];

    function PlanReview(container, plan, opts = {}) {
        let editing = null;
        plan.tasks = (plan.tasks || []).map(t => {
            const x = { include: true, ...t, id: t.id || uid("draft") };
            if (x.type === "event" && !x.duration) x.duration = (toMin(x.end) - toMin(x.start)) || 60;
            return x;
        });
        plan.goals = plan.goals || [];
        plan.updates = (plan.updates || []).map(u => ({ include: true, ...u }));

        function count() {
            return plan.tasks.filter(t => t.include).length + plan.updates.filter(u => u.include).length;
        }

        function row(item, kind) {
            const key = kind + ":" + item.id;
            if (editing === key) {
                const d = DURATIONS.includes(item.duration) ? DURATIONS : DURATIONS.concat(item.duration).sort((a, b) => a - b);
                return `
                <div class="sp-task editing" data-key="${esc(key)}">
                    ${kind === "task" ? `<label class="sp-lbl">${item.type === "event" ? "Event" : "Task"}<input type="text" class="sp-f-title" value="${esc(item.title)}"></label>` : `<div class="sp-task-title">${esc(item.title)}</div>`}
                    <div class="sp-edit-grid">
                        <label>Day<input type="date" class="sp-f-date" value="${esc(item.date)}"></label>
                        <label>Start<input type="time" class="sp-f-start" value="${esc(item.start)}"></label>
                        <label>${item.type === "event" ? "Length" : "Duration"}<select class="sp-f-dur">${d.map(x => `<option value="${x}" ${x === item.duration ? "selected" : ""}>${durLabel(x)}</option>`).join("")}</select></label>
                    </div>
                    <div class="sp-edit-actions">
                        <button type="button" class="btn-secondary" data-act="cancel">Cancel</button>
                        <button type="button" class="btn-primary" data-act="save" data-key="${esc(key)}">Save</button>
                    </div>
                </div>`;
            }
            const goalName = item.goalRef ? (plan.goals.find(g => g.ref === item.goalRef) || {}).title : (item.goalId ? goalTitle(item.goalId) : "");
            const meta = kind === "update" && item.remove
                ? `<strong>Will be removed</strong> · ${esc(shortDate(item.date))}${item.start ? " " + esc(time12(item.start)) : ""}`
                : kind === "update"
                ? `<span class="sp-from">${esc(shortDate(item.from && item.from.date))}${item.from && item.from.start ? " " + esc(time12(item.from.start)) : ""}</span> → <strong>${esc(dayLabel(item.date))} ${esc(time12(item.start))}</strong> · ${durLabel(item.duration)}`
                : `${esc(time12(item.start))} – ${esc(time12(item.end))}${item.type === "event" ? "" : " · " + durLabel(item.duration)}`;
            const cat = kind === "task" ? categoryInfo(item.category || categoryOf(item)) : null;
            const isEvent = item.type === "event";
            // Colour of the row: the goal's colour for goal tasks, otherwise the category's
            let rowColor = null;
            if (kind === "task" && !isEvent) {
                const pg = item.goalRef ? (plan.goals || []).find(g => g.ref === item.goalRef) : null;
                if (pg && !pg.existingId && !validColor(pg.color)) {
                    const taken = getGoals({ includeArchived: true }).map(g => g.color).concat((plan.goals || []).map(g => g.color));
                    pg.color = nextGoalColor(taken);
                }
                if (pg) rowColor = pg.existingId ? taskColor({ goalId: pg.existingId }).color : pg.color;
                else if (item.goalId) rowColor = taskColor({ goalId: item.goalId }).color;
            }
            if (!rowColor && cat) rowColor = cat.color;
            const extras = kind === "task" ? [
                cat ? `<span class="cat-dot" style="background:${cat.color}"></span>${esc(cat.label)}` : "",
                !isEvent && item.priority === "high" ? "High priority" : "",
                isEvent && item.repeat && item.repeat.type ? esc(repeatLabel(item.repeat, item.date)) : "",
                isEvent && item.location ? esc(item.location) : ""
            ].filter(Boolean) : [];
            return `
            <div class="sp-task ${item.include ? "" : "off"} ${goalName ? "goal" : ""} ${kind === "update" ? "update" : ""}" data-key="${esc(key)}"${rowColor ? ` style="--task-c:${rowColor}"` : ""}>
                <label class="sp-check"><input type="checkbox" data-act="toggle" data-key="${esc(key)}" ${item.include ? "checked" : ""} aria-label="Include ${esc(item.title)}"><span></span></label>
                <div class="sp-task-body">
                    ${kind === "task" ? `<span class="item-kind ${isEvent ? "is-event" : "is-task"}"><i class="ti ${isEvent ? "ti-calendar-event" : "ti-checkbox"}" aria-hidden="true"></i>${isEvent ? "Event" : "Task"}</span>` : ""}
                    <div class="sp-task-title">${esc(item.title)}</div>
                    <div class="sp-task-meta"><i class="ti ${kind === "update" ? "ti-arrow-right" : "ti-clock"}" aria-hidden="true"></i><span>${meta}</span></div>
                    ${extras.length ? `<div class="sp-task-extra">${extras.join(" · ")}</div>` : ""}
                    ${goalName ? `<div class="sp-task-goal"><i class="ti ti-target-arrow" aria-hidden="true"></i>${esc(goalName)}</div>` : ""}
                    ${item.notes ? `<div class="sp-task-note"><i class="ti ti-info-circle" aria-hidden="true"></i>${esc(item.notes)}</div>` : ""}
                </div>
                <div class="sp-task-btns">
                    ${item.remove ? "" : `<button type="button" data-act="edit" data-key="${esc(key)}" aria-label="Edit ${esc(item.title)}"><i class="ti ti-pencil"></i></button>`}
                    <button type="button" data-act="remove" data-key="${esc(key)}" aria-label="Remove ${esc(item.title)}"><i class="ti ti-x"></i></button>
                </div>
            </div>`;
        }

        function find(key) {
            const [kind, id] = key.split(/:(.+)/);
            const list = kind === "task" ? plan.tasks : plan.updates;
            return { kind, item: list.find(x => String(x.id) === id), list };
        }

        function render() {
            const byDay = {};
            plan.tasks.slice().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
                .forEach(t => { (byDay[t.date] = byDay[t.date] || []).push(t); });

            const goalsHtml = plan.goals.map(g => {
                const sessions = plan.tasks.filter(t => t.goalRef === g.ref);
                return `
                <div class="sp-goal">
                    <div class="sp-goal-top">
                        <span class="sp-goal-icon" aria-hidden="true"><i class="ti ti-target-arrow"></i></span>
                        <div>
                            <div class="sp-goal-title">${esc(g.title)}</div>
                            <div class="sp-goal-meta">${g.existingId ? "Adds sessions to this goal" : "New goal"}${g.date ? " · by " + esc(shortDate(g.date)) : ""} · ${sessions.length} session${sessions.length === 1 ? "" : "s"}</div>
                        </div>
                    </div>
                    ${(g.milestones || []).length ? `<ul class="sp-milestones">${g.milestones.map(m => `<li><i class="ti ti-flag" aria-hidden="true"></i><span class="t">${esc(m.text)}</span>${m.date ? `<span class="d">${esc(shortDate(m.date))}</span>` : ""}</li>`).join("")}</ul>` : ""}
                </div>`;
            }).join("");

            const updatesHtml = plan.updates.length ? `
                <div class="sp-day">
                    <div class="sp-day-label">Changes to your schedule</div>
                    ${plan.updates.map(u => row(u, "update")).join("")}
                </div>` : "";

            const daysHtml = Object.keys(byDay).map(d => `
                <div class="sp-day">
                    <div class="sp-day-label">${esc(dayLabel(d))}</div>
                    ${byDay[d].map(t => row(t, "task")).join("")}
                </div>`).join("");

            const n = count();
            const minutes = plan.tasks.filter(t => t.include).reduce((a, t) => a + (t.duration || 0), 0);

            container.innerHTML = `
                <div class="sp-review-head">
                    <span>${esc(opts.heading || "Suggested plan")}</span>
                    <span class="sp-review-sum">${n} item${n === 1 ? "" : "s"}${minutes ? " · " + durLabel(minutes) : ""}</span>
                </div>
                ${goalsHtml}${updatesHtml}${daysHtml}
                <div class="sp-actions">
                    <button type="button" class="btn-secondary" data-act="discard">${esc(opts.discardText || "Discard")}</button>
                    <button type="button" class="btn-primary" data-act="approve" ${n || plan.goals.some(g => !g.existingId) ? "" : "disabled"}>
                        <i class="ti ti-check" aria-hidden="true"></i> ${plan.updates.length && !plan.tasks.length ? (plan.updates.every(u => u.remove) ? "Remove" : "Apply changes") : plan.tasks.length && plan.tasks.every(t => t.type === "event") && !plan.goals.length ? "Add to calendar" : "Add to my plan"}
                    </button>
                </div>`;
            container.hidden = false;
            if (editing) {
                const f = container.querySelector(".sp-task.editing input");
                if (f) f.focus();
            }
        }

        container.onclick = e => {
            const btn = e.target.closest("[data-act]");
            if (!btn || btn.tagName === "INPUT") return;
            const act = btn.dataset.act;
            if (act === "discard") { opts.onDiscard && opts.onDiscard(); return; }
            if (act === "approve") {
                const result = applyPlan(plan, { source: opts.source });
                opts.onApprove && opts.onApprove(result, plan);
                return;
            }
            if (act === "cancel") { editing = null; render(); return; }
            const { kind, item, list } = find(btn.dataset.key);
            if (!item) return;
            if (act === "edit") { editing = btn.dataset.key; render(); return; }
            if (act === "remove") {
                list.splice(list.indexOf(item), 1);
                if (!plan.tasks.length && !plan.updates.length && !plan.goals.length) { opts.onDiscard && opts.onDiscard(); return; }
                render();
                return;
            }
            if (act === "save") {
                const rowEl = container.querySelector(`[data-key="${CSS.escape(btn.dataset.key)}"]`);
                const title = rowEl.querySelector(".sp-f-title");
                if (title && title.value.trim()) item.title = title.value.trim();
                item.date = rowEl.querySelector(".sp-f-date").value || item.date;
                item.start = rowEl.querySelector(".sp-f-start").value || item.start;
                item.duration = Number(rowEl.querySelector(".sp-f-dur").value) || item.duration;
                item.end = toClock(toMin(item.start) + item.duration);
                item.notes = "";
                editing = null;
                render();
            }
        };
        container.onchange = e => {
            if (e.target.dataset.act !== "toggle") return;
            const { item } = find(e.target.dataset.key);
            if (item) { item.include = e.target.checked; render(); }
        };

        render();
        return { render, plan };
    }


    /* =====================================================
       Sheets (modal bottom sheets) + confirm
       ===================================================== */

    let lastFocus = null;

    function openSheet({ title, icon, body, onReady, wide }) {
        closeSheet();
        lastFocus = document.activeElement;
        const backdrop = document.createElement("div");
        backdrop.className = "auth-sheet-backdrop pl-sheet";
        backdrop.id = "planora-sheet";
        backdrop.innerHTML = `
            <div class="auth-sheet ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="pl-sheet-title">
                <div class="auth-sheet-head">
                    ${icon ? `<i class="ti ${icon}" aria-hidden="true"></i>` : ""}
                    <div><h3 id="pl-sheet-title">${esc(title)}</h3></div>
                    <button type="button" class="auth-sheet-close" aria-label="Close"><i class="ti ti-x"></i></button>
                </div>
                <div class="pl-sheet-body">${body}</div>
            </div>`;
        backdrop.addEventListener("click", e => { if (e.target === backdrop) closeSheet(); });
        backdrop.querySelector(".auth-sheet-close").addEventListener("click", closeSheet);
        document.body.appendChild(backdrop);
        document.body.classList.add("pl-sheet-open");
        const panel = backdrop.querySelector(".pl-sheet-body");
        if (onReady) onReady(panel, backdrop);
        const first = panel.querySelector("input, textarea, select, button");
        if (first && window.innerWidth > 700) first.focus();
        return panel;
    }

    function closeSheet() {
        const el = document.getElementById("planora-sheet");
        if (el) { el.remove(); document.dispatchEvent(new CustomEvent("planora:sheet-closed")); }
        document.body.classList.remove("pl-sheet-open");
        if (lastFocus && document.contains(lastFocus)) { try { lastFocus.focus(); } catch {} }
    }

    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && document.getElementById("planora-sheet")) closeSheet();
    });

    function confirmDialog({ title = "Are you sure?", message = "", confirmText = "Confirm", danger = false } = {}) {
        return new Promise(resolve => {
            let answered = false;
            openSheet({
                title,
                icon: danger ? "ti-alert-triangle" : "ti-help-circle",
                body: `
                    ${message ? `<p class="auth-sheet-info">${esc(message)}</p>` : ""}
                    <div class="pl-row-actions">
                        <button type="button" class="btn-secondary" data-no>Cancel</button>
                        <button type="button" class="${danger ? "btn-danger" : "btn-primary"}" data-yes>${esc(confirmText)}</button>
                    </div>`,
                onReady(panel, backdrop) {
                    const finish = v => { if (answered) return; answered = true; closeSheet(); resolve(v); };
                    panel.querySelector("[data-yes]").onclick = () => finish(true);
                    panel.querySelector("[data-no]").onclick = () => finish(false);
                    backdrop.querySelector(".auth-sheet-close").addEventListener("click", () => finish(false));
                    backdrop.addEventListener("click", e => { if (e.target === backdrop) finish(false); });
                    setTimeout(() => panel.querySelector("[data-yes]").focus(), 30);
                }
            });
        });
    }

    // Preview any plan in a sheet (used by recommendations, planners, Journal)
    function openPlanPreview(plan, { title = "Review your plan", intro = "", source = "planora", onDone } = {}) {
        openSheet({
            title,
            icon: "ti-sparkles",
            wide: true,
            body: `${intro ? `<p class="auth-sheet-info">${esc(intro)}</p>` : ""}<div class="sp-review pl-preview"></div>`,
            onReady(panel) {
                PlanReview(panel.querySelector(".sp-review"), plan, {
                    source,
                    onDiscard: closeSheet,
                    onApprove(result) {
                        closeSheet();
                        toast(summariseResult(result), "success");
                        onDone && onDone(result);
                    }
                });
            }
        });
    }


    /* =====================================================
       Quick add (the + button on every page)
       ===================================================== */

    function quickAdd() {
        // On the Calendar, "+" lets you choose a Task or an Event
        if (window.PlanoraCalendar) { PlanoraCalendar.create(); return; }
        // Everywhere else: one quick-add (natural language + repeats + priority)
        openQuickAddSheet(window.PlanoraCalendarDate ? { date: window.PlanoraCalendarDate } : {});
    }


    /* =====================================================
       Recurring tasks
       One rule per series in "planora_recurring"; the actual
       occurrences are normal tasks (seriesId) in the one task store,
       created a few weeks ahead. Completing one occurrence never
       touches the others.
       ===================================================== */

    const SERIES_KEY = "planora_recurring";
    const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    function getSeries() {
        const list = loadJSON(SERIES_KEY, []);
        return Array.isArray(list) ? list : [];
    }

    function saveSeries(list) { saveJSON(SERIES_KEY, list); }

    function dowOf(ds) { return new Date(ds + "T00:00:00").getDay(); }

    function repeatMatches(rule, ds, startDate) {
        if (!rule) return false;
        const d = dowOf(ds);
        if (rule.type === "daily") return true;
        if (rule.type === "weekdays") return d >= 1 && d <= 5;
        if (rule.type === "weekly") return d === dowOf(startDate);
        if (rule.type === "custom") return (rule.days || []).includes(d);
        return false;
    }

    function repeatLabel(rule, startDate) {
        if (!rule) return "";
        if (rule.type === "daily") return "Every day";
        if (rule.type === "weekdays") return "Weekdays";
        if (rule.type === "weekly") return "Every " + new Date((startDate || today()) + "T00:00:00").toLocaleDateString(undefined, { weekday: "long" });
        if (rule.type === "custom") {
            const days = (rule.days || []).slice().sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7));
            if (!days.length) return "";
            return "Every " + days.map(x => DOW[x]).join(", ");
        }
        return "";
    }

    function createRecurring(data) {
        const series = getSeries();
        const s = {
            id: uid("series"),
            title: String(data.title || "Task").trim().slice(0, 140),
            start: data.start || "",
            duration: Number(data.duration) || 30,
            priority: data.priority && data.priority !== "normal" ? data.priority : null,
            ...(data.category ? { category: data.category } : {}),
            ...(validColor(data.color) ? { color: data.color } : {}),
            repeat: data.repeat,
            startDate: data.date || today(),
            skipped: [],
            endAfter: null,
            createdAt: new Date().toISOString()
        };
        series.push(s);
        saveSeries(series);
        const made = extendRecurring();
        return { series: s, created: made };
    }

    // Make sure each series has occurrences for the next few weeks (never duplicates)
    function extendRecurring(horizon = 28) {
        const series = getSeries().filter(x => x.kind !== "event");
        if (!series.length) return 0;
        const tasks = getTasks();
        const have = new Set(tasks.filter(t => t.seriesId).map(t => t.seriesId + "|" + t.date));
        const t0 = today();
        const add = [];
        series.forEach(s => {
            let d = s.startDate > t0 ? s.startDate : t0;
            const last = addDays(t0, horizon);
            for (let i = 0; i <= horizon + 1 && d <= last; i++, d = addDays(d, 1)) {
                if (s.endAfter && d > s.endAfter) break;
                if ((s.skipped || []).includes(d)) continue;
                if (!repeatMatches(s.repeat, d, s.startDate)) continue;
                if (have.has(s.id + "|" + d)) continue;
                have.add(s.id + "|" + d);
                add.push({
                    id: s.id + "-" + d,
                    title: s.title,
                    date: d,
                    start: s.start || "",
                    end: s.start ? toClock(toMin(s.start) + s.duration) : "",
                    duration: s.duration,
                    completed: false,
                    seriesId: s.id,
                    ...(s.priority ? { priority: s.priority } : {}),
                    ...(s.category ? { category: s.category } : {}),
                    ...(validColor(s.color) ? { color: s.color } : {}),
                    source: "recurring"
                });
            }
        });
        if (add.length) { saveTasks(tasks.concat(add)); notifyChange(); }
        return add.length;
    }

    function seriesFor(task) {
        return task && task.seriesId ? getSeries().find(s => s.id === task.seriesId) || null : null;
    }

    // Delete one occurrence (skip that date) or this and all future ones
    function deleteOccurrence(task, allFuture) {
        const series = getSeries();
        const s = series.find(x => x.id === task.seriesId);
        if (s) {
            if (allFuture) s.endAfter = addDays(task.date, -1);
            else s.skipped = Array.from(new Set((s.skipped || []).concat(task.date)));
            saveSeries(allFuture && s.endAfter < s.startDate ? series.filter(x => x !== s) : series);
        }
        const tasks = getTasks().filter(t => {
            if (String(t.id) === String(task.id)) return false;
            if (allFuture && t.seriesId === task.seriesId && t.date >= task.date && !t.completed) return false;
            return true;
        });
        saveTasks(tasks);
        notifyChange();
    }


    /* =====================================================
       EVENTS — things that happen at a time (meeting, class,
       appointment). Separate from tasks: no checkbox, never
       "completed", and Planora never moves them by itself.
       Stored in planora_events (synced like everything else).
       Repeating events use the same planora_recurring rules
       (kind: "event"); each occurrence is its own event.
       ===================================================== */

    const EVENT_KEY = "planora_events";
    // Labels are the user's own (name + colour). Planora doesn't ship ready-made ones.
    const CATS = () => customCategories();

    function categoryInfo(id) {
        if (!id) return null;
        const list = CATS();
        // by id, or by name (Planora's suggestions say "study", "work"…: they match a label you named that way)
        return list.find(c => c.id === id) || list.find(c => c.label.toLowerCase() === String(id).toLowerCase()) || null;
    }
    // The label for an item: its own, or one of your labels that fits its name (e.g. "gym" → your "Health" label)
    function categoryOf(item) {
        const own = item && item.category ? categoryInfo(item.category) : null;
        if (own) return own.id;
        const guess = window.PlanoraPriority ? PlanoraPriority.guessCategory(item && item.title) : "";
        const fit = guess && guess !== "other" ? categoryInfo(guess) : null;
        return fit ? fit.id : "";
    }
    function categoryOptions(selected, { allowNone } = {}) {
        const sel = categoryInfo(selected);
        return (allowNone !== false ? `<option value="" ${!sel ? "selected" : ""}>None</option>` : "") +
            CATS().map(c => `<option value="${esc(c.id)}" ${sel && c.id === sel.id ? "selected" : ""}>${esc(c.label)}</option>`).join("");
    }

    function getEvents() {
        const list = loadJSON(EVENT_KEY, []);
        return Array.isArray(list) ? list.filter(e => e && typeof e === "object" && e.date) : [];
    }
    function saveEvents(list) { saveJSON(EVENT_KEY, list); }
    function getEvent(id) { return getEvents().find(e => String(e.id) === String(id)) || null; }

    function normaliseEvent(e) {
        const start = e.start || "09:00";
        let end = e.end || "";
        if (toMin(end) === null || toMin(end) <= toMin(start)) end = toClock(Math.min(24 * 60 - 1, toMin(start) + (Number(e.duration) || 60)));
        const ev = {
            id: e.id || uid("event"),
            title: String(e.title || "Event").trim().slice(0, 140),
            date: e.date || today(),
            start, end,
            category: e.category && categoryInfo(e.category) ? categoryInfo(e.category).id : (e.category || ""),
            createdAt: e.createdAt || new Date().toISOString()
        };
        if (e.location) ev.location = String(e.location).slice(0, 140);
        if (e.notes) ev.notes = String(e.notes).slice(0, 1000);
        if (e.seriesId) ev.seriesId = e.seriesId;
        if (e.detached) ev.detached = true;
        if (e.source) ev.source = e.source;
        if (validColor(e.color)) ev.color = e.color;
        return ev;
    }

    function addEvents(list) {
        const added = list.map(normaliseEvent);
        saveEvents(getEvents().concat(added));
        notifyChange();
        return added;
    }
    function updateEvent(id, patch) {
        const list = getEvents();
        const i = list.findIndex(e => String(e.id) === String(id));
        if (i === -1) return null;
        list[i] = { ...list[i], ...patch };
        if (toMin(list[i].end) === null || toMin(list[i].end) <= toMin(list[i].start)) list[i].end = toClock(Math.min(24 * 60 - 1, toMin(list[i].start) + 60));
        saveEvents(list);
        notifyChange();
        return list[i];
    }
    function removeEvent(id) {
        saveEvents(getEvents().filter(e => String(e.id) !== String(id)));
        notifyChange();
    }
    function eventDuration(e) {
        const s = toMin(e.start), en = toMin(e.end);
        return s !== null && en !== null && en > s ? en - s : 60;
    }

    /* ---- repeating events ---- */
    function createEventSeries(data) {
        const series = getSeries();
        const ev = normaliseEvent(data);
        const s = {
            id: uid("eseries"), kind: "event",
            title: ev.title, start: ev.start, end: ev.end, category: ev.category, color: ev.color || null,
            location: ev.location || "", notes: ev.notes || "",
            repeat: data.repeat, startDate: ev.date, skipped: [], endAfter: null,
            createdAt: new Date().toISOString()
        };
        series.push(s);
        saveSeries(series);
        extendEventSeries();
        return s;
    }

    function extendEventSeries(horizon = 56) {
        const series = getSeries().filter(x => x.kind === "event");
        if (!series.length) return 0;
        const events = getEvents();
        const have = new Set(events.filter(e => e.seriesId).map(e => e.seriesId + "|" + e.date));
        const ids = new Set(events.map(e => String(e.id)));
        const t0 = addDays(today(), -7);
        const add = [];
        series.forEach(s => {
            let d = s.startDate > t0 ? s.startDate : t0;
            const last = addDays(today(), horizon);
            for (let i = 0; i <= horizon + 9 && d <= last; i++, d = addDays(d, 1)) {
                if (s.endAfter && d > s.endAfter) break;
                if ((s.skipped || []).includes(d)) continue;
                if (!repeatMatches(s.repeat, d, s.startDate)) continue;
                const id = s.id + "-" + d;
                if (have.has(s.id + "|" + d) || ids.has(id)) continue;
                have.add(s.id + "|" + d);
                add.push(normaliseEvent({ id, title: s.title, date: d, start: s.start, end: s.end, category: s.category, color: s.color, location: s.location, notes: s.notes, seriesId: s.id, source: "recurring" }));
            }
        });
        if (add.length) { saveEvents(events.concat(add)); notifyChange(); }
        return add.length;
    }

    function eventSeriesFor(ev) {
        return ev && ev.seriesId ? getSeries().find(s => s.id === ev.seriesId) || null : null;
    }

    // scope: "one" | "future" | "all"
    function editEventScoped(ev, patch, scope) {
        const s = eventSeriesFor(ev);
        if (!s || scope === "one") return updateEvent(ev.id, { ...patch, ...(s ? { detached: true } : {}) });
        const series = getSeries();
        const si = series.findIndex(x => x.id === s.id);
        const fields = ["title", "start", "end", "category", "color", "location", "notes"];
        if (scope === "all") {
            fields.forEach(f => { if (patch[f] !== undefined) series[si][f] = patch[f]; });
            if (patch.repeat) series[si].repeat = patch.repeat;
            saveSeries(series);
            const list = getEvents().map(e => {
                if (e.seriesId !== s.id || e.detached) return e;
                const next = { ...e };
                fields.forEach(f => { if (patch[f] !== undefined) next[f] = patch[f]; });
                return next;
            });
            // a changed repeat pattern: rebuild the upcoming occurrences
            const rebuilt = patch.repeat ? list.filter(e => !(e.seriesId === s.id && !e.detached && e.date >= today())) : list;
            saveEvents(rebuilt);
            extendEventSeries();
            notifyChange();
            return getEvent(ev.id);
        }
        // this and future: end the old series the day before, start a new one here
        series[si].endAfter = addDays(ev.date, -1);
        const merged = { ...s };
        fields.forEach(f => { if (patch[f] !== undefined) merged[f] = patch[f]; });
        const newSeries = { ...merged, id: uid("eseries"), repeat: patch.repeat || s.repeat, startDate: patch.date || ev.date, skipped: [], endAfter: s.endAfter || null, createdAt: new Date().toISOString() };
        series.push(newSeries);
        saveSeries(series.filter(x => !(x.id === s.id && x.endAfter && x.endAfter < x.startDate)));
        saveEvents(getEvents().filter(e => !(e.seriesId === s.id && e.date >= ev.date && !e.detached)));
        extendEventSeries();
        notifyChange();
        return getEvents().find(e => e.seriesId === newSeries.id) || null;
    }

    function deleteEventScoped(ev, scope) {
        const s = eventSeriesFor(ev);
        if (!s || scope === "one") {
            if (s) {
                const series = getSeries();
                const x = series.find(y => y.id === s.id);
                x.skipped = Array.from(new Set((x.skipped || []).concat(ev.date)));
                saveSeries(series);
            }
            removeEvent(ev.id);
            return;
        }
        const series = getSeries();
        if (scope === "all") {
            saveSeries(series.filter(x => x.id !== s.id));
            saveEvents(getEvents().filter(e => e.seriesId !== s.id));
        } else {
            const x = series.find(y => y.id === s.id);
            x.endAfter = addDays(ev.date, -1);
            saveSeries(x.endAfter < x.startDate ? series.filter(y => y !== x) : series);
            saveEvents(getEvents().filter(e => !(e.seriesId === s.id && e.date >= ev.date)));
        }
        notifyChange();
    }

    async function askScope(ev, verb) {
        return chooseDialog({
            title: "This event repeats",
            message: `"${ev.title}" repeats (${repeatLabel(eventSeriesFor(ev).repeat, eventSeriesFor(ev).startDate).toLowerCase()}). ${verb}:`,
            options: [["one", "This occurrence"], ["future", "This and future"], ["all", "Entire series"]],
            danger: verb === "Delete"
        });
    }

    /* ---- event details (no Complete: an event isn't a task) ---- */
    function openEventSheet(id) {
        const ev = getEvent(id);
        if (!ev) return;
        const cat = categoryInfo(ev.category) || categoryInfo("other");
        const s = eventSeriesFor(ev);
        openSheet({
            title: ev.title,
            icon: "ti-calendar-event",
            body: `
                <p class="item-kind is-event"><i class="ti ti-calendar-event" aria-hidden="true"></i> Event</p>
                <p class="pl-hint ev-when">${esc(dayLabel(ev.date))} · ${esc(time12(ev.start))}–${esc(time12(ev.end))}</p>
                <dl class="ev-details">
                    <div><dt>Location</dt><dd>${ev.location ? esc(ev.location) : "<span class='muted'>None</span>"}</dd></div>
                    <div><dt>Notes</dt><dd>${ev.notes ? esc(ev.notes) : "<span class='muted'>None</span>"}</dd></div>
                    <div><dt>Repeat</dt><dd>${s ? esc(repeatLabel(s.repeat, s.startDate)) : "None"}</dd></div>
                    <div><dt>Colour</dt><dd><span class="cat-dot" style="background:${eventColor(ev).color}"></span>${esc(validColor(ev.color) ? "Custom colour" : (cat ? cat.label : "Other"))}</dd></div>
                </dl>
                <div class="pl-row-actions">
                    <button type="button" class="btn-secondary" data-a="edit"><i class="ti ti-pencil" aria-hidden="true"></i> Edit</button>
                    <button type="button" class="btn-secondary danger" data-a="delete"><i class="ti ti-trash" aria-hidden="true"></i> Delete</button>
                </div>`,
            onReady(panel) {
                panel.onclick = async e => {
                    const b = e.target.closest("[data-a]");
                    if (!b) return;
                    if (b.dataset.a === "edit") openEventForm({ editId: ev.id });
                    if (b.dataset.a === "delete") {
                        let scope = "one";
                        if (s) { scope = await askScope(ev, "Delete"); if (!scope) return; }
                        else {
                            const ok = await confirmDialog({ title: "Delete this event?", message: `"${ev.title}" will be removed from your calendar.`, confirmText: "Delete", danger: true });
                            if (!ok) return;
                        }
                        const before = getEvents(), beforeSeries = getSeries();
                        deleteEventScoped(ev, scope);
                        closeSheet();
                        toastUndo("Event deleted.", () => { saveEvents(before); saveSeries(beforeSeries); notifyChange(); });
                    }
                };
            }
        });
    }

    /* ---- create / edit an event ---- */
    function openEventForm(defaults = {}) {
        const editing = defaults.editId ? getEvent(defaults.editId) : null;
        const d = editing ? { ...editing } : {
            title: defaults.title || "", date: defaults.date || today(),
            start: defaults.start || toClock(Math.min(22 * 60, Math.ceil((nowMin() + 1) / 60) * 60)),
            category: defaults.category || ""
        };
        if (!editing) d.end = defaults.end || toClock(Math.min(24 * 60 - 1, toMin(d.start) + 60));
        const s = editing ? eventSeriesFor(editing) : null;
        openSheet({
            title: editing ? "Edit event" : "New event",
            icon: "ti-calendar-event",
            body: `
                <form class="pl-form" novalidate>
                    <label class="sp-lbl">Event
                        <input type="text" name="title" required autocomplete="off" placeholder="e.g. Client meeting" value="${esc(d.title || "")}">
                    </label>
                    <div class="sp-edit-grid">
                        <label>Day<input type="date" name="date" value="${esc(d.date)}"></label>
                        <label>Start<input type="time" name="start" value="${esc(d.start)}"></label>
                        <label>End<input type="time" name="end" value="${esc(d.end)}"></label>
                    </div>
                    ${COLOR_FIELD_HTML}
                    <label class="sp-lbl">Location (optional)<input type="text" name="location" autocomplete="off" value="${esc(d.location || "")}"></label>
                    <label class="sp-lbl">Notes (optional)<textarea name="notes" rows="2">${esc(d.notes || "")}</textarea></label>
                    ${editing ? "" : `
                    <label class="sp-lbl">Repeat
                        <select name="repeat">
                            <option value="">None</option>
                            <option value="daily">Every day</option>
                            <option value="weekdays">Weekdays</option>
                            <option value="weekly">Weekly</option>
                            <option value="custom">Custom days…</option>
                        </select>
                    </label>
                    <div class="pl-days" role="group" aria-label="Repeat on" hidden>
                        ${[1, 2, 3, 4, 5, 6, 0].map(x => `<label class="day-chip"><input type="checkbox" value="${x}"><span>${DOW[x]}</span></label>`).join("")}
                    </div>`}
                    <p class="auth-error" hidden></p>
                    <button type="submit" class="btn-primary">${editing ? "Save changes" : "Add to calendar"}</button>
                </form>`,
            onReady(panel) {
                const form = panel.querySelector("form");
                const f = n => form.querySelector(`[name=${n}]`);
                const days = form.querySelector(".pl-days");
                const rep = f("repeat");
                if (rep) rep.onchange = () => { days.hidden = rep.value !== "custom"; };
                attachMic(f("title"), { place: btn => { const w = document.createElement("div"); w.className = "voice-field"; f("title").before(w); w.append(f("title"), btn); } });
                mountColorChips(form.querySelector(".edit-color-field"), {
                    selected: d.category || "",
                    color: d.color || "",
                    autoFrom: editing ? null : f("title")
                });
                // keep the length when the start moves
                let len = toMin(d.end) - toMin(d.start);
                f("start").addEventListener("change", () => { if (toMin(f("start").value) !== null) f("end").value = toClock(Math.min(24 * 60 - 1, toMin(f("start").value) + Math.max(15, len))); });
                f("end").addEventListener("change", () => { const l = toMin(f("end").value) - toMin(f("start").value); if (l > 0) len = l; });
                form.onsubmit = async e => {
                    e.preventDefault();
                    const err = form.querySelector(".auth-error");
                    const v = { title: f("title").value.trim(), date: f("date").value || today(), start: f("start").value, end: f("end").value, category: catValue(f("category")), color: colorValue(form), location: f("location").value.trim(), notes: f("notes").value.trim() };
                    if (!v.title) { err.textContent = "Please give the event a name."; err.hidden = false; f("title").focus(); return; }
                    if (toMin(v.start) === null) { err.textContent = "Please choose a start time."; err.hidden = false; return; }
                    if (toMin(v.end) === null || toMin(v.end) <= toMin(v.start)) v.end = toClock(Math.min(24 * 60 - 1, toMin(v.start) + 60));
                    if (editing) {
                        let scope = "one";
                        if (s) { closeSheet(); scope = await askScope(editing, "Save changes to"); if (!scope) return; }
                        const before = getEvents(), beforeSeries = getSeries();
                        editEventScoped(editing, v, scope);
                        closeSheet();
                        toastUndo("Event updated.", () => { saveEvents(before); saveSeries(beforeSeries); notifyChange(); });
                        return;
                    }
                    if (rep && rep.value) {
                        const r = { type: rep.value, days: Array.from(days.querySelectorAll("input:checked")).map(i => Number(i.value)) };
                        if (r.type === "custom" && !r.days.length) { err.textContent = "Pick at least one day for it to repeat on."; err.hidden = false; return; }
                        createEventSeries({ ...v, repeat: r });
                        closeSheet();
                        toast(`Added "${v.title}" · ${repeatLabel(r, v.date).toLowerCase()}.`, "success");
                        return;
                    }
                    const [ev] = addEvents([{ ...v, source: "calendar" }]);
                    closeSheet();
                    toastUndo(`Added "${ev.title}" to your calendar.`, () => removeEvent(ev.id));
                };
                if (!editing) setTimeout(() => f("title").focus(), 30);
            }
        });
    }

    /* ---- "+" : choose Task or Event ---- */
    function openCreateSheet(defaults = {}) {
        const date = defaults.date || today();
        openSheet({
            title: "Create",
            icon: "ti-plus",
            body: `
                <p class="pl-hint">${esc(dayLabel(date))}${defaults.start ? " · " + esc(time12(defaults.start)) : ""}</p>
                <div class="create-choice">
                    <button type="button" class="create-opt is-task" data-c="task"><i class="ti ti-checkbox" aria-hidden="true"></i><span><strong>Task</strong><small>Something to get done</small></span></button>
                    <button type="button" class="create-opt is-event" data-c="event"><i class="ti ti-calendar-event" aria-hidden="true"></i><span><strong>Event</strong><small>Something happening at a time</small></span></button>
                </div>`,
            onReady(panel) {
                panel.querySelector("[data-c=task]").onclick = () => openQuickAddSheet({ date, start: defaults.start || "", duration: defaults.duration || 30 });
                panel.querySelector("[data-c=event]").onclick = () => openEventForm({ date, start: defaults.start, end: defaults.end });
            }
        });
    }

    /*
     * Click an empty calendar slot → quick create, with the day and time filled in.
     * Type a name; Task/Event is guessed from the words (you can switch).
     */
    function openSlotCreate({ date, start, kind }) {
        const guess = t => (window.PlanoraPriority ? PlanoraPriority.kindOf(t) : "task");
        let type = kind || "task", typeTouched = Boolean(kind);
        const endDefault = toClock(Math.min(24 * 60 - 1, toMin(start) + 60));
        openSheet({
            title: "Create",
            icon: "ti-plus",
            body: `
                <form class="pl-form slot-create" novalidate>
                    <p class="pl-hint slot-when"><i class="ti ti-clock" aria-hidden="true"></i> ${esc(dayLabel(date))} · ${esc(time12(start))}</p>
                    <div class="seg" role="tablist" aria-label="Create a">
                        <button type="button" role="tab" data-k="task" aria-selected="${type === "task"}"><i class="ti ti-checkbox" aria-hidden="true"></i> Task</button>
                        <button type="button" role="tab" data-k="event" aria-selected="${type === "event"}"><i class="ti ti-calendar-event" aria-hidden="true"></i> Event</button>
                    </div>
                    <label class="sp-lbl"><span class="slot-name-label">${type === "event" ? "Event" : "Task"} name</span>
                        <input type="text" name="title" required autocomplete="off" placeholder="${type === "event" ? "e.g. Client meeting" : "e.g. Physics assignment"}">
                    </label>
                    <div class="sp-edit-grid">
                        <label>Day<input type="date" name="date" value="${esc(date)}"></label>
                        <label>Start<input type="time" name="start" value="${esc(start)}"></label>
                        <label data-only="task">Duration<select name="duration">${DURATIONS.map(x => `<option value="${x}" ${x === 30 ? "selected" : ""}>${durLabel(x)}</option>`).join("")}</select></label>
                        <label data-only="event">End<input type="time" name="end" value="${esc(endDefault)}"></label>
                        <label data-only="task">Priority<select name="priority"><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></label>
                    </div>
                    ${COLOR_FIELD_HTML}
                    <details data-only="event" class="slot-more"><summary>Location and notes</summary>
                        <label class="sp-lbl">Location<input type="text" name="location" autocomplete="off"></label>
                        <label class="sp-lbl">Notes<textarea name="notes" rows="2"></textarea></label>
                    </details>
                    <p class="auth-error" hidden></p>
                    <button type="submit" class="btn-primary slot-save">${type === "event" ? "Save" : "Add task"}</button>
                </form>`,
            onReady(panel) {
                const form = panel.querySelector("form");
                const f = n => form.querySelector(`[name=${n}]`);
                const apply = () => {
                    form.querySelectorAll("[data-k]").forEach(b => b.setAttribute("aria-selected", b.dataset.k === type ? "true" : "false"));
                    form.querySelectorAll("[data-only]").forEach(el => { el.hidden = el.dataset.only !== type; });
                    form.querySelector(".slot-name-label").textContent = type === "event" ? "Event name" : "Task name";
                    form.querySelector(".slot-save").textContent = type === "event" ? "Save" : "Add task";
                    document.dispatchEvent(new CustomEvent("planora:slot-preview", { detail: preview() }));
                };
                const preview = () => ({
                    type, title: f("title").value.trim(), date: f("date").value, start: f("start").value,
                    end: type === "event" ? f("end").value : toClock(Math.min(24 * 60 - 1, toMin(f("start").value) + Number(f("duration").value)))
                });
                form.querySelectorAll("[data-k]").forEach(b => b.onclick = () => { type = b.dataset.k; typeTouched = true; apply(); });
                mountColorChips(form.querySelector(".edit-color-field"), { selected: "", autoFrom: f("title") });
                attachMic(f("title"), { place: btn => { const w = document.createElement("div"); w.className = "voice-field"; f("title").before(w); w.append(f("title"), btn); } });
                f("title").addEventListener("input", () => {
                    const t = f("title").value;
                    if (!typeTouched && t.trim().length > 2) { const g = guess(t); if (g !== "ambiguous" && g !== type) { type = g; apply(); } }
                    document.dispatchEvent(new CustomEvent("planora:slot-preview", { detail: preview() }));
                });
                ["date", "start", "end", "duration"].forEach(n => f(n).addEventListener("change", () => {
                    if (n === "start" && toMin(f("start").value) !== null) f("end").value = toClock(Math.min(24 * 60 - 1, toMin(f("start").value) + 60));
                    document.dispatchEvent(new CustomEvent("planora:slot-preview", { detail: preview() }));
                }));
                form.onsubmit = e => {
                    e.preventDefault();
                    const title = f("title").value.trim();
                    const err = form.querySelector(".auth-error");
                    if (!title) { err.textContent = `Please give the ${type} a name.`; err.hidden = false; f("title").focus(); return; }
                    const date2 = f("date").value || date, start2 = f("start").value || start;
                    if (type === "event") {
                        const [ev] = addEvents([{ title, date: date2, start: start2, end: f("end").value, category: catValue(f("category")), color: colorValue(form), location: f("location").value.trim(), notes: f("notes").value.trim(), source: "calendar" }]);
                        closeSheet();
                        toastUndo(`Added "${ev.title}" · ${dayLabel(ev.date)} ${time12(ev.start)}–${time12(ev.end)}.`, () => removeEvent(ev.id));
                    } else {
                        const dur = Number(f("duration").value) || 30;
                        const [t] = addTasks([{ title, date: date2, start: start2, end: toClock(toMin(start2) + dur), duration: dur, priority: f("priority").value, category: catValue(f("category")), color: colorValue(form), source: "calendar", fixed: true }]);
                        closeSheet();
                        toastUndo(`Added "${t.title}" · ${dayLabel(t.date)} ${time12(t.start)}.`, () => removeTask(t.id));
                    }
                };
                apply();
                setTimeout(() => f("title").focus(), 30);
            }
        });
    }


    /* =====================================================
       Moving tasks (Move to today / tomorrow / choose time)
       ===================================================== */

    // Find a free slot on `date` (keeps the old time if it's free) and move the task
    async function moveTask(id, date, start) {
        const task = getTasks().find(t => String(t.id) === String(id));
        if (!task) return null;
        const before = { date: task.date, start: task.start, end: task.end };
        const dur = taskDuration(task);
        let patch;
        if (start) {
            patch = { date, start, end: toClock(toMin(start) + dur), duration: dur };
        } else {
            let placed = null;
            try {
                placed = (await scheduleItems([{ title: task.title, date, start: task.start || "", duration: dur, flexible: true, sourceId: task.id }], { excludeIds: [task.id] }))[0];
            } catch {}
            patch = placed ? { date: placed.date, start: placed.start, end: placed.end, duration: placed.duration } : { date };
        }
        updateTask(id, patch);
        toastUndo(`Moved "${task.title}" to ${dayLabel(patch.date).toLowerCase()}${patch.start ? " at " + time12(patch.start) : ""}.`, () => updateTask(id, before));
        return patch;
    }

    function toastUndo(message, undo) {
        const host = document.getElementById("planora-toast-host");
        toast(message, "success");
        if (!undo) return;
        setTimeout(() => {
            const last = (document.getElementById("planora-toast-host") || host || document.body).lastElementChild;
            if (!last || last.querySelector(".toast-undo")) return;
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "toast-undo";
            btn.textContent = "Undo";
            btn.onclick = () => { undo(); btn.parentElement && btn.parentElement.remove(); toast("Undone."); };
            last.appendChild(btn);
        }, 20);
    }

    function openRescheduleSheet(id) {
        const task = getTasks().find(t => String(t.id) === String(id));
        if (!task) return;
        const t = today();
        openSheet({
            title: "Reschedule",
            icon: "ti-calendar-time",
            body: `
                <p class="pl-hint"><strong>${esc(task.title)}</strong> · ${esc(dayLabel(task.date))}${task.start ? " " + esc(time12(task.start)) : ""}</p>
                <div class="pl-row-actions">
                    ${task.date !== t ? `<button type="button" class="btn-secondary" data-move="today"><i class="ti ti-sun" aria-hidden="true"></i> Move to today</button>` : ""}
                    <button type="button" class="btn-secondary" data-move="tomorrow"><i class="ti ti-arrow-right" aria-hidden="true"></i> Move to tomorrow</button>
                </div>
                <form class="pl-form" novalidate>
                    <p class="sp-lbl" style="margin:4px 0 0;">Or choose a time</p>
                    <div class="sp-edit-grid">
                        <label>Day<input type="date" name="date" value="${esc(task.date || t)}"></label>
                        <label>Start<input type="time" name="start" value="${esc(task.start || "")}"></label>
                    </div>
                    <button type="submit" class="btn-primary">Move</button>
                </form>`,
            onReady(panel) {
                panel.querySelectorAll("[data-move]").forEach(b => b.onclick = async () => {
                    closeSheet();
                    await moveTask(id, b.dataset.move === "today" ? t : addDays(t, 1));
                });
                panel.querySelector("form").onsubmit = async e => {
                    e.preventDefault();
                    const f = new FormData(e.target);
                    closeSheet();
                    await moveTask(id, f.get("date") || t, f.get("start") || "");
                };
            }
        });
    }


    /* =====================================================
       Task actions (tap a task anywhere): Start · Done ·
       Reschedule · Edit · Delete
       ===================================================== */

    function openTaskSheet(id) {
        const task = getTasks().find(t => String(t.id) === String(id));
        if (!task) return;
        const goal = task.goalId ? getGoal(task.goalId) : null;
        const s = seriesFor(task);
        const meta = [
            dayLabel(task.date) + (task.start ? " · " + time12(task.start) + (task.end ? "–" + time12(task.end) : "") : ""),
            durLabel(taskDuration(task)),
            task.priority === "high" ? "High priority" : "",
            task.deadline ? "Due " + dayLabel(task.deadline).toLowerCase() : "",
            s ? repeatLabel(s.repeat, s.startDate) : ""
        ].filter(Boolean);
        const cat = categoryInfo(task.category || categoryOf(task));
        openSheet({
            title: task.title,
            icon: task.completed ? "ti-circle-check" : "ti-checkbox",
            body: `
                <p class="item-kind is-task"><i class="ti ti-checkbox" aria-hidden="true"></i> Task${task.completed ? " · done" : ""}</p>
                <p class="pl-hint">${meta.map(esc).join(" · ")}</p>
                <dl class="ev-details">
                    <div><dt>Priority</dt><dd>${task.priority === "high" ? "High" : task.priority === "low" ? "Low" : "Normal"}</dd></div>
                    <div><dt>Colour</dt><dd><span class="cat-dot" style="background:${taskColor(task).color}"></span>${esc(taskColor(task).kind === "goal" ? "Goal colour" : taskColor(task).kind === "custom" ? "Custom colour" : (cat && task.category ? cat.label : "Default"))}</dd></div>
                </dl>
                ${goal ? `<p class="pl-hint"><i class="ti ti-target-arrow" aria-hidden="true" style="color:${goalColor(goal).color}"></i> Goal: ${esc(goal.title)} <span class="cat-dot" style="background:${goalColor(goal).color}" title="Goal colour"></span></p>` : ""}
                ${task.completed ? "" : `<button type="button" class="btn-primary" data-a="start"><i class="ti ti-player-play" aria-hidden="true"></i> Start (${durLabel(taskDuration(task))})</button>`}
                <div class="pl-row-actions">
                    <button type="button" class="btn-secondary" data-a="done"><i class="ti ${task.completed ? "ti-arrow-back-up" : "ti-check"}" aria-hidden="true"></i> ${task.completed ? "Mark not done" : "Complete"}</button>
                    ${task.completed ? "" : `<button type="button" class="btn-secondary" data-a="move"><i class="ti ti-calendar-time" aria-hidden="true"></i> Reschedule</button>`}
                </div>
                <div class="pl-row-actions">
                    <button type="button" class="btn-secondary" data-a="edit"><i class="ti ti-pencil" aria-hidden="true"></i> Edit</button>
                    <button type="button" class="btn-secondary danger" data-a="delete"><i class="ti ti-trash" aria-hidden="true"></i> Delete</button>
                </div>`,
            onReady(panel) {
                panel.onclick = async e => {
                    const b = e.target.closest("[data-a]");
                    if (!b) return;
                    const a = b.dataset.a;
                    if (a === "start") { closeSheet(); window.PlanoraFocus && PlanoraFocus.start(task.id); }
                    if (a === "done") { closeSheet(); updateTask(task.id, { completed: !task.completed }); toast(task.completed ? "Marked as not done." : "Done. ✅", "success"); }
                    if (a === "move") openRescheduleSheet(task.id);
                    if (a === "edit") openQuickAddSheet({ editId: task.id });
                    if (a === "delete") {
                        if (s) {
                            const choice = await chooseDialog({
                                title: "Delete repeating task",
                                message: `"${task.title}" repeats (${repeatLabel(s.repeat, s.startDate).toLowerCase()}).`,
                                options: [["one", "Only this one"], ["future", "This and all future ones"]],
                                danger: true
                            });
                            if (!choice) return;
                            deleteOccurrence(task, choice === "future");
                        } else {
                            const ok = await confirmDialog({ title: "Delete this task?", message: `"${task.title}" will be deleted.`, confirmText: "Delete", danger: true });
                            if (!ok) return;
                            removeTask(task.id);
                        }
                        toast("Task deleted.");
                    }
                };
            }
        });
    }

    function chooseDialog({ title, message, options, danger }) {
        return new Promise(resolve => {
            let answered = false;
            openSheet({
                title,
                icon: "ti-help-circle",
                body: `${message ? `<p class="auth-sheet-info">${esc(message)}</p>` : ""}
                    ${options.map(([v, l], i) => `<button type="button" class="${i === options.length - 1 && danger ? "btn-danger" : "btn-secondary"}" data-v="${esc(v)}">${esc(l)}</button>`).join("")}
                    <button type="button" class="btn-ghost" data-v="">Cancel</button>`,
                onReady(panel, backdrop) {
                    const finish = v => { if (answered) return; answered = true; closeSheet(); resolve(v || null); };
                    panel.querySelectorAll("[data-v]").forEach(b => b.onclick = () => finish(b.dataset.v));
                    backdrop.querySelector(".auth-sheet-close").addEventListener("click", () => finish(null));
                }
            });
        });
    }


    /* =====================================================
       Quick add / edit — natural language + repeats
       "Finish my physics assignment tomorrow for 2 hours"
       ===================================================== */

    function understoodText(v) {
        if (!v.title) return "";
        const bits = [];
        const dur = Number(v.duration) || 0;
        bits.push(dur ? `a ${dur >= 60 && dur % 60 === 0 ? (dur / 60) + "-hour" : durLabel(dur)} task` : "a task");
        if (v.repeat && v.repeat.type) bits.push(repeatLabel(v.repeat, v.date).replace(/^Every /, "every ").replace(/^Weekdays$/, "on weekdays"));
        else if (v.date) bits.push(dayLabel(v.date).toLowerCase().replace(/^(mon|tues|wednes|thurs|fri|satur|sun)day/, m => "on " + m));
        if (v.start) bits.push("at " + time12(v.start));
        if (v.priority === "high") bits.push("(high priority)");
        return `I understood this as ${bits.join(" ")}.`;
    }

    function openQuickAddSheet(defaults = {}) {
        const editing = defaults.editId ? getTasks().find(t => String(t.id) === String(defaults.editId)) : null;
        const d = editing ? {
            title: editing.title, date: editing.date, start: editing.start || "", duration: taskDuration(editing), priority: editing.priority || "normal", category: editing.category || ""
        } : { date: today(), duration: 30, priority: "normal", category: "", ...defaults };
        const dur = DURATIONS.includes(Number(d.duration)) ? DURATIONS : DURATIONS.concat(Number(d.duration)).sort((x, y) => x - y);

        openSheet({
            title: editing ? "Edit task" : "Add a task",
            icon: editing ? "ti-pencil" : "ti-plus",
            body: `
                <form class="pl-form" novalidate>
                    <label class="sp-lbl">${editing ? "Task" : "What do you need to do?"}
                        <input type="text" name="title" required autocomplete="off"
                            placeholder="e.g. Finish my physics assignment tomorrow for 2 hours" value="${esc(d.title || "")}">
                    </label>
                    <p class="pl-understood" aria-live="polite" hidden></p>
                    <div class="sp-edit-grid">
                        <label>Day<input type="date" name="date" value="${esc(d.date || today())}"></label>
                        <label>Start (optional)<input type="time" name="start" value="${esc(d.start || "")}"></label>
                        <label>Duration<select name="duration">${dur.map(x => `<option value="${x}" ${x === Number(d.duration) ? "selected" : ""}>${durLabel(x)}</option>`).join("")}</select></label>
                        <label>Priority<select name="priority">
                            <option value="normal" ${d.priority !== "high" && d.priority !== "low" ? "selected" : ""}>Normal</option>
                            <option value="high" ${d.priority === "high" ? "selected" : ""}>High</option>
                            <option value="low" ${d.priority === "low" ? "selected" : ""}>Low</option></select></label>
                    </div>
                    ${COLOR_FIELD_HTML}
                    ${editing ? "" : `
                    <label class="sp-lbl">Repeats
                        <select name="repeat">
                            <option value="">Never</option>
                            <option value="daily">Daily</option>
                            <option value="weekdays">Weekdays</option>
                            <option value="weekly">Weekly</option>
                            <option value="custom">Custom days…</option>
                        </select>
                    </label>
                    <div class="pl-days" role="group" aria-label="Repeat on" hidden>
                        ${[1, 2, 3, 4, 5, 6, 0].map(x => `<label class="day-chip"><input type="checkbox" value="${x}"><span>${DOW[x]}</span></label>`).join("")}
                    </div>`}
                    <p class="auth-error" hidden></p>
                    <button type="submit" class="btn-primary">${editing ? "Save changes" : "Add task"}</button>
                    ${editing ? "" : `<p class="pl-hint">Type naturally, like "gym every Mon, Wed and Fri at 6pm" or "essay tomorrow for 2 hours". You can change anything before adding.</p>`}
                </form>`,
            onReady(panel) {
                const form = panel.querySelector("form");
                const f = n => form.querySelector(`[name=${n}]`);
                attachMic(f("title"), { place: btn => { const w = document.createElement("div"); w.className = "voice-field"; f("title").before(w); w.append(f("title"), btn); } });
                mountColorChips(form.querySelector(".edit-color-field"), {
                    selected: d.category,
                    color: editing ? editing.color : "",
                    goal: editing && editing.goalId ? getGoal(editing.goalId) : null,
                    autoFrom: editing ? null : f("title"),
                    onChangeGoalColor: g => { closeSheet(); openGoalSheet({ id: g.id }); }
                });
                const said = form.querySelector(".pl-understood");
                const days = form.querySelector(".pl-days");
                const touched = new Set();
                ["date", "start", "duration", "priority", "repeat"].forEach(n => { const el = f(n); if (el) el.addEventListener("change", () => touched.add(n)); });

                const repeatSel = f("repeat");
                const syncDays = () => { if (days) days.hidden = !repeatSel || repeatSel.value !== "custom"; };
                if (repeatSel) repeatSel.addEventListener("change", syncDays);

                let parsedTitle = null, timer = null, seq = 0;
                const current = () => {
                    const rep = repeatSel && repeatSel.value ? { type: repeatSel.value, days: Array.from(days.querySelectorAll("input:checked")).map(i => Number(i.value)) } : null;
                    return { title: parsedTitle || f("title").value.trim(), date: f("date").value, start: f("start").value, duration: Number(f("duration").value), priority: f("priority").value, category: catValue(f("category")) || null, color: colorValue(form), repeat: rep };
                };
                const setSelect = (el, value) => {
                    if (!el || value == null) return;
                    if (el.tagName === "SELECT" && !Array.from(el.options).some(o => o.value === String(value))) {
                        const o = document.createElement("option"); o.value = value; o.textContent = durLabel(Number(value)); el.appendChild(o);
                    }
                    el.value = value;
                };

                if (!editing) f("title").addEventListener("input", () => {
                    clearTimeout(timer);
                    const text = f("title").value.trim();
                    if (text.length < 4) { said.hidden = true; parsedTitle = null; return; }
                    timer = setTimeout(async () => {
                        const my = ++seq;
                        try {
                            const r = await fetch("/api/parse-task", {
                                method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ text, today: today(), now: nowClock() })
                            });
                            const p = await r.json();
                            if (my !== seq || !r.ok || !p.title) return;
                            parsedTitle = p.title !== text ? p.title : null;
                            if (p.date && !touched.has("date")) f("date").value = p.date;
                            if (p.start && !touched.has("start")) f("start").value = p.start;
                            if (p.duration && !touched.has("duration")) setSelect(f("duration"), p.duration);
                            if (p.priority && !touched.has("priority")) f("priority").value = p.priority;
                            if (p.repeat && repeatSel && !touched.has("repeat")) {
                                repeatSel.value = p.repeat.type;
                                days.querySelectorAll("input").forEach(i => { i.checked = (p.repeat.days || []).includes(Number(i.value)); });
                                syncDays();
                            }
                            const v = current();
                            said.innerHTML = `<i class="ti ti-sparkles" aria-hidden="true"></i><span>${esc(understoodText(v))}${parsedTitle ? ` Title: <strong>${esc(parsedTitle)}</strong>.` : ""}</span>`;
                            said.hidden = false;
                        } catch { /* offline: fields stay as typed */ }
                    }, 350);
                });

                form.onsubmit = e => {
                    e.preventDefault();
                    const v = current();
                    if (!v.title) {
                        const err = form.querySelector(".auth-error");
                        err.textContent = "Please give the task a name.";
                        err.hidden = false;
                        f("title").focus();
                        return;
                    }
                    if (editing) {
                        const patch = { title: f("title").value.trim() || editing.title, date: v.date || editing.date, start: v.start || "", duration: v.duration, priority: v.priority === "normal" ? null : v.priority, category: v.category, color: editing.goalId ? editing.color || null : v.color };
                        patch.end = patch.start ? toClock(toMin(patch.start) + v.duration) : "";
                        updateTask(editing.id, patch);
                        closeSheet();
                        toast("Task updated.", "success");
                        return;
                    }
                    if (v.repeat && v.repeat.type) {
                        if (v.repeat.type === "custom" && !v.repeat.days.length) {
                            const err = form.querySelector(".auth-error");
                            err.textContent = "Pick at least one day for it to repeat on.";
                            err.hidden = false;
                            return;
                        }
                        const r = createRecurring({ title: v.title, date: v.date, start: v.start, duration: v.duration, priority: v.priority, category: v.category, color: v.color, repeat: v.repeat });
                        closeSheet();
                        toast(`Added "${v.title}" · ${repeatLabel(v.repeat, v.date).toLowerCase()}.`, "success");
                        return r;
                    }
                    addTasks([{
                        title: v.title, date: v.date || today(), start: v.start || "", duration: v.duration,
                        priority: v.priority, category: v.category, color: v.color, source: "quick-add", fixed: Boolean(v.start)
                    }]);
                    closeSheet();
                    toast(`Added "${v.title}".`, "success");
                };
            }
        });
    }


    /* =====================================================
       Optimize my day · Organize tomorrow  (always previewed)
       ===================================================== */

    // A task Planora may move: planned by Planora/planners, goal sessions, or no time yet.
    // Tasks you gave a fixed time yourself (and repeating ones) stay where they are.
    function isMovable(t) {
        if (t.completed || t.fixed || t.seriesId) return false;
        if (!t.start) return true;
        if (t.goalId) return true;
        return ["planora", "daily-planner", "breakdown", "journal", "study-planner", "openai"].includes(t.source);
    }

    async function optimizeDay() {
        const t = today();
        const now = nowMin();
        const tasks = getTasks();
        const ctx = priorityCtx();
        const movable = tasks.filter(x => x.date === t && isMovable(x) &&
            (toMin(x.start) === null || toMin(x.start) >= now));
        if (!movable.length) {
            toast("Nothing to rearrange: your remaining tasks have fixed times.");
            return null;
        }
        const ranked = window.PlanoraPriority ? PlanoraPriority.rank(movable, ctx) : movable;
        const startFrom = toClock(Math.ceil((now + 10) / 15) * 15);
        const placed = await scheduleItems(ranked.map(x => ({
            title: x.title, date: t, start: startFrom, duration: taskDuration(x), flexible: true, sourceId: x.id,
            deadline: x.deadline || null
        })), { excludeIds: ranked.map(x => x.id) });
        const byId = {};
        ranked.forEach(x => { byId[String(x.id)] = x; });
        const updates = placed.filter(p => {
            const o = byId[p.sourceId];
            return o && (o.start !== p.start || o.date !== p.date);
        }).map(p => {
            const o = byId[p.sourceId];
            return { id: p.sourceId, title: p.title, date: p.date, start: p.start, end: p.end, duration: p.duration, notes: p.notes, from: { date: o.date, start: o.start, end: o.end } };
        });
        if (!updates.length) {
            toast("Your day already looks good. No changes needed.", "success");
            return null;
        }
        openPlanPreview({ tasks: [], goals: [], updates }, {
            title: "Planora found a better schedule",
            intro: `${updates.length} change${updates.length === 1 ? "" : "s"}: most important first, fitted around your fixed-time tasks. Nothing changes until you apply.`
        });
        return updates;
    }

    async function organizeTomorrow(list) {
        const t = today();
        const tomorrow = addDays(t, 1);
        const ctx = priorityCtx();
        const items = (window.PlanoraPriority ? PlanoraPriority.rank(list, ctx) : list);
        if (!items.length) return;
        const placed = await scheduleItems(items.map(x => ({
            title: x.title, date: tomorrow, start: x.fixed && x.start ? x.start : "", duration: taskDuration(x), flexible: true, sourceId: x.id, deadline: x.deadline || null
        })), { excludeIds: items.map(x => x.id) });
        const byId = {};
        items.forEach(x => { byId[String(x.id)] = x; });
        const updates = placed.map(p => {
            const o = byId[p.sourceId] || {};
            return { id: p.sourceId, title: p.title, date: p.date, start: p.start, end: p.end, duration: p.duration, notes: p.notes, from: { date: o.date, start: o.start, end: o.end } };
        });
        openPlanPreview({ tasks: [], goals: [], updates }, {
            title: "Organize tomorrow",
            intro: "Here's how your unfinished tasks could fit into tomorrow. Edit anything, then apply."
        });
    }


    /* =====================================================
       Today's review (optional, any time; offered in the evening)
       ===================================================== */

    function reviewStats(date) {
        const d = date || today();
        const list = getTasks().filter(x => x.date === d);
        const done = list.filter(x => x.completed);
        const left = list.filter(x => !x.completed);
        const minutes = done.reduce((a, x) => a + (Number(x.focusMinutes) || taskDuration(x)), 0);
        const goalSessions = done.filter(x => x.goalId).length;
        return { done, left, minutes, goalSessions, total: list.length };
    }

    function openDailyReview() {
        const r = reviewStats();
        const goalsTouched = Array.from(new Set(r.done.filter(x => x.goalId).map(x => goalTitle(x.goalId)).filter(Boolean)));
        openSheet({
            title: "Today's review",
            icon: "ti-clipboard-check",
            body: `
                <div class="review-stats">
                    <div><strong>${r.done.length}</strong><span>completed</span></div>
                    <div><strong>${r.left.length}</strong><span>remaining</span></div>
                    <div><strong>${durLabel(r.minutes)}</strong><span>of work done</span></div>
                </div>
                ${r.goalSessions ? `<p class="pl-hint"><i class="ti ti-target-arrow" aria-hidden="true"></i> Goal progress: +${r.goalSessions} session${r.goalSessions === 1 ? "" : "s"}${goalsTouched.length ? ` (${goalsTouched.map(esc).join(", ")})` : ""}</p>` : ""}
                ${r.left.length ? `
                    <p class="auth-sheet-info">You still have ${r.left.length} unfinished task${r.left.length === 1 ? "" : "s"}: ${r.left.slice(0, 3).map(x => esc(x.title)).join(", ")}${r.left.length > 3 ? "…" : ""}.</p>
                    <button type="button" class="btn-primary" data-r="plan"><i class="ti ti-calendar-plus" aria-hidden="true"></i> Plan tomorrow</button>`
                  : r.total ? `<p class="auth-sheet-info">Everything planned for today is done. Nice work.</p>` : `<p class="auth-sheet-info">Nothing was planned for today.</p>`}
                <div class="sheet-divider"></div>
                <p class="auth-sheet-info">What went well today?</p>
                <a class="btn-secondary review-journal" href="journal.html?review=1"><i class="ti ti-notebook" aria-hidden="true"></i> Write in Journal</a>`,
            onReady(panel) {
                const plan = panel.querySelector("[data-r=plan]");
                if (plan) plan.onclick = () => { closeSheet(); organizeTomorrow(r.left); };
                panel.querySelector(".review-journal").addEventListener("click", () => {
                    try { localStorage.removeItem("planora_journal_selected_date"); } catch {}
                });
            }
        });
    }


    /* =====================================================
       Search Planora (tasks, goals, journal)
       ===================================================== */

    function openSearch() {
        openSheet({
            title: "Search Planora",
            icon: "ti-search",
            wide: true,
            body: `
                <label class="sr-only" for="pl-search-input">Search Planora</label>
                <input type="search" id="pl-search-input" class="pl-search-input" placeholder="Search Planora..." autocomplete="off">
                <div class="pl-search-results" aria-live="polite"></div>`,
            onReady(panel) {
                const input = panel.querySelector("input");
                const out = panel.querySelector(".pl-search-results");
                const tasks = getTasks();
                const goals = getGoals({ includeArchived: true });
                const journals = loadJSON("planora_journals", []);
                const events = getEvents();
                const run = () => {
                    const q = input.value.trim().toLowerCase();
                    if (q.length < 2) { out.innerHTML = `<p class="pl-hint">Search your tasks, events, goals and journal.</p>`; return; }
                    const hit = s => String(s || "").toLowerCase().includes(q);
                    const T = tasks.filter(x => hit(x.title)).sort((a, b) => (a.completed - b.completed) || String(b.date).localeCompare(String(a.date))).slice(0, 8);
                    const seen = new Set();
                    const E = events.filter(x => hit(x.title) || hit(x.location) || hit(x.notes))
                        .sort((a, b) => Math.abs(new Date(a.date) - new Date(today())) - Math.abs(new Date(b.date) - new Date(today())))
                        .filter(x => { const k = (x.seriesId || x.id); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
                    const G = goals.filter(g => hit(g.title) || g.milestones.some(m => hit(m.text))).slice(0, 5);
                    const J = (Array.isArray(journals) ? journals : []).filter(j => j && (hit(j.content) || hit(j.brainDump) || (j.wins || []).some(hit) || (j.tags || []).some(hit)))
                        .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);
                    const snippet = text => {
                        const t = String(text || ""), i = t.toLowerCase().indexOf(q);
                        return esc(i < 0 ? t.slice(0, 80) : (i > 30 ? "…" : "") + t.slice(Math.max(0, i - 30), i + 60));
                    };
                    const group = (label, rows) => rows.length ? `<p class="pl-search-group">${label}</p>${rows.join("")}` : "";
                    const html =
                        group("Tasks", T.map(x => `<button type="button" class="pl-search-row" data-task="${esc(x.id)}"><i class="ti ${x.completed ? "ti-circle-check" : "ti-checkbox"}" aria-hidden="true"></i><span><strong>${esc(x.title)}</strong><small>Task · ${esc(dayLabel(x.date))}${x.start ? " · " + esc(time12(x.start)) : ""}${x.completed ? " · done" : ""}</small></span></button>`)) +
                        group("Events", E.map(x => `<button type="button" class="pl-search-row" data-event="${esc(x.id)}"><i class="ti ti-calendar-event" aria-hidden="true"></i><span><strong>${esc(x.title)}</strong><small>Event · ${esc(dayLabel(x.date))} · ${esc(time12(x.start))}–${esc(time12(x.end))}${x.seriesId ? " · repeats" : ""}</small></span></button>`)) +
                        group("Goals", G.map(g => `<a class="pl-search-row" href="planner.html?goal=${encodeURIComponent(g.id)}#goals"><i class="ti ti-target-arrow" aria-hidden="true"></i><span><strong>${esc(g.title)}</strong><small>${goalProgress(g)}% · ${g.date ? "by " + esc(shortDate(g.date)) : "no target date"}</small></span></a>`)) +
                        group("Journal", J.map(j => `<button type="button" class="pl-search-row" data-journal="${esc(j.date)}"><i class="ti ti-notebook" aria-hidden="true"></i><span><strong>${esc(shortDate(j.date))}</strong><small>${snippet(j.content || (j.wins || []).join(", "))}</small></span></button>`));
                    out.innerHTML = html || `<p class="pl-hint">Nothing found for "${esc(input.value.trim())}".</p>`;
                };
                input.addEventListener("input", run);
                out.addEventListener("click", e => {
                    const task = e.target.closest("[data-task]");
                    if (task) { openTaskSheet(task.dataset.task); return; }
                    const evb = e.target.closest("[data-event]");
                    if (evb) { openEventSheet(evb.dataset.event); return; }
                    const j = e.target.closest("[data-journal]");
                    if (j) { localStorage.setItem("planora_journal_selected_date", j.dataset.journal); location.href = "journal.html"; }
                });
                run();
                setTimeout(() => input.focus(), 30);
            }
        });
    }


    /* =====================================================
       Goal editor (create / edit) — same everywhere
       ===================================================== */

    function openGoalSheet(goalOrNull, { onSaved } = {}) {
        const goal = goalOrNull ? getGoal(goalOrNull.id || goalOrNull) : null;
        const tasks = getTasks();
        const sessions = goal ? goalSessions(goal.id, tasks) : [];
        const manualAllowed = goal && !goal.milestones.length && !sessions.length;
        const onPlanora = Boolean(window.PlanoraAsk);

        openSheet({
            title: goal ? "Edit goal" : "New goal",
            icon: "ti-target-arrow",
            body: `
                <form class="pl-form" novalidate>
                    <label class="sp-lbl">Goal
                        <input type="text" name="title" required placeholder="e.g. Learn Python" value="${esc(goal ? goal.title : "")}">
                    </label>
                    <label class="sp-lbl">Target date (optional)
                        <input type="date" name="date" value="${esc(goal && goal.date ? goal.date : "")}">
                    </label>
                    <div class="sp-lbl goal-color-field">Colour <span class="pl-hint-inline">All of this goal's tasks use it</span>
                        ${swatchesHTML("color", goal ? goalColor(goal).color : nextGoalColor(getGoals({ includeArchived: true }).map(g => g.color)))}
                    </div>
                    ${goal ? "" : `<label class="sp-lbl">Milestones (optional, one per line)
                        <textarea name="milestones" rows="3" placeholder="Finish the basics&#10;Build a small project"></textarea>
                    </label>
                    <label class="pl-check-row"><input type="checkbox" name="plan" checked> Let Planora schedule practice sessions for it</label>`}
                    ${manualAllowed ? `<label class="sp-lbl">Progress: <span class="pl-range-val">${goalProgress(goal)}%</span>
                        <input type="range" name="progress" min="0" max="100" step="5" value="${goalProgress(goal)}">
                    </label>` : ""}
                    ${goal ? `<p class="pl-hint">${sessions.length ? `${sessions.filter(t => t.completed).length} of ${sessions.length} sessions done. ` : ""}${goal.milestones.length ? `${goal.milestones.filter(m => m.done).length} of ${goal.milestones.length} milestones done.` : ""}</p>` : ""}
                    <p class="auth-error" hidden></p>
                    <button type="submit" class="btn-primary">${goal ? "Save changes" : "Create goal"}</button>
                    ${goal ? `
                    <div class="pl-row-actions">
                        <button type="button" class="btn-secondary" data-act="plan"><i class="ti ti-sparkles" aria-hidden="true"></i> Plan sessions</button>
                        <button type="button" class="btn-secondary" data-act="status">${goal.status === "completed" ? "Mark as active" : "Mark as achieved"}</button>
                    </div>
                    <button type="button" class="pl-link-danger" data-act="delete">Delete goal</button>` : ""}
                </form>`,
            onReady(panel) {
                const form = panel.querySelector("form");
                const range = form.querySelector("[name=progress]");
                if (range) range.oninput = () => { form.querySelector(".pl-range-val").textContent = range.value + "%"; };

                form.onsubmit = e => {
                    e.preventDefault();
                    const f = new FormData(form);
                    const title = String(f.get("title") || "").trim();
                    if (!title) {
                        const err = form.querySelector(".auth-error");
                        err.textContent = "Please name your goal.";
                        err.hidden = false;
                        return;
                    }
                    let saved;
                    if (goal) {
                        const patch = { title, date: f.get("date") || null };
                        if (validColor(f.get("color"))) patch.color = f.get("color");
                        if (range) patch.manualProgress = Number(range.value);
                        saved = updateGoal(goal.id, patch);
                        closeSheet();
                        toast("Goal updated.", "success");
                    } else {
                        saved = createGoal({
                            title,
                            date: f.get("date") || null,
                            color: f.get("color") || null,
                            milestones: String(f.get("milestones") || "").split("\n").map(s => s.trim()).filter(Boolean),
                            source: onPlanora ? "manual" : (document.getElementById("journal-screen") ? "journal" : "manual")
                        });
                        closeSheet();
                        toast("Goal created.", "success");
                        if (f.get("plan")) planGoalSessions(saved);
                    }
                    onSaved && onSaved(saved);
                };

                const planBtn = form.querySelector("[data-act=plan]");
                if (planBtn) planBtn.onclick = () => { closeSheet(); planGoalSessions(goal); };

                const statusBtn = form.querySelector("[data-act=status]");
                if (statusBtn) statusBtn.onclick = () => {
                    updateGoal(goal.id, { status: goal.status === "completed" ? "active" : "completed" });
                    closeSheet();
                    toast(goal.status === "completed" ? "Goal is active again." : "Goal achieved. Well done! 🎉", "success");
                    onSaved && onSaved();
                };

                const delBtn = form.querySelector("[data-act=delete]");
                if (delBtn) delBtn.onclick = async () => {
                    const open = sessions.filter(t => !t.completed).length;
                    const ok = await confirmDialog({
                        title: "Delete this goal?",
                        message: `"${goal.title}" will be deleted.${open ? ` Its ${open} unfinished session${open === 1 ? "" : "s"} will be removed from your schedule.` : ""} Completed sessions stay in your history.`,
                        confirmText: "Delete goal",
                        danger: true
                    });
                    if (!ok) return;
                    deleteGoal(goal.id);
                    toast("Goal deleted.");
                    onSaved && onSaved();
                };
            }
        });
    }

    // Ask Planora to schedule sessions for an existing goal
    function planGoalSessions(goal) {
        if (window.PlanoraAsk && PlanoraAsk.planForGoal) {
            PlanoraAsk.planForGoal(goal);
            return;
        }
        location.href = "planner.html?plan-goal=" + encodeURIComponent(goal.id);
    }


    /* =====================================================
       Navigation (same on every page)
       Desktop: Home · Calendar · Planora · Journal · Profile
       Phone:   Home · Calendar · + · Planora · Profile
       ===================================================== */

    const NAV = [
        { key: "home", label: "Home", icon: "ti-home", href: "home.html" },
        { key: "calendar", label: "Calendar", icon: "ti-calendar", href: "calendar.html" },
        { key: "planora", label: "Planora", icon: "ti-sparkles", href: "planner.html" },
        { key: "journal", label: "Journal", icon: "ti-notebook", href: "journal.html" },
        { key: "profile", label: "Profile", icon: "ti-user", href: "profile.html" }
    ];

    function currentPage() {
        const p = location.pathname.toLowerCase();
        if (p.includes("calendar")) return "calendar";
        if (p.includes("planner")) return "planora";
        if (p.includes("journal")) return "journal";
        if (p.includes("profile") || p.includes("streak")) return "profile";
        return "home";
    }

    function navLink(item, page) {
        const active = item.key === page;
        return `<a class="nav-item${active ? " active" : ""}" href="${item.href}" ${active ? 'aria-current="page"' : ""} data-nav="${item.key}"><i class="ti ${item.icon}" aria-hidden="true"></i><span>${item.label}</span></a>`;
    }

    function renderNav() {
        const page = currentPage();
        document.querySelectorAll(".side-rail").forEach(rail => {
            rail.setAttribute("role", "navigation");
            rail.setAttribute("aria-label", "Main");
            rail.innerHTML = `
                <a class="logo-mark has-logo" href="home.html" aria-label="Planora home"><img class="logo-img" src="icons/logo-128.png" alt="" width="64" height="64"></a>
                <button type="button" class="nav-item nav-search" data-search aria-label="Search Planora (press /)"><i class="ti ti-search" aria-hidden="true"></i><span>Search</span></button>
                ${NAV.map(item => navLink(item, page)).join("")}`;
        });
        document.querySelectorAll(".bottom-nav").forEach(bar => {
            bar.setAttribute("role", "navigation");
            bar.setAttribute("aria-label", "Main");
            const items = NAV.filter(i => i.key !== "journal");
            bar.innerHTML = `
                ${navLink(items[0], page)}
                ${navLink(items[1], page)}
                <button type="button" class="nav-item nav-add" data-quick-add aria-label="Add a task"><span class="nav-add-circle"><i class="ti ti-plus" aria-hidden="true"></i></span></button>
                ${navLink(items[2], page)}
                ${navLink(items[3], page)}`;
        });
        document.querySelectorAll("[data-quick-add]").forEach(btn => btn.addEventListener("click", quickAdd));
        document.querySelectorAll("[data-search]").forEach(btn => btn.addEventListener("click", openSearch));
        // Journal always opens on today
        document.querySelectorAll('[data-nav="journal"]').forEach(a => a.addEventListener("click", () => {
            try { localStorage.removeItem("planora_journal_selected_date"); } catch {}
        }));
    }


    /* =====================================================
       Public API + start
       ===================================================== */

    window.PlanoraCore = {
        // data
        getTasks, saveTasks, addTasks, updateTask, removeTask,
        getGoals, getGoal, createGoal, updateGoal, deleteGoal, toggleMilestone,
        goalProgress, goalSessions, goalTitle, normaliseGoal,
        // planning
        focusTasks, reasonFor, priorityCtx, aiContext, freeWindows, scheduleItems,
        applyPlan, summariseResult, PlanReview, openPlanPreview, planGoalSessions,
        // ui
        openSheet, closeSheet, confirm: confirmDialog, choose: chooseDialog, quickAdd, openQuickAddSheet, openGoalSheet, toast, toastUndo,
        // doing the work
        openTaskSheet, openRescheduleSheet, moveTask, optimizeDay, organizeTomorrow, isMovable,
        openDailyReview, reviewStats, openSearch,
        // recurring
        getSeries, createRecurring, extendRecurring, deleteOccurrence, repeatLabel, seriesFor,
        // events (not tasks)
        getEvents, getEvent, addEvents, updateEvent, removeEvent, saveEvents, eventDuration, createEventSeries, extendEventSeries,
        eventSeriesFor, editEventScoped, deleteEventScoped, openEventSheet, openEventForm, openCreateSheet, openSlotCreate,
        categoryInfo, categoryOf, categoryOptions, customCategories, addCategory,
        // colours
        openLabelsManager, voiceSupported, attachMic, taskColor, eventColor, paintTask, decorateTaskItem, goalColor, softOf, SWATCHES, mountColorChips,
        // utils
        today, addDays, nowMin, nowClock, toMin, toClock, time12, durLabel, dayLabel, shortDate, esc, uid, taskDuration, loadJSON, saveJSON,
        migrate
    };

    try { migrate(); } catch (error) { console.error("Planora migration failed (data left unchanged):", error); }
    try { extendRecurring(); } catch (error) { console.error("Planora could not extend repeating tasks:", error); }
    try { extendEventSeries(); } catch (error) { console.error("Planora could not extend repeating events:", error); }

    /* "+ New category…" in any category list: name it and pick a colour, right there */
    document.addEventListener("focusin", e => {
        const sel = e.target;
        if (sel && sel.tagName === "SELECT" && sel.name === "category" && sel.value !== "__new") sel.dataset.prev = sel.value;
    });
    document.addEventListener("change", e => {
        const sel = e.target;
        if (!sel || sel.tagName !== "SELECT" || sel.name !== "category") return;
        if (sel.value !== "__new") { sel.dataset.prev = sel.value; return; }
        e.stopImmediatePropagation();
        const host = sel.closest("label") || sel;
        if (host.nextElementSibling && host.nextElementSibling.classList.contains("cat-new")) { host.nextElementSibling.querySelector("input[type=text]").focus(); return; }
        const box = document.createElement("div");
        box.className = "cat-new";
        box.innerHTML = `
            <input type="text" maxlength="24" placeholder="New category name (e.g. Uni, Side hustle)" aria-label="New category name">
            ${swatchesHTML("cat-new-color", SWATCHES[(customCategories().length + 6) % SWATCHES.length])}
            <p class="auth-error" hidden></p>
            <div class="cat-new-actions">
                <button type="button" class="btn-secondary" data-cat="cancel">Cancel</button>
                <button type="button" class="btn-primary" data-cat="add">Add category</button>
            </div>`;
        host.after(box);
        const input = box.querySelector("input[type=text]");
        input.focus();
        const close = () => box.remove();
        const cancel = () => { sel.value = sel.dataset.prev !== undefined ? sel.dataset.prev : (sel.options[0] ? sel.options[0].value : ""); close(); };
        const add = () => {
            try {
                const color = (box.querySelector("input[name=cat-new-color]:checked") || {}).value;
                const cat = addCategory(input.value, color);
                const hasNone = Array.from(sel.options).some(o => o.value === "");
                sel.innerHTML = categoryOptions(cat.id, { allowNone: hasNone });
                sel.value = cat.id;
                sel.dataset.prev = cat.id;
                close();
                sel.dispatchEvent(new Event("change", { bubbles: true }));
                toast(`Category "${cat.label}" added.`, "success");
            } catch (error) {
                const err = box.querySelector(".auth-error");
                err.textContent = error.message; err.hidden = false;
            }
        };
        box.querySelector("[data-cat=cancel]").onclick = cancel;
        box.querySelector("[data-cat=add]").onclick = add;
        input.addEventListener("keydown", ev => {
            if (ev.key === "Enter") { ev.preventDefault(); add(); }
            if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancel(); }
        });
    }, true);

    // "/" or Ctrl/Cmd+K opens search (not while typing)
    document.addEventListener("keydown", e => {
        const typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || "") || (document.activeElement || {}).isContentEditable;
        if ((e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
            if (document.getElementById("planora-sheet")) return;
            e.preventDefault();
            openSearch();
        }
    });

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", renderNav);
    else renderNav();

})();
