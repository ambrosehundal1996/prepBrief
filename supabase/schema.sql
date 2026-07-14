-- PrepBrief: user profiles, usage tracking, and Stripe billing metadata.
-- Run in the Supabase SQL editor after enabling Email auth in Authentication → Providers.
-- Table/function/trigger names use the prepbrief_ prefix for multi-project Supabase orgs.

-- ---------------------------------------------------------------------------
-- Profiles (one row per auth.users)
-- ---------------------------------------------------------------------------
create table if not exists public.prepbrief_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  briefs_used int not null default 0,
  plan text not null default 'free'
    check (plan in ('free', 'job_seeker', 'intensive')),
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text,
  period_briefs_used int not null default 0,
  period_start date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists prepbrief_profiles_stripe_customer_id_idx
  on public.prepbrief_profiles (stripe_customer_id);

-- Auto-create profile on sign-up
create or replace function public.prepbrief_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.prepbrief_profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists prepbrief_on_auth_user_created on auth.users;
create trigger prepbrief_on_auth_user_created
  after insert on auth.users
  for each row execute function public.prepbrief_handle_new_user();

-- Row-level security: users can read their own profile
alter table public.prepbrief_profiles enable row level security;

drop policy if exists "prepbrief_users_read_own_profile" on public.prepbrief_profiles;
create policy "prepbrief_users_read_own_profile"
  on public.prepbrief_profiles for select
  using (auth.uid() = id);

-- Server uses service_role key (bypasses RLS) for writes and usage checks.
