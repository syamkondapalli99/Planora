# Planora: AI daily planner

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

## Accounts and sign-in (Supabase)

Sign-in and each person's saved data use **Supabase Auth** (works on GitHub Pages, no server needed):

- Continue with **Google** / **Apple** (Supabase OAuth, PKCE)
- **Email + password**: create account (with email confirmation), sign in, forgot password (`reset-password.html`)
- One account per person: the Supabase user id is the key. Google/Apple/email with the same verified email = one account.
- Sessions are stored and refreshed by the Supabase SDK (no login after refresh, no login-screen flash).
- Data: one row per user in `public.planora_user_data` protected by Row Level Security (`supabase/schema.sql`).
- Data from the old version that is still on a device is moved into the new account on first sign-in (only if that account is empty).
- "Skip to dashboard" is **development only** (localhost); it is hidden and blocked on planoraai.net.

### Setup (once)

1. Supabase → **SQL Editor** → run `supabase/schema.sql`.
2. Supabase → **Project Settings → API**: copy the Project URL and the **anon / publishable** key into `planora-config.js`.
   Never put the service_role key, OAuth client secrets, Apple keys or the OpenAI key in that file.
3. Supabase → **Authentication → URL Configuration**
   - Site URL: `https://planoraai.net`
   - Redirect URLs: `https://planoraai.net/**`, `https://www.planoraai.net/**`, `http://localhost:3000/**`
4. Supabase → **Authentication → Providers**: Email (confirm email on, minimum password length 8), Google, Apple.
   Provider callback URL to give Google and Apple: `https://<project-ref>.supabase.co/auth/v1/callback`
5. Supabase → **Authentication → Emails → SMTP**: add your own SMTP for real users (the built-in sender is rate-limited).

The return address is chosen automatically: `https://planoraai.net/` on the live site (also from www), otherwise the
address the app is running on (e.g. `http://localhost:3000/`).

### Ask Planora on the live site

GitHub Pages only serves files, so `server.js` (Ask Planora's AI endpoints) does not run there. To use them on
planoraai.net, host `server.js` (Render, Railway, Fly…) with `.env`, and set `apiBase` in `planora-config.js` to that
address. The server only answers signed-in users: it checks the Supabase access token with Supabase.

## How Planora is organised

**Navigation:** Home · Calendar · Planora · Journal · Profile (desktop sidebar).
On phones: Home · Calendar · **+** · Planora · Profile (the + is quick add).

| Page | What it's for |
|---|---|
| **Home** | "What should I do today?" A real sentence about your day, **Today's focus** (top 3, prioritised), at most 2 genuinely useful suggestions, **Today's schedule**, and **Ask Planora**. New accounts see "Let's build your first day" instead of fake tasks. |
| **Calendar** | Google Calendar-style: ‹ Today › · date range (tap for a date picker) · Month / Week / Day. Tasks and events at their times, current-time line, drag to move, drag the bottom edge to resize (15-min snap, Undo), click an empty slot to create a Task or Event. Phones open in Day view, tablets and laptops in Week; your last view is remembered on each device. Shortcuts: T today, N next, P previous, C create, / search. |
| **Planora** (`planner.html`) | Ask Planora, **Your goals**, and **Quick tools** (Plan my day, Break down a task, Create a study plan, Work on a goal). |
| **Journal** | Mood, today's thoughts, wins, Save. Everything else (prompts, reflections, brain dump, tags, photo, goals, ideas, insights, monthly reflection, search, streak) is under **More**. |
| **Profile** | Your info, 3 progress numbers, settings. Charts are under **View detailed progress**. |
| Streak (`streak.html`) | Reached from Profile / the streak chip on Home. |

### Everyday features

- **Next up + Start** (Home): the one task to do now, why, and a Start button. **What should I do now?** gives the same answer anywhere.
- **Focus Mode**: full-screen timer for one task. Pause, resume, complete, stop. Keeps running if you change page or reload
  (a small pill shows it). Completing marks the real task done and shows what's next.
- **Workload** (Home): On track / Getting tight / Overloaded, from the work left today vs. the time left.
- **Optimize my day**: proposes a better order for flexible tasks only (fixed events, repeats and your own timed tasks stay put). Preview first.
- **Reschedule** any task: tap it → Move to today / Move to tomorrow / Choose time. Undo is offered.
- **Today's review** (from 5pm, or anytime): done / remaining / time worked, **Plan tomorrow** for unfinished tasks, link to the Journal.
- **Repeating tasks**: quick add → Repeats: Daily / Weekdays / Weekly / Custom days. Each day is its own task, so ticking one
  doesn't tick the others. Delete one day or all future ones.
- **Quick add understands sentences**: "Physics assignment tomorrow 2 hours high priority" → "I understood this as a 2-hour task tomorrow." You can edit before saving.
- **Goals** show their next session with **Start session**, or **Plan next session** if none is booked.
- **Tasks vs Events**: a task is something you complete (checkbox, Start, Complete). An event happens at a set time (meeting, class,
  appointment): calendar icon, soft colour, no checkbox, never moved by Planora. Both can have a category colour
  (Work, Study, Personal, Health, Other) and can repeat. Editing a repeating event asks: This occurrence / This and future / Entire series.
- Ask Planora knows the difference ("dentist Friday at 3" → event, "finish my assignment Friday" → task), asks "Task or Event?" when it
  isn't clear, never schedules tasks over events, and warns you if you move a task onto one.
- **Search** (`/` or Ctrl/Cmd+K, or the search button): tasks, goals and journal, grouped.
- **Journal link**: after saving, Planora may (at most once a day) offer one practical change, e.g. shorter focus sessions tomorrow. No medical or personal inferences.
- Progress is shown as tasks done this week; the streak is still there on the Streak page, without guilt messages.

Old links still work: `planner.html#goals`, `#daily`, `#breakdown`, `#study`, `streak.html`.

## Phones, tablets and laptops

- **Phones and tablets are an app.** Planora installs to the home screen and opens full-screen,
  with its own icon, no browser bars, and it opens offline.
  - iPhone / iPad (Safari): Share → **Add to Home Screen**.
  - Android (Chrome): tap **Install** on the banner on Home, or browser menu → Install app.
  - Planora shows a small "Get the Planora app" banner on Home (phones/tablets only, "Not now" hides it for 14 days)
    and **Install the app** in Profile → Settings.
- **Laptops and desktops are the website**, in a card that now fills the window (up to 1240px wide).
- Layouts: phone = bottom tab bar; tablet and phone-on-its-side = full-screen app with the side bar;
  laptop = website card. Safe areas (notch, home bar), 16px text in fields (no zoom on iPhone),
  40px+ tap targets, and no double-tap zoom delay on touch screens.
- **Offline:** pages you've opened work without signal; changes are kept on the device and sync when you're back online.
  Coming back to the app after using another device picks up the other device's changes.
- **Using it on your phone:** start the server, then open the "On your phone/tablet (same Wi-Fi)" address it prints.
  Home-screen install with offline support needs **https** (e.g. once Planora is deployed). On plain http over Wi-Fi,
  iPhone/iPad "Add to Home Screen" still gives the full-screen app, but without offline.

## Ask Planora

One box on Home and Planora. Examples: "Plan my day", "I need to finish my assignment tonight",
"Learn Python by next week", "I have an exam next Friday", "Gym 3x this week and call mum tomorrow at 6pm",
"Move my gym session to 7pm", "Make those sessions 30 minutes", "What should I do now?", "Plan my week",
"I only have 2 hours tonight", "I'm behind on my assignment", "Move everything unfinished to tomorrow",
"Break down my assignment", "Create a study plan", "Am I on track for my goal?".

Planora uses your real tasks, goals, free time and productive time. Every change is **Preview → Edit → Confirm**:
nothing is added or moved until you tap **Add to my plan** / **Apply changes**.
With `OPENAI_API_KEY` set, OpenAI understands the request; without it (or if OpenAI fails) the built-in
planner handles it. Either way the same scheduler picks the times and avoids clashes.
Optional: `OPENAI_MODEL=gpt-4o` (default `gpt-4o-mini`).

## Data model (one of each)

- **Tasks**: `planora_tasks` — the only task list. Home, Calendar, Ask Planora, Journal "Turn into tasks",
  Plan my day, Task Breakdown, Study Planner and goal sessions all write here.
  Fields: `id, title, date, start, end, completed` + optional `duration, priority, deadline, goalId, source, completedAt,
  fixed` (don't move), `seriesId` (part of a repeat), `focusMinutes` (time spent in Focus Mode).
- **Repeats**: `planora_recurring` — one rule per repeating task `{id, title, start, duration, priority, repeat{type: daily|weekdays|weekly|custom, days[]},
  startDate, skipped[], endAfter}`. Occurrences are real tasks (`id = seriesId-date`) created up to 4 weeks ahead.
  Tasks may also have `category` (work / study / personal / health / other).
- **Events**: `planora_events` — `{id, title, date, start, end, category, location?, notes?, seriesId?, detached?}`. Separate from tasks
  (existing tasks are never converted). Repeating events are rules in `planora_recurring` with `kind: "event"`; occurrences are
  real events created ~8 weeks ahead. Events count as busy time for free time, "What should I do now?", workload and every Planora plan.
- **Goals**: `planora_goals` — shared by Planora, Journal and AI.
  Fields: `id, title, description, date (deadline), createdAt, updatedAt, status (active/completed/archived),
  category, source, milestones[{id,text,done,date,completedAt}], manualProgress, progress`.
  **Sessions are tasks with `goalId`** (so they show on Home and Calendar automatically).
  Deleting a goal removes its unfinished sessions and keeps completed ones as history.
- Shared code: `planora-core.js` (data, migration, plan preview, quick add, goal editor, navigation) and
  `planora-priority.js` (one prioritisation used by Home, recommendations and the server).

**Migration** runs automatically and safely on every page load (`planora_migrations` records what ran):
old Journal goals (`{id,title,progress}`) and old Goal Tracker goals become the shared goal shape;
the three untouched sample tasks older versions added (Team standup, Gym session, Read 20 pages, not completed)
are removed; every task gets a string id. Journal entries, your own tasks and accounts are not changed.

## Other settings (`.env`, server only, never in the browser)

```
OPENAI_API_KEY=...        # optional: real AI plans (otherwise mock mode)
PORT=3000
SUPABASE_URL=...          # optional: defaults to the value in planora-config.js
SUPABASE_ANON_KEY=...     # optional: defaults to the value in planora-config.js
ALLOWED_ORIGINS=...       # optional: extra sites allowed to call this server (planoraai.net is allowed already)
GOOGLE_CLIENT_SECRET=...  # Google Calendar link: the Web client's secret (Google Cloud → Clients)
GCAL_TOKEN_KEY=...        # Google Calendar link: any long random text, used to encrypt Google's permission
```

### Google Calendar (read-only)

Calendar → **Google** (or Profile → Google Calendar) links a Google account. Google events show in
Month / Week / Day with Google's colours, open read-only with "Open in Google Calendar", and Ask Planora
and free-time checks plan around them. Planora never changes anything in Google.

Google's popup gives the browser a one-time code; `gcal-server.js` swaps it (with the client secret) for
Google's long-lived permission, encrypts it (AES-256-GCM, `GCAL_TOKEN_KEY`) and stores it in
`planora_google_calendar` (RLS, own row only; `supabase/google-calendar.sql`). Tokens never reach the
page or localStorage. Needs: Google Calendar API enabled, the `calendar.readonly` scope on the consent
screen, the two settings above on the server, and the SQL run once.

## What's where

| File | What it does |
|---|---|
| `server.js` | Express server + AI endpoints (`/api/plan`, `/api/study-plan`) |
| `auth-server.js` | Checks Supabase sign-in on the AI endpoints, blocks private files, CORS for planoraai.net |
| `planora-config.js` | Public settings: Supabase URL + anon key, production URL, `apiBase` |
| `supabase/schema.sql` | The one table + Row Level Security + delete-my-account function |
| `supabase/google-calendar.sql` | Google Calendar link table + Row Level Security |
| `gcal-server.js` + `gcal.js` | Google Calendar link: server (code swap, encrypted permission, events) and app (panel, events in the calendar) |
| `vendor/supabase.js` | Supabase JS SDK (v2.117.2, MIT) |
| `reset-password.html` | Choose a new password from the email link |
| `index.html` + `login.js` | Sign in / create account / Google / Apple / forgot password + onboarding |
| `smart-plan-server.js` | Ask Planora engine: plan / plan my day or week / what now / limited time / behind / move unfinished / break down / goal status / edit, scheduler, sentence parser (`/api/smart-plan`, `/api/schedule`, `/api/parse-task`) |
| `smart-planner.js` | The Ask Planora box (Home and Planora) |
| `planora-core.js` | Shared tasks + goals + repeats, migration, Preview → Edit → Confirm, quick add, task sheet, reschedule, optimize, today's review, search, goal editor, navigation |
| `planora-priority.js` | One prioritisation (overdue, deadline, priority, time, goal, duration) for browser and server |
| `home.js` | Home: greeting sentence, Today's focus, recommendations, first day, empty states |
| `auth.js` | Runs on every page: Supabase session check, saves your data to your account row, toasts |
| `device.js` | Runs first on every page: phone / tablet / laptop, app vs website |
| `devices.css` | Layout for every device: full-screen app on phones/tablets, website on laptops |
| `pwa.js` + `sw.js` + `manifest.webmanifest` + `icons/` + `offline.html` | Installable app, offline support, install banner, offline notice |
| `focus.js` | Focus Mode (timer, pill, complete → next up) on every page |
| `calendar-views.js` | Calendar Month / Week / Day, navigation, date picker, drag / resize / click-to-create |
| `journal-link.js` | Journal ↔ planning: review prompt and the once-a-day suggestion |
| `app-extras.js` | Real streak, Profile page stats and settings, Streak page, daily reminder |
| `extras.css` | Styles for the above + phone layout fixes |
| `home.html`, `planner.html` (Planora), `journal.html`, `calendar.html`, `profile.html`, `streak.html` | App pages |
| `script.js`, `planner.js`, `calendar.js`, `ai-assistant.js`, `style.css` | Original app logic and styles |
