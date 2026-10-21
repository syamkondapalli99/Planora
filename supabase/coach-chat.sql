-- =========================================================
-- PLANORA — Ask Planora chat memory
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to run again (it only creates what's missing).
--
-- One row per user: the last ~20 messages of their Ask Planora chat and a
-- short running summary of older ones, so Planora remembers "I haven't
-- finished module 2" or "I'm out 10–6".
--
-- Row Level Security: a user can only ever see or change their own row.
-- Planora's server reads and writes it with the person's OWN sign-in token,
-- so these rules apply on the server too (no admin key is used for this).
-- Deleting the account deletes this row (on delete cascade), and
-- Profile → Privacy and data → Clear chat history deletes it any time.
-- =========================================================

create table if not exists public.planora_chat (
    user_id    uuid primary key references auth.users (id) on delete cascade,
    messages   jsonb not null default '[]'::jsonb,
    summary    text  not null default '',
    updated_at timestamptz not null default now()
);

alter table public.planora_chat enable row level security;

drop policy if exists "Users read their own Planora chat"   on public.planora_chat;
drop policy if exists "Users create their own Planora chat" on public.planora_chat;
drop policy if exists "Users update their own Planora chat" on public.planora_chat;
drop policy if exists "Users delete their own Planora chat" on public.planora_chat;

create policy "Users read their own Planora chat"
    on public.planora_chat for select
    to authenticated
    using ((select auth.uid()) = user_id);

create policy "Users create their own Planora chat"
    on public.planora_chat for insert
    to authenticated
    with check ((select auth.uid()) = user_id);

create policy "Users update their own Planora chat"
    on public.planora_chat for update
    to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

create policy "Users delete their own Planora chat"
    on public.planora_chat for delete
    to authenticated
    using ((select auth.uid()) = user_id);

-- Only signed-in users can touch the table at all (no anonymous access).
revoke all on public.planora_chat from anon;
grant select, insert, update, delete on public.planora_chat to authenticated;
