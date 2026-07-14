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
  // Plain "Country" = country of residence. Citizenship/nationality questions
  // stay with the LLM — the profile doesn't store citizenship.
  [/\bcountry\b(?!.*(citizen|national))/i, () => 'United States'],
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
  // Education *date* questions ("Start month/year of university") would greedily
  // match the school/degree patterns — route them to saved answers / the LLM,
  // which can reason from grad_date and the resume.
  const eduDate = /\b(start|end|month|year|date)\b/i.test(label)
    && /\b(school|university|college|education|degree)\b/i.test(label)
    && !/graduation|expected grad/i.test(label);
  if (!eduDate) for (const [re, get] of STANDARD) {
    if (re.test(label)) {
      const v = get(profile);
      if (v != null && v !== '') return matchOption(v, options) ?? v;
    }
  }
  const saved = savedAnswer(label, profile.common_answers);
  if (saved) return matchOption(saved, options) ?? saved;
  const t = Date.now();
  const llm = await llmAnswer(label, options, profile, job);
  console.log(`    ⏱ LLM ${((Date.now() - t) / 1000).toFixed(1)}s — ${label.slice(0, 60)}`);
  answers[label] = `${llm} (AI)`;
  return llm;
}

// Snap a desired value onto the closest option string, if options exist.
// Whole-word containment only — "No" must never match the "no" inside
// "Yes, I will need sponsorship support NOw".
function matchOption(value, options) {
  if (!options?.length) return null;
  const norm = (s) => String(s).toLowerCase().trim();
  const v = norm(value);
  const rex = (s) => new RegExp(`(^|[^a-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
  return options.find((o) => norm(o) === v)
      || options.find((o) => rex(v).test(norm(o)) || rex(norm(o)).test(v))
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

// Only VISIBLE captcha challenges block us — Greenhouse et al. use invisible
// reCAPTCHA that auto-passes on submit; if it doesn't, the "no confirmation
// detected" check after submit still catches it.
async function hasCaptcha(page) {
  const boxes = page.locator(
    'iframe[src*="captcha" i], .g-recaptcha, [class*="h-captcha"], [data-sitekey]');
  for (let i = 0; i < await boxes.count(); i++) {
    const el = boxes.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    // The floating "protected by reCAPTCHA" badge (256×60, bottom corner) is
    // invisible mode, not a challenge — don't let it abort the fill.
    const badge = await el.evaluate((n) =>
      !!n.closest('.grecaptcha-badge') || /size=invisible/.test(n.src || '')).catch(() => false);
    if (badge) continue;
    const box = await el.boundingBox().catch(() => null);
    if (box && box.width > 40 && box.height > 40) return true;
  }
  return false;
}

// A real challenge in an attended session isn't fatal: the human solves it,
// we fill as usual once it clears.
async function waitForHumanCaptcha(page, opts) {
  if (!opts.interactive) return false;
  console.log("  🧩 CAPTCHA on the form — solve it in the browser and I'll start filling (waiting up to 5 min)…");
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (!(await hasCaptcha(page))) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

// Navigate to the actual application form for each ATS.
async function gotoForm(page, job) {
  if (job.ats === 'lever') {
    const base = job.url.replace(/[?#].*$/, '').replace(/\/apply$/, '');
    await page.goto(`${base}/apply`, { waitUntil: 'domcontentloaded' });
  } else {
    await page.goto(job.url, { waitUntil: 'domcontentloaded' });
    // Embedded Greenhouse (company site with ?gh_jid=…) renders the real form
    // in an iframe — jump straight to the hosted form URL instead.
    if (job.ats === 'greenhouse' && !page.url().includes('greenhouse.io')) {
      const frame = page.locator('iframe[src*="greenhouse.io"]').first();
      try {
        await frame.waitFor({ timeout: 10000 });
        const src = await frame.getAttribute('src');
        if (src) await page.goto(src, { waitUntil: 'domcontentloaded' });
      } catch { /* no iframe appeared — generic filler may still find a form */ }
    }
    // Greenhouse new boards + Ashby show the form behind an Apply button/tab.
    const applyBtn = page.getByRole('button', { name: /^apply/i }).or(
      page.getByRole('link', { name: /^apply/i })).first();
    if (await applyBtn.count() && !(await page.locator('input[type="file"]').count())) {
      await applyBtn.click().catch(() => {});
      await page.waitForTimeout(1500);
    }
  }
  await page.waitForSelector('input, textarea, select', { timeout: 15000 });
  // React boards paint before they hydrate; a pre-hydration click on Attach
  // does nothing. 'load' means the bundles at least arrived.
  await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
  // Cookie banners (OneTrust & co.) swallow the first click on Attach.
  await page.locator('#onetrust-accept-btn-handler, button:has-text("Accept all")').first()
    .click({ timeout: 1500 }).catch(() => {});
}

// react-select combobox (Greenhouse's new boards): open the menu, offer the
// visible options to the answer resolver, type to filter, click the matching
// option, then VERIFY the selection stuck (single-value chip present).
async function fillReactSelect(page, combo, label, profile, job, answers) {
  await combo.click().catch(() => {});
  await page.waitForTimeout(400);
  // ":visible" is critical — e.g. intl-tel-input phone widgets keep a hidden
  // 200+ item country list with role=option in the DOM at all times.
  const menuOpts = (await page.locator('[role="option"]:visible').allTextContents().catch(() => []))
    .map((t) => t.trim()).filter(Boolean);
  // Small menus (months, yes/no) become real choices; huge/async ones (schools)
  // are treated as free-text search.
  const asChoices = menuOpts.length && menuOpts.length <= 25 ? menuOpts : null;
  let value = await resolveAnswer(label, asChoices, profile, job, answers);
  if (value == null || value === '') { await combo.press('Escape').catch(() => {}); return false; }
  // The typed text acts as a FILTER — it must be an actual menu option or
  // nothing will match ("No." ≠ "No", "Authorized to work…" ≠ "Yes").
  if (asChoices) {
    let snapped = matchOption(String(value).replace(/[.!]$/, ''), asChoices);
    if (!snapped) {
      const reask = await llmAnswer(label, asChoices, profile, job).catch(() => null);
      snapped = reask ? matchOption(reask, asChoices) : null;
      if (snapped) answers[label] = `${snapped} (AI)`;
    }
    if (snapped) value = snapped;
  }
  // Compound answers ("Computer Science and Math"): a multi-select gets every
  // segment selected; a single-select falls back to the first segment when
  // the full text has no menu match.
  const segments = String(value).split(/\s+(?:and|&|\/)\s+|,/i).map((s) => s.trim()).filter(Boolean);
  const isMulti = await combo.evaluate((n) =>
    n.getAttribute('aria-multiselectable') === 'true'
    || !!(n.closest('[class*="container" i]') || n.closest('div')?.parentElement)
        ?.querySelector('[class*="multi" i]'),
  ).catch(() => false);
  const wanted = (isMulti && segments.length > 1) ? segments : [String(value)];

  const pickOne = async (text, allowShorten) => {
    await combo.fill('').catch(() => {});
    await combo.pressSequentially(text.slice(0, 50), { delay: 15 }).catch(() => {});
    await page.waitForTimeout(1500);
    const options = page.locator('[role="option"]:visible');
    if (!(await options.count().catch(() => 0)) && allowShorten
        && segments[0] && segments[0].length < text.length) {
      await combo.fill('').catch(() => {});
      await combo.pressSequentially(segments[0].slice(0, 50), { delay: 15 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    let target = options.filter({ hasText: text.slice(0, 30) }).first();
    if (!(await target.count().catch(() => 0))) target = options.first();
    if (await target.count().catch(() => 0)) await target.click({ timeout: 5000 }).catch(() => {});
    else await combo.press('Enter').catch(() => {});
  };
  for (const seg of wanted) await pickOne(seg, wanted.length === 1);

  await page.waitForTimeout(300);
  const shown = await combo.evaluate((n) => {
    // single-value/multi-value chips live inside the select CONTROL, which is
    // an ancestor of the input (not of its tiny input-container).
    const scope = n.closest('[class*="control" i]')?.parentElement
      || n.closest('[class*="control" i]')
      || n.closest('div')?.parentElement?.parentElement;
    if (!scope) return '';
    const multi = [...scope.querySelectorAll('[class*="multi-value" i]')]
      .map((c) => c.textContent.trim()).filter(Boolean);
    if (multi.length) return [...new Set(multi)].join(', ');
    return (scope.querySelector('[class*="single-value" i]')?.textContent || '').trim();
  }).catch(() => '');
  if (!shown) await combo.press('Escape').catch(() => {});
  if (!answers[label] || !shown) answers[label] = shown || `${value} (NOT ACCEPTED)`;
  return !!shown;
}

// List required fields the DOM still considers empty (ground truth after filling).
async function auditRequired(page) {
  return await page.evaluate(() => {
    const out = [];
    const clean = (s) => (s || '').replace(/\s+/g, ' ').replace(/\s*[*✱]\s*$/, '').trim();
    const nameOf = (el) => clean(el.labels?.[0]?.textContent
      || el.getAttribute('aria-label') || el.closest('label')?.textContent
      || el.closest('div,li,fieldset')?.querySelector('label,legend')?.textContent
      || el.name || el.id) || 'Unlabeled field';
    // react-select's hidden companion inputs never carry a value even when a
    // selection was made — the visible chip in a nearby ancestor is the truth.
    // 2 levels only: a real react-select companion sits inside the value
    // container beside its chip; wider walks catch NEIGHBORING fields' chips.
    const nearbyChip = (el) => {
      let c = el.parentElement;
      for (let k = 0; k < 2 && c; k++, c = c.parentElement) {
        if (c.querySelector('[class*="single-value" i], [class*="multi-value" i]')) return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll(
      'input[required], textarea[required], select[required], [aria-required="true"]')) {
      const type = (el.type || '').toLowerCase();
      if (type === 'file') {
        // Uploaders often reset the input after handing off to S3 — accept a
        // rendered filename near the input as proof of attachment.
        if (el.files?.length) continue;
        let c = el.parentElement, hasDoc = false;
        for (let k = 0; k < 4 && c; k++, c = c.parentElement) {
          if (/\.(pdf|docx?|txt|rtf)\b/i.test(c.innerText || '')) { hasDoc = true; break; }
        }
        if (!hasDoc) out.push(nameOf(el));
        continue;
      }
      if (type === 'checkbox' || type === 'radio') {
        const group = el.name ? document.querySelectorAll(`[name="${el.name}"]`) : [el];
        if (![...group].some((g) => g.checked)) out.push(nameOf(el)); continue;
      }
      if (!(el.value || '').trim() && !nearbyChip(el)) out.push(nameOf(el));
    }
    return [...new Set(out)].slice(0, 20);
  }).catch(() => []);
}

// Second pass for required fields the direct fill didn't stick on: drive the
// VISIBLE widget the way a person would (select2 search boxes, file-chooser
// dialogs, radio groups outside fieldsets).
async function repairRequired(page, job, profile, files, answers) {
  const req = page.locator('input[required], textarea[required], select[required], [aria-required="true"]');
  for (let i = 0; i < await req.count(); i++) {
    const el = req.nth(i);
    const info = await el.evaluate((n) => ({
      tag: n.tagName.toLowerCase(),
      type: (n.type || '').toLowerCase(),
      id: n.id,
      empty: (n.type || '').toLowerCase() === 'file'
        ? !(n.files?.length)
        : ((n.type || '').toLowerCase().match(/checkbox|radio/)
          ? !(n.name ? [...document.querySelectorAll(`[name="${n.name}"]`)] : [n]).some((g) => g.checked)
          : !(n.value || '').trim()),
      s2: !!(n.nextElementSibling && /select2/i.test(n.nextElementSibling.className || '')),
      // A selection chip nearby means the visible widget IS filled — the
      // hidden companion input just never carries a value.
      chip: (() => {
        let c = n.parentElement;
        for (let k = 0; k < 2 && c; k++, c = c.parentElement) {
          if (c.querySelector('[class*="single-value" i], [class*="multi-value" i]')) return true;
        }
        return false;
      })(),
      // The combobox this hidden input belongs to, if any — search only the
      // IMMEDIATE field container (2 levels), never distant wrappers.
      comboId: (() => {
        let c = n.parentElement;
        for (let k = 0; k < 2 && c; k++, c = c.parentElement) {
          const q = c.querySelector('input[role="combobox"]');
          if (q) return q.id || null;
        }
        return null;
      })(),
    })).catch(() => null);
    if (!info?.empty || info.chip) continue;
    const label = (await labelFor(el)) || 'This required field';

    // ---- file inputs: use the real file-chooser flow via the Attach control ----
    if (info.type === 'file') {
      const trigger = page.locator(
        'a[data-source="attach"]:visible, button:has-text("Attach"):visible, ' +
        'label:has-text("Attach"):visible, button:has-text("Upload"):visible').first();
      if (await trigger.count()) {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
          trigger.click().catch(() => {}),
        ]);
        if (chooser) {
          await chooser.setFiles(/transcript/i.test(label) && files.transcript ? files.transcript : files.resume);
          await page.waitForTimeout(4000); // async upload → their validation state
          answers[`file repair: ${label}`] = 'attached via chooser';
        }
      }
      continue;
    }

    // ---- hidden companions of react-select comboboxes, or straggler text
    // inputs the main loop missed (forms inject fields as answers land) ----
    if ((info.tag === 'input' && !['file', 'radio', 'checkbox'].includes(info.type))
        || info.tag === 'textarea') {
      const combo = info.comboId ? page.locator(`[id="${info.comboId}"]`).first() : null;
      if (combo && await combo.count().catch(() => 0)) {
        const comboLabel = (await labelFor(combo)) || label;
        await fillReactSelect(page, combo, comboLabel, profile, job, answers);
      } else if (await el.isVisible().catch(() => false)) {
        const value = await resolveAnswer(label, null, profile, job, answers);
        if (value != null && value !== '') {
          await el.fill(String(value)).catch(() => {});
          answers[label] ??= String(value);
        }
      }
      continue;
    }

    // ---- radios/checkboxes not caught by the fieldset pass ----
    if (info.type === 'radio' || info.type === 'checkbox') {
      const name = await el.getAttribute('name').catch(() => null);
      const group = name ? page.locator(`input[name="${name}"]`) : el;
      const labels = [];
      for (let g = 0; g < await group.count(); g++) {
        labels.push((await labelFor(group.nth(g))) || '');
      }
      const clean = labels.filter(Boolean);
      const value = await resolveAnswer(label, clean.length ? clean : null, profile, job, answers);
      const idx = Math.max(0, clean.findIndex((l) => l === (matchOption(value, clean) || clean[0])));
      await group.nth(idx).check({ force: true }).catch(() => {});
      answers[label] ??= clean[idx] || String(value);
      continue;
    }

    // ---- select2-backed selects: click container, type in search, pick result ----
    if (info.tag === 'select') {
      const options = (await el.locator('option').allTextContents())
        .map((t) => t.trim()).filter((t) => t && !/^select|^choose|^--/i.test(t));
      const value = await resolveAnswer(label, options.length ? options : null, profile, job, answers);
      const container = info.id ? page.locator(`#s2id_${info.id}`).first() : null;
      const clickTarget = (container && await container.count()) ? container
        : page.locator(`select#${info.id} + .select2-container, select#${info.id} ~ .select2`).first();
      if (await clickTarget.count()) {
        await clickTarget.click().catch(() => {});
        const search = page.locator(
          '.select2-search input:visible, .select2-search__field:visible, .select2-input:visible').first();
        if (await search.count()) {
          await search.fill(String(value)).catch(() => {});
          await page.waitForTimeout(1500);
          const result = page.locator(
            '.select2-results li:not(.select2-no-results):visible, .select2-results__option:visible').first();
          if (await result.count()) await result.click().catch(() => {});
          else await search.press('Enter').catch(() => {});
        }
      }
      // Last resort: set value directly + fire events.
      if (!(await el.inputValue().catch(() => ''))) {
        await el.evaluate((node, want) => {
          const opt = [...node.options].find((o) => o.text.trim() === want)
            || [...node.options].find((o) => o.text.toLowerCase().includes(want.toLowerCase()));
          if (opt) {
            node.value = opt.value;
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, matchOption(value, options) || String(value)).catch(() => {});
      }
      const ok = await el.inputValue().catch(() => '');
      answers[label] = ok ? (matchOption(value, options) || String(value)) : `${value} (repair failed)`;
    }
  }
}

export async function fillAndSubmit(page, job, profile, files, opts = {}) {
  const answers = {};
  let tPhase = Date.now();
  const mark = (phase) => {
    console.log(`  ⏱ ${phase}: ${((Date.now() - tPhase) / 1000).toFixed(1)}s`);
    tPhase = Date.now();
  };
  await gotoForm(page, job);
  mark('open page → form ready');

  if (await hasCaptcha(page) && !(await waitForHumanCaptcha(page, opts))) {
    return { status: 'needs_review', detail: 'CAPTCHA on form — apply manually', answers };
  }

  // ---- File uploads (resume required, transcript when a slot exists) ----
  // The section around the input tells us resume vs transcript vs cover letter
  // more reliably than the input's own (often just "Attach") label.
  const fileInputs = page.locator('input[type="file"]');
  for (let i = 0; i < await fileInputs.count(); i++) {
    const input = fileInputs.nth(i);
    const section = ((await labelFor(input)) + ' ' + (await input.evaluate((n) => {
      const c = n.closest('[class*="field" i], [class*="question" i], [id*="resume" i], [id*="cover" i], [id*="transcript" i], div, li');
      return (c?.id || '') + ' ' + (c?.textContent || '').slice(0, 120);
    }).catch(() => ''))).toLowerCase();
    let file = null;
    if (/transcript/.test(section) && files.transcript) file = files.transcript;
    else if (/cover/.test(section)) continue;                       // no cover letter file
    else if (/resume|cv/.test(section) || i === 0) file = files.resume;
    if (!file) continue;
    const tag = file.split(/[\\/]/).pop(); // uploaded basename, e.g. Elsa_Li_Resume.pdf
    const tUpload = Date.now();
    // Chooser-first: React ATS uploaders (Greenhouse job-boards) ignore
    // programmatic input changes — only the Attach-button file dialog triggers
    // their real upload pipeline.
    // Attachment proof polls instead of one flat wait, so success returns in
    // ~a second: the filename anywhere on the page, or (for widgets that
    // rename the file) document-like text near the input — the same heuristic
    // auditRequired trusts.
    // Widgets truncate long filenames in the chip — match a prefix of the
    // basename, not the whole thing.
    const tagStart = tag.slice(0, 12);
    const chipShown = async (timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        // innerText covers any visible node (no .first()-lands-on-a-hidden-
        // match trap); input values cover read-only filename fields.
        if (await page.evaluate((needle) => document.body.innerText.includes(needle)
            || [...document.querySelectorAll('input')].some((i) => (i.value || '').includes(needle)),
        tagStart).catch(() => false)) return true;
        const near = await input.evaluate((n) => {
          let c = n.parentElement;
          for (let k = 0; k < 4 && c; k++, c = c.parentElement) {
            if (/\.(pdf|docx?|txt|rtf)\b/i.test(c.innerText || '')) return true;
          }
          return false;
        }).catch(() => false);
        if (near) return true;
        await page.waitForTimeout(500);
      }
      return false;
    };
    let shown = false;
    const attach = page.locator(
      'button:has-text("Attach"), a[data-source="attach"], label:has-text("Attach")').nth(i);
    if (await attach.count().catch(() => 0)) {
      // React boards hydrate the Attach button late — a too-early click does
      // nothing and the chooser never opens. Retry the hand-off a few times.
      let chooser = null;
      for (let tries = 0; tries < 4 && !chooser; tries++) {
        if (tries) await page.waitForTimeout(1500); // hydration may lag first paint
        [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null),
          attach.click({ timeout: 3000 }).catch(() => {}),
        ]);
      }
      if (!chooser) console.log(`    ⚠ Attach button never opened a file chooser (${tag})`);
      if (chooser) await chooser.setFiles(file).catch(() => {});
      if (chooser) shown = await chipShown();
    }
    if (!shown) {
      // Explicit timeout: Greenhouse replaces the input node after uploads,
      // and a detached target otherwise stalls for Playwright's 30s default.
      await input.setInputFiles(file, { timeout: 3000 }).catch(() => {});
      // Shorter second attempt — a failure here still gets one more shot in
      // the audit/repair pass.
      shown = await chipShown(8000);
    }
    answers[`file: ${tag}`] = shown ? 'attached ✓ (filename visible in form)' : 'FAILED to attach';
    console.log(`    ⏱ upload ${tag}: ${((Date.now() - tUpload) / 1000).toFixed(1)}s${shown ? '' : ' (no chip!)'}`);
  }
  await page.waitForTimeout(3000); // let async upload / resume-parse prefill run
  mark('file uploads + prefill wait');

  // ---- Text inputs & textareas ----
  const textFields = page.locator(
    'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input:not([type]), textarea');
  for (let i = 0; i < await textFields.count(); i++) {
    const el = textFields.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    if (await el.inputValue().catch(() => '')) continue;      // keep prefilled values
    const label = await labelFor(el);
    if (!label || /search/i.test(label)) continue;
    const isCombo = await el.evaluate((n) => n.getAttribute('role') === 'combobox'
      || /select__input/.test(n.className || ''));
    if (isCombo) {
      await fillReactSelect(page, el, label, profile, job, answers);
      continue;
    }
    const value = await resolveAnswer(label, null, profile, job, answers);
    if (value == null || value === '') continue;
    await el.fill(String(value)).catch(() => {});
    const finalVal = await el.inputValue().catch(() => '');
    answers[label] ??= finalVal ? finalVal : `${value} (NOT ACCEPTED by widget)`;
  }
  mark('text fields');

  // ---- Native selects ----
  const selects = page.locator('select');
  for (let i = 0; i < await selects.count(); i++) {
    const el = selects.nth(i);
    // NOTE: don't skip invisible selects — select2/styled dropdowns hide the
    // real <select>, but its value is what the form submits.
    if (await el.inputValue().catch(() => '')) continue;
    const label = await labelFor(el);
    const options = (await el.locator('option').allTextContents())
      .map((t) => t.trim()).filter((t) => t && !/^select|^choose|^--/i.test(t));
    if (!label || !options.length) continue;
    const value = await resolveAnswer(label, options, profile, job, answers);
    const picked = matchOption(value, options) || options[0];
    await el.selectOption({ label: picked }, { timeout: 3000 }).catch(async () => {
      // Hidden select (select2 & co): set the value directly and fire the
      // events the wrapper widget listens for.
      await el.evaluate((node, want) => {
        const opt = [...node.options].find((o) => o.text.trim() === want);
        if (opt) {
          node.value = opt.value;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, picked).catch(() => {});
    });
    const ok = await el.inputValue().catch(() => '');
    answers[label] ??= ok ? picked : `${picked} (NOT ACCEPTED by widget)`;
  }
  mark('native selects');

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
  mark('radio/checkbox groups');

  // ---- Audit + repair pass for stubborn widgets (select2, custom uploaders) ----
  let missing = await auditRequired(page);
  if (missing.length) {
    await repairRequired(page, job, profile, files, answers);
    missing = await auditRequired(page);
  }
  if (missing.length) answers['⚠ STILL EMPTY (required)'] = missing.join(' | ');
  mark('audit + repair');


  if (await hasCaptcha(page)) {
    return { status: 'needs_review', detail: 'CAPTCHA appeared before submit — apply manually', answers };
  }
  if (opts.dryRun) {
    return {
      status: 'dry_run',
      detail: missing.length
        ? `DRY RUN — ${missing.length} required field(s) still empty: ${missing.join('; ')}`
        : 'DRY RUN — all required fields filled, nothing submitted',
      answers,
    };
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
