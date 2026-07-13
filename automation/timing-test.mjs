// Temporary: dry-run fillAndSubmit against one real job to verify phase
// timing logs and the chip-wait rework. No DB writes, no submission.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { fillAndSubmit } from './lib/fill.mjs';
import { env } from './lib/util.mjs';

const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

const { data: job } = await sb.from('job_postings').select('*')
  .eq('id', process.env.JOB_ID || '601c3ed3-2d00-4340-bbf6-45858347040c').single();
const { data: profile } = await sb.from('job_profile').select('*').limit(1).single();

const dir = await mkdtemp(join(tmpdir(), 'timing-test-'));
const { data: pdf } = await sb.storage.from('job-docs').download(profile.resume_path);
const resume = join(dir, `${(profile.full_name || 'My').trim().replace(/\s+/g, '_')}_Resume.pdf`);
await writeFile(resume, Buffer.from(await pdf.arrayBuffer()));

const t0 = Date.now();
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1600 } })).newPage();
console.log(`▶ ${job.company} — ${job.title} (${job.ats}) DRY RUN`);
try {
  const r = await fillAndSubmit(page, job, profile, { resume }, { dryRun: true });
  console.log(`\nTOTAL ${((Date.now() - t0) / 1000).toFixed(1)}s → ${r.status}: ${r.detail}`);
  for (const [q, a] of Object.entries(r.answers)) console.log(`  • ${q} → ${a}`);
} catch (e) {
  console.error('FAILED:', e.message);
}
await browser.close();
