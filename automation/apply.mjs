// Apply worker: picks up queued applications from Supabase, fills each with
// Playwright, emails a status summary. Submission always requires a human in
// the loop (ASSIST/HEADED session or explicit AUTO_SUBMIT=1).
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { extractText, getDocumentProxy } from 'unpdf';
import { fillAndSubmit } from './lib/fill.mjs';
import { env, sendEmail, esc, detectAts, loadPriorAnswers } from './lib/util.mjs';

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

  // Extract resume text once for LLM context, persist for future runs.
  if (!p.resume_text) {
    try {
      const buf = await (await sb.storage.from('job-docs').download(p.resume_path)).data.arrayBuffer();
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(pdf, { mergePages: true });
      p.resume_text = text.slice(0, 15000);
      await sb.from('job_profile').update({ resume_text: p.resume_text }).eq('user_id', userId);
    } catch (e) { console.warn('resume text extraction failed:', e.message); }
  }

  const entry = { profile: p, files };
  profiles.set(userId, entry);
  return entry;
}

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
    await setStatus(app.id, 'needs_review', `Unsupported ATS (${job.ats}) — apply manually: ${job.url}`);
    results.push({ tag, status: 'needs_review', detail: `unsupported ATS ${job.ats}`, url: job.url });
    console.log(`  → skipped: unsupported ATS (${job.ats})`);
    continue;
  }

  // Answers already given to this company (earlier applications, this run's
  // included) get reused before asking the LLM again.
  job.priorAnswers = await loadPriorAnswers(sb, job, app.id).catch(() => ({}));

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
      let confirmed = false;
      while (Date.now() < deadline && !confirmed) {
        confirmed = await page.evaluate(() =>
          /thank you|application (submitted|received|complete)|we('|’)ve received|successfully submitted/i
            .test(document.body.innerText)).catch(() => false);
        if (!confirmed) await page.waitForTimeout(5000);
      }
      r = confirmed
        ? { ...r, status: 'submitted', detail: 'Submitted manually in assisted session' }
        : { ...r, status: 'needs_review', detail: 'Assisted session ended without submission' };
      console.log(confirmed ? '  ✅ manual submission confirmed' : '  ⏭ not submitted — leaving as needs_review');
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
    await page.screenshot({ path: `failure-${app.id}.png`, fullPage: true }).catch(() => {});
    await setStatus(app.id, 'failed', e.message);
    results.push({ tag, status: 'failed', detail: e.message, url: job.url });
    console.warn(`  → failed: ${e.message}`);
  } finally {
    await ctx.close();
  }
}
await browser.close();

// ---- Status email ----
if (DRY_RUN) { console.log('\n🧪 DRY RUN complete — no statuses changed, no email sent.'); process.exit(0); }
const icon = { submitted: '✅', needs_review: '👀', failed: '❌' };
const items = results.map((r) =>
  `<li>${icon[r.status] || '•'} <b>${esc(r.tag)}</b> — ${esc(r.status)}: ${esc(r.detail)}` +
  (r.url && r.status !== 'submitted' ? ` (<a href="${esc(r.url)}">open</a>)` : '') + '</li>').join('\n');
const submitted = results.filter((r) => r.status === 'submitted').length;
await sendEmail(
  `📨 Auto-apply run: ${submitted}/${results.length} submitted`,
  `<ul>${items}</ul><p><a href="https://elsali.dev/jobs.html">Dashboard</a></p>`
);
