// One-off maintenance: remove duplicate job_postings.
//   node dedupe-postings.mjs            # dry run — prints the plan, changes nothing
//   node dedupe-postings.mjs --apply    # actually repoint apps/notes + delete dupes
//
// Two duplicate patterns are collapsed:
//   1. Same normalized URL (query/hash/trailing-slash stripped) → identical
//      posting. Keep ONE row.
//   2. Same company+title where a Greenhouse row exists alongside non-Greenhouse
//      rows → keep the Greenhouse row(s), drop the others. (Groups with no
//      Greenhouse row are left alone — same title can be genuinely different
//      reqs on Workday/iCIMS/Oracle, so we don't guess.)
//
// Keeper priority within a URL group: Greenhouse > other direct ATS
// (lever/ashby/workday) > aggregator (simplify/internlist/manual); ties broken
// by earliest first_seen. The keeper inherits the earliest first_seen in its
// group so the feed's "new" badge stays honest.
//
// applications.job_id and job_notes.job_id are FK ON DELETE CASCADE, so before
// deleting a loser we repoint its apps/notes to the keeper (or drop them if the
// keeper already has one for that user, to respect the unique constraints).
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { postingKey } from './lib/util.mjs';

const APPLY = process.argv.includes('--apply');

const env = Object.fromEntries(
  (await readFile(new URL('./.env.local', import.meta.url), 'utf8'))
    .split('\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; })
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const urlKey = postingKey;   // shared canonical identity (see lib/util.mjs)
const isGH = (r) => r.ats === 'greenhouse' || r.source === 'greenhouse';
const isAggregator = (s) => s === 'simplify' || s === 'internlist' || s === 'manual';

// Lower rank = better keeper. A Greenhouse job often appears twice with the
// same URL: once from the direct Greenhouse API (source='greenhouse') and once
// from Simplify (source='simplify', ats='greenhouse'). Prefer the direct-API
// row — stabler external_id and cleaner title — then any greenhouse-ATS row,
// then other direct ATSs, then aggregators.
function rank(r) {
  if (r.source === 'greenhouse') return 0;
  if (r.ats === 'greenhouse') return 1;
  if (!isAggregator(r.source)) return 2;   // lever/ashby/workday direct
  return 3;                                 // aggregator / other
}
// Pick the survivor of a group; also returns the earliest first_seen to inherit.
function pickKeeper(group) {
  const keeper = [...group].sort((a, b) =>
    rank(a) - rank(b) || new Date(a.first_seen) - new Date(b.first_seen))[0];
  const earliest = group.reduce((m, r) =>
    new Date(r.first_seen) < new Date(m) ? r.first_seen : m, group[0].first_seen);
  return { keeper, earliest };
}

// ---- load everything (paged) ----
async function loadAll(table, cols) {
  let out = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + 999);
    if (error) throw error;
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

const postings = await loadAll('job_postings', 'id,source,ats,external_id,company,title,url,first_seen');
const apps = await loadAll('applications', 'id,user_id,job_id,status');
const notes = await loadAll('job_notes', 'user_id,job_id');
console.log(`Loaded ${postings.length} postings, ${apps.length} applications, ${notes.length} notes`);

// loserId -> keeperId, and keeperId -> earliest first_seen to set
const remap = new Map();
const keeperFirstSeen = new Map();
const keptIds = new Set();

// ---- Pass 1: exact normalized-URL duplicates ----
const byURL = new Map();
for (const r of postings) {
  const k = urlKey(r.url);
  if (!byURL.has(k)) byURL.set(k, []);
  byURL.get(k).push(r);
}
// survivors after pass 1 (one row per URL)
const survivors = [];
let urlDupCount = 0;
for (const group of byURL.values()) {
  if (group.length === 1) { survivors.push(group[0]); continue; }
  const { keeper, earliest } = pickKeeper(group);
  survivors.push(keeper);
  keptIds.add(keeper.id);
  keeperFirstSeen.set(keeper.id, earliest);
  for (const r of group) if (r.id !== keeper.id) { remap.set(r.id, keeper.id); urlDupCount++; }
}

// ---- Pass 2: company+title groups where Greenhouse coexists with non-GH ----
const byCT = new Map();
for (const r of survivors) {
  const k = norm(r.company) + '|' + norm(r.title);
  if (!byCT.has(k)) byCT.set(k, []);
  byCT.get(k).push(r);
}
let ghPrefCount = 0;
for (const group of byCT.values()) {
  if (group.length === 1) continue;
  const gh = group.filter(isGH);
  const nonGh = group.filter((r) => !isGH(r));
  if (!gh.length || !nonGh.length) continue;   // need both to apply the GH rule
  // Keep every greenhouse row; the earliest-seen GH row absorbs the losers.
  const { keeper } = pickKeeper(gh);
  const priorEarliest = keeperFirstSeen.get(keeper.id) ?? keeper.first_seen;
  const earliestMs = Math.min(
    new Date(priorEarliest).getTime(),
    ...nonGh.map((r) => new Date(r.first_seen).getTime())
  );
  keeperFirstSeen.set(keeper.id, new Date(earliestMs).toISOString());
  for (const r of nonGh) { remap.set(r.id, keeper.id); ghPrefCount++; }
}

// A loser might point to a keeper that is itself a loser (shouldn't happen given
// pass structure, but resolve transitively to be safe).
function resolve(id) {
  let seen = new Set();
  while (remap.has(id) && !seen.has(id)) { seen.add(id); id = remap.get(id); }
  return id;
}
for (const [loser] of remap) remap.set(loser, resolve(loser));

const loserIds = [...remap.keys()];
console.log(`\nPlan:`);
console.log(`  URL-duplicate rows to remove:            ${urlDupCount}`);
console.log(`  Greenhouse-preferred rows to remove:     ${ghPrefCount}`);
console.log(`  Total rows to delete:                    ${loserIds.length}`);
console.log(`  Postings remaining after cleanup:        ${postings.length - loserIds.length}`);

// ---- applications: keep the most-advanced status per (user, keeper job) ----
// When a user has applications on several rows that collapse to one keeper, we
// keep whichever reached the furthest status (a real 'submitted' must never be
// dropped in favor of a 'failed'/'staged' duplicate) and repoint it onto the
// keeper; the rest are removed.
const STATUS_RANK = { submitted: 6, needs_review: 5, applying: 4, failed: 3, abandoned: 2, ready: 1, staged: 0 };
const srank = (s) => STATUS_RANK[s] ?? -1;
const keeperJob = (jobId) => remap.get(jobId) ?? jobId;

// Group every app by (user, keeper job it maps to).
const appGroups = new Map();
for (const a of apps) {
  const k = a.user_id + '|' + keeperJob(a.job_id);
  if (!appGroups.has(k)) appGroups.set(k, []);
  appGroups.get(k).push(a);
}
const appRepoint = [], appDrop = [];
for (const [k, group] of appGroups) {
  const target = k.split('|')[1];
  // Only groups touched by the dedup (some app is on a loser row) need work.
  if (!group.some((a) => remap.has(a.job_id))) continue;
  // Winner: furthest status, tiebreak the one already on the keeper.
  const winner = [...group].sort((a, b) =>
    srank(b.status) - srank(a.status) || (a.job_id === target ? -1 : 1))[0];
  for (const a of group) if (a.id !== winner.id) appDrop.push(a);
  if (winner.job_id !== target) appRepoint.push({ id: winner.id, target, status: winner.status });
}
const noteByUserJob = new Set(notes.map((n) => n.user_id + '|' + n.job_id));
const noteRepoint = [], noteDrop = [];
const claimed = new Set();   // (user,keeper) slots already taken by a repoint
for (const n of notes) {
  if (!remap.has(n.job_id)) continue;
  const target = remap.get(n.job_id);
  const slot = n.user_id + '|' + target;
  // Drop if the keeper already has a note, or another loser note already
  // claimed this keeper slot in this run (notes PK is (user_id, job_id)).
  if (noteByUserJob.has(slot) || claimed.has(slot)) noteDrop.push(n);
  else { claimed.add(slot); noteRepoint.push({ user_id: n.user_id, from: n.job_id, target }); }
}
console.log(`  Applications to repoint (winner→keeper):  ${appRepoint.length}`);
console.log(`  Applications to drop (inferior dupes):    ${appDrop.length}`);
console.log(`  Notes to repoint:                        ${noteRepoint.length}`);
console.log(`  Notes to drop:                           ${noteDrop.length}`);

if (appRepoint.length || appDrop.length) {
  console.log('\n  Affected applications:');
  for (const a of appRepoint) console.log(`    keep+repoint app ${a.id} (${a.status}) → ${a.target}`);
  for (const a of appDrop) console.log(`    drop app ${a.id} (${a.status}, job ${a.job_id})`);
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing changed. Re-run with --apply to execute.');
  process.exit(0);
}

// ---- execute ----
// Order matters: drop inferior apps FIRST (frees the unique(user_id,job_id)
// slot), then repoint winners onto the keeper, then delete loser postings
// (which would otherwise cascade-delete a winner still sitting on a loser row).
console.log('\nApplying…');
for (const a of appDrop) {
  const { error } = await sb.from('applications').delete().eq('id', a.id);
  if (error) throw error;
}
for (const a of appRepoint) {
  const { error } = await sb.from('applications')
    .update({ job_id: a.target, updated_at: new Date().toISOString() }).eq('id', a.id);
  if (error) throw error;
}
for (const n of noteRepoint) {
  const { error } = await sb.from('job_notes')
    .update({ job_id: n.target }).eq('user_id', n.user_id).eq('job_id', n.from);
  if (error) throw error;
}
for (const n of noteDrop) {
  const { error } = await sb.from('job_notes').delete().eq('user_id', n.user_id).eq('job_id', n.job_id);
  if (error) throw error;
}
// Update keepers' first_seen to the earliest in their group.
for (const [id, fs] of keeperFirstSeen) {
  const { error } = await sb.from('job_postings').update({ first_seen: fs }).eq('id', id);
  if (error) throw error;
}
// Delete losers in batches.
let deleted = 0;
for (let i = 0; i < loserIds.length; i += 100) {
  const chunk = loserIds.slice(i, i + 100);
  const { error } = await sb.from('job_postings').delete().in('id', chunk);
  if (error) throw error;
  deleted += chunk.length;
}
console.log(`Done. Deleted ${deleted} duplicate postings.`);
