-- =========================================================
-- PLANORA — Google Calendar link
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to run again (it only creates what's missing).
--
-- One row per user who linked Google Calendar.
--   google_email : which Google account is linked (shown in the app)
--   token_enc    : Google's long-lived permission, ENCRYPTED by Planora's
--                  server (AES-256-GCM, key only in the server's settings).
--                  Planora's web page never sees the real token.
--   calendars    : which of their Google calendars to show ([] = the ones
--                  ticked in Google Calendar itself)
--   scopes       : what the person allowed in Google's window
--   sync         : copy Planora tasks/events into Google Calendar (on/off)
--   planora_cal  : the id of the "Planora" calendar Planora made in their Google account
-- Row Level Security: a user can only ever see or change their own row.
-- Deleting the account deletes this row too.
-- =========================================================

create table if not exists public.planora_google_calendar (
    user_id      uuid primary key references auth.users (id) on delete cascade,
    google_email text not null default '',
    token_enc    text not null,
    calendars    jsonb not null default '[]'::jsonb,
    updated_at   timestamptz not null default now(),
    created_at   timestamptz not null default now()
);

-- added 3 Oct 2026: Planora → Google Calendar sync
alter table public.planora_google_calendar add column if not exists scopes      text    not null default '';
alter table public.planora_google_calendar add column if not exists sync        boolean not null default false;
alter table public.planora_google_calendar add column if not exists planora_cal text    not null default '';

alter table public.planora_google_calendar enable row level security;

drop policy if exists "Users read their own Google link"   on public.planora_google_calendar;
drop policy if exists "Users create their own Google link" on public.planora_google_calendar;
drop policy if exists "Users update their own Google link" on public.planora_google_calendar;
drop policy if exists "Users delete their own Google link" on public.planora_google_calendar;

create policy "Users read their own Google link"
    on public.planora_google_calendar for select
    to authenticated
    using ((select auth.uid()) = user_id);

create policy "Users create their own Google link"
    on public.planora_google_calendar for insert
    to authenticated
    with check ((select auth.uid()) = user_id);

create policy "Users update their own Google link"
    on public.planora_google_calendar for update
    to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

create policy "Users delete their own Google link"
    on public.planora_google_calendar for delete
    to authenticated
    using ((select auth.uid()) = user_id);

revoke all on public.planora_google_calendar from anon;
grant select, insert, update, delete on public.planora_google_calendar to authenticated;
