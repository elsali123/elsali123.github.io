// Job sources. Each fetcher returns rows shaped for the job_postings table:
// { source, ats, external_id, company, title, locations, url, term, posted_at, raw }
// All fetchers are best-effort: a failing company/repo logs and is skipped.
import { classifyPosting, detectAts, fetchJson, TARGET_TERMS } from './util.mjs';

// ---------- SimplifyJobs GitHub repos ----------
// The community keeps structured listings at .github/scripts/listings.json on
// the dev branch. Terms live in each listing's `terms` array. We try every
// candidate repo and ignore 404s so this keeps working as new season repos appear.
const SIMPLIFY_REPOS = [
  'SimplifyJobs/Summer2027-Internships',
  'SimplifyJobs/Summer2026-Internships',
  'vanshb03/Summer2026-Internships',
];

export async function fetchSimplify() {
  const rows = [];
  for (const repo of SIMPLIFY_REPOS) {
    const url = `https://raw.githubusercontent.com/${repo}/dev/.github/scripts/listings.json`;
    let listings;
    try { listings = await fetchJson(url); }
    catch (e) { console.warn(`simplify: skipping ${repo}: ${e.message}`); continue; }
    for (const l of listings) {
      if (l.is_visible === false || l.active === false) continue;
      const terms = (l.terms || []).filter((t) => TARGET_TERMS.includes(t));
      if (!terms.length) continue;
      rows.push({
        source: 'simplify',
        ats: detectAts(l.url),
        external_id: l.id || `${l.company_name}|${l.title}|${l.url}`,
        company: l.company_name,
        title: l.title,
        locations: (l.locations || []).join('; '),
        url: l.url,
        term: terms[0],
        posted_at: l.date_posted ? new Date(l.date_posted * 1000).toISOString() : null,
        raw: l,
      });
    }
    console.log(`simplify: ${repo} → ${rows.length} cumulative target-term rows`);
  }
  return rows;
}

// ---------- Greenhouse public board API (free, no key) ----------
export async function fetchGreenhouse(boards) {
  const rows = [];
  for (const board of boards) {
    try {
      const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs`);
      for (const j of data.jobs || []) {
        const term = classifyPosting(j.title);
        if (!term) continue;
        rows.push({
          source: 'greenhouse', ats: 'greenhouse',
          external_id: `${board}/${j.id}`,
          company: board, title: j.title,
          locations: j.location?.name || '',
          url: j.absolute_url,
          term,
          posted_at: j.updated_at || null,
          raw: { board, id: j.id },
        });
      }
    } catch (e) { console.warn(`greenhouse: skipping ${board}: ${e.message}`); }
  }
  return rows;
}

// ---------- Lever public postings API (free, no key) ----------
export async function fetchLever(companies) {
  const rows = [];
  for (const c of companies) {
    try {
      const postings = await fetchJson(`https://api.lever.co/v0/postings/${c}?mode=json`);
      for (const p of postings) {
        const term = classifyPosting(p.text, p.descriptionPlain || '');
        if (!term) continue;
        rows.push({
          source: 'lever', ats: 'lever',
          external_id: p.id,
          company: c, title: p.text,
          locations: p.categories?.location || '',
          url: p.hostedUrl,
          term,
          posted_at: p.createdAt ? new Date(p.createdAt).toISOString() : null,
          raw: { company: c, id: p.id },
        });
      }
    } catch (e) { console.warn(`lever: skipping ${c}: ${e.message}`); }
  }
  return rows;
}

// ---------- Workday CXS search API (free, no key; discovery-only ATS) ----------
// Entries look like "nvidia.wd5/NVIDIAExternalCareerSite" (host prefix / site).
// Country facet ids vary by tenant, so search broadly and let the title
// classifier + US location filter narrow it down. apply.mjs can't fill
// Workday (per-company accounts), so these surface as apply-manually links.
export async function fetchWorkday(tenants) {
  const rows = [];
  for (const entry of tenants) {
    try {
      const [host, site] = entry.split('/');
      const tenant = host.split('.')[0];
      const base = `https://${host}.myworkdayjobs.com`;
      const seen = rows.length;
      for (let offset = 0; offset < 300; offset += 20) {
        const data = await fetchJson(`${base}/wday/cxs/${tenant}/${site}/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: 'intern' }),
        });
        for (const j of data.jobPostings || []) {
          const term = classifyPosting(j.title);
          if (!term || !j.externalPath) continue;
          rows.push({
            source: 'workday', ats: 'workday',
            external_id: `${tenant}/${j.bulletFields?.[0] || j.externalPath}`,
            company: tenant, title: j.title,
            locations: j.locationsText || '',
            url: `${base}/${site}${j.externalPath}`,
            term,
            posted_at: null, // postedOn is relative text ("Posted 3 Days Ago")
            raw: { tenant: entry, id: j.bulletFields?.[0] },
          });
        }
        if (offset + 20 >= (data.total || 0)) break;
      }
      console.log(`workday: ${entry} → ${rows.length - seen} rows`);
    } catch (e) { console.warn(`workday: skipping ${entry}: ${e.message}`); }
  }
  return rows;
}

// ---------- Ashby public posting API (free, no key) ----------
export async function fetchAshby(boards) {
  const rows = [];
  for (const b of boards) {
    try {
      const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${b}`);
      for (const j of data.jobs || []) {
        const term = classifyPosting(j.title, j.descriptionPlain || '');
        if (!term) continue;
        rows.push({
          source: 'ashby', ats: 'ashby',
          external_id: j.id,
          company: b, title: j.title,
          locations: j.location || '',
          url: j.jobUrl || j.applyUrl,
          term,
          posted_at: j.publishedAt || null,
          raw: { board: b, id: j.id },
        });
      }
    } catch (e) { console.warn(`ashby: skipping ${b}: ${e.message}`); }
  }
  return rows;
}
