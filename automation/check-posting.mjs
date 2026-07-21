// Check when a job posting was first published and last updated by asking the
// ATS's public API (the job pages themselves rarely show dates).
//   node check-posting.mjs <job-url> [more-urls…]
// Supports Greenhouse, Lever, Ashby and Workday URLs. For postings on a
// company's own domain (e.g. janestreet.com/…/apply/8599644002/) it guesses
// Greenhouse board tokens from the hostname, since that's how most embedded
// boards work. Only Greenhouse exposes "last updated"; the others just publish
// a posted/created date.
import { fetchJson } from './lib/util.mjs';

const DAY = 86_400_000;

// "2026-07-06T15:01:27-04:00" → "2026-07-06 (12 days ago)"
function describe(value) {
  if (!value) return 'not published by this ATS';
  const d = new Date(value);
  if (isNaN(d)) return String(value);
  const days = Math.floor((Date.now() - d) / DAY);
  const ago = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return `${d.toISOString().slice(0, 10)} (${ago})`;
}

// Candidate Greenhouse board tokens for a job hosted on the company's own
// site: "www.jane-street.com" → ["jane-street", "janestreet"].
function boardGuesses(hostname) {
  const label = hostname.replace(/^(www|careers|jobs|boards|apply)\./, '').split('.')[0];
  return [...new Set([label, label.replace(/-/g, '')])];
}

async function checkGreenhouse(board, id) {
  const j = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`);
  return {
    ats: 'greenhouse', company: board, title: j.title,
    location: j.location?.name, posted: j.first_published, updated: j.updated_at,
  };
}

async function checkLever(company, id) {
  const p = await fetchJson(`https://api.lever.co/v0/postings/${company}/${id}`);
  return {
    ats: 'lever', company, title: p.text, location: p.categories?.location,
    posted: p.createdAt, updated: null,
  };
}

async function checkAshby(board, id) {
  const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${board}`);
  const j = (data.jobs || []).find((x) => x.id === id);
  if (!j) throw new Error(`job ${id} not in the ${board} Ashby board feed`);
  return {
    ats: 'ashby', company: board, title: j.title, location: j.location,
    posted: j.publishedAt, updated: j.updatedAt || null,
  };
}

async function checkWorkday(u) {
  const host = u.hostname.replace(/\.myworkdayjobs\.com$/, ''); // e.g. nvidia.wd5
  const tenant = host.split('.')[0];
  const parts = u.pathname.split('/').filter(Boolean);
  if (/^[a-z]{2}-[A-Z]{2}$/.test(parts[0])) parts.shift(); // drop locale (en-US)
  const site = parts.shift();
  const detail = await fetchJson(`https://${u.hostname}/wday/cxs/${tenant}/${site}/${parts.join('/')}`);
  const info = detail.jobPostingInfo || {};
  return {
    ats: 'workday', company: tenant, title: info.title, location: info.location,
    posted: info.startDate || info.postedOn, updated: null,
  };
}

// Route a URL to the right ATS check. Returns the result or throws.
async function check(rawUrl) {
  const u = new URL(rawUrl);
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  let m;
  if ((m = path.match(/^\/([^/]+)\/jobs\/(\d+)/)) && host.endsWith('greenhouse.io'))
    return checkGreenhouse(m[1], m[2]);
  const ghJid = u.searchParams.get('gh_jid') || (host.endsWith('greenhouse.io') && u.searchParams.get('token'));
  if (ghJid) {
    const boards = [u.searchParams.get('for'), ...boardGuesses(host)].filter(Boolean);
    return tryBoards(boards, ghJid);
  }
  if (host.endsWith('lever.co') && (m = path.match(/^\/([^/]+)\/([0-9a-f-]{36})/i)))
    return checkLever(m[1], m[2]);
  if (host.endsWith('ashbyhq.com') && (m = path.match(/^\/([^/]+)\/([0-9a-f-]{36})/i)))
    return checkAshby(m[1], decodeURIComponent(m[2]));
  if (host.endsWith('myworkdayjobs.com')) return checkWorkday(u);

  // Company-hosted page with a numeric id → probably an embedded Greenhouse board.
  if ((m = rawUrl.match(/(\d{7,})/))) return tryBoards(boardGuesses(host), m[1]);
  throw new Error('unrecognized URL — expected a Greenhouse/Lever/Ashby/Workday job link');
}

async function tryBoards(boards, id) {
  for (const b of boards) {
    try { return await checkGreenhouse(b, id); } catch { /* try next guess */ }
  }
  throw new Error(`no Greenhouse board matched (tried: ${boards.join(', ')}) — the page may use an ATS without a public API`);
}

const urls = process.argv.slice(2);
if (!urls.length) {
  console.error('Usage: node check-posting.mjs <job-url> [more-urls…]');
  process.exit(2);
}

let failures = 0;
for (const url of urls) {
  try {
    const r = await check(url);
    console.log(`\n${r.title || '(untitled)'} — ${r.company}${r.location ? ` · ${r.location}` : ''} [${r.ats}]`);
    console.log(`  posted:  ${describe(r.posted)}`);
    console.log(`  updated: ${describe(r.updated)}`);
  } catch (e) {
    failures++;
    console.error(`\n${url}\n  ✗ ${e.message}`);
  }
}
process.exit(failures === urls.length && urls.length ? 1 : 0);
