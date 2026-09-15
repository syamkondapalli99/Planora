// ======================================================
// AI ASSISTANT (dashboard chat -> OpenAI -> plan review
// -> planora_tasks store)
//
// Relies on globals already defined in script.js:
//   loadTaskStore(), upsertTaskInStore(), formatTime(),
//   getDateString(), renderStoreTasksToDOM(),
//   generateWeekCalendar(), updateScheduleTitle(),
//   showTasksForDate(), renderHomeOverview(), selectedDate
// ======================================================

let aiPlanTasks = [];
let aiPlanEditing = false;


document.addEventListener("DOMContentLoaded", function () {

    const sendBtn = document.getElementById("ai-send-btn");
    const input = document.getElementById("ai-chat-input");
    const editBtn = document.getElementById("ai-plan-edit-btn");
    const okBtn = document.getElementById("ai-plan-ok-btn");

    if (!sendBtn || !input) return; // panel not on this page

    sendBtn.addEventListener("click", sendAIMessage);

    input.addEventListener("keydown", function (e) {

        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendAIMessage();
        }
    });

    if (editBtn) {

        editBtn.addEventListener("click", function () {

            aiPlanEditing = !aiPlanEditing;

            editBtn.textContent = aiPlanEditing ? "Done editing" : "Edit";

            renderAIPlanReview();
        });
    }

    if (okBtn) {
        okBtn.addEventListener("click", confirmAIPlan);
    }

});


// ======================================================
// SEND MESSAGE -> /api/plan
// ======================================================

async function sendAIMessage() {

    const input = document.getElementById("ai-chat-input");

    const message = input.value.trim();

    if (!message) return;

    addAIBubble(message, "user");

    input.value = "";

    const sendBtn = document.getElementById("ai-send-btn");

    if (sendBtn) sendBtn.disabled = true;

    const thinkingBubble = addAIBubble("Thinking...", "assistant");

    try {

        const response = await fetch("/api/plan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message,
                today: getDateString(new Date())
            })
        });

        const data = await response.json();

        thinkingBubble.remove();

        if (!response.ok) {

            addAIBubble(
                data.error || "Something went wrong.",
                "assistant error"
            );

            return;
        }

        if (!data.tasks || !Array.isArray(data.tasks) || data.tasks.length === 0) {

            addAIBubble(
                "I couldn't build a plan from that. Try adding a few more details.",
                "assistant error"
            );

            return;
        }

        aiPlanTasks = data.tasks;

        addAIBubble(
            `Here's a plan with ${aiPlanTasks.length} task${aiPlanTasks.length === 1 ? "" : "s"}. Review it below.`,
            "assistant"
        );

        aiPlanEditing = false;

        const editBtn = document.getElementById("ai-plan-edit-btn");

        if (editBtn) editBtn.textContent = "Edit";

        renderAIPlanReview();

    } catch (error) {

        console.error("Plan request failed:", error);

        thinkingBubble.remove();

        addAIBubble(
            "Could not reach the server. Is server.js running?",
            "assistant error"
        );

    } finally {

        if (sendBtn) sendBtn.disabled = false;
    }

}


// ======================================================
// CHAT BUBBLES
// ======================================================

function addAIBubble(text, type) {

    const log = document.getElementById("ai-chat-log");

    if (!log) return null;

    const bubble = document.createElement("div");

    bubble.className = `ai-bubble ${type}`;

    bubble.textContent = text;

    log.appendChild(bubble);

    log.scrollTop = log.scrollHeight;

    return bubble;
}


// ======================================================
// RENDER PLAN REVIEW
// ======================================================

function renderAIPlanReview() {

    const review = document.getElementById("ai-plan-review");

    const list = document.getElementById("ai-plan-tasks");

    if (!review || !list) return;

    review.style.display = "block";

    list.innerHTML = "";

    aiPlanTasks.forEach((task, index) => {

        const card = document.createElement("div");

        card.className = "ai-plan-task" + (aiPlanEditing ? " editing" : "");

        if (aiPlanEditing) {

            card.innerHTML = `
                <input type="text" data-field="title" value="${escapeAttr(task.title || "")}" placeholder="Task title">
                <input type="date" data-field="date" value="${escapeAttr(task.date || "")}">
                <input type="time" data-field="start" value="${escapeAttr(task.start || "")}">
                <input type="time" data-field="end" value="${escapeAttr(task.end || "")}">
            `;

            card.querySelectorAll("input").forEach((el) => {

                el.addEventListener("input", (e) => {
                    aiPlanTasks[index][e.target.dataset.field] = e.target.value;
                });
            });

        } else {

            const dateLabel = task.date ? formatDateDisplay(task.date) : "No date";

            const timeLabel =
                task.start && task.end
                    ? `${formatTime(task.start)} - ${formatTime(task.end)}`
                    : task.start
                        ? formatTime(task.start)
                        : "No time set";

            card.innerHTML = `
                <div class="title">${escapeHtmlLocal(task.title || "")}</div>
                <div class="meta">${dateLabel} · ${timeLabel}</div>
            `;
        }

        list.appendChild(card);

    });

}


// ======================================================
// CONFIRM PLAN -> WRITE INTO planora_tasks
// ======================================================

function confirmAIPlan() {

    if (aiPlanTasks.length === 0) return;

    aiPlanTasks.forEach((task) => {

        upsertTaskInStore({
            id: "ai-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
            title: task.title || "Untitled task",
            date: task.date || getDateString(new Date()),
            start: task.start || "",
            end: task.end || "",
            completed: false
        });
    });

    addAIBubble(
        `Added ${aiPlanTasks.length} task${aiPlanTasks.length === 1 ? "" : "s"} to your calendar.`,
        "assistant"
    );

    aiPlanTasks = [];

    const review = document.getElementById("ai-plan-review");

    if (review) review.style.display = "none";

    // Refresh the dashboard in place (functions already defined in script.js)
    if (typeof renderStoreTasksToDOM === "function") renderStoreTasksToDOM();
    if (typeof generateWeekCalendar === "function") generateWeekCalendar();
    if (typeof updateScheduleTitle === "function") updateScheduleTitle();
    if (typeof showTasksForDate === "function") showTasksForDate(selectedDate);
    if (typeof renderHomeOverview === "function") renderHomeOverview();

    // Then hand off to the calendar view, per the planned flow
    setTimeout(() => {
        window.location.href = "calendar.html";
    }, 600);

}


// ======================================================
// SMALL HELPERS
// ======================================================

function escapeHtmlLocal(text) {

    const div = document.createElement("div");

    div.textContent = text || "";

    return div.innerHTML;
}

function escapeAttr(text) {

    return String(text || "").replace(/"/g, "&quot;");
}