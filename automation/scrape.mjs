// Hourly scraper: pull internships from all sources, upsert into Supabase,
// email a digest of anything new. Run by .github/workflows/job-scraper.yml.
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { fetchSimplify, fetchGreenhouse, fetchLever, fetchAshby, fetchWorkday, fetchInternList } from './lib/sources.mjs';
import { env, sendEmail, esc, isUSLocation, classifyPosting, postingKey } from './lib/util.mjs';

const DASHBOARD_URL = 'https://elsali.dev/jobs.html';

const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

const companies = JSON.parse(await readFile(new URL('./companies.json', import.meta.url), 'utf8'));

const results = await Promise.allSettled([
  fetchSimplify(),
  fetchGreenhouse(companies.greenhouse || []),
  fetchLever(companies.lever || []),
  fetchAshby(companies.ashby || []),
  fetchWorkday(companies.workday || []),
  fetchInternList(),
]);
const allRows = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
for (const r of results) if (r.status === 'rejected') console.warn('source failed:', r.reason);

// Fetch every row from a table, paginating past PostgREST's default 1000-row
// cap — with 2000+ postings now stored, a plain .select() silently truncates.
async function selectAll(table, columns, filter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(columns).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// US internships only.
const rows = allRows.filter((r) => isUSLocation(r.locations));
console.log(`US filter: ${allRows.length} → ${rows.length} rows`);

// How good a row's apply link is, lower = better. A direct ATS row links
// straight at the application form; simplify links at the employer's real
// posting; intern-list can only produce a Google search URL (ats:'search'),
// since its own "Apply" link is a jobright.ai interstitial behind a login.
// Same job from two sources → keep the one you can actually apply through.
const SOURCE_RANK = { greenhouse: 0, lever: 0, ashby: 0, workday: 0, manual: 0, simplify: 1, internlist: 2 };
const rank = (s) => SOURCE_RANK[s] ?? 1;

// Dedupe within this run. Same posting reached by two URLs collapses to the
// better-ranked source; its external_id is also stabler across runs.
const byKey = new Map();
for (const row of rows) {
  const key = postingKey(row.url);
  const existing = byKey.get(key);
  if (!existing || rank(row.source) < rank(existing.source)) byKey.set(key, row);
}

// Second pass: drop rows describing a job another source covers better.
// Grouping by company+title (not URL) is what catches intern-list's search
// URLs, which share no structure with the real posting's URL.
//
// Only strictly-worse tiers are dropped — every row in the best tier is
// kept. Employers legitimately post one role across many locations under
// identical company+title (RTX lists the same intern role in 13 cities,
// each its own Workday requisition), and those are separate applications,
// not duplicates.
const normKey = (r) => (r.company + '|' + r.title).toLowerCase().replace(/[^a-z0-9|]/g, '');
const bestRank = new Map();
for (const r of byKey.values()) {
  const k = normKey(r);
  const cur = bestRank.get(k);
  if (cur === undefined || rank(r.source) < cur) bestRank.set(k, rank(r.source));
}
const deduped = [...byKey.values()].filter((r) => rank(r.source) === bestRank.get(normKey(r)));
console.log(`Fetched ${rows.length} rows → ${deduped.length} after dedupe`);

// Upsert, then find what's new: first_seen defaults to now() on INSERT only,
// so rows first seen after this run started are the fresh ones.
const runStart = new Date(Date.now() - 60_000).toISOString(); // 1 min skew allowance
if (deduped.length) {
  const toUpsert = deduped.map(r => ({ ...r, active: true }));
  const { error } = await sb.from('job_postings').upsert(toUpsert, { onConflict: 'source,external_id' });
  if (error) throw error;
}
// applications.job_id references job_postings(id) on delete cascade — never
// delete a row a real application still points to, or the application (and
// its submission history) silently disappears with it.
const { data: refRows, error: refErr } = await sb.from('applications').select('job_id');
if (refErr) throw refErr;
const referencedIds = new Set((refRows || []).map((r) => r.job_id));

// Purge any stored rows that fail the US filter, or that the classifier
// would now reject (grad-only titles, bare fall/spring) — covers rows
// scraped before these filters existed, and future filter tightening.
const stored = await selectAll('job_postings', 'id, source, company, title, locations, first_seen, active');
const nonUS = stored.filter((r) => !isUSLocation(r.locations) && !referencedIds.has(r.id)).map((r) => r.id);
const excluded = stored.filter((r) => !classifyPosting(r.title) && !referencedIds.has(r.id)).map((r) => r.id);
const toPurge = [...new Set([...nonUS, ...excluded])];
for (let i = 0; i < toPurge.length; i += 100) {
  const { error } = await sb.from('job_postings').delete().in('id', toPurge.slice(i, i + 100));
  if (error) throw error;
}
if (nonUS.length) console.log(`Purged ${nonUS.length} non-US postings`);
if (excluded.length) console.log(`Purged ${excluded.length} grad-only/fall/spring postings`);

// intern-list.com's feed churns fast (postings rotate out within a day) and,
// unlike a company's own ATS board, a job missing from this run's fetch has
// no other signal that it's gone — its stale row would keep the dead
// jobright.ai link forever otherwise. Deactivate (not delete, so any
// application referencing it stays intact) whatever we didn't see this run.
const internlistSeenIds = new Set(allRows.filter((r) => r.source === 'internlist').map((r) => r.external_id));
if (internlistSeenIds.size) {
  const activeInternlist = await selectAll('job_postings', 'id, external_id',
    (q) => q.eq('source', 'internlist').eq('active', true));
  const staleIds = activeInternlist.filter((r) => !internlistSeenIds.has(r.external_id)).map((r) => r.id);
  for (let i = 0; i < staleIds.length; i += 100) {
    const { error } = await sb.from('job_postings').update({ active: false }).in('id', staleIds.slice(i, i + 100));
    if (error) throw error;
  }
  if (staleIds.length) console.log(`Deactivated ${staleIds.length} internlist postings no longer listed`);
} else {
  console.log('internlist fetch returned nothing this run — skipping staleness cleanup to be safe');
}

// Cross-run intern-list duplicates. intern-list reissues Airtable record ids
// for reposted listings, so the same job accumulates under several
// external_ids over time — the in-run dedupe above only ever sees one run's
// rows, so it cannot catch these. Deactivate rather than delete: reversible,
// hides them from the feed immediately, and the archival sweep retires them
// permanently once they age out.
//
// Two rows are only treated as the same posting when neither carries extra
// information: intern-list synthesizes its URL from company+title, so
// identical company+title always means an identical link. That is why this
// is scoped to intern-list and never applied across ATS sources, where the
// same company+title routinely means distinct per-location requisitions.
const purgedIds = new Set(toPurge);
const liveStored = stored.filter((r) => r.active !== false && !purgedIds.has(r.id));
const coveredByBetter = new Set(
  liveStored.filter((r) => r.source !== 'internlist').map(normKey)
);
const redundantIds = [];
const bestByKey = new Map();
for (const r of liveStored.filter((r) => r.source === 'internlist')) {
  const k = normKey(r);
  if (coveredByBetter.has(k)) { redundantIds.push(r.id); continue; }
  const prev = bestByKey.get(k);
  if (!prev) { bestByKey.set(k, r); continue; }
  // Keep whichever intern-list row we saw most recently; retire the other.
  const [keep, drop] = new Date(r.first_seen) > new Date(prev.first_seen) ? [r, prev] : [prev, r];
  bestByKey.set(k, keep);
  redundantIds.push(drop.id);
}
for (let i = 0; i < redundantIds.length; i += 100) {
  const { error } = await sb.from('job_postings').update({ active: false }).in('id', redundantIds.slice(i, i + 100));
  if (error) throw error;
}
if (redundantIds.length) {
  console.log(`Deactivated ${redundantIds.length} redundant intern-list postings (already covered by a better source, or superseded by a newer row)`);
}

// Roll old intern-list rows off into job_postings_archive so the live table
// can't grow unbounded again — intern-list mints a fresh Airtable record id
// for many reposted/duplicate listings, so raw accumulation over months of
// hourly runs ballooned this table into the hundreds of thousands of rows and
// degraded query performance project-wide.
//
// The move is a single atomic statement inside archive_stale_internlist()
// (see supabase/archive-internlist.sql), which also refuses to touch any
// posting an application references — applications.job_id cascades on delete.
// Non-fatal: if the function hasn't been installed yet, the scrape still
// succeeds and just skips the roll-off.
const { data: archivedCount, error: archiveErr } = await sb.rpc('archive_stale_internlist', {
  batch_limit: 5000,
  cutoff_days: 14,
});
if (archiveErr) console.warn('rolling internlist archival skipped:', archiveErr.message);
else if (archivedCount) console.log(`Rolling cleanup: archived ${archivedCount} stale internlist postings`);

const { data: fresh, error: freshErr } = await sb
  .from('job_postings')
  .select('company, title, url, term, locations, source')
  .gte('first_seen', runStart)
  .order('company');
if (freshErr) throw freshErr;
console.log(`Upserted ${deduped.length} postings, ${fresh.length} new`);

// Dedupe the digest by job identity so the same role can't appear twice; when a
// job was seen both on intern-list and elsewhere, keep the non-intern-list row
// so it lands in the main list.
const freshByKey = new Map();
for (const j of fresh) {
  const key = postingKey(j.url);
  const existing = freshByKey.get(key);
  if (!existing || (existing.source === 'internlist' && j.source !== 'internlist')) freshByKey.set(key, j);
}
const uniqueFresh = [...freshByKey.values()];
const mainFresh = uniqueFresh.filter((j) => j.source !== 'internlist');
// intern-list links go through opaque jobright.ai URLs, so they can't be
// identity-matched to a direct ATS row — fall back to company+title to drop any
// intern-list posting that's already in the main list ("found on both → main").
const ctKey = (j) => (j.company + '|' + j.title).toLowerCase().replace(/[^a-z0-9|]/g, '');
const mainCT = new Set(mainFresh.map(ctKey));
const internlistFresh = uniqueFresh.filter((j) => j.source === 'internlist' && !mainCT.has(ctKey(j)));

const li = (j) => `<li><b>${esc(j.company)}</b> — <a href="${esc(j.url)}">${esc(j.title)}</a>
   <small>(${esc(j.term)}${j.locations ? ' · ' + esc(j.locations) : ''})</small></li>`;

// Only intern-list postings are new → nothing worth an email (that feed is noisy
// and unverified; it lives in the dashboard's intern-list view instead).
if (!mainFresh.length) {
  console.log(internlistFresh.length
    ? `No new main-source postings; ${internlistFresh.length} intern-list-only — no digest sent.`
    : 'No new postings; no digest sent.');
} else {
  const internlistSection = internlistFresh.length
    ? `<hr style="margin:22px 0;border:none;border-top:1px solid #eee">
       <p><b>From intern-list.com</b> <small>(unverified aggregator — links go through jobright.ai)</small></p>
       <ul>${internlistFresh.map(li).join('\n')}</ul>`
    : '';
  await sendEmail(
    `🧑‍💻 ${mainFresh.length} new internship posting${mainFresh.length > 1 ? 's' : ''}`,
    `<p>New postings found this hour:</p><ul>${mainFresh.map(li).join('\n')}</ul>
     ${internlistSection}
     <p><a href="${DASHBOARD_URL}">Open the dashboard</a> to queue applications.</p>`
  );
}
