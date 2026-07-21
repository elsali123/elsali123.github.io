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

// Dedupe within this run (same job can appear via an aggregator AND the direct
// API; prefer the direct-API row since its external_id is stabler). Between
// aggregators (simplify repos, internlist), keep the FIRST row so it upserts
// onto the external_ids already stored from earlier runs instead of duplicating.
const isAggregator = (s) => s === 'simplify' || s === 'internlist';
const byKey = new Map();
for (const row of rows) {
  const key = postingKey(row.url);
  const existing = byKey.get(key);
  if (!existing || (isAggregator(existing.source) && !isAggregator(row.source))) byKey.set(key, row);
}
// Second pass: an aggregator row describing a job we also fetched from a
// direct ATS API (same company+title) is a duplicate with a worse URL
// (e.g. internlist links go through jobright.ai interstitials).
const normKey = (r) => (r.company + '|' + r.title).toLowerCase().replace(/[^a-z0-9|]/g, '');
const directKeys = new Set([...byKey.values()].filter((r) => !isAggregator(r.source)).map(normKey));
const deduped = [...byKey.values()].filter((r) => !isAggregator(r.source) || !directKeys.has(normKey(r)));
console.log(`Fetched ${rows.length} rows → ${deduped.length} after dedupe`);

// Upsert, then find what's new: first_seen defaults to now() on INSERT only,
// so rows first seen after this run started are the fresh ones.
const runStart = new Date(Date.now() - 60_000).toISOString(); // 1 min skew allowance
if (deduped.length) {
  const { error } = await sb.from('job_postings').upsert(deduped, { onConflict: 'source,external_id' });
  if (error) throw error;
}
// Purge any stored rows that fail the US filter, or that the classifier
// would now reject (grad-only titles, bare fall/spring) — covers rows
// scraped before these filters existed, and future filter tightening.
const stored = await selectAll('job_postings', 'id, title, locations');
const nonUS = stored.filter((r) => !isUSLocation(r.locations)).map((r) => r.id);
const excluded = stored.filter((r) => !classifyPosting(r.title)).map((r) => r.id);
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
