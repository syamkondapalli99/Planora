/* =========================================================
   ASK PLANORA  (smart-planner.js)

   <div data-smart-planner data-placeholder="…"></div>

   One box for everything. Planora knows your real tasks, goals
   and free time, and can:
   - plan new things ("finish my assignment tonight", "learn Python by next week")
   - change existing tasks ("move my gym session to 7pm")
   - plan your day from what's already on your list ("plan my day")
   - answer questions ("what should I do now?")
   Every change is shown first: Preview -> Edit -> Confirm.
   Uses PlanoraCore (planora-core.js) for the preview and saving.
   ========================================================= */

(function () {

    const EXAMPLES = [
        "Plan my day",
        "I need to finish my assignment tonight",
        "I have an exam next Friday",
        "Move my gym session to 7pm"
    ];

    const INTRO = "Tell me what you need to get done. I'll find the time, work out how long it takes and show you the plan before anything changes.";

    function esc(t) { return PlanoraCore.esc(t); }
    function rich(t) { return esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"); }

    function SmartPlanner(root) {
        const placeholder = root.dataset.placeholder || "What do you need to get done?";
        const examples = root.dataset.examples ? root.dataset.examples.split("|") : EXAMPLES;
        const state = { history: [], plan: null, review: null, busy: false, recent: [], lastMessage: "", attachGoal: null, file: null };

        root.classList.add("sp-root");
        root.innerHTML = `
            <div class="sp-head">
                <div class="sp-title"><i class="ti ti-sparkles" aria-hidden="true"></i><span>${esc(root.dataset.title || "Ask Planora")}</span></div>
                <button type="button" class="sp-clear" hidden><i class="ti ti-refresh" aria-hidden="true"></i> New</button>
            </div>
            <form class="sp-input-row">
                <label class="sr-only" for="sp-input-${uidSuffix}">${esc(placeholder)}</label>
                <textarea class="sp-input" id="sp-input-${uidSuffix}" rows="1" placeholder="${esc(placeholder)}"></textarea>
                <button type="button" class="sp-attach" aria-label="Attach a document or photo (syllabus, timetable, assignment)" title="Attach a document or photo"><i class="ti ti-paperclip" aria-hidden="true"></i></button>
                <input type="file" class="sp-file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.pdf,application/pdf,.docx,.txt,.md,.csv" hidden>
                <button type="submit" class="sp-send" aria-label="Send to Planora"><i class="ti ti-send" aria-hidden="true"></i></button>
            </form>
            <div class="sp-attached" hidden></div>
            <div class="sp-examples" aria-label="Examples">
                ${examples.map(e => `<button type="button" class="sp-example">${esc(e)}</button>`).join("")}
            </div>
            <div class="sp-log" aria-live="polite" hidden></div>
            <div class="sp-review" hidden></div>
        `;
        uidSuffix++;

        const $ = s => root.querySelector(s);
        const log = $(".sp-log"), input = $(".sp-input"), reviewEl = $(".sp-review");
        const exampleRow = $(".sp-examples"), sendBtn = $(".sp-send"), clearBtn = $(".sp-clear");

        function bubble(html, who, cls = "") {
            log.hidden = false;
            const el = document.createElement("div");
            el.className = `sp-bubble ${who} ${cls}`.trim();
            el.innerHTML = html;
            log.appendChild(el);
            log.scrollTop = log.scrollHeight;
            return el;
        }

        function setBusy(on) {
            state.busy = on;
            sendBtn.disabled = on;
            input.disabled = on;
            const ab = root.querySelector(".sp-attach"); if (ab) ab.disabled = on;
            root.classList.toggle("is-busy", on);
        }

        function showReview(plan, heading) {
            state.plan = plan;
            document.body.classList.add("sp-reviewing");
            state.review = PlanoraCore.PlanReview(reviewEl, plan, {
                heading,
                onDiscard: () => {
                    closeReview();
                    bubble("No problem. Nothing was changed.", "ai");
                },
                onApprove: (result) => {
                    closeReview();
                    state.recent = result.taskIds.concat((plan.updates || []).filter(u => u.include !== false && !u.remove).map(u => u.id));
                    state.history = [];
                    const links = [`<a href="calendar.html"><i class="ti ti-calendar" aria-hidden="true"></i>View in calendar</a>`];
                    if (result.goals || plan.goals.some(g => g.existingId)) links.push(`<a href="planner.html#goals"><i class="ti ti-target-arrow" aria-hidden="true"></i>See goal</a>`);
                    bubble(`${esc(PlanoraCore.summariseResult(result))} ✅<div class="sp-after">${links.join("")}</div>`, "ai");
                    input.placeholder = "Anything else?";
                    PlanoraCore.toast(PlanoraCore.summariseResult(result), "success");
                }
            });
            reviewEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
            input.placeholder = "Want changes? e.g. \"move it to 7pm\" or \"make them 30 min\"";
        }

        function closeReview() {
            state.plan = null;
            state.review = null;
            state.attachGoal = null;
            reviewEl.hidden = true;
            reviewEl.innerHTML = "";
            document.body.classList.remove("sp-reviewing");
            input.placeholder = placeholder;
        }

        function draftForServer() {
            if (!state.plan || !state.plan.tasks.filter(t => t.type !== "event").length) return null;
            return {
                tasks: state.plan.tasks.filter(t => t.type !== "event").map(({ include, ...t }) => t),
                goals: state.plan.goals
            };
        }

        async function send(text, opts = {}) {
            const message = (text || input.value).trim();
            if (state.file && !text && !state.busy) return sendDoc(message);
            if (!message || state.busy) return;
            state.lastMessage = message;
            exampleRow.hidden = true;
            clearBtn.hidden = false;
            bubble(esc(message), "me");
            input.value = "";
            autoGrow();
            setBusy(true);
            const thinking = bubble(`<span class="sp-dots" aria-label="Planora is thinking"><i></i><i></i><i></i></span>`, "ai", "thinking");

            try {
                const response = await fetch("/api/smart-plan", {
                    method: "POST",
                    credentials: "same-origin",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        message,
                        today: PlanoraCore.today(),
                        now: PlanoraCore.nowClock(),
                        context: PlanoraCore.aiContext(),
                        existing: PlanoraCore.busySlots ? PlanoraCore.busySlots() : [],
                        history: state.history.slice(-6),
                        draft: draftForServer(),
                        recent: state.recent,
                        attachGoal: opts.attachGoal || null
                    })
                });
                const data = await response.json().catch(() => ({}));
                thinking.remove();

                if (response.status === 401) {
                    bubble("Your session has ended. Please sign in again.", "ai", "error");
                    setTimeout(() => location.replace("index.html"), 1500);
                    return;
                }
                if (!response.ok) throw new Error(data.error || "server");

                state.history.push({ role: "user", text: message }, { role: "assistant", text: data.reply || "" });

                const hasPlan = (data.tasks || []).length || (data.goals || []).length || (data.updates || []).length || (data.events || []).length;
                const reply = bubble(rich(data.reply || (hasPlan ? "Here's what I suggest." : "I'm not sure how to help with that yet.")), "ai");
                if (data.suggestion) reply.appendChild(suggestionCard(data.suggestion));
                if ((data.actions || []).length) reply.appendChild(actionRow(data.actions, opts));
                log.scrollTop = log.scrollHeight;

                if (hasPlan) {
                    const plan = {
                        tasks: (data.tasks || []).concat((data.events || []).map(e => ({ ...e, type: "event", eventNotes: e.notes && !/^No time given/.test(e.notes) ? e.notes : "" }))),
                        goals: data.goals || [], updates: data.updates || []
                    };
                    if (opts.attachGoal) {
                        // sessions go into the goal the user already has
                        if (!plan.goals.length) plan.goals = [{ ref: "g1", title: opts.attachGoal.title, date: opts.attachGoal.date, milestones: [] }];
                        const ref = plan.goals[0].ref;
                        plan.goals = [{ ...plan.goals[0], title: opts.attachGoal.title, date: opts.attachGoal.date || plan.goals[0].date, existingId: opts.attachGoal.id }];
                        plan.tasks.forEach(t => { t.goalRef = ref; });
                    }
                    showReview(plan, plan.updates.length && !plan.tasks.length ? "Suggested changes" : plan.tasks.length && plan.tasks.every(t => t.type === "event") ? "Preview" : "Suggested plan");
                } else if (state.plan) {
                    // keep showing the current draft
                }
            } catch (error) {
                thinking.remove();
                const el = bubble(`Planora couldn't do that right now. Your existing tasks are safe. <button type="button" class="sp-retry">Try again</button>`, "ai", "error");
                el.querySelector(".sp-retry").onclick = () => { el.remove(); send(message, opts); };
            } finally {
                setBusy(false);
                if (window.innerWidth > 700) input.focus();
            }
        }

        /* ---------- 📎 plan from a document or photo ---------- */
        const MAX_FILE = 8 * 1024 * 1024;
        const attachBtn = $(".sp-attach"), fileInput = $(".sp-file"), attachedEl = $(".sp-attached");
        const fileIcon = n => /\.pdf$/i.test(n) ? "ti-file-type-pdf" : /\.docx$/i.test(n) ? "ti-file-type-doc" : /\.(png|jpe?g|webp|heic|heif|gif)$/i.test(n) ? "ti-photo" : "ti-file-text";
        function showAttached() {
            const f = state.file;
            attachedEl.hidden = !f;
            attachBtn.classList.toggle("is-on", Boolean(f));
            input.placeholder = f ? "Anything to add? e.g. \"only the exams\" (optional) — then send" : (state.plan ? input.placeholder : placeholder);
            attachedEl.innerHTML = f ? `<span class="sp-file-chip"><i class="ti ${fileIcon(f.name)}" aria-hidden="true"></i><span class="n">${esc(f.name)}</span><button type="button" class="sp-file-x" aria-label="Remove ${esc(f.name)}"><i class="ti ti-x" aria-hidden="true"></i></button></span>
                <span class="sp-file-hint">Planora will plan only from the dates in this file. You'll see the plan before anything is added.</span>` : "";
            const x = attachedEl.querySelector(".sp-file-x");
            if (x) x.onclick = () => { state.file = null; showAttached(); input.focus(); };
        }
        const readAsDataURL = file => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => bad(r.error); r.readAsDataURL(file); });
        // photos: shrink big ones and turn HEIC/odd formats into JPEG (the browser does it, nothing is uploaded yet)
        async function photoToJpeg(file) {
            const url = URL.createObjectURL(file);
            try {
                const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
                const scale = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight));
                const c = document.createElement("canvas");
                c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
                const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
                return c.toDataURL("image/jpeg", 0.86);
            } finally { URL.revokeObjectURL(url); }
        }
        async function takeFile(file) {
            if (!file) return;
            const name = file.name || "document";
            const isImg = /^image\//.test(file.type) || /\.(heic|heif)$/i.test(name);
            const ok = isImg || /\.(pdf|docx|txt|md|csv)$/i.test(name);
            if (!ok) { bubble("Planora can read photos (JPG, PNG), PDFs, Word (.docx) and text files.", "ai", "error"); return; }
            if (!isImg && file.size > MAX_FILE) { bubble("That file is too big. Please use one under 8 MB.", "ai", "error"); return; }
            try {
                let dataUrl, type = file.type || "", outName = name;
                if (isImg && (file.size > 1.5 * 1024 * 1024 || !/^image\/(png|jpeg)$/.test(type))) {
                    dataUrl = await photoToJpeg(file); type = "image/jpeg"; outName = name.replace(/\.[a-z0-9]+$/i, "") + ".jpg";
                } else dataUrl = await readAsDataURL(file);
                const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
                if (data.length * 0.75 > MAX_FILE) { bubble("That file is too big. Please use one under 8 MB.", "ai", "error"); return; }
                state.file = { name: outName, type: type || (/\.pdf$/i.test(name) ? "application/pdf" : ""), data };
                showAttached();
                input.focus();
            } catch {
                bubble("Planora couldn't open that file on this device. Try a PDF or a JPG photo.", "ai", "error");
            }
        }
        attachBtn.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", () => { takeFile(fileInput.files[0]); fileInput.value = ""; });
        // drop a file onto the box
        root.addEventListener("dragover", e => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); root.classList.add("sp-drop"); } });
        root.addEventListener("dragleave", e => { if (!root.contains(e.relatedTarget)) root.classList.remove("sp-drop"); });
        root.addEventListener("drop", e => { if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); root.classList.remove("sp-drop"); takeFile(e.dataTransfer.files[0]); } });

        async function sendDoc(message) {
            const f = state.file;
            if (!f || state.busy) return;
            exampleRow.hidden = true;
            clearBtn.hidden = false;
            bubble(`<span class="sp-file-chip in-bubble"><i class="ti ${fileIcon(f.name)}" aria-hidden="true"></i><span class="n">${esc(f.name)}</span></span>${message ? "<br>" + esc(message) : ""}`, "me");
            input.value = ""; autoGrow();
            state.file = null; showAttached();
            setBusy(true);
            const thinking = bubble(`<span class="sp-dots" aria-label="Planora is reading your document"><i></i><i></i><i></i></span> <span class="sp-reading">Reading ${esc(f.name)}…</span>`, "ai", "thinking");
            try {
                const response = await fetch("/api/plan-from-doc", {
                    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ file: f, message, today: PlanoraCore.today(), now: PlanoraCore.nowClock(),
                        context: PlanoraCore.aiContext(), existing: PlanoraCore.busySlots ? PlanoraCore.busySlots() : [] })
                });
                const data = await response.json().catch(() => ({}));
                thinking.remove();
                if (response.status === 401) { bubble("Your session has ended. Please sign in again.", "ai", "error"); setTimeout(() => location.replace("index.html"), 1500); return; }
                if (!response.ok) { bubble(esc(data.error || "Planora couldn't read that document right now. Please try again."), "ai", "error"); return; }
                state.history.push({ role: "user", text: `[document: ${f.name}] ${message}` }, { role: "assistant", text: data.reply || "" });
                bubble(rich(data.reply || ""), "ai");
                const hasPlan = (data.tasks || []).length || (data.goals || []).length || (data.events || []).length;
                if (hasPlan) {
                    const plan = {
                        tasks: (data.tasks || []).concat((data.events || []).map(e => ({ ...e, type: "event", eventNotes: e.notes && !/^No time given/.test(e.notes) ? e.notes : "" }))),
                        goals: data.goals || [], updates: []
                    };
                    showReview(plan, "Plan from your document");
                }
            } catch {
                thinking.remove();
                bubble("Planora couldn't read that document right now. Your existing tasks are safe. Please try again.", "ai", "error");
            } finally {
                setBusy(false);
            }
        }

        // "What should I do now?" → one task, short reasons, Start
        function suggestionCard(sg) {
            const task = PlanoraCore.getTasks().find(t => String(t.id) === String(sg.taskId));
            const el = document.createElement("div");
            el.className = "sp-now";
            if (!task) return el;
            el.innerHTML = `
                <ul class="sp-now-why">${(sg.reasons || []).map(r => `<li>${esc(r)}</li>`).join("")}</ul>
                <div class="sp-now-actions">
                    <button type="button" class="btn-primary" data-now-start><i class="ti ti-player-play" aria-hidden="true"></i> Start ${PlanoraCore.durLabel(sg.minutes || PlanoraCore.taskDuration(task))}</button>
                    <button type="button" class="btn-secondary" data-now-open>Options</button>
                </div>`;
            el.querySelector("[data-now-start]").onclick = () => window.PlanoraFocus && PlanoraFocus.start(task.id, sg.minutes);
            el.querySelector("[data-now-open]").onclick = () => PlanoraCore.openTaskSheet(task.id);
            return el;
        }

        function actionRow(actions, opts) {
            const el = document.createElement("div");
            el.className = "sp-after";
            actions.forEach(a => {
                const b = document.createElement("button");
                b.type = "button";
                b.className = "sp-action";
                b.textContent = a.label;
                b.onclick = () => {
                    if (a.send) send(a.send);
                    else if (a.start && window.PlanoraFocus) PlanoraFocus.start(a.start);
                    else if (a.planGoal) { const g = PlanoraCore.getGoal(a.planGoal); if (g) planForGoal(g); }
                    else if (a.openTool) {
                        if (typeof window.switchPlannerTab === "function") window.switchPlannerTab(a.openTool);
                        else location.href = "planner.html#" + a.openTool;
                    }
                };
                el.appendChild(b);
            });
            return el;
        }

        function reset() {
            closeReview();
            state.history = [];
            state.recent = [];
            log.innerHTML = "";
            log.hidden = true;
            exampleRow.hidden = false;
            clearBtn.hidden = true;
            input.focus();
        }

        function autoGrow() {
            input.style.height = "auto";
            input.style.height = Math.min(160, input.scrollHeight) + "px";
        }

        // Show a plan made elsewhere (planners, recommendations) in this box
        function showPlan(plan, reply, heading) {
            exampleRow.hidden = true;
            clearBtn.hidden = false;
            if (reply) bubble(rich(reply), "ai");
            showReview(plan, heading || "Suggested plan");
            root.scrollIntoView({ behavior: "smooth", block: "start" });
        }

        function planForGoal(goal) {
            root.scrollIntoView({ behavior: "smooth", block: "start" });
            send(`Plan practice sessions for my goal "${goal.title}"${goal.date ? " by " + PlanoraCore.shortDate(goal.date) : ""}`, {
                attachGoal: { id: goal.id, title: goal.title, date: goal.date || null }
            });
        }

        root.querySelector(".sp-input-row").addEventListener("submit", e => { e.preventDefault(); send(); });
        // 🎤 speak instead of typing: when you stop talking it's sent (you still review the plan before anything changes)
        if (PlanoraCore.attachMic) PlanoraCore.attachMic(input, {
            label: "Speak to Planora",
            place: btn => sendBtn.before(btn),
            onFinal: text => { if (text && !state.busy) send(); }
        });
        input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
        input.addEventListener("input", autoGrow);
        input.addEventListener("focus", () => document.body.classList.add("sp-typing"));
        input.addEventListener("blur", () => document.body.classList.remove("sp-typing"));
        exampleRow.querySelectorAll(".sp-example").forEach(b => b.addEventListener("click", () => send(b.textContent)));
        clearBtn.addEventListener("click", reset);

        return { send, reset, showPlan, planForGoal, fill: (t) => { input.value = t; autoGrow(); input.focus(); } };
    }

    let uidSuffix = 1;

    function init() {
        document.querySelectorAll("[data-smart-planner]").forEach((el, i) => {
            if (el._smartPlanner) return;
            el._smartPlanner = SmartPlanner(el);
            if (i === 0) window.PlanoraAsk = el._smartPlanner;
        });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();

})();
