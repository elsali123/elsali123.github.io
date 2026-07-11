// Hourly scraper: pull internships from all sources, upsert into Supabase,
// email a digest of anything new. Run by .github/workflows/job-scraper.yml.
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { fetchSimplify, fetchGreenhouse, fetchLever, fetchAshby, fetchWorkday } from './lib/sources.mjs';
import { env, sendEmail, esc, isUSLocation } from './lib/util.mjs';

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
]);
const allRows = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
for (const r of results) if (r.status === 'rejected') console.warn('source failed:', r.reason);

// US internships only.
const rows = allRows.filter((r) => isUSLocation(r.locations));
console.log(`US filter: ${allRows.length} → ${rows.length} rows`);

// Dedupe within this run (same job can appear via Simplify AND the direct API;
// prefer the direct-API row since its external_id is stabler). Between two
// simplify-format repos, keep the FIRST (SimplifyJobs) row so it upserts onto
// the external_ids already stored from earlier runs instead of duplicating.
const byKey = new Map();
for (const row of rows) {
  const key = row.url.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
  const existing = byKey.get(key);
  if (!existing || (existing.source === 'simplify' && row.source !== 'simplify')) byKey.set(key, row);
}
const deduped = [...byKey.values()];
console.log(`Fetched ${rows.length} rows → ${deduped.length} after dedupe`);

// Upsert, then find what's new: first_seen defaults to now() on INSERT only,
// so rows first seen after this run started are the fresh ones.
const runStart = new Date(Date.now() - 60_000).toISOString(); // 1 min skew allowance
if (deduped.length) {
  const { error } = await sb.from('job_postings').upsert(deduped, { onConflict: 'source,external_id' });
  if (error) throw error;
}
// Purge any stored rows that fail the US filter (covers rows scraped
// before the filter existed, and future filter tightening).
const { data: stored, error: stErr } = await sb.from('job_postings').select('id, locations');
if (stErr) throw stErr;
const nonUS = (stored || []).filter((r) => !isUSLocation(r.locations)).map((r) => r.id);
for (let i = 0; i < nonUS.length; i += 100) {
  const { error } = await sb.from('job_postings').delete().in('id', nonUS.slice(i, i + 100));
  if (error) throw error;
}
if (nonUS.length) console.log(`Purged ${nonUS.length} non-US postings`);

const { data: fresh, error: freshErr } = await sb
  .from('job_postings')
  .select('company, title, url, term, locations')
  .gte('first_seen', runStart)
  .order('company');
if (freshErr) throw freshErr;
console.log(`Upserted ${deduped.length} postings, ${fresh.length} new`);

if (fresh.length) {
  const items = fresh
    .map((j) => `<li><b>${esc(j.company)}</b> — <a href="${esc(j.url)}">${esc(j.title)}</a>
       <small>(${esc(j.term)}${j.locations ? ' · ' + esc(j.locations) : ''})</small></li>`)
    .join('\n');
  await sendEmail(
    `🧑‍💻 ${fresh.length} new internship posting${fresh.length > 1 ? 's' : ''}`,
    `<p>New postings found this hour:</p><ul>${items}</ul>
     <p><a href="${DASHBOARD_URL}">Open the dashboard</a> to queue applications.</p>`
  );
} else {
  console.log('No new postings; no digest sent.');
}
