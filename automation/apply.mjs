// Apply worker: picks up queued applications from Supabase, fills each with
// Playwright, emails a status summary. Submission always requires a human in
// the loop (ASSIST/HEADED session or explicit AUTO_SUBMIT=1).
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { extractText, getDocumentProxy } from 'unpdf';
import { fillAndSubmit } from './lib/fill.mjs';
import { env, sendEmail, esc, detectAts, loadPriorAnswers, loadDraftedAnswers } from './lib/util.mjs';

const MAX_PER_RUN = Number(process.env.MAX_APPLICATIONS_PER_RUN || 8);
const SUPPORTED_ATS = new Set(['greenhouse', 'lever', 'ashby']);
// DRY_RUN=1: fill forms but never submit, never change statuses, no email.
// HEADED=1: visible browser (for watching locally), slowed down a touch.
const DRY_RUN = process.env.DRY_RUN === '1';
// ASSIST=1: batch hand-submission session. Takes 'ready' applications (released
// via the dashboard's Apply-all button), fills each in a visible browser, and
// waits for YOU to review + click submit before moving to the next.
const ASSIST = process.env.ASSIST === '1';
const HEADED = process.env.HEADED === '1' || ASSIST;
if (DRY_RUN) console.log('🧪 DRY RUN — nothing will be submitted or written back');
if (ASSIST) console.log('🤝 ASSISTED SESSION — I fill, you submit each application by hand');

// Every submission needs a human present: an assisted/headed session, or an
// explicit AUTO_SUBMIT=1 opt-in. Refuse to run headless against real forms.
if (!DRY_RUN && !ASSIST && !HEADED && process.env.AUTO_SUBMIT !== '1') {
  console.log('⛔ Unattended run — refusing to submit. Use ASSIST=1 (you click submit), DRY_RUN=1, or set AUTO_SUBMIT=1 to override.');
  process.exit(0);
}

const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

const { data: queue, error: qErr } = await sb
  .from('applications')
  .select('*, job:job_postings(*)')
  .eq('status', ASSIST ? 'ready' : 'queued')
  .order('created_at')
  .limit(ASSIST ? 50 : MAX_PER_RUN);
if (qErr) throw qErr;
if (!queue?.length) { console.log('Queue empty — nothing to do.'); process.exit(0); }
console.log(`Processing ${queue.length} queued application(s)`);

async function setStatus(id, status, detail, answers) {
  if (DRY_RUN) return;
  // Leave stored answers alone unless this update carries new ones — the
  // 'applying' transition used to wipe them, killing cross-application reuse.
  const patch = { status, detail: detail?.slice(0, 500) ?? null, updated_at: new Date().toISOString() };
  if (answers !== undefined) patch.answers = answers;
  const { error } = await sb.from('applications').update(patch).eq('id', id);
  if (error) console.warn('status update failed:', error.message);
}

// ---- Load profiles + docs per user (usually just one user) ----
const profiles = new Map();
async function getProfile(userId) {
  if (profiles.has(userId)) return profiles.get(userId);
  const { data: p, error } = await sb.from('job_profile').select('*').eq('user_id', userId).single();
  if (error || !p) { profiles.set(userId, null); return null; }
  if (!p.resume_path) { profiles.set(userId, null); return null; }

  const dir = await mkdtemp(join(tmpdir(), 'apply-'));
  const dl = async (path, name) => {
    const { data, error: e } = await sb.storage.from('job-docs').download(path);
    if (e) throw new Error(`download ${path}: ${e.message}`);
    const file = join(dir, name);
    await writeFile(file, Buffer.from(await data.arrayBuffer()));
    return file;
  };
  // Recruiters see the filename — "Elsa_Li_Resume.pdf" beats "resume.pdf".
  const prefix = (p.full_name || 'My').trim().replace(/\s+/g, '_');
  const files = { resume: await dl(p.resume_path, `${prefix}_Resume.pdf`) };
  if (p.transcript_path) {
    try { files.transcript = await dl(p.transcript_path, `${prefix}_Transcript.pdf`); }
    catch (e) { console.warn(e.message); }
  }

  // Resume text is the LLM's context for answering application questions, so
  // it has to match the PDF actually being submitted. This used to extract
  // only when the column was empty, which meant uploading a revised resume
  // never invalidated it — answers kept citing the previous version's roles
  // and dates. Re-extract every run from the copy just downloaded (no extra
  // fetch), and only write back when it actually changed.
  try {
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(files.resume)));
    const { text } = await extractText(pdf, { mergePages: true });
    const fresh = text.slice(0, 15000);
    if (fresh && fresh !== p.resume_text) {
      const stale = Boolean(p.resume_text);
      p.resume_text = fresh;
      await sb.from('job_profile').update({ resume_text: fresh }).eq('user_id', userId);
      console.log(stale ? '📄 resume text refreshed — PDF changed since last run' : '📄 resume text extracted');
    }
  } catch (e) { console.warn('resume text extraction failed:', e.message); }

  p.draftedAnswers = await loadDraftedAnswers().catch((e) => { console.warn('drafted answers unavailable:', e.message); return {}; });

  const entry = { profile: p, files };
  profiles.set(userId, entry);
  return entry;
}

// Playwright reports a closed tab/window as an error on whatever call happens
// to touch the page next. Closing the tab right after clicking submit is the
// normal way a hand-submission ends, so this must never be recorded as a
// failure — 'failed' means the bot broke, and burying real breakage under
// dozens of these makes the status column useless.
const isTargetClosed = (e) =>
  /target (page|closed|crashed)|context or browser has been closed/i.test(e?.message || '');

// Post-submit confirmation, matched two ways because the tab often closes
// within a second of the click: page text (polled) and the main frame's URL
// (captured on navigation, so it survives the page being gone).
const CONFIRM_TEXT_RE = /thank you|application (submitted|received|complete)|we('|’)ve received|successfully submitted/i;
const CONFIRM_URL_RE = /confirmation|thank[-_]?you|application[-_]?(submitted|received|complete)|\bsubmitted\b/i;

// ---- Work the queue ----
const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 120 : 0 });
const results = [];
for (const [idx, app] of queue.entries()) {
  const job = app.job;
  // Recompute ATS from the URL in case the stored value predates detector fixes.
  if (!SUPPORTED_ATS.has(job.ats)) job.ats = detectAts(job.url);
  const tag = `${job.company} — ${job.title}`;
  const left = queue.length - idx - 1;
  console.log(`\n▶ [${idx + 1}/${queue.length}] ${tag} (${job.ats})`
    + (left ? ` — ${left} more after this` : ' — last one!'));
  await setStatus(app.id, 'applying');

  const entry = await getProfile(app.user_id).catch((e) => { console.warn(e.message); return null; });
  if (!entry) {
    await setStatus(app.id, 'failed', 'Profile incomplete — set your info and upload a resume on the dashboard first');
    results.push({ tag, status: 'failed', detail: 'profile incomplete' });
    continue;
  }
  if (!SUPPORTED_ATS.has(job.ats)) {
    // ats: 'search' (intern-list.com rows) has no real posting link at all —
    // say so plainly instead of implying job.url is the application page.
    const detail = job.ats === 'search'
      ? `No direct apply link (aggregator source) — the job link is a search for the real posting: ${job.url}`
      : `Unsupported ATS (${job.ats}) — apply manually: ${job.url}`;
    await setStatus(app.id, 'needs_review', detail);
    results.push({ tag, status: 'needs_review', detail: `unsupported ATS ${job.ats}`, url: job.url });
    console.log(`  → skipped: unsupported ATS (${job.ats})`);
    continue;
  }

  // Answers already given to this company (earlier applications, this run's
  // included) get reused before asking the LLM again.
  job.priorAnswers = await loadPriorAnswers(sb, job, app.id).catch(() => ({}));

  // Surface the user's note/category on this job right when it matters.
  const { data: noteRow } = await sb.from('job_notes').select('note, category')
    .eq('user_id', app.user_id).eq('job_id', app.job_id).maybeSingle();
  if (noteRow?.category === 'one_app_only') console.log('  ☝️ NOTE: this company allows only ONE application — make it count!');
  if (noteRow?.category === 'not_interested') console.log('  🚫 marked "no longer interested" — consider skipping this one');
  if (noteRow?.note) console.log(`  📝 your note: ${noteRow.note}`);

  // Tall viewport helps headless screenshots; a screen-sized one is used when
  // a human is watching (HEADED) so window scrolling behaves normally.
  const ctx = await browser.newContext({ viewport: HEADED ? { width: 1200, height: 800 } : { width: 1280, height: 1600 } });
  const page = await ctx.newPage();
  try {
    // ASSIST fills but never auto-submits (dryRun stops before the submit click).
    // interactive: a human is watching and can solve CAPTCHAs mid-fill.
    let r = await fillAndSubmit(page, job, entry.profile, entry.files,
      { dryRun: DRY_RUN || ASSIST, interactive: HEADED });
    // Hand-submission hold: in ASSIST for every app, otherwise only when a
    // headed real run got blocked (CAPTCHA) — watch for the confirmation page.
    const needsHuman = (ASSIST && (r.status === 'dry_run' || r.status === 'needs_review'))
      || (!DRY_RUN && !ASSIST && HEADED && r.status === 'needs_review');
    if (needsHuman) {
      const hold = Number(process.env.HOLD_SECONDS || 600);
      console.log(`  👤 Your turn — review and click submit (waiting up to ${Math.round(hold / 60)} min)…`);
      const deadline = Date.now() + hold * 1000;

      // Latch the confirmation the instant the form navigates, rather than
      // only when the next poll happens to catch it. Submitting and closing
      // the tab in one motion is the common case, and anything we can only
      // learn by reading the page is unrecoverable once it's closed.
      let confirmed = false;
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame() && CONFIRM_URL_RE.test(frame.url())) confirmed = true;
      });

      let closed = false;
      while (Date.now() < deadline && !confirmed && !closed) {
        if (page.isClosed()) { closed = true; break; }
        confirmed = await page
          .evaluate((src) => new RegExp(src, 'i').test(document.body.innerText), CONFIRM_TEXT_RE.source)
          .catch(() => { closed = page.isClosed(); return false; });
        // A page-independent sleep. page.waitForTimeout() rejects the moment
        // the tab closes, and that rejection escaped to the catch below —
        // which is how a successfully hand-submitted application ended up
        // recorded as 'failed'.
        if (!confirmed && !closed) await new Promise((res) => setTimeout(res, 1000));
      }

      if (confirmed) {
        r = { ...r, status: 'submitted', detail: 'Submitted manually in assisted session' };
        console.log('  ✅ manual submission confirmed');
      } else if (closed) {
        // You reviewed this one and closed the tab, which in practice means
        // you decided against it. 'abandoned' renders quietly on the
        // dashboard, so passing on a job doesn't build a to-do list.
        r = { ...r, status: 'abandoned', detail: 'Closed during review in assisted session' };
        console.log('  🗑 closed after review — marking abandoned');
      } else {
        r = { ...r, status: 'needs_review', detail: 'Assisted session ended without submission' };
        console.log('  ⏭ not submitted — leaving as needs_review');
      }
    }
    await setStatus(app.id, r.status, r.detail, r.answers); // no-op in DRY_RUN
    results.push({ tag, ...r, url: job.url });
    console.log(`  → ${r.status}: ${r.detail}`);
    if (DRY_RUN) {
      console.log('  Answers used:');
      for (const [q, a] of Object.entries(r.answers)) console.log(`    • ${q} → ${a}`);
      if (HEADED) {
        const hold = Number(process.env.HOLD_SECONDS || 120);
        console.log(`  Browser stays open ${hold}s so you can inspect the filled form…`);
        await page.waitForTimeout(hold * 1000);
      }
    }
  } catch (e) {
    // A closed tab is the human ending the session, not the automation
    // breaking. Reaching HERE means it closed before the form was ever put in
    // front of you (closing the window to stop a run blows through every
    // remaining queue entry this way), so this one was never actually
    // reviewed — send it back to 'ready' for the next session rather than
    // quietly retiring work you haven't seen. Deciding against a job you DID
    // review is the 'abandoned' branch above.
    const closedTarget = isTargetClosed(e);
    const status = closedTarget ? 'ready' : 'failed';
    const detail = closedTarget
      ? 'Session ended before this one was filled — requeued'
      : e.message;
    if (!closedTarget) await page.screenshot({ path: `failure-${app.id}.png`, fullPage: true }).catch(() => {});
    await setStatus(app.id, status, detail);
    results.push({ tag, status, detail, url: job.url });
    console.warn(`  → ${status}: ${detail}`);
  } finally {
    await ctx.close();
  }
}
await browser.close();

// ---- Status email ----
if (DRY_RUN) { console.log('\n🧪 DRY RUN complete — no statuses changed, no email sent.'); process.exit(0); }
const icon = { submitted: '✅', needs_review: '👀', failed: '❌', abandoned: '🗑', ready: '↩️' };
const items = results.map((r) =>
  `<li>${icon[r.status] || '•'} <b>${esc(r.tag)}</b> — ${esc(r.status)}: ${esc(r.detail)}` +
  (r.url && r.status !== 'submitted' ? ` (<a href="${esc(r.url)}">open</a>)` : '') + '</li>').join('\n');
const submitted = results.filter((r) => r.status === 'submitted').length;
await sendEmail(
  `📨 Auto-apply run: ${submitted}/${results.length} submitted`,
  `<ul>${items}</ul><p><a href="https://elsali.dev/jobs.html">Dashboard</a></p>`
);
