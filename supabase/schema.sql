-- =========================================================
-- PLANORA — Supabase schema
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to run again (it only creates what's missing).
--
-- One row per user. Every sign-in method (email, Google, Apple) gives
-- the same Supabase user id, so the same row and the same data.
--   profile : name, onboarding answers (prefs), onboarded flag
--   data    : Planora's saved data (tasks, goals, events, journal…)
-- Row Level Security: a user can only ever see or change their own row.
-- =========================================================

create table if not exists public.planora_user_data (
    user_id    uuid primary key references auth.users (id) on delete cascade,
    profile    jsonb not null default '{}'::jsonb,
    data       jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

alter table public.planora_user_data enable row level security;

drop policy if exists "Users read their own Planora data"   on public.planora_user_data;
drop policy if exists "Users create their own Planora row"  on public.planora_user_data;
drop policy if exists "Users update their own Planora data" on public.planora_user_data;
drop policy if exists "Users delete their own Planora data" on public.planora_user_data;

create policy "Users read their own Planora data"
    on public.planora_user_data for select
    to authenticated
    using ((select auth.uid()) = user_id);

create policy "Users create their own Planora row"
    on public.planora_user_data for insert
    to authenticated
    with check ((select auth.uid()) = user_id);

create policy "Users update their own Planora data"
    on public.planora_user_data for update
    to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

create policy "Users delete their own Planora data"
    on public.planora_user_data for delete
    to authenticated
    using ((select auth.uid()) = user_id);

-- Only signed-in users can touch the table at all (no anonymous access).
revoke all on public.planora_user_data from anon;
grant select, insert, update, delete on public.planora_user_data to authenticated;


-- "Delete my account" (Profile → Privacy and data).
-- Deleting a sign-in needs admin rights, so this small function runs with
-- them, but it can only ever delete the account of the person calling it.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    me uuid := auth.uid();
begin
    if me is null then
        raise exception 'Not signed in';
    end if;
    delete from public.planora_user_data where user_id = me;
    delete from auth.users where id = me;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
