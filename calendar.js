// ======================================================
// SHARED TASK STORE (localStorage)
//
// Same key that script.js (dashboard) writes to. This is
// how a task added on the dashboard shows up as a dot
// here, and why the task counts always match.
// ======================================================

const TASK_STORE_KEY = "planora_tasks";

function loadTaskStore() {

    try {
        return JSON.parse(localStorage.getItem(TASK_STORE_KEY)) || [];
    } catch (e) {
        return [];
    }
}

function saveTaskStore(tasks) {

    localStorage.setItem(
        TASK_STORE_KEY,
        JSON.stringify(tasks)
    );
}

// Groups all stored tasks by date -> [{title, timeText}, ...]
function getTasksByDate() {

    const tasks = loadTaskStore();

    const map = {};

    tasks.forEach(task => {

        if (!task.date) return;

        if (!map[task.date]) {
            map[task.date] = [];
        }

        map[task.date].push(task);
    });

    return map;
}

function formatTime(time) {

    if (!time) return "";

    let [hour, minute] = time.split(":");

    hour = parseInt(hour, 10);

    const period = hour >= 12 ? "PM" : "AM";

    hour = hour % 12 || 12;

    return `${hour}:${minute} ${period}`;
}

function getTaskTimeText(task) {

    if (task.start && task.end) {
        return `${formatTime(task.start)} - ${formatTime(task.end)}`;
    }

    if (task.start) {
        return formatTime(task.start);
    }

    if (task.end) {
        return formatTime(task.end);
    }

    return "No time set";
}


// ======================================================
// DATE HELPERS
// ======================================================

function getDateString(date) {

    return (
        date.getFullYear() + "-" +
        String(date.getMonth() + 1).padStart(2, "0") + "-" +
        String(date.getDate()).padStart(2, "0")
    );
}

function formatDateDisplay(dateString) {

    if (!dateString) return "";

    const date = new Date(dateString + "T00:00:00");

    if (isNaN(date.getTime())) return "";

    return (
        String(date.getDate()).padStart(2, "0") + "/" +
        String(date.getMonth() + 1).padStart(2, "0") + "/" +
        date.getFullYear()
    );
}


// ======================================================
// DOT COLOURS
//
// One colour per task on a given day, cycling through the
// palette if a day has more tasks than colours.
// ======================================================

const DOT_COLORS = [
    "#c17a7a", // dull red
    "#7a95b8", // dull blue
    "#c9b06b", // dull yellow
    "#7fa382", // dull green
    "#9b85ad", // dull purple
    "#c69368", // dull orange
    "#bd85a0", // dull pink
    "#6fa39c"  // dull teal
];

const MAX_VISIBLE_DOTS = 4;


// ======================================================
// CALENDAR STATE
// ======================================================

let currentDate = new Date();

let selectedCalendarDate = null;


// ======================================================
// RENDER CALENDAR GRID
// ======================================================

function renderCalendar() {

    const calendarGrid =
        document.getElementById("calendarGrid");

    const monthTitle =
        document.getElementById("calendarMonth");

    if (!calendarGrid || !monthTitle) return;

    const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];

    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    monthTitle.textContent = `${monthNames[month]} ${year}`;

    // Keep day-of-week headings
    calendarGrid.innerHTML = `
        <div class="cal-dow">S</div>
        <div class="cal-dow">M</div>
        <div class="cal-dow">T</div>
        <div class="cal-dow">W</div>
        <div class="cal-dow">T</div>
        <div class="cal-dow">F</div>
        <div class="cal-dow">S</div>
    `;

    const tasksByDate = getTasksByDate();

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const previousMonthDays = new Date(year, month, 0).getDate();

    // Previous month's trailing days
    for (let i = firstDay - 1; i >= 0; i--) {

        const day = previousMonthDays - i;

        const cell = document.createElement("div");

        cell.className = "cal-cell muted";

        cell.textContent = day;

        calendarGrid.appendChild(cell);
    }

    // Current month's days
    for (let day = 1; day <= daysInMonth; day++) {

        const cell = document.createElement("div");

        cell.className = "cal-cell";

        cell.textContent = day;

        const dateKey =
            `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

        // Today styling
        const today = new Date();

        if (
            today.getFullYear() === year &&
            today.getMonth() === month &&
            today.getDate() === day
        ) {
            cell.classList.add("today");
        }

        // Selected styling (persists across re-renders)
        if (dateKey === selectedCalendarDate) {
            cell.classList.add("selected");
        }

        // One coloured dot per task on this date
        const dayTasks = tasksByDate[dateKey] || [];

        if (dayTasks.length > 0) {

            const dotsContainer = document.createElement("span");

            dotsContainer.className = "task-dots";

            const visibleTasks = dayTasks.slice(0, MAX_VISIBLE_DOTS);

            visibleTasks.forEach((task, i) => {

                const dot = document.createElement("span");

                dot.className = "task-dot";

                dot.style.background = DOT_COLORS[i % DOT_COLORS.length];

                dotsContainer.appendChild(dot);
            });

            if (dayTasks.length > MAX_VISIBLE_DOTS) {

                const more = document.createElement("span");

                more.className = "task-dot-more";

                more.textContent = `+${dayTasks.length - MAX_VISIBLE_DOTS}`;

                dotsContainer.appendChild(more);
            }

            cell.appendChild(dotsContainer);
        }

        // Click date -> update the preview list below the grid
        cell.addEventListener("click", function () {

            document
                .querySelectorAll(".cal-cell")
                .forEach(c => c.classList.remove("selected"));

            cell.classList.add("selected");

            selectedCalendarDate = dateKey;

            showDayTasks(dateKey, day, month, year, tasksByDate);
        });

        calendarGrid.appendChild(cell);
    }
}


// ======================================================
// DAY NAME HELPER
// ======================================================

function getDayName(year, month, day) {

    const names = [
        "Sunday", "Monday", "Tuesday", "Wednesday",
        "Thursday", "Friday", "Saturday"
    ];

    return names[new Date(year, month, day).getDay()];
}


// ======================================================
// SHOW TASKS FOR SELECTED DAY
//
// Same look and behaviour as dashboard.html's task items:
// edit button (opens the modal) + tick button (completes).
// ======================================================

function showDayTasks(dateKey, day, month, year, tasksByDate) {

    const monthNamesShort = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ];

    const label = document.getElementById("selectedDateLabel");

    const container = document.getElementById("selectedTasks");

    if (!label || !container) return;

    label.textContent =
        `${getDayName(year, month, day)}, ${monthNamesShort[month]} ${day}`;

    container.innerHTML = "";

    const dayTasks = tasksByDate[dateKey] || [];

    if (dayTasks.length === 0) {

        container.innerHTML = `
            <div class="no-tasks">No tasks for this day.</div>
        `;

        return;
    }

    dayTasks.forEach(task => {

        const item = document.createElement("div");

        item.className = "task-item" + (task.completed ? " completed" : "");

        item.dataset.taskId = task.id;

        item.innerHTML = `
            <div>
                <p class="t-title"></p>
                <p class="t-time"></p>
            </div>

            <div class="task-actions">

                <button class="task-edit-btn" aria-label="Edit task">
                    <i class="ti ti-edit"></i>
                </button>

                <button class="task-check-btn" aria-label="Complete task">
                    <i class="ti ti-check"></i>
                </button>

            </div>
        `;

        item.querySelector(".t-title").textContent = task.title;

        item.querySelector(".t-time").textContent = getTaskTimeText(task);

        item.querySelector(".task-edit-btn")
            .addEventListener("click", function () {
                openEditTaskModal(task.id);
            });

        item.querySelector(".task-check-btn")
            .addEventListener("click", function () {
                toggleCalendarTaskComplete(task.id);
            });

        container.appendChild(item);
    });
}


// ======================================================
// TOGGLE COMPLETE (from the calendar page)
// ======================================================

function toggleCalendarTaskComplete(taskId) {

    const tasks = loadTaskStore();

    const idx = tasks.findIndex(t => t.id === taskId);

    if (idx === -1) return;

    tasks[idx].completed = !tasks[idx].completed;

    saveTaskStore(tasks);

    renderCalendar();

    if (selectedCalendarDate) {

        const tasksByDate = getTasksByDate();

        const d = new Date(selectedCalendarDate + "T00:00:00");

        showDayTasks(
            selectedCalendarDate,
            d.getDate(),
            d.getMonth(),
            d.getFullYear(),
            tasksByDate
        );
    }
}


// ======================================================
// TOP HEADER — always shows today's real date
// (independent of whichever month is being browsed)
// ======================================================

function renderTodayHeader() {

    const el = document.getElementById("todayHeader");

    if (!el) return;

    const today = new Date();

    el.textContent = today.toLocaleDateString("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
        year: "numeric"
    });
}


// ======================================================
// MONTH NAVIGATION (main grid)
// ======================================================

function initMonthNav() {

    const prevBtn = document.getElementById("previousMonth");

    const nextBtn = document.getElementById("nextMonth");

    if (prevBtn) {

        prevBtn.addEventListener("click", function () {

            currentDate.setMonth(currentDate.getMonth() - 1);

            renderCalendar();
        });
    }

    if (nextBtn) {

        nextBtn.addEventListener("click", function () {

            currentDate.setMonth(currentDate.getMonth() + 1);

            renderCalendar();
        });
    }
}


// ======================================================
// ADD / EDIT TASK MODAL
// ======================================================

let taskModalMode = "add"; // "add" | "edit"

let currentEditTaskId = null;

let datePickerViewDate = new Date();


function openAddTaskModal() {

    taskModalMode = "add";

    currentEditTaskId = null;

    document.getElementById("task-modal-title").textContent = "Add Task";

    document.getElementById("task-modal-submit-btn").textContent = "Add Task";

    document.getElementById("edit-title").value = "";

    const dateStr = selectedCalendarDate || getDateString(new Date());

    document.getElementById("edit-date").value = dateStr;

    document.getElementById("date-picker-display").textContent =
        formatDateDisplay(dateStr);

    document.getElementById("edit-start").value = "";

    document.getElementById("edit-end").value = "";

    setTimeDisplay("start-time-display", "");

    setTimeDisplay("end-time-display", "");

    datePickerViewDate = new Date(dateStr + "T00:00:00");

    openTaskModalElement();
}


function openEditTaskModal(taskId) {

    const tasks = loadTaskStore();

    const task = tasks.find(t => t.id === taskId);

    if (!task) return;

    taskModalMode = "edit";

    currentEditTaskId = taskId;

    document.getElementById("task-modal-title").textContent = "Edit Task";

    document.getElementById("task-modal-submit-btn").textContent = "Save Changes";

    document.getElementById("edit-title").value = task.title || "";

    document.getElementById("edit-date").value = task.date || "";

    document.getElementById("date-picker-display").textContent =
        formatDateDisplay(task.date);

    document.getElementById("edit-start").value = task.start || "";

    document.getElementById("edit-end").value = task.end || "";

    setTimeDisplay("start-time-display", task.start);

    setTimeDisplay("end-time-display", task.end);

    datePickerViewDate =
        task.date ? new Date(task.date + "T00:00:00") : new Date();

    openTaskModalElement();
}


function openTaskModalElement() {

    const modal = document.getElementById("edit-modal");

    if (modal) modal.style.display = "flex";

    document.getElementById("custom-calendar")?.classList.remove("show");

    document.getElementById("start-time-dropdown")?.classList.remove("show");

    document.getElementById("end-time-dropdown")?.classList.remove("show");
}


function closeTaskModal() {

    const modal = document.getElementById("edit-modal");

    if (modal) modal.style.display = "none";

    document.getElementById("custom-calendar")?.classList.remove("show");

    document.getElementById("start-time-dropdown")?.classList.remove("show");

    document.getElementById("end-time-dropdown")?.classList.remove("show");
}


function saveTaskModal() {

    const title = document.getElementById("edit-title").value.trim();

    const date = document.getElementById("edit-date").value;

    const start = document.getElementById("edit-start").value;

    const end = document.getElementById("edit-end").value;

    if (!title || !date) {

        alert("Please enter a task name and date.");

        return;
    }

    const tasks = loadTaskStore();

    if (taskModalMode === "add") {

        const newId = "cal-" + Date.now();

        tasks.push({
            id: newId,
            title,
            date,
            start,
            end,
            completed: false
        });

    } else if (taskModalMode === "edit" && currentEditTaskId) {

        const idx = tasks.findIndex(t => t.id === currentEditTaskId);

        if (idx > -1) {
            tasks[idx] = { ...tasks[idx], title, date, start, end };
        }
    }

    saveTaskStore(tasks);

    selectedCalendarDate = date;

    currentDate = new Date(date + "T00:00:00");

    closeTaskModal();

    renderCalendar();

    const tasksByDate = getTasksByDate();

    const d = new Date(date + "T00:00:00");

    showDayTasks(date, d.getDate(), d.getMonth(), d.getFullYear(), tasksByDate);
}


// ======================================================
// DATE PICKER (inside the Add / Edit modal)
// ======================================================

function renderDatePickerCalendar() {

    const calendarDays = document.getElementById("calendar-days");

    const calendarMonthEl = document.getElementById("calendar-month");

    if (!calendarDays || !calendarMonthEl) return;

    calendarDays.innerHTML = "";

    const year = datePickerViewDate.getFullYear();

    const month = datePickerViewDate.getMonth();

    calendarMonthEl.textContent =
        datePickerViewDate.toLocaleDateString("en-US", {
            month: "long",
            year: "numeric"
        });

    const firstDay = new Date(year, month, 1);

    let startingDay = firstDay.getDay();

    startingDay = startingDay === 0 ? 6 : startingDay - 1;

    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const daysInPreviousMonth = new Date(year, month, 0).getDate();

    for (let i = startingDay - 1; i >= 0; i--) {

        const day = daysInPreviousMonth - i;

        calendarDays.appendChild(
            createDatePickerDay(day, year, month - 1, true)
        );
    }

    for (let day = 1; day <= daysInMonth; day++) {

        calendarDays.appendChild(
            createDatePickerDay(day, year, month, false)
        );
    }

    const totalCells = calendarDays.children.length;

    const remaining =
        totalCells <= 35 ? 35 - totalCells : 42 - totalCells;

    for (let day = 1; day <= remaining; day++) {

        calendarDays.appendChild(
            createDatePickerDay(day, year, month + 1, true)
        );
    }
}


function createDatePickerDay(day, year, month, otherMonth) {

    const button = document.createElement("button");

    button.type = "button";

    button.textContent = day;

    const date = new Date(year, month, day);

    const dateString = getDateString(date);

    button.dataset.date = dateString;

    if (otherMonth) {
        button.classList.add("other-month");
    }

    const todayString = getDateString(new Date());

    if (dateString === todayString) {
        button.classList.add("today");
    }

    const editDateInput = document.getElementById("edit-date");

    if (editDateInput && editDateInput.value === dateString) {
        button.classList.add("selected");
    }

    button.addEventListener("click", function () {

        if (editDateInput) {
            editDateInput.value = dateString;
        }

        const dateDisplay = document.getElementById("date-picker-display");

        if (dateDisplay) {
            dateDisplay.textContent = formatDateDisplay(dateString);
        }

        document.getElementById("custom-calendar")?.classList.remove("show");

        document.getElementById("date-picker-button")?.classList.remove("active");

        renderDatePickerCalendar();
    });

    return button;
}


function initDatePicker() {

    const dateButton = document.getElementById("date-picker-button");

    const customCalendar = document.getElementById("custom-calendar");

    const calendarPrev = document.getElementById("calendar-prev");

    const calendarNext = document.getElementById("calendar-next");

    if (dateButton) {

        dateButton.addEventListener("click", function (e) {

            e.stopPropagation();

            if (!customCalendar) return;

            customCalendar.classList.toggle("show");

            dateButton.classList.toggle("active");

            if (customCalendar.classList.contains("show")) {
                renderDatePickerCalendar();
            }
        });
    }

    if (calendarPrev) {

        calendarPrev.addEventListener("click", function (e) {

            e.stopPropagation();

            datePickerViewDate.setMonth(datePickerViewDate.getMonth() - 1);

            renderDatePickerCalendar();
        });
    }

    if (calendarNext) {

        calendarNext.addEventListener("click", function (e) {

            e.stopPropagation();

            datePickerViewDate.setMonth(datePickerViewDate.getMonth() + 1);

            renderDatePickerCalendar();
        });
    }

    document.addEventListener("click", function (e) {

        if (customCalendar && !e.target.closest(".date-picker-wrapper")) {

            customCalendar.classList.remove("show");

            dateButton?.classList.remove("active");
        }
    });
}


// ======================================================
// TIME PICKERS (inside the Add / Edit modal)
// ======================================================

function setTimeDisplay(displayId, value) {

    const display = document.getElementById(displayId);

    if (!display) return;

    display.textContent = value ? formatTime(value) : "Select time";
}


function createCustomTimePicker(buttonId, dropdownId, displayId, inputId) {

    const button = document.getElementById(buttonId);

    const dropdown = document.getElementById(dropdownId);

    const display = document.getElementById(displayId);

    const input = document.getElementById(inputId);

    if (!button || !dropdown || !display || !input) return;

    dropdown.innerHTML = "";

    for (let hour = 0; hour < 24; hour++) {

        for (let minute = 0; minute < 60; minute += 30) {

            const hour12 = hour % 12 || 12;

            const minuteText = String(minute).padStart(2, "0");

            const period = hour < 12 ? "AM" : "PM";

            const displayTime = `${hour12}:${minuteText} ${period}`;

            const value = `${String(hour).padStart(2, "0")}:${minuteText}`;

            const option = document.createElement("button");

            option.type = "button";

            option.className = "custom-time-option";

            option.textContent = displayTime;

            option.dataset.value = value;

            option.addEventListener("click", function () {

                input.value = value;

                display.textContent = displayTime;

                dropdown
                    .querySelectorAll(".custom-time-option")
                    .forEach(btn => btn.classList.remove("selected"));

                option.classList.add("selected");

                dropdown.classList.remove("show");

                button.classList.remove("active");
            });

            dropdown.appendChild(option);
        }
    }

    button.addEventListener("click", function (event) {

        event.stopPropagation();

        const isOpen = dropdown.classList.contains("show");

        document
            .querySelectorAll(".custom-time-dropdown")
            .forEach(drop => drop.classList.remove("show"));

        document
            .querySelectorAll(".custom-time-button")
            .forEach(btn => btn.classList.remove("active"));

        if (!isOpen) {

            dropdown.classList.add("show");

            button.classList.add("active");

            dropdown
                .querySelectorAll(".custom-time-option")
                .forEach(option => {

                    option.classList.toggle(
                        "selected",
                        option.dataset.value === input.value
                    );
                });
        }
    });
}


function initTimePickers() {

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

    document.addEventListener("click", function () {

        document
            .querySelectorAll(".custom-time-dropdown")
            .forEach(dropdown => dropdown.classList.remove("show"));

        document
            .querySelectorAll(".custom-time-button")
            .forEach(button => button.classList.remove("active"));
    });
}


// ======================================================
// INITIALISE
// ======================================================

document.addEventListener("DOMContentLoaded", function () {

    initMonthNav();

    initDatePicker();

    initTimePickers();

    renderTodayHeader();

    renderCalendar();
});

