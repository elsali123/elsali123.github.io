-- ============================================================================
-- intern-list archival + job_postings performance
--
-- Context: intern-list mints a fresh Airtable record id for many reposted
-- listings, so hourly scraping accumulated ~270k rows in job_postings and
-- degraded every query project-wide (count(exact) began returning HTTP 500).
-- Stale rows move to job_postings_archive instead of being destroyed.
--
-- Run the steps in the order documented in each section header.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- STEP 1 — archive table
-- `like ... including defaults` mirrors job_postings' columns AND their order,
-- which `insert into ... select *` depends on. If job_postings ever gains a
-- column, add it here too or the archival insert will start failing.
-- ---------------------------------------------------------------------------
create table if not exists job_postings_archive (
  like job_postings including defaults
);

-- Idempotent re-archival: a row that gets rescraped, re-deactivated and
-- archived a second time should be skipped, not raise a duplicate-key error.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'job_postings_archive_pkey'
  ) then
    alter table job_postings_archive add primary key (id);
  end if;
end $$;

-- Deliberately NO foreign key back to applications. The whole point of the
-- archive is to outlive the job_postings row, and applications.job_id
-- cascades on delete -- a FK here would recreate the exact hazard this is
-- meant to avoid.

alter table job_postings_archive enable row level security;

drop policy if exists "archive readable by authed" on job_postings_archive;
create policy "archive readable by authed" on job_postings_archive
  for select to authenticated using (true);
-- No insert/update/delete policy: only the service role (scraper) writes it.


-- ---------------------------------------------------------------------------
-- STEP 2 — index (run BEFORE the bulk move; it makes the move fast too)
-- Every hot query filters on active + source and orders by first_seen.
-- Without this, Postgres sequentially scans and sorts the entire table even
-- for `limit 50`.
-- ---------------------------------------------------------------------------
create index if not exists job_postings_active_source_seen_idx
  on job_postings (active, source, first_seen desc);


-- ---------------------------------------------------------------------------
-- STEP 3 — the move, as a function
-- Atomic: the delete and the archival insert happen in one statement, so a
-- failure can't drop rows without preserving them.
--
-- The `not exists` clause is load-bearing: applications.job_id references
-- job_postings(id) ON DELETE CASCADE, so removing a posting an application
-- points at silently destroys that application and its history.
-- ---------------------------------------------------------------------------
create or replace function archive_stale_internlist(
  batch_limit int default 5000,
  cutoff_days int default 14
) returns int
language sql
set search_path = public
as $$
  with doomed as (
    select jp.id
    from job_postings jp
    where jp.source = 'internlist'
      and jp.active = false
      and jp.first_seen < now() - make_interval(days => cutoff_days)
      and not exists (select 1 from applications a where a.job_id = jp.id)
    limit batch_limit
  ),
  moved as (
    delete from job_postings jp
    using doomed d
    where jp.id = d.id
    returning jp.*
  ),
  archived as (
    insert into job_postings_archive
    select * from moved
    on conflict (id) do nothing
    returning 1
  )
  select count(*)::int from archived;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default, which in
-- Supabase means anon could invoke this over RPC and mass-delete postings.
revoke all on function archive_stale_internlist(int, int) from public;
revoke all on function archive_stale_internlist(int, int) from anon;
revoke all on function archive_stale_internlist(int, int) from authenticated;


-- ---------------------------------------------------------------------------
-- STEP 4 — drain the existing backlog
-- Re-run until it returns 0. Batched rather than one large transaction so no
-- single statement risks hitting the editor's statement timeout.
--
--   select archive_stale_internlist(25000, 14);
--
-- Progress check:
--   select count(*) from job_postings where source = 'internlist';
--   select count(*) from job_postings_archive;


-- ---------------------------------------------------------------------------
-- STEP 5 — reclaim (run LAST, alone)
-- VACUUM cannot run inside a transaction block, so it must be executed by
-- itself -- pasting it alongside other statements will error.
--
--   vacuum analyze job_postings;
-- ---------------------------------------------------------------------------
