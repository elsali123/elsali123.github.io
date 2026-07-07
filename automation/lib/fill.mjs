// Playwright-based application form filler for Greenhouse / Lever / Ashby.
//
// Strategy: navigate to the apply form, enumerate visible fields, answer each
// from (1) standard profile fields, (2) the user's saved common_answers,
// (3) Claude — then submit and verify a confirmation appears.
//
// Returns { status: 'submitted'|'needs_review'|'failed', detail, answers }.
import { llmAnswer } from './llm.mjs';

const STANDARD = [
  [/first\s*name/i, (p) => (p.full_name || '').split(/\s+/)[0]],
  [/last\s*name|family\s*name|surname/i, (p) => (p.full_name || '').split(/\s+/).slice(1).join(' ')],
  [/full\s*name|^name$|your\s*name/i, (p) => p.full_name],
  [/e-?mail/i, (p) => p.email],
  [/phone|mobile/i, (p) => p.phone],
  [/linkedin/i, (p) => p.linkedin],
  [/github/i, (p) => p.github],
  [/portfolio|website|personal\s*site/i, (p) => p.website],
  [/current\s*(location|city)|^location|where.*(located|based)/i, (p) => p.location],
  [/school|university|college|institution/i, (p) => p.school],
  [/degree\s*(type|level)?$/i, (p) => p.degree],
  [/major|discipline|field\s*of\s*study|concentration/i, (p) => p.major],
  [/grad(uation)?\s*(date|year|month)|expected\s*grad/i, (p) => p.grad_date],
  [/\bgpa\b|grade\s*point/i, (p) => p.gpa],
  [/authoriz|legally\s*(able|permitted)\s*to\s*work|work\s*eligib/i, (p) => p.work_auth],
  [/sponsor(ship)?|visa/i, (p) => p.needs_sponsorship],
  [/gender(?!\s*identity\s*describe)/i, (p) => p.gender],
  [/race|ethnicit/i, (p) => p.race],
  [/veteran/i, (p) => p.veteran],
  [/disabilit/i, (p) => p.disability],
  [/how\s*did\s*you\s*hear|hear\s*about\s*(us|this)/i, () => 'Other'],
  [/pronouns/i, () => ''],
];

function savedAnswer(label, common) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const nl = norm(label);
  for (const [q, a] of Object.entries(common || {})) {
    const nq = norm(q);
    if (nq && (nl.includes(nq) || nq.includes(nl))) return a;
  }
  return null;
}

async function resolveAnswer(label, options, profile, job, answers) {
  for (const [re, get] of STANDARD) {
    if (re.test(label)) {
      const v = get(profile);
      if (v != null && v !== '') return matchOption(v, options) ?? v;
    }
  }
  const saved = savedAnswer(label, profile.common_answers);
  if (saved) return matchOption(saved, options) ?? saved;
  const llm = await llmAnswer(label, options, profile, job);
  answers[label] = `${llm} (AI)`;
  return llm;
}

// Snap a desired value onto the closest option string, if options exist.
function matchOption(value, options) {
  if (!options?.length) return null;
  const v = String(value).toLowerCase();
  return options.find((o) => o.toLowerCase() === v)
      || options.find((o) => o.toLowerCase().includes(v) || v.includes(o.toLowerCase()))
      || null;
}

async function labelFor(el) {
  return (await el.evaluate((node) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').replace(/\s*[*✱]\s*$/, '').trim();
    if (node.labels?.length) return clean(node.labels[0].textContent);
    const aria = node.getAttribute('aria-label'); if (aria) return clean(aria);
    const labelled = node.getAttribute('aria-labelledby');
    if (labelled) {
      const t = labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (t.trim()) return clean(t);
    }
    const wrap = node.closest('label'); if (wrap) return clean(wrap.textContent);
    // Greenhouse/Ashby wrap fields in a container whose first text is the question.
    const container = node.closest('[class*="field" i], [class*="question" i], li, fieldset, div');
    const lbl = container?.querySelector('label, legend, [class*="label" i]');
    if (lbl) return clean(lbl.textContent);
    return clean(node.getAttribute('placeholder') || node.name || '');
  })) || '';
}

async function hasCaptcha(page) {
  return await page.locator(
    'iframe[src*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], ' +
    '.g-recaptcha, [class*="h-captcha"], [data-sitekey]'
  ).count() > 0;
}

// Navigate to the actual application form for each ATS.
async function gotoForm(page, job) {
  if (job.ats === 'lever') {
    const base = job.url.replace(/[?#].*$/, '').replace(/\/apply$/, '');
    await page.goto(`${base}/apply`, { waitUntil: 'domcontentloaded' });
  } else {
    await page.goto(job.url, { waitUntil: 'domcontentloaded' });
    // Greenhouse new boards + Ashby show the form behind an Apply button/tab.
    const applyBtn = page.getByRole('button', { name: /^apply/i }).or(
      page.getByRole('link', { name: /^apply/i })).first();
    if (await applyBtn.count() && !(await page.locator('input[type="file"]').count())) {
      await applyBtn.click().catch(() => {});
      await page.waitForTimeout(1500);
    }
  }
  await page.waitForSelector('input, textarea, select', { timeout: 15000 });
}

export async function fillAndSubmit(page, job, profile, files, opts = {}) {
  const answers = {};
  await gotoForm(page, job);

  if (await hasCaptcha(page)) {
    return { status: 'needs_review', detail: 'CAPTCHA on form — apply manually', answers };
  }

  // ---- File uploads (resume required, transcript when a slot exists) ----
  const fileInputs = page.locator('input[type="file"]');
  for (let i = 0; i < await fileInputs.count(); i++) {
    const input = fileInputs.nth(i);
    const label = (await labelFor(input)).toLowerCase();
    if (/transcript/.test(label) && files.transcript) {
      await input.setInputFiles(files.transcript); answers[label || 'transcript'] = 'transcript.pdf';
    } else if (/resume|cv/.test(label) || i === 0) {
      await input.setInputFiles(files.resume); answers[label || 'resume'] = 'resume.pdf';
    }
  }
  await page.waitForTimeout(2000); // let async resume-parse prefill run

  // ---- Text inputs & textareas ----
  const textFields = page.locator(
    'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type]), textarea');
  for (let i = 0; i < await textFields.count(); i++) {
    const el = textFields.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    if (await el.inputValue().catch(() => '')) continue;      // keep prefilled values
    const label = await labelFor(el);
    if (!label || /search/i.test(label)) continue;
    // Custom comboboxes (react-select etc.): type then pick the first option.
    const isCombo = await el.evaluate((n) => n.getAttribute('role') === 'combobox'
      || n.closest('[class*="select" i], [role="combobox"]') !== null);
    const value = await resolveAnswer(label, null, profile, job, answers);
    if (value == null || value === '') continue;
    if (isCombo) {
      await el.click().catch(() => {});
      await el.fill(String(value)).catch(() => el.pressSequentially(String(value)).catch(() => {}));
      await page.waitForTimeout(600);
      const opt = page.locator('[role="option"]').first();
      if (await opt.count()) await opt.click().catch(() => {});
      else await el.press('Enter').catch(() => {});
    } else {
      await el.fill(String(value)).catch(() => {});
    }
    answers[label] ??= String(value);
  }

  // ---- Native selects ----
  const selects = page.locator('select');
  for (let i = 0; i < await selects.count(); i++) {
    const el = selects.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    if (await el.inputValue().catch(() => '')) continue;
    const label = await labelFor(el);
    const options = (await el.locator('option').allTextContents())
      .map((t) => t.trim()).filter((t) => t && !/^select|^choose|^--/i.test(t));
    if (!label || !options.length) continue;
    const value = await resolveAnswer(label, options, profile, job, answers);
    const picked = matchOption(value, options) || options[0];
    await el.selectOption({ label: picked }).catch(() => {});
    answers[label] ??= picked;
  }

  // ---- Radio / checkbox groups (yes-no style questions) ----
  const groups = await page.locator('fieldset:has(input[type="radio"]), [role="radiogroup"]').all();
  for (const group of groups) {
    const label = (await group.locator('legend, [class*="label" i]').first().textContent().catch(() => ''))?.trim();
    if (!label) continue;
    const opts = await group.locator('label').allTextContents();
    const clean = opts.map((t) => t.trim()).filter(Boolean);
    if (!clean.length) continue;
    const value = await resolveAnswer(label, clean, profile, job, answers);
    const picked = matchOption(value, clean) || clean[0];
    await group.locator(`label:has-text("${picked.replace(/"/g, '\\"')}")`).first().click().catch(() => {});
    answers[label] ??= picked;
  }

  if (await hasCaptcha(page)) {
    return { status: 'needs_review', detail: 'CAPTCHA appeared before submit — apply manually', answers };
  }
  if (opts.dryRun) {
    return { status: 'dry_run', detail: 'DRY RUN — form filled, nothing submitted', answers };
  }
  if (profile.auto_submit === false) {
    return { status: 'needs_review', detail: 'Auto-submit disabled in profile; form was validated but not sent', answers };
  }

  // ---- Submit & verify ----
  const submit = page.locator('button[type="submit"], input[type="submit"]')
    .or(page.getByRole('button', { name: /submit/i })).first();
  if (!(await submit.count())) return { status: 'needs_review', detail: 'No submit button found', answers };
  await submit.click();

  try {
    await page.waitForFunction(() => {
      const t = document.body.innerText.toLowerCase();
      return /thank you|application (submitted|received|complete)|we('|’)ve received|successfully submitted/.test(t);
    }, { timeout: 20000 });
    return { status: 'submitted', detail: 'Confirmation detected', answers };
  } catch {
    const errText = (await page.locator('[class*="error" i], [role="alert"]').allTextContents())
      .map((t) => t.trim()).filter(Boolean).slice(0, 3).join(' | ');
    return {
      status: 'needs_review',
      detail: errText ? `Form errors after submit: ${errText}` : 'No confirmation detected after submit — verify manually',
      answers,
    };
  }
}
