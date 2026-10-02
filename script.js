// ======================================================
// GLOBAL VARIABLES
// ======================================================

let currentStep = 1;
const totalSteps = 3;   // what to help with, productive time, you're ready

let currentTask = null;

let taskModalMode = "edit";

let currentWeekOffset = 0;

let selectedDate = null;

let calendarViewDate = new Date();

const TASK_STORE_KEY = "planora_tasks";


// ======================================================
// NAVIGATION
// ======================================================

// Handles the "Log in" button on index.html.
//
// There is no real backend authentication in this app (no
// account database, no server-side session). This mirrors
// the existing "Go to Dashboard" button on the same screen:
// it just checks that something was typed into both fields,
// then takes the person to the local/demo dashboard, the
// same way "Go to Dashboard" already does.
function handleLogin() {

    // Real sign-in (email + password) now lives in login.js.
    if (window.PlanoraLogin) {
        return window.PlanoraLogin.login();
    }

    const emailInput =
        document.querySelector("#login-screen input[type='email']");

    const passwordInput =
        document.querySelector("#login-screen input[type='password']");

    const email = emailInput ? emailInput.value.trim() : "";
    const password = passwordInput ? passwordInput.value : "";

    if (!email || !password) {
        alert("Please enter both an email and password to continue.");
        return;
    }

    location.href = "home.html";
}


function goTo(id) {

    document
        .querySelectorAll(".screen")
        .forEach(screen => {
            screen.classList.remove("active");
        });

    const screen =
        document.getElementById(id);

    if (screen) {
        screen.classList.add("active");
    }
}


// ======================================================
// ONBOARDING
// ======================================================

function renderProgress() {

    const bar =
        document.getElementById("progress-bar");

    if (!bar) return;

    bar.innerHTML = "";

    for (let i = 1; i <= totalSteps; i++) {

        const seg =
            document.createElement("div");

        seg.className =
            "seg" +
            (i <= currentStep ? " done" : "");

        bar.appendChild(seg);
    }
}


function showStep(step) {

    const steps =
        document.querySelectorAll(".onboard-step");

    if (steps.length === 0) return;

    steps.forEach(el => {
        el.style.display = "none";
    });

    const current =
        document.querySelector(
            `.onboard-step[data-step="${step}"]`
        );

    if (current) {
        current.style.display = "block";
    }

    const backBtn =
        document.getElementById("back-btn");

    const nextBtn =
        document.getElementById("next-btn");

    if (backBtn) {

        backBtn.style.display =
            step === 1 ? "none" : "flex";
    }

    if (nextBtn) {

        nextBtn.textContent =
            step === totalSteps
                ? "Let's go"
                : "Continue";
    }

    renderProgress();
}


function nextStep() {

    if (currentStep < totalSteps) {

        currentStep++;

        showStep(currentStep);

    } else if (window.PlanoraLogin) {

        // Save the onboarding answers to the account, then open the app
        window.PlanoraLogin.finishOnboarding();

    } else {

        goTo("dashboard-screen");
    }
}


function prevStep() {

    if (currentStep > 1) {

        currentStep--;

        showStep(currentStep);
    }
}


function selectOption(el) {

    el.parentElement
        .querySelectorAll(".option-card")
        .forEach(card => {
            card.classList.remove("selected");
        });

    el.classList.add("selected");

    el.parentElement
        .querySelectorAll(".option-card[role=radio]")
        .forEach(card => card.setAttribute("aria-checked", card === el ? "true" : "false"));
}


function toggleChip(el) {

    el.classList.toggle("selected");
}


// ======================================================
// TASK STORE (shared with calendar.html via localStorage)
// ======================================================

function loadTaskStore() {

    try {

        return JSON.parse(
            localStorage.getItem(TASK_STORE_KEY)
        ) || [];

    } catch (error) {

        console.error(
            "Could not load tasks:",
            error
        );

        return [];
    }
}


function saveTaskStore(tasks) {

    localStorage.setItem(
        TASK_STORE_KEY,
        JSON.stringify(tasks)
    );
}


function upsertTaskInStore(task) {

    const tasks =
        loadTaskStore();

    const index =
        tasks.findIndex(
            existing => String(existing.id) === String(task.id)
        );

    if (index !== -1) {

        tasks[index] = {
            ...tasks[index],
            ...task
        };

    } else {

        tasks.push(task);
    }

    saveTaskStore(tasks);
}


function removeTaskFromStore(id) {

    const tasks =
        loadTaskStore().filter(
            task => String(task.id) !== String(id)
        );

    saveTaskStore(tasks);
}


// Seeds a starter set of tasks (dated "today") the very first
// time the app is opened on this browser, so the dashboard and
// calendar always start from the exact same data.
function seedDefaultTasksIfEmpty() {

    const existing =
        loadTaskStore();

    // New accounts no longer get sample tasks: nothing should look like
    // activity unless the user created it. (Home shows "Let's build your
    // first day" instead.)
    return existing;

    const today =
        getDateString(new Date());

    const defaults = [

        {
            id: "seed-1",
            title: "Team standup",
            date: today,
            start: "09:00",
            end: "09:15",
            completed: false
        },

        {
            id: "seed-2",
            title: "Gym session",
            date: today,
            start: "18:00",
            end: "19:00",
            completed: false
        },

        {
            id: "seed-3",
            title: "Read 20 pages",
            date: today,
            start: "21:00",
            end: "21:30",
            completed: false
        }

    ];

    saveTaskStore(defaults);

    return defaults;
}


// ======================================================
// DATE HELPERS
// ======================================================

function getDateString(date) {

    return (
        date.getFullYear() +
        "-" +
        String(date.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(date.getDate()).padStart(2, "0")
    );
}


function formatDateDisplay(dateString) {

    if (!dateString) return "";

    const date =
        new Date(
            dateString + "T00:00:00"
        );

    if (isNaN(date.getTime())) {
        return "";
    }

    return (
        String(date.getDate()).padStart(2, "0") +
        "/" +
        String(date.getMonth() + 1).padStart(2, "0") +
        "/" +
        date.getFullYear()
    );
}


// ======================================================
// TIME
// ======================================================

function formatTime(time) {

    if (!time) return "";

    let [hour, minute] =
        time.split(":");

    hour =
        parseInt(hour, 10);

    const period =
        hour >= 12 ? "PM" : "AM";

    hour =
        hour % 12 || 12;

    return `${hour}:${minute} ${period}`;
}


function toMinutes(time) {

    if (!time) return 0;

    const [hour, minute] =
        time.split(":").map(Number);

    return hour * 60 + minute;
}


// ======================================================
// RENDER STORE TASKS INTO THE DOM
// ======================================================

function renderStoreTasksToDOM() {

    const tasks =
        loadTaskStore();

    const taskList =
        document.getElementById("task-list");

    const completedList =
        document.getElementById("completed-list");

    const completedSection =
        document.getElementById("completed-section");

    if (!taskList) return;

    // Full re-render from the store keeps the dashboard, the
    // calendar, and any edits/deletes made on either page in sync.
    taskList.innerHTML = "";

    if (completedList) {
        completedList.innerHTML = "";
    }

    tasks.forEach(task => {

        const item =
            createTaskElement(task);

        if (
            task.completed &&
            completedList
        ) {

            completedList.appendChild(item);

        } else {

            taskList.appendChild(item);
        }
    });

    if (
        completedSection &&
        completedList
    ) {

        completedSection.style.display =
            completedList.children.length > 0
                ? "block"
                : "none";
    }
}


// ======================================================
// CREATE TASK ELEMENT
// ======================================================

function createTaskElement(task) {

    const item =
        document.createElement("div");

    item.className =
        "task-item" +
        (task.completed ? " completed" : "");

    item.dataset.taskId =
        String(task.id);

    item.dataset.date =
        task.date || "";

    item.dataset.start =
        task.start || "";

    item.dataset.end =
        task.end || "";

    item.innerHTML = `

        <div>

            <p class="t-title"></p>

            <p class="t-time"></p>

        </div>

        <div class="task-actions">

            ${!task.completed && window.PlanoraFocus ? `<button
                type="button"
                class="task-start-btn"
                aria-label="Start ${String(task.title || "task").replace(/"/g, "&quot;")}">

                <i class="ti ti-player-play"></i>

            </button>` : ""}

            <button
                class="task-edit-btn"
                onclick="openEditModal(this)"
                aria-label="Edit task">

                <i class="ti ti-edit"></i>

            </button>

            <button
                class="task-check-btn"
                onclick="toggleTaskComplete(this)"
                aria-label="Complete task">

                <i class="ti ti-check"></i>

            </button>

        </div>
    `;

    item.querySelector(".t-title")
        .textContent =
        task.title || "";

    // Start: opens the Focus timer for this task
    const startBtn = item.querySelector(".task-start-btn");
    if (startBtn) startBtn.addEventListener("click", e => {
        e.stopPropagation();
        window.PlanoraFocus.start(task.id);
    });

    // Tap the task's name for Start · Reschedule · Delete (keeps the original box look)
    const info = item.firstElementChild;
    if (info && window.PlanoraCore && PlanoraCore.openTaskSheet) {
        info.classList.add("task-open");
        info.setAttribute("role", "button");
        info.tabIndex = 0;
        info.setAttribute("aria-label", (task.title || "Task") + ": start, reschedule or delete");
        info.addEventListener("click", () => PlanoraCore.openTaskSheet(task.id));
        info.addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); PlanoraCore.openTaskSheet(task.id); }
        });
    }

    // Repeating tasks show a small repeat icon
    if (task.seriesId) {
        const rep = document.createElement("i");
        rep.className = "ti ti-repeat t-repeat";
        rep.setAttribute("aria-label", "Repeats");
        item.querySelector(".t-title").appendChild(rep);
    }

    // Goal / study sessions show which goal they belong to
    if (task.goalId && window.PlanoraCore) {
        const goalName = window.PlanoraCore.goalTitle(task.goalId);
        if (goalName) {
            const tag = document.createElement("p");
            tag.className = "t-goal";
            tag.innerHTML = '<i class="ti ti-target-arrow" aria-hidden="true"></i>';
            tag.appendChild(document.createTextNode(goalName));
            item.querySelector(".t-time").after(tag);
        }
    }

    // Colour: the goal's colour for goal tasks, otherwise the category's
    if (window.PlanoraCore && PlanoraCore.decorateTaskItem) PlanoraCore.decorateTaskItem(item, task);

    const timeElement =
        item.querySelector(".t-time");

    if (task.start && task.end) {

        timeElement.textContent =
            `${formatTime(task.start)} - ${formatTime(task.end)}`;

    } else if (task.start) {

        timeElement.textContent =
            formatTime(task.start);

    } else if (task.end) {

        timeElement.textContent =
            formatTime(task.end);

    } else {

        timeElement.textContent =
            "No time set";
    }

    return item;
}


// ======================================================
// ADD TASK MODAL
// ======================================================

function openAddTaskModal() {

    currentTask = null;

    taskModalMode = "add";

    const title =
        document.getElementById(
            "task-modal-title"
        );

    const submitButton =
        document.getElementById(
            "task-modal-submit-btn"
        );

    const deleteButton =
        document.getElementById(
            "task-modal-delete-btn"
        );

    if (title) {
        title.textContent = "Add Task";
    }

    if (submitButton) {
        submitButton.textContent = "Add Task";
    }

    if (deleteButton) {
        deleteButton.style.display = "none";
    }


    // Clear task name

    const titleInput =
        document.getElementById("edit-title");

    if (titleInput) {
        titleInput.value = "";
    }


    // Date

    const date =
        selectedDate ||
        getDateString(new Date());

    const dateInput =
        document.getElementById("edit-date");

    if (dateInput) {
        dateInput.value = date;
    }

    const dateDisplay =
        document.getElementById(
            "date-picker-display"
        );

    if (dateDisplay) {

        dateDisplay.textContent =
            formatDateDisplay(date);
    }


    // Time

    const startInput =
        document.getElementById("edit-start");

    const endInput =
        document.getElementById("edit-end");

    if (startInput) {
        startInput.value = "";
    }

    if (endInput) {
        endInput.value = "";
    }


    updateTimeDisplaySafe(
        "start-time-display",
        ""
    );

    updateTimeDisplaySafe(
        "end-time-display",
        ""
    );


    // Calendar month

    calendarViewDate =
        new Date(
            date + "T00:00:00"
        );


    closeDropdowns();


    const modal =
        document.getElementById("edit-modal");

    if (modal) {
        modal.style.display = "flex";
    }


    setTimeout(() => {

        titleInput?.focus();

    }, 100);
}


// ======================================================
// EDIT TASK
// ======================================================

function openEditModal(button) {

    currentTask =
        button.closest(".task-item");

    if (!currentTask) return;

    taskModalMode = "edit";


    const title =
        document.getElementById(
            "task-modal-title"
        );

    const submitButton =
        document.getElementById(
            "task-modal-submit-btn"
        );

    const deleteButton =
        document.getElementById(
            "task-modal-delete-btn"
        );

    if (title) {
        title.textContent = "Edit Task";
    }

    if (submitButton) {
        submitButton.textContent = "Save Changes";
    }

    if (deleteButton) {
        deleteButton.style.display = "flex";
    }


    const titleInput =
        document.getElementById("edit-title");

    const dateInput =
        document.getElementById("edit-date");

    const startInput =
        document.getElementById("edit-start");

    const endInput =
        document.getElementById("edit-end");


    if (titleInput) {

        titleInput.value =
            currentTask
                .querySelector(".t-title")
                ?.textContent
                .trim() || "";
    }


    if (dateInput) {

        dateInput.value =
            currentTask.dataset.date || "";
    }


    if (startInput) {

        startInput.value =
            currentTask.dataset.start || "";
    }


    if (endInput) {

        endInput.value =
            currentTask.dataset.end || "";
    }


    const dateDisplay =
        document.getElementById(
            "date-picker-display"
        );

    if (dateDisplay) {

        dateDisplay.textContent =
            formatDateDisplay(
                currentTask.dataset.date
            );
    }


    updateTimeDisplaySafe(
        "start-time-display",
        currentTask.dataset.start
    );

    updateTimeDisplaySafe(
        "end-time-display",
        currentTask.dataset.end
    );


    calendarViewDate =
        new Date(
            currentTask.dataset.date +
            "T00:00:00"
        );


    closeDropdowns();


    const modal =
        document.getElementById("edit-modal");

    if (modal) {
        modal.style.display = "flex";
    }
}


// ======================================================
// SAVE ADD / EDIT
// ======================================================

function saveEditModal() {

    const titleInput =
        document.getElementById("edit-title");

    const dateInput =
        document.getElementById("edit-date");

    const startInput =
        document.getElementById("edit-start");

    const endInput =
        document.getElementById("edit-end");


    const title =
        titleInput?.value.trim() || "";

    const date =
        dateInput?.value || "";

    const start =
        startInput?.value || "";

    const end =
        endInput?.value || "";


    if (!title) {

        alert("Please enter a task name.");

        titleInput?.focus();

        return;
    }


    if (!date) {

        alert("Please select a date.");

        return;
    }


    if (
        start &&
        end &&
        toMinutes(end) <= toMinutes(start)
    ) {

        alert(
            "End time must be later than start time."
        );

        return;
    }


    // ==================================================
    // ADD
    // ==================================================

    if (taskModalMode === "add") {

        const newTaskId =
            "t" + Date.now();

        const task = {

            id: newTaskId,

            title,

            date,

            start,

            end,

            completed: false

        };


        upsertTaskInStore(task);


        selectedDate =
            date;

        currentTask = null;


        renderStoreTasksToDOM();

        generateWeekCalendar();

        updateScheduleTitle();

        showTasksForDate(
            selectedDate
        );

        renderHomeOverview();


        closeEditModal();

        return;
    }


    // ==================================================
    // EDIT
    // ==================================================

    if (!currentTask) {

        closeEditModal();

        return;
    }


    const taskId =
        String(
            currentTask.dataset.taskId
        );


    const existingTasks =
        loadTaskStore();

    const existingTask =
        existingTasks.find(
            task =>
                String(task.id) === taskId
        );


    const completed =
        existingTask
            ? existingTask.completed
            : currentTask.classList.contains("completed");


    const updatedTask = {

        id: taskId,

        title,

        date,

        start,

        end,

        completed

    };


    upsertTaskInStore(
        updatedTask
    );


    selectedDate =
        date;


    renderStoreTasksToDOM();

    generateWeekCalendar();

    updateScheduleTitle();

    showTasksForDate(
        selectedDate
    );

    renderHomeOverview();

    closeEditModal();
}


// ======================================================
// DELETE TASK
// ======================================================

function deleteEditModalTask() {

    if (
        taskModalMode !== "edit" ||
        !currentTask
    ) {

        closeEditModal();

        return;
    }

    const confirmed =
        confirm(
            "Delete this task? This can't be undone."
        );

    if (!confirmed) return;

    const taskId =
        String(currentTask.dataset.taskId);

    removeTaskFromStore(taskId);

    currentTask = null;


    renderStoreTasksToDOM();

    generateWeekCalendar();

    updateScheduleTitle();

    showTasksForDate(
        selectedDate
    );

    renderHomeOverview();

    closeEditModal();
}


// ======================================================
// CLOSE MODAL
// ======================================================

function closeEditModal() {

    const modal =
        document.getElementById(
            "edit-modal"
        );

    if (modal) {
        modal.style.display = "none";
    }

    closeDropdowns();
}


// ======================================================
// CLOSE DROPDOWNS
// ======================================================

function closeDropdowns() {

    document
        .querySelectorAll(
            ".custom-calendar"
        )
        .forEach(el => {
            el.classList.remove("show");
        });

    document
        .querySelectorAll(
            ".custom-time-dropdown"
        )
        .forEach(el => {
            el.classList.remove("show");
        });

    document
        .querySelectorAll(
            ".custom-date-button, .custom-time-button"
        )
        .forEach(el => {
            el.classList.remove("active");
        });
}


// ======================================================
// COMPLETE TASK
// ======================================================

function toggleTaskComplete(button) {

    const item =
        button.closest(".task-item");

    if (!item) return;


    const completing =
        !item.classList.contains("completed");


    item.classList.toggle(
        "completed",
        completing
    );


    const completedList =
        document.getElementById(
            "completed-list"
        );

    const taskList =
        document.getElementById(
            "task-list"
        );

    const completedSection =
        document.getElementById(
            "completed-section"
        );


    if (completing) {

        if (completedList) {
            completedList.appendChild(item);
        }

    } else {

        if (taskList) {
            taskList.appendChild(item);
        }
    }


    if (
        completedSection &&
        completedList
    ) {

        completedSection.style.display =
            completedList.children.length > 0
                ? "block"
                : "none";
    }


    const taskId =
        String(item.dataset.taskId);


    upsertTaskInStore({

        id: taskId,

        completed: completing

    });


    showTasksForDate(
        selectedDate
    );

    renderHomeOverview();
}


// ======================================================
// WEEK CALENDAR
// ======================================================

function generateWeekCalendar() {

    const weekStrip =
        document.getElementById(
            "week-strip"
        );

    if (!weekStrip) return;


    const today =
        new Date();

    const todayString =
        getDateString(today);


    if (!selectedDate) {

        selectedDate =
            todayString;
    }


    const baseDate =
        new Date(today);


    const day =
        baseDate.getDay();


    const daysFromMonday =
        day === 0
            ? 6
            : day - 1;


    baseDate.setDate(
        baseDate.getDate() -
        daysFromMonday
    );


    baseDate.setDate(
        baseDate.getDate() +
        currentWeekOffset * 7
    );


    weekStrip.innerHTML = "";


    for (let i = 0; i < 7; i++) {

        const date =
            new Date(baseDate);

        date.setDate(
            baseDate.getDate() + i
        );


        const dateString =
            getDateString(date);


        const cell =
            document.createElement("div");

        cell.className =
            "day-cell";


        if (
            dateString === selectedDate
        ) {

            cell.classList.add(
                "today"
            );
        }


        cell.innerHTML = `

            <span class="dow">
                ${date.toLocaleDateString(
                    "en-US",
                    { weekday: "short" }
                )}
            </span>

            <span class="num">
                ${date.getDate()}
            </span>
        `;


        cell.dataset.date =
            dateString;


        cell.addEventListener(
            "click",
            function () {

                selectedDate =
                    this.dataset.date;

                generateWeekCalendar();

                showTasksForDate(
                    selectedDate
                );

                updateScheduleTitle();

                renderHomeOverview();
            }
        );


        weekStrip.appendChild(cell);
    }
}


// ======================================================
// CHANGE WEEK
// ======================================================

function changeWeek(direction) {

    currentWeekOffset +=
        direction;

    generateWeekCalendar();
}


// ======================================================
// SCHEDULE TITLE
// ======================================================

function updateScheduleTitle() {

    const title =
        document.getElementById(
            "schedule-title"
        );

    if (!title || !selectedDate) {
        return;
    }


    const date =
        new Date(
            selectedDate +
            "T00:00:00"
        );


    title.textContent =
        date.toLocaleDateString(
            "en-US",
            {
                weekday: "long",
                month: "short",
                day: "numeric"
            }
        );
}


// ======================================================
// SHOW TASKS FOR DATE
// ======================================================

function showTasksForDate(dateToShow) {

    if (!dateToShow) return;


    document
        .querySelectorAll(
            "#task-list .task-item"
        )
        .forEach(task => {

            task.style.display =
                task.dataset.date === dateToShow
                    ? "flex"
                    : "none";
        });


    document
        .querySelectorAll(
            "#completed-list .task-item"
        )
        .forEach(task => {

            task.style.display =
                task.dataset.date === dateToShow
                    ? "flex"
                    : "none";
        });
}


// ======================================================
// CUSTOM TIME PICKER
// ======================================================

function createCustomTimePicker(
    buttonId,
    dropdownId,
    displayId,
    inputId
) {

    const button =
        document.getElementById(buttonId);

    const dropdown =
        document.getElementById(dropdownId);

    const display =
        document.getElementById(displayId);

    const input =
        document.getElementById(inputId);


    if (
        !button ||
        !dropdown ||
        !display ||
        !input
    ) {
        return;
    }


    dropdown.innerHTML = "";


    for (
        let hour = 0;
        hour < 24;
        hour++
    ) {

        for (
            let minute = 0;
            minute < 60;
            minute += 30
        ) {

            const hour12 =
                hour % 12 || 12;

            const minuteText =
                String(minute)
                    .padStart(2, "0");

            const period =
                hour < 12
                    ? "AM"
                    : "PM";

            const displayTime =
                `${hour12}:${minuteText} ${period}`;

            const value =
                `${String(hour).padStart(2, "0")}:${minuteText}`;


            const option =
                document.createElement(
                    "button"
                );

            option.type =
                "button";

            option.className =
                "custom-time-option";

            option.textContent =
                displayTime;

            option.dataset.value =
                value;


            option.addEventListener(
                "click",
                function (event) {

                    event.stopPropagation();

                    input.value =
                        value;

                    display.textContent =
                        displayTime;


                    dropdown
                        .querySelectorAll(
                            ".custom-time-option"
                        )
                        .forEach(btn => {

                            btn.classList.remove(
                                "selected"
                            );
                        });


                    option.classList.add(
                        "selected"
                    );


                    dropdown.classList.remove(
                        "show"
                    );

                    button.classList.remove(
                        "active"
                    );
                }
            );


            dropdown.appendChild(
                option
            );
        }
    }


    button.addEventListener(
        "click",
        function (event) {

            event.stopPropagation();


            const currentlyOpen =
                dropdown.classList.contains(
                    "show"
                );


            closeDropdowns();


            if (!currentlyOpen) {

                dropdown.classList.add(
                    "show"
                );

                button.classList.add(
                    "active"
                );


                dropdown
                    .querySelectorAll(
                        ".custom-time-option"
                    )
                    .forEach(option => {

                        option.classList.toggle(
                            "selected",
                            option.dataset.value ===
                            input.value
                        );
                    });
            }
        }
    );
}


// ======================================================
// SAFE TIME DISPLAY
// ======================================================

function updateTimeDisplaySafe(
    displayId,
    time
) {

    const display =
        document.getElementById(
            displayId
        );

    if (!display) return;

    display.textContent =
        time
            ? formatTime(time)
            : "Select time";
}


// ======================================================
// DATE PICKER
// ======================================================

function setupDatePicker() {

    const dateButton =
        document.getElementById(
            "date-picker-button"
        );

    const customCalendar =
        document.getElementById(
            "custom-calendar"
        );

    if (!dateButton || !customCalendar) {
        return;
    }


    dateButton.addEventListener(
        "click",
        function (event) {

            event.stopPropagation();


            const open =
                customCalendar.classList.contains(
                    "show"
                );


            closeDropdowns();


            if (!open) {

                customCalendar.classList.add(
                    "show"
                );

                dateButton.classList.add(
                    "active"
                );

                renderCustomCalendar();
            }
        }
    );
}


// ======================================================
// RENDER DATE CALENDAR
// ======================================================

function renderCustomCalendar() {

    const daysContainer =
        document.getElementById(
            "calendar-days"
        );

    const monthLabel =
        document.getElementById(
            "calendar-month"
        );

    if (!daysContainer || !monthLabel) {
        return;
    }


    daysContainer.innerHTML = "";


    const year =
        calendarViewDate.getFullYear();

    const month =
        calendarViewDate.getMonth();


    monthLabel.textContent =
        calendarViewDate.toLocaleDateString(
            "en-US",
            {
                month: "long",
                year: "numeric"
            }
        );


    const firstDay =
        new Date(
            year,
            month,
            1
        );


    let startingDay =
        firstDay.getDay();


    startingDay =
        startingDay === 0
            ? 6
            : startingDay - 1;


    const daysInMonth =
        new Date(
            year,
            month + 1,
            0
        ).getDate();


    const daysInPreviousMonth =
        new Date(
            year,
            month,
            0
        ).getDate();


    for (
        let i = startingDay - 1;
        i >= 0;
        i--
    ) {

        const day =
            daysInPreviousMonth - i;

        daysContainer.appendChild(
            createCalendarDay(
                day,
                year,
                month - 1,
                true
            )
        );
    }


    for (
        let day = 1;
        day <= daysInMonth;
        day++
    ) {

        daysContainer.appendChild(
            createCalendarDay(
                day,
                year,
                month,
                false
            )
        );
    }


    const total =
        daysContainer.children.length;


    const remaining =
        total <= 35
            ? 35 - total
            : 42 - total;


    for (
        let day = 1;
        day <= remaining;
        day++
    ) {

        daysContainer.appendChild(
            createCalendarDay(
                day,
                year,
                month + 1,
                true
            )
        );
    }
}


// ======================================================
// CREATE CALENDAR DAY
// ======================================================

function createCalendarDay(
    day,
    year,
    month,
    otherMonth
) {

    const button =
        document.createElement(
            "button"
        );

    button.type =
        "button";

    button.textContent =
        day;


    const date =
        new Date(
            year,
            month,
            day
        );


    const dateString =
        getDateString(date);


    button.dataset.date =
        dateString;


    if (otherMonth) {

        button.classList.add(
            "other-month"
        );
    }


    const todayString =
        getDateString(
            new Date()
        );


    if (
        dateString ===
        todayString
    ) {

        button.classList.add(
            "today"
        );
    }


    const selectedInput =
        document.getElementById(
            "edit-date"
        );


    if (
        selectedInput &&
        selectedInput.value === dateString
    ) {

        button.classList.add(
            "selected"
        );
    }


    button.addEventListener(
        "click",
        function (event) {

            event.stopPropagation();


            if (selectedInput) {

                selectedInput.value =
                    dateString;
            }


            const display =
                document.getElementById(
                    "date-picker-display"
                );


            if (display) {

                display.textContent =
                    formatDateDisplay(
                        dateString
                    );
            }


            const calendar =
                document.getElementById(
                    "custom-calendar"
                );


            if (calendar) {

                calendar.classList.remove(
                    "show"
                );
            }


            const dateButton =
                document.getElementById(
                    "date-picker-button"
                );


            if (dateButton) {

                dateButton.classList.remove(
                    "active"
                );
            }


            renderCustomCalendar();
        }
    );


    return button;
}


// ======================================================
// MONTH NAVIGATION
// ======================================================

function setupCalendarNavigation() {

    const previous =
        document.getElementById(
            "calendar-prev"
        );

    const next =
        document.getElementById(
            "calendar-next"
        );


    if (previous) {

        previous.addEventListener(
            "click",
            function (event) {

                event.stopPropagation();

                calendarViewDate.setMonth(
                    calendarViewDate.getMonth() - 1
                );

                renderCustomCalendar();
            }
        );
    }


    if (next) {

        next.addEventListener(
            "click",
            function (event) {

                event.stopPropagation();

                calendarViewDate.setMonth(
                    calendarViewDate.getMonth() + 1
                );

                renderCustomCalendar();
            }
        );
    }
}


// ======================================================
// CLOSE MODAL WHEN CLICKING OUTSIDE
// ======================================================

document.addEventListener(
    "click",
    function (event) {

        const modal =
            document.getElementById(
                "edit-modal"
            );

        if (
            modal &&
            event.target === modal
        ) {

            closeEditModal();
        }


        const calendar =
            document.getElementById(
                "custom-calendar"
            );

        if (
            calendar &&
            !event.target.closest(
                ".date-picker-wrapper"
            )
        ) {

            calendar.classList.remove(
                "show"
            );

            document
                .getElementById(
                    "date-picker-button"
                )
                ?.classList.remove(
                    "active"
                );
        }
    }
);


// ======================================================
// ESCAPE
// ======================================================

document.addEventListener(
    "keydown",
    function (event) {

        if (
            event.key === "Escape"
        ) {

            closeEditModal();
        }
    }
);


// ======================================================
// HOME DATA
// ======================================================

function getTasksForDate(dateString) {

    return loadTaskStore()
        .filter(
            task =>
                task.date === dateString
        );
}


// ======================================================
// FIND LARGEST GAP
// ======================================================

function findLargestGap(tasks) {

    const timed =
        tasks
            .filter(
                task =>
                    task.start &&
                    task.end
            )
            .sort(
                (a, b) =>
                    a.start.localeCompare(
                        b.start
                    )
            );


    if (timed.length < 2) {
        return null;
    }


    let largest = null;


    for (
        let i = 0;
        i < timed.length - 1;
        i++
    ) {

        const end =
            toMinutes(
                timed[i].end
            );

        const nextStart =
            toMinutes(
                timed[i + 1].start
            );


        const gap =
            nextStart - end;


        if (
            gap > 0 &&
            (
                !largest ||
                gap > largest.minutes
            )
        ) {

            largest = {

                start:
                    timed[i].end,

                minutes:
                    gap
            };
        }
    }


    return largest;
}


// ======================================================
// GREETING
// ======================================================

function renderGreeting() {

    const dateElement =
        document.getElementById(
            "current-date"
        );

    const heading =
        document.getElementById(
            "greeting-heading"
        );

    const messageElement =
        document.getElementById(
            "ai-greeting-msg"
        );


    const now =
        new Date();


    if (dateElement) {

        dateElement.textContent =
            now.toLocaleDateString(
                "en-US",
                {
                    weekday: "long",
                    month: "long",
                    day: "numeric"
                }
            );
    }


    if (heading) {

        const hour =
            now.getHours();


        const greeting =
            hour < 12
                ? "Good morning"
                : hour < 18
                    ? "Good afternoon"
                    : "Good evening";


        const name =
            window.PlanoraAuth ? window.PlanoraAuth.firstName() : "";

        heading.textContent =
            name ? `${greeting}, ${name}` : greeting;
    }


    // Home's own sentence (home.js) is worked out from real data
    if (messageElement && window.PlanoraHome) {

        messageElement.textContent =
            window.PlanoraHome.sentence();

        return;
    }

    if (messageElement) {

        const today =
            getDateString(now);

        const tasks =
            getTasksForDate(today);

        const remaining =
            tasks.filter(
                task => !task.completed
            ).length;


        let message;


        if (tasks.length === 0) {

            message =
                "Nothing on the books today — a good day to breathe.";

        } else if (remaining === 0) {

            message =
                "You've cleared everything on today's list. Nice work!";

        } else if (remaining >= 4) {

            message =
                "It's a full day — let's take it one task at a time.";

        } else {

            message =
                "You have a focused day ahead. Let's get started.";
        }


        messageElement.textContent =
            message;
    }
}


// ======================================================
// AI OVERVIEW
// ======================================================

function renderAIOverview() {

    const element =
        document.getElementById(
            "ai-overview-text"
        );

    if (!element) return;


    const today =
        getDateString(
            new Date()
        );


    const tasks =
        getTasksForDate(today);


    const remaining =
        tasks.filter(
            task => !task.completed
        );


    if (tasks.length === 0) {

        element.textContent =
            "You don't have any tasks scheduled today. Add one to get started.";

        return;
    }


    const lines = [];


    lines.push(
        `You have ${tasks.length} task${tasks.length === 1 ? "" : "s"} today.`
    );


    const timed =
        remaining
            .filter(task => task.start)
            .sort(
                (a, b) =>
                    a.start.localeCompare(
                        b.start
                    )
            );


    const priority =
        timed[0] ||
        remaining[0];


    if (priority) {

        lines.push(
            `Your most important priority is ${priority.title}.`
        );
    }


    const gap =
        findLargestGap(tasks);


    if (
        gap &&
        gap.minutes >= 90
    ) {

        lines.push(
            `You have a lighter stretch from ${formatTime(gap.start)} — a good window to get ahead.`
        );
    }


    element.textContent =
        lines.join(" ");
}


// ======================================================
// OPTIMIZE
// ======================================================

function optimizeMyDay() {

    const today =
        selectedDate ||
        getDateString(
            new Date()
        );


    const taskList =
        document.getElementById(
            "task-list"
        );

    if (!taskList) return;


    const items =
        Array.from(
            taskList.querySelectorAll(
                ".task-item"
            )
        )
        .filter(
            item =>
                item.dataset.date === today
        );


    items.sort(
        (a, b) => {

            const aStart =
                a.dataset.start ||
                "99:99";

            const bStart =
                b.dataset.start ||
                "99:99";

            return aStart.localeCompare(
                bStart
            );
        }
    );


    items.forEach(
        item =>
            taskList.appendChild(item)
    );


    renderAIOverview();

    alert(
        "Your day has been reordered by start time."
    );
}


// ======================================================
// PRIORITIES
// ======================================================

function renderPriorities() {

    const container =
        document.getElementById(
            "priorities-list"
        );

    if (!container) return;


    const today =
        getDateString(
            new Date()
        );


    const tasks =
        getTasksForDate(today)
            .filter(
                task =>
                    !task.completed
            );


    const timed =
        tasks
            .filter(
                task =>
                    task.start
            )
            .sort(
                (a, b) =>
                    a.start.localeCompare(
                        b.start
                    )
            );


    const untimed =
        tasks.filter(
            task =>
                !task.start
        );


    const ordered =
        [
            ...timed,
            ...untimed
        ].slice(0, 3);


    container.innerHTML = "";


    if (ordered.length === 0) {

        container.innerHTML =
            `<div class="no-tasks">
                Nothing left to prioritize today 🎉
            </div>`;

        return;
    }


    ordered.forEach(task => {

        const row =
            document.createElement(
                "div"
            );

        row.className =
            "task-item priority-item";


        row.innerHTML = `

            <div>

                <p class="t-title"></p>

                <p class="t-time"></p>

            </div>
        `;


        row.querySelector(
            ".t-title"
        ).textContent =
            task.title;


        row.querySelector(
            ".t-time"
        ).textContent =

            task.start && task.end
                ? `${formatTime(task.start)} - ${formatTime(task.end)}`
                : task.start
                    ? formatTime(task.start)
                    : "No time set";


        container.appendChild(row);
    });
}


// ======================================================
// PROGRESS
// ======================================================

function renderHomeProgress() {

    const fill =
        document.getElementById(
            "progress-fill"
        );

    const text =
        document.getElementById(
            "progress-text"
        );


    if (!fill || !text) {
        return;
    }


    const today =
        getDateString(
            new Date()
        );


    const tasks =
        getTasksForDate(today);


    const completed =
        tasks.filter(
            task =>
                task.completed
        ).length;


    const percentage =
        tasks.length === 0
            ? 0
            : Math.round(
                (completed / tasks.length) *
                100
            );


    fill.style.width =
        percentage + "%";


    text.textContent =
        tasks.length === 0
            ? "No tasks scheduled today."
            : `${completed} / ${tasks.length} tasks completed (${percentage}%)`;
}


// ======================================================
// AI SUGGESTION
// ======================================================

let dismissedSuggestionKey = null;


function renderAISuggestion() {

    const card =
        document.getElementById(
            "ai-suggestion-card"
        );

    const text =
        document.getElementById(
            "ai-suggestion-text"
        );


    if (!card || !text) {
        return;
    }


    const today =
        getDateString(
            new Date()
        );


    const tasks =
        getTasksForDate(today);


    const gap =
        findLargestGap(tasks);


    if (
        !gap ||
        gap.minutes < 30
    ) {

        card.style.display =
            "none";

        return;
    }


    const key =
        `${today}-${gap.start}`;


    if (
        dismissedSuggestionKey === key
    ) {

        card.style.display =
            "none";

        return;
    }


    card.dataset.gapDate =
        today;

    card.dataset.gapStart =
        gap.start;


    const freeTime =
        gap.minutes >= 60

            ? `${Math.round(
                (gap.minutes / 60) * 10
            ) / 10} hours`

            : `${gap.minutes} minutes`;


    text.textContent =
        `You have about ${freeTime} free before your next task. Want me to suggest something productive?`;


    card.style.display =
        "block";
}


function planSuggestion() {

    const card =
        document.getElementById(
            "ai-suggestion-card"
        );


    const date =
        card?.dataset.gapDate;

    const start =
        card?.dataset.gapStart;


    if (!date) return;


    selectedDate =
        date;


    openAddTaskModal();


    if (start) {

        const startInput =
            document.getElementById(
                "edit-start"
            );

        if (startInput) {
            startInput.value =
                start;
        }

        updateTimeDisplaySafe(
            "start-time-display",
            start
        );
    }
}


function dismissSuggestion() {

    const card =
        document.getElementById(
            "ai-suggestion-card"
        );


    if (
        card?.dataset.gapDate &&
        card?.dataset.gapStart
    ) {

        dismissedSuggestionKey =
            `${card.dataset.gapDate}-${card.dataset.gapStart}`;
    }


    if (card) {
        card.style.display =
            "none";
    }
}


// ======================================================
// MOMENTUM
// ======================================================

function renderMomentum() {

    // Removed: this used to show fixed sample streaks (Study 5 days,
    // Exercise 3, Reading 7). Real streaks are on the Streak page.
}


// ======================================================
// HOME OVERVIEW
// ======================================================

function renderHomeOverview() {

    renderGreeting();

    renderAIOverview();

    renderPriorities();

    renderHomeProgress();

    renderAISuggestion();

    renderMomentum();
}


// ======================================================
// PROFILE
// ======================================================

// The Profile charts (weekly completion, categories, activity heatmap)
// are drawn from the user's real tasks in app-extras.js. The old fixed
// sample numbers and the random heatmap were removed.

function renderBarChart() {}

function renderCategoryBars() {}

function renderHeatmap() {}


function initProfilePage() {

    renderBarChart();

    renderCategoryBars();

    renderHeatmap();
}


// ======================================================
// INITIALISE
// ======================================================

document.addEventListener(
    "DOMContentLoaded",
    function () {

        // First-run seed (only writes if the store is empty)
        seedDefaultTasksIfEmpty();

        // Render everything from the shared store
        renderStoreTasksToDOM();

        // Calendar
        generateWeekCalendar();

        updateScheduleTitle();

        showTasksForDate(
            selectedDate
        );

        // Home
        renderHomeOverview();

        // Custom controls
        createCustomTimePicker(
            "start-time-button",
            "start-time-dropdown",
            "start-time-display",
            "edit-start"
        );

        createCustomTimePicker(
            "end-time-button",
            "end-time-dropdown",
            "end-time-display",
            "edit-end"
        );

        setupDatePicker();

        setupCalendarNavigation();

        // Other pages if elements exist
        renderBarChart();

        renderCategoryBars();

        renderHeatmap();
    }
);