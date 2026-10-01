/* =========================================================
   PLANORA JOURNAL ↔ PLANNING  (journal-link.js)

   Keeps the Journal calm (no new cards). Two small links:
   1. journal.html?review=1 (from Today's review): opens today's
      entry with the prompt "What went well today?".
   2. After you save today's entry, Planora may offer ONE practical
      adjustment when it's clearly useful (at most once a day):
      - trouble focusing  → shorter focus sessions tomorrow
      - lots on your plate → move tomorrow's least urgent task later
      No sensitive inferences, no medical or psychological claims.
   ========================================================= */

(function () {

    const OFFER_KEY = "planora_journal_offer";   // { date } — once per day
    const C = () => window.PlanoraCore;

    function reviewPrompt() {
        if (!new URLSearchParams(location.search).has("review")) return;
        const box = document.getElementById("journalContent");
        if (!box) return;
        const r = C().reviewStats();
        box.placeholder = "What went well today? What would you do differently tomorrow?";
        const note = document.createElement("p");
        note.className = "journal-review-note";
        note.textContent = r.total
            ? `Today: ${r.done.length} of ${r.total} tasks done${r.minutes ? ` · ${C().durLabel(r.minutes)} of work` : ""}. What went well today?`
            : "What went well today?";
        box.parentElement.insertBefore(note, box);
        setTimeout(() => box.focus(), 300);
    }

    function offeredToday() {
        const o = C().loadJSON(OFFER_KEY, null);
        return o && o.date === C().today();
    }

    function todaysText() {
        const ids = ["journalContent", "eveningReflection", "morningReflection", "brainDump"];
        return ids.map(id => (document.getElementById(id) || {}).value || "").join(" ");
    }

    const FOCUS = /\b(couldn'?t|could not|can'?t|cannot|hard to|struggl\w* to|unable to|didn'?t)\s+(really\s+)?(focus|concentrate)\b|\b(so|really|very|kept getting)\s+distracted\b|\bprocrastinat\w*/i;
    const SWAMPED = /\b(overwhelm\w*|too much to do|so much to do|swamped|drowning in (work|tasks|deadlines)|way too busy)\b/i;

    function maybeOffer() {
        if (offeredToday()) return;
        if (typeof currentDate !== "undefined" && currentDate !== C().today()) return;
        const text = todaysText();
        if (FOCUS.test(text)) return offerShorterSessions();
        if (SWAMPED.test(text)) return offerLighterTomorrow();
    }

    function remember() { C().saveJSON(OFFER_KEY, { date: C().today() }); }

    function offerShorterSessions() {
        remember();
        const tomorrow = C().addDays(C().today(), 1);
        C().openSheet({
            title: "A small adjustment?",
            icon: "ti-sparkles",
            body: `
                <p class="auth-sheet-info">You mentioned having trouble focusing today. Would you like shorter focus sessions tomorrow?</p>
                <p class="pl-hint">Focus Mode will use 25-minute sessions tomorrow. Your tasks stay where they are.</p>
                <div class="pl-row-actions">
                    <button type="button" class="btn-secondary" data-no>No thanks</button>
                    <button type="button" class="btn-primary" data-yes>Yes, adjust tomorrow</button>
                </div>`,
            onReady(panel) {
                panel.querySelector("[data-no]").onclick = () => C().closeSheet();
                panel.querySelector("[data-yes]").onclick = async () => {
                    try {
                        await PlanoraAuth.updateProfile({ prefs: { shortSessionsDate: tomorrow } });
                        C().closeSheet();
                        C().toast("Done. Tomorrow's focus sessions will be 25 minutes.", "success");
                    } catch (e) { C().toast(e.message || "Couldn't save that right now.", "error"); }
                };
            }
        });
    }

    async function offerLighterTomorrow() {
        const core = C();
        const tomorrow = core.addDays(core.today(), 1);
        const list = core.getTasks().filter(t => t.date === tomorrow && core.isMovable(t));
        if (!list.length) return;
        remember();
        const ranked = window.PlanoraPriority ? PlanoraPriority.rank(list, core.priorityCtx()) : list;
        const drop = ranked[ranked.length - 1];
        core.openSheet({
            title: "Lighten tomorrow?",
            icon: "ti-sparkles",
            body: `
                <p class="auth-sheet-info">It sounds like there's a lot on your plate. Want me to move "${core.esc(drop.title)}", your least urgent task tomorrow, to later in the week?</p>
                <div class="pl-row-actions">
                    <button type="button" class="btn-secondary" data-no>No thanks</button>
                    <button type="button" class="btn-primary" data-yes>Show me the change</button>
                </div>`,
            onReady(panel) {
                panel.querySelector("[data-no]").onclick = () => core.closeSheet();
                panel.querySelector("[data-yes]").onclick = async () => {
                    core.closeSheet();
                    try {
                        const target = core.addDays(tomorrow, 2);
                        const placed = await core.scheduleItems([{ title: drop.title, date: target, start: drop.start || "", duration: core.taskDuration(drop), flexible: true, sourceId: drop.id, deadline: drop.deadline || null }], { excludeIds: [drop.id] });
                        core.openPlanPreview({ tasks: [], goals: [], updates: placed.map(p => ({ id: p.sourceId, title: p.title, date: p.date, start: p.start, end: p.end, duration: p.duration, notes: p.notes, from: { date: drop.date, start: drop.start, end: drop.end } })) }, { title: "Lighten tomorrow", intro: "Nothing changes until you apply it." });
                    } catch (e) { core.toast("Planora couldn't do that right now. Your existing tasks are safe.", "error"); }
                };
            }
        });
    }

    function wrapSave() {
        if (typeof window.saveJournal !== "function" || window.saveJournal._planora) return;
        const orig = window.saveJournal;
        window.saveJournal = function (showMessage) {
            const r = orig.apply(this, arguments);
            if (showMessage !== false) setTimeout(maybeOffer, 600);
            return r;
        };
        window.saveJournal._planora = true;
    }

    function init() {
        if (!window.PlanoraCore) return;
        wrapSave();
        reviewPrompt();
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(init, 0));
    else setTimeout(init, 0);

})();
