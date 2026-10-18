-- =========================================================
-- PLANORA — Reminders (push notifications)
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to run again (it only creates what's missing).
--
-- planora_push_subs  : one row per device that turned reminders on
--                      (the browser's push address + its public keys).
-- planora_push_queue : the reminders to send: the morning summary and
--                      "starts in 15 minutes" for each task and event.
--                      The app rewrites a person's upcoming reminders
--                      whenever their plans change.
--
-- Row Level Security is ON with NO policies: nobody can read or change
-- these tables from the app or with the public (anon) key. Only Planora's
-- server can, using the service-role key kept in Render's settings.
-- Deleting an account deletes its rows too.
-- =========================================================

create table if not exists public.planora_push_subs (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references auth.users (id) on delete cascade,
    endpoint    text not null unique,
    p256dh      text not null,
    auth        text not null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists planora_push_subs_user on public.planora_push_subs (user_id);

create table if not exists public.planora_push_queue (
    id          bigint generated always as identity primary key,
    user_id     uuid not null references auth.users (id) on delete cascade,
    fire_at     timestamptz not null,
    kind        text not null default 'task',
    title       text not null,
    body        text not null default '',
    url         text not null default '/home.html',
    tag         text not null default '',
    sent_at     timestamptz,
    created_at  timestamptz not null default now()
);
create index if not exists planora_push_queue_due  on public.planora_push_queue (fire_at) where sent_at is null;
create index if not exists planora_push_queue_user on public.planora_push_queue (user_id);

alter table public.planora_push_subs  enable row level security;
alter table public.planora_push_queue enable row level security;
-- (no policies on purpose: only the server's service-role key can use these tables)
revoke all on public.planora_push_subs  from anon, authenticated;
revoke all on public.planora_push_queue from anon, authenticated;
