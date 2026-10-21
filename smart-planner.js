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

    /* ---------- 🔊 Planora's spoken replies ----------
       Off by default (Voice on/off at the top of Ask Planora, remembered on this device).
       1st choice: Planora's own voice (warm, upbeat, female) made on Planora's server.
       Backup: the best female voice built into the phone / browser. */
    const Voice = (() => {
        const synth = window.speechSynthesis;
        const hasSynth = Boolean(synth && window.SpeechSynthesisUtterance);
        const KEY = "planora_voice_replies";
        const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
        let audio = null, voice = null, primed = false, busy = null, serverOffUntil = 0;
        const lang = () => (document.documentElement.lang && document.documentElement.lang.length > 2 ? document.documentElement.lang : (navigator.language || "en-US"));
        const FEMALE = /female|samantha|karen|moira|tessa|serena|ava|allison|susan|victoria|zira|aria|jenny|sonia|libby|natasha|hazel|catherine|joanna|salli|kendra|kimberly|ivy|emma|amy|google us english|google uk english female/i;
        const MALE = /\bmale\b|daniel|alex\b|fred|arthur|oliver|george|guy|ryan|david|mark|james|thomas|aaron|rishi/i;
        function pick() {
            if (!hasSynth) return null;
            const all = synth.getVoices() || [];
            if (!all.length) return null;
            const base = lang().toLowerCase().slice(0, 2);
            const mine = all.filter(v => (v.lang || "").toLowerCase().startsWith(base));
            const pool = mine.length ? mine : all;
            const nice = v => /natural|neural|premium|enhanced|google/i.test(v.name);
            const fem = pool.filter(v => FEMALE.test(v.name) && !MALE.test(v.name.replace(/female/i, "")));
            return fem.find(nice) || fem[0] || pool.find(v => !MALE.test(v.name) && nice(v)) || pool.find(v => !MALE.test(v.name)) || pool[0];
        }
        if (hasSynth) { voice = pick(); synth.addEventListener && synth.addEventListener("voiceschanged", () => { voice = pick(); }); }
        const plain = t => String(t || "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\*\*(.+?)\*\*/g, "$1")
            .replace(/[→←↔]/g, " to ")
            .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
            .replace(/\s+/g, " ").trim();
        function deviceSpeak(say, finish) {
            if (!hasSynth) { finish(); return; }
            const u = new SpeechSynthesisUtterance(say);
            if (!voice) voice = pick();
            if (voice) u.voice = voice;
            u.lang = (voice && voice.lang) || lang();
            u.rate = 1.06; u.pitch = 1.12;          // a little brighter and livelier
            u.onend = finish; u.onerror = finish;
            busy.utter = u;
            try { synth.speak(u); } catch { finish(); }
        }
        return {
            supported: hasSynth || typeof Audio !== "undefined",
            enabled() { try { return localStorage.getItem(KEY) === "on"; } catch { return false; } },
            setEnabled(on) { try { localStorage.setItem(KEY, on ? "on" : "off"); } catch {} if (!on) this.stop(); },
            // inside the tap that starts the mic: unlock sound so phones let Planora speak a moment later
            prime() {
                if (primed) return; primed = true;
                try { audio = audio || new Audio(); audio.src = SILENT; const p = audio.play(); if (p && p.catch) p.catch(() => {}); } catch {}
                if (hasSynth) { try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; synth.speak(u); } catch {} }
            },
            speaking() { return Boolean(busy); },
            async speak(text, { onend } = {}) {
                this.stop();
                const say = plain(text);
                if (!say) { if (onend) onend(); return; }
                const me = busy = { ctrl: null, utter: null };
                let done = false;
                const finish = () => { if (done) return; done = true; if (busy === me) busy = null; if (onend) onend(); };
                me.finish = finish;
                if (Date.now() > serverOffUntil) {
                    try {
                        me.ctrl = new AbortController();
                        const t = setTimeout(() => me.ctrl.abort(), 12000);
                        const r = await fetch("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: say }), signal: me.ctrl.signal });
                        clearTimeout(t);
                        if (busy !== me) return;                                  // stopped while loading
                        if (!r.ok) { serverOffUntil = Date.now() + (r.status === 429 ? 10 * 60e3 : r.status === 503 ? 60 * 60e3 : 60e3); throw new Error("voice " + r.status); }
                        const url = URL.createObjectURL(await r.blob());
                        if (busy !== me) { URL.revokeObjectURL(url); return; }
                        audio = audio || new Audio();
                        audio.onended = audio.onerror = () => { URL.revokeObjectURL(url); finish(); };
                        audio.src = url;
                        await audio.play();
                        return;
                    } catch (e) {
                        if (busy !== me) return;                                  // stopped on purpose
                    }
                }
                deviceSpeak(say, finish);                                          // backup: the device's own voice
            },
            stop() {
                const b = busy; busy = null;
                if (b && b.ctrl) { try { b.ctrl.abort(); } catch {} }
                if (audio) { try { audio.onended = audio.onerror = null; audio.pause(); } catch {} }
                if (hasSynth) { try { if (b && b.utter) b.utter.onend = b.utter.onerror = null; synth.cancel(); } catch {} }
            }
        };
    })();
    window.PlanoraVoice = Voice;
    window.addEventListener("pagehide", () => Voice.stop());

    function esc(t) { return PlanoraCore.esc(t); }
    function rich(t) { return esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"); }
    // Light markdown for Ask Planora replies: tables, bullets, numbered lists, bold, paragraphs (escaped first)
    function md(text) {
        const inline = t => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
        const cells = l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
        const lines = String(text || "").replace(/\r/g, "").split("\n");
        const out = [];
        for (let i = 0; i < lines.length;) {
            const l = lines[i];
            if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
                const head = cells(l); i += 2;
                const rows = [];
                while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
                out.push(`<div class="sp-table-wrap"><table class="sp-table"><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${head.map((_, k) => `<td>${inline(r[k] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
                continue;
            }
            if (/^\s*([-*•])\s+/.test(l)) {
                const items = [];
                while (i < lines.length && /^\s*([-*•])\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*•])\s+/, "")); i++; }
                out.push(`<ul>${items.map(x => `<li>${inline(x)}</li>`).join("")}</ul>`);
                continue;
            }
            if (/^\s*\d+[.)]\s+/.test(l)) {
                const items = [];
                while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, "")); i++; }
                out.push(`<ol>${items.map(x => `<li>${inline(x)}</li>`).join("")}</ol>`);
                continue;
            }
            if (!l.trim()) { i++; continue; }
            const para = [];
            while (i < lines.length && lines[i].trim() && !/^\s*\|/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) { para.push(inline(lines[i].replace(/^#+\s*/, ""))); i++; }
            out.push(`<p>${para.join("<br>")}</p>`);
        }
        return out.join("");
    }

    function SmartPlanner(root) {
        const placeholder = root.dataset.placeholder || "Ask AI to plan your day";
        const examples = root.dataset.examples ? root.dataset.examples.split("|") : EXAMPLES;
        const state = { history: [], plan: null, review: null, busy: false, recent: [], lastMessage: "", attachGoal: null, file: null, convo: false };

        root.classList.add("sp-root");
        root.innerHTML = `
            <div class="sp-head">
                <div class="sp-title"><i class="ti ti-sparkles" aria-hidden="true"></i><span>${esc(root.dataset.title || "Ask Planora")}</span></div>
                <span class="sp-head-tools">
                    <button type="button" class="sp-voice-toggle" hidden aria-pressed="true" title="Spoken replies when you talk to Planora"><i class="ti ti-volume" aria-hidden="true"></i><span class="sp-vt-label">Voice on</span></button>
                    <button type="button" class="sp-clear" hidden title="Start a new chat (Planora forgets this conversation)"><i class="ti ti-message-plus" aria-hidden="true"></i> New chat</button>
                </span>
            </div>
            <form class="sp-input-row">
                <label class="sr-only" for="sp-input-${uidSuffix}">${esc(placeholder)}</label>
                <textarea class="sp-input" id="sp-input-${uidSuffix}" rows="1" enterkeyhint="send" placeholder="${esc(placeholder)}"></textarea>
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
                    const b = bubble("No problem. Nothing was changed.", "ai");
                    if (state.convo) talk(b, "No problem, nothing was changed. Anything else?");
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
                    if (state.convo) talk(log.lastElementChild, `Done! ${PlanoraCore.summariseResult(result)} Anything else?`);
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
                        ...(PlanoraCore.labelContext ? PlanoraCore.labelContext() : {}), routine: PlanoraCore.routine ? PlanoraCore.routine() : [],
                        attachGoal: opts.attachGoal || null,
                        ...(PlanoraCore.coachExtras ? PlanoraCore.coachExtras() : {})
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
                const reply = bubble(md(data.reply || (hasPlan ? "Here's what I suggest." : "I'm not sure how to help with that yet.")), "ai", "sp-md");
                if (data.suggestion) reply.appendChild(suggestionCard(data.suggestion));
                if ((data.actions || []).length) reply.appendChild(actionRow(data.actions, opts));
                log.scrollTop = log.scrollHeight;
                if (state.convo) {
                    const words = data.spoken ? data.spoken + (hasPlan && !/add it|save it|want me to/i.test(data.spoken) ? " Say add it to save it, or tell me what to change." : "")
                        : (data.reply || (hasPlan ? "Here's what I suggest." : "I'm not sure how to help with that yet.")).replace(/^\|.*$/gm, "")
                          + (hasPlan ? " It's in the preview. Say add it to save it, or tell me what to change." : "");
                    talk(reply, words);
                }

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
                if (state.convo) { state.convo = false; talk(el, "Sorry, I couldn't do that right now. Please try again in a moment.", { listen: false }); }
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
            syncSend();
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
                        context: PlanoraCore.aiContext(), existing: PlanoraCore.busySlots ? PlanoraCore.busySlots() : [],
                        ...(PlanoraCore.labelContext ? PlanoraCore.labelContext() : {}), routine: PlanoraCore.routine ? PlanoraCore.routine() : [] })
                });
                const data = await response.json().catch(() => ({}));
                thinking.remove();
                if (response.status === 401) { bubble("Your session has ended. Please sign in again.", "ai", "error"); setTimeout(() => location.replace("index.html"), 1500); return; }
                if (!response.ok) { bubble(esc(data.error || "Planora couldn't read that document right now. Please try again."), "ai", "error"); return; }
                state.history.push({ role: "user", text: `[document: ${f.name}] ${message}` }, { role: "assistant", text: data.reply || "" });
                bubble(md(data.reply || ""), "ai", "sp-md");
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

        function reset({ forget = false } = {}) {
            closeReview();
            if (forget) fetch("/api/coach/history", { method: "DELETE" }).catch(() => {});
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
            syncSend();
        }
        // send looks inactive until there's something to send (text or an attached file)
        function syncSend() {
            const empty = !input.value.trim() && !state.file;
            sendBtn.classList.toggle("is-empty", empty);
            sendBtn.setAttribute("aria-disabled", String(empty));
        }

        // Show a plan made elsewhere (planners, recommendations) in this box
        function showPlan(plan, reply, heading) {
            exampleRow.hidden = true;
            clearBtn.hidden = false;
            if (reply) bubble(md(reply), "ai", "sp-md");
            showReview(plan, heading || "Suggested plan");
            root.scrollIntoView({ behavior: "smooth", block: "start" });
        }

        function planForGoal(goal) {
            root.scrollIntoView({ behavior: "smooth", block: "start" });
            send(`Plan practice sessions for my goal "${goal.title}"${goal.date ? " by " + PlanoraCore.shortDate(goal.date) : ""}`, {
                attachGoal: { id: goal.id, title: goal.title, date: goal.date || null }
            });
        }

        root.querySelector(".sp-input-row").addEventListener("submit", e => { e.preventDefault(); if (state.convo) endConvo(); send(); });
        /* ---------- 🎤 voice chat ----------
           Talk to Planora → the reply shows as text AND is read aloud → the mic opens again for your answer
           ("add it", "move it to 7pm", "that's all"). Typing, tapping stop, or silence ends the voice chat.
           Nothing is ever added without the preview being confirmed (by tap or by saying "add it"). */
        const voiceToggle = $(".sp-voice-toggle");
        let micBtn = null;
        const visible = () => root.offsetParent !== null && !document.hidden;
        function syncVoiceToggle() {
            if (!voiceToggle) return;
            const on = Voice.enabled();
            voiceToggle.hidden = !Voice.supported;
            voiceToggle.setAttribute("aria-pressed", String(on));
            voiceToggle.setAttribute("aria-label", on ? "Spoken replies are on. Turn off" : "Spoken replies are off. Turn on");
            voiceToggle.querySelector("i").className = "ti " + (on ? "ti-volume" : "ti-volume-off");
            voiceToggle.querySelector(".sp-vt-label").textContent = on ? "Voice on" : "Voice off";
        }
        if (voiceToggle) voiceToggle.addEventListener("click", () => {
            const on = !Voice.enabled();
            Voice.setEnabled(on);
            root.querySelectorAll(".sp-bubble.is-speaking").forEach(b => b.classList.remove("is-speaking"));
            syncVoiceToggle();
            if (on) { Voice.prime(); Voice.speak("Hi! Voice is on. Tap the mic and tell me what you need to do."); }
            else endConvo();
            PlanoraCore.toast(on ? "Voice replies on: tap the mic and talk to Planora." : "Voice replies off.");
        });
        function endConvo() {
            state.convo = false;
            Voice.stop();
            root.classList.remove("sp-convo");
            root.querySelectorAll(".sp-bubble.is-speaking").forEach(b => b.classList.remove("is-speaking"));
        }
        // read a reply aloud, then (still in voice chat) listen for the answer
        function talk(bubbleEl, text, { listen = true } = {}) {
            if (!Voice.enabled()) { endConvo(); return; }
            if (bubbleEl) {
                bubbleEl.classList.add("is-speaking");
                if (!bubbleEl.querySelector(".sp-stop-voice")) {
                    const b = document.createElement("button");
                    b.type = "button"; b.className = "sp-stop-voice";
                    b.innerHTML = '<i class="ti ti-player-stop-filled" aria-hidden="true"></i> Stop';
                    b.setAttribute("aria-label", "Stop speaking");
                    b.onclick = () => endConvo();
                    bubbleEl.appendChild(b);
                }
            }
            Voice.speak(text, {
                onend: () => {
                    if (bubbleEl) bubbleEl.classList.remove("is-speaking");
                    if (listen && state.convo) listenAgain();
                }
            });
        }
        function listenAgain() {
            if (!state.convo || state.busy || !micBtn || !visible()) { if (!visible()) endConvo(); return; }
            setTimeout(() => { if (state.convo && !micBtn.classList.contains("listening") && visible()) micBtn.click(); }, 250);
        }
        const SAY_YES = /^(yes|yeah|yep|yup|ok(ay)?|sure|add( it| them| that| those)?|save( it| them)?|confirm|do it|go ahead|sounds good|looks good|perfect|great|that'?s (good|fine|perfect))[\s.!]*(please|thanks|thank you)?[\s.!]*$/i;
        const SAY_NO = /^(no|nope|cancel|discard|never ?mind|scrap (it|that)|don'?t (add|save) (it|them))[\s.!]*$/i;
        const SAY_BYE = /^(stop|that'?s (all|it)|nothing( else)?|no thanks?( you)?|thanks?( you)?|bye|goodbye|i'?m done|done)[\s.!]*$/i;
        function handleSpoken(text) {
            const t = text.trim();
            if (state.review && SAY_YES.test(t)) {
                const b = reviewEl.querySelector('[data-act="approve"]:not([disabled])');
                if (b) { bubble(esc(t), "me"); input.value = ""; autoGrow(); b.click(); return; }
            }
            if (state.review && SAY_NO.test(t)) {
                const b = reviewEl.querySelector('[data-act="discard"]');
                if (b) { bubble(esc(t), "me"); input.value = ""; autoGrow(); b.click(); return; }
            }
            if (SAY_BYE.test(t) && log.children.length) {
                bubble(esc(t), "me");
                input.value = ""; autoGrow();
                const b = bubble("Okay! I'm here whenever you need me.", "ai");
                talk(b, "Okay! I'm here whenever you need me.", { listen: false });
                state.convo = false; root.classList.remove("sp-convo");
                return;
            }
            send();
        }
        if (PlanoraCore.attachMic) micBtn = PlanoraCore.attachMic(input, {
            label: "Speak to Planora",
            place: btn => sendBtn.before(btn),
            quiet: () => state.convo,
            onStart: () => {
                Voice.stop();                                   // never talk over the person
                Voice.prime();
                root.querySelectorAll(".sp-bubble.is-speaking").forEach(b => b.classList.remove("is-speaking"));
            },
            onFinal: text => {
                if (!text || state.busy) return;
                state.convo = Voice.supported && Voice.enabled();
                root.classList.add("sp-voice-used");
                root.classList.toggle("sp-convo", state.convo);
                syncVoiceToggle();
                handleSpoken(text);
            },
            onEmpty: () => { if (state.convo) endConvo(); }   // silence or tapping stop ends the voice chat
        });
        syncVoiceToggle();
        // the conversation continues: show the last few remembered messages
        (async () => {
            if (root.dataset.history === "off") return;
            try {
                const r = await fetch("/api/coach/history");
                if (!r.ok) return;
                const h = await r.json();
                const msgs = (h.messages || []).slice(-6);
                if (!msgs.length || log.children.length) return;
                exampleRow.hidden = true; clearBtn.hidden = false;
                const mark = document.createElement("p"); mark.className = "sp-earlier"; mark.textContent = "Earlier";
                log.hidden = false; log.appendChild(mark);
                msgs.forEach(m => bubble(m.role === "assistant" ? md(m.text) : esc(m.text), m.role === "assistant" ? "ai" : "me", m.role === "assistant" ? "sp-md is-old" : "is-old"));
                state.history = msgs.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", text: String(m.text || "").slice(0, 800) }));
                log.scrollTop = log.scrollHeight;
            } catch {}
        })();
        // typing means you've switched to the keyboard
        input.addEventListener("keydown", e => { if (state.convo && e.key.length === 1) endConvo(); });
        document.addEventListener("visibilitychange", () => { if (document.hidden) endConvo(); });
        input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (state.convo) endConvo(); send(); } });
        input.addEventListener("input", autoGrow);
        syncSend();
        input.addEventListener("focus", () => document.body.classList.add("sp-typing"));
        input.addEventListener("blur", () => document.body.classList.remove("sp-typing"));
        exampleRow.querySelectorAll(".sp-example").forEach(b => b.addEventListener("click", () => send(b.textContent)));
        clearBtn.addEventListener("click", () => { endConvo(); reset({ forget: true }); PlanoraCore.toast("New chat started. Planora has forgotten the earlier conversation."); });

        return { send, reset, showPlan, planForGoal, stopVoice: endConvo, fill: (t) => { input.value = t; autoGrow(); input.focus(); } };
    }

    let uidSuffix = 1;

    function init() {
        document.querySelectorAll("[data-smart-planner]").forEach((el, i) => {
            if (el._smartPlanner) return;
            el._smartPlanner = SmartPlanner(el);
            // the main Ask Planora box (data-primary, or the first one) is the one other parts of the app talk to
            if (el.hasAttribute("data-primary") || !window.PlanoraAsk) window.PlanoraAsk = el._smartPlanner;
        });
    }

    // other pages (Calendar's "Plan with AI") can open an Ask box in a sheet
    window.PlanoraSmartPlanner = { mount: el => { if (!el) return null; if (!el._smartPlanner) el._smartPlanner = SmartPlanner(el); return el._smartPlanner; } };

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();

})();
