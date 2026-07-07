-- ============================================================
-- Auto-Apply feature schema
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- Job postings discovered by the hourly scraper (written by the
-- GitHub Action using the service-role key, read by logged-in users).
create table if not exists job_postings (
  id          uuid primary key default gen_random_uuid(),
  source      text not null,          -- simplify | greenhouse | lever | ashby
  ats         text,                   -- greenhouse | lever | ashby | workday | other
  external_id text not null,          -- stable id from the source, for dedupe
  company     text not null,
  title       text not null,
  locations   text,
  url         text not null,
  term        text,                   -- 'Winter 2026' | 'Summer 2027' | 'Unspecified'
  active      boolean default true,
  posted_at   timestamptz,
  first_seen  timestamptz default now(),
  raw         jsonb,
  unique (source, external_id)
);
create index if not exists job_postings_first_seen_idx on job_postings (first_seen desc);

-- One row per (user, job) the user chose to apply to.
-- status: queued → applying → submitted | needs_review | failed | skipped
create table if not exists applications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  job_id     uuid not null references job_postings(id) on delete cascade,
  status     text not null default 'queued',
  detail     text,                    -- human-readable failure/review reason
  answers    jsonb,                   -- question → answer actually used on the form
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, job_id)
);
create index if not exists applications_status_idx on applications (status);

-- The user's application profile: contact info, standard fields, saved
-- answers to common questions, and pointers to uploaded docs.
create table if not exists job_profile (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  full_name       text, email text, phone text,
  linkedin        text, github text, website text,
  location        text,
  school          text, degree text, major text, grad_date text, gpa text,
  work_auth       text,               -- e.g. 'US Citizen', 'Requires sponsorship'
  needs_sponsorship text,             -- 'Yes' | 'No'
  gender          text, race text, veteran text, disability text,
  common_answers  jsonb default '{}'::jsonb,  -- { "question text": "answer" }
  extra_context   text,               -- freeform context the LLM can draw on
  resume_path     text,               -- storage path in job-docs bucket
  transcript_path text,
  resume_text     text,               -- extracted text, filled by apply run
  auto_submit     boolean default true,
  updated_at      timestamptz default now()
);

-- ---------- Row Level Security ----------
alter table job_postings enable row level security;
alter table applications enable row level security;
alter table job_profile  enable row level security;

-- Any logged-in user can read the shared job feed; only the service
-- role (scraper) writes it.
drop policy if exists "jobs readable by authed" on job_postings;
create policy "jobs readable by authed" on job_postings
  for select to authenticated using (true);

-- Users manage only their own applications and profile.
drop policy if exists "own applications" on applications;
create policy "own applications" on applications
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own profile" on job_profile;
create policy "own profile" on job_profile
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- Storage bucket for resume / transcript ----------
insert into storage.buckets (id, name, public)
values ('job-docs', 'job-docs', false)
on conflict (id) do nothing;

drop policy if exists "own docs read"   on storage.objects;
drop policy if exists "own docs write"  on storage.objects;
drop policy if exists "own docs update" on storage.objects;
drop policy if exists "own docs delete" on storage.objects;
create policy "own docs read" on storage.objects
  for select to authenticated
  using (bucket_id = 'job-docs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own docs write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'job-docs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own docs update" on storage.objects
  for update to authenticated
  using (bucket_id = 'job-docs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own docs delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'job-docs' and (storage.foldername(name))[1] = auth.uid()::text);
