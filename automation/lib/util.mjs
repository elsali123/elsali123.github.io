// Shared helpers: term detection, ATS detection, env, email.
import { readFile } from 'node:fs/promises';
import nodemailer from 'nodemailer';

export const TARGET_TERMS = ['Winter 2026', 'Summer 2027'];

const INTERN_RE = /\b(intern|internship|co[- ]?op)\b/i;

// Grad-only signal in the title, e.g. "Research Intern (PhD)" or
// "ML Intern — Master's Student". Bare "MS"/"BS" abbreviations are NOT
// grad-only — most internships list them as accepted degrees, so only the
// spelled-out forms count as a real PhD/Master's-targeted posting.
const GRAD_ONLY_RE = /\bph\.?d\.?\b|\bdoctoral\b|\bdoctorate\b|\bmaster'?s\b/i;

// Decide whether a posting looks like an internship for one of the target
// terms. Returns the matched term, 'Unspecified' for intern roles with no
// term in the text, or null to skip the posting entirely.
export function classifyPosting(title, extraText = '') {
  if (!INTERN_RE.test(title)) return null;
  if (GRAD_ONLY_RE.test(title)) return null;
  const hay = `${title} ${extraText}`.toLowerCase();
  for (const term of TARGET_TERMS) {
    const [season, year] = term.toLowerCase().split(' ');
    // match "summer 2027", "summer, 2027", "2027 summer"
    if (new RegExp(`${season}[,\\s]*${year}|${year}[,\\s]*${season}`).test(hay)) return term;
  }
  // Explicitly some *other* term (e.g. "Fall 2026") → skip.
  if (/\b(spring|summer|fall|autumn|winter)[,\s]*20\d\d\b/.test(hay)) return null;
  // Fall/spring internships with no year in the text are still fall/spring
  // (winter is fine even with no year — it's a target season).
  if (/\b(fall|autumn|spring)\b/i.test(hay)) return null;
  return 'Unspecified';
}

// ---------- US-only location filter ----------
const US_POSITIVE = new RegExp(
  '\\b(united states|usa|u\\.s\\.|us[- ]?remote|remote[- ](in[- ])?(the[- ])?us)\\b|' +
  // "City, ST" with a US state/territory abbreviation
  ',\\s*(A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY]|PR)\\b|' +
  '\\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\\b|' +
  // common US city names/abbreviations that appear without a state
  '\\b(sf|nyc|bay area|silicon valley|san francisco|new york city|los angeles|palo alto|mountain view|menlo park|santa clara|san jose|sunnyvale|cupertino|redwood city|seattle|bellevue|redmond|austin|chicago|boston|denver|atlanta|dallas|houston|miami|philadelphia|pittsburgh|washington,? d\\.?c\\.?)\\b',
  'i');
const US_NEGATIVE = new RegExp(
  '\\b(canada|ontario|toronto|vancouver|montreal|waterloo|calgary|ottawa|' +
  'united kingdom|uk|london|cambridge uk|england|scotland|ireland|dublin|' +
  'germany|berlin|munich|france|paris|netherlands|amsterdam|belgium|spain|madrid|barcelona|' +
  'italy|milan|sweden|stockholm|switzerland|zurich|geneva|poland|warsaw|krakow|' +
  'india|bangalore|bengaluru|hyderabad|mumbai|delhi|pune|chennai|gurgaon|noida|' +
  'singapore|japan|tokyo|china|shanghai|beijing|hong kong|taiwan|taipei|korea|seoul|' +
  'australia|sydney|melbourne|new zealand|israel|tel aviv|brazil|sao paulo|' +
  'mexico city|argentina|colombia|dubai|uae|saudi|nigeria|south africa|kenya|egypt|emea|apac|latam|' +
  // countries that show up on global Workday tenants
  'malaysia|penang|vietnam|philippines|manila|indonesia|jakarta|thailand|bangkok|' +
  'romania|bucharest|czech|prague|hungary|budapest|portugal|lisbon|finland|helsinki|' +
  'denmark|copenhagen|norway|oslo|austria|vienna|costa rica|chile|santiago|peru|' +
  'ukraine|kyiv|turkey|istanbul|russia|russian federation|moscow|' +
  // bare "mexico" is safe: "New Mexico" hits US_POSITIVE first, which wins
  'mexico|guadalajara|bulgaria|sofia|serbia|belgrade|croatia|zagreb|slovakia|bratislava|greece|athens)\\b',
  'i');

// True if any listed location looks like the US; locations with no signal
// either way (e.g. bare "Remote" or "San Francisco") are kept.
export function isUSLocation(locations) {
  if (!locations) return true;
  const judged = String(locations).split(/[;|•]/).map((part) => {
    if (US_POSITIVE.test(part)) return true;
    if (US_NEGATIVE.test(part)) return false;
    return null;
  });
  return judged.includes(true) || !judged.includes(false);
}

// Q→A map from earlier applications to the same company (newest wins).
// Company names vary by source ("jumptrading" vs "Jump Trading"), so compare
// lowercase alphanumerics. Meta entries (files, audit warnings, rejected
// values) are skipped — the point is reusing real answers, LLM ones included.
export async function loadPriorAnswers(sb, job, excludeId) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const { data, error } = await sb.from('applications')
    .select('id, answers, job:job_postings(company)')
    .not('answers', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(100);
  if (error) { console.warn('prior answers lookup failed:', error.message); return {}; }
  const out = {};
  for (const row of data || []) {
    if (row.id === excludeId || norm(row.job?.company) !== norm(job.company)) continue;
    for (const [q, v] of Object.entries(row.answers || {})) {
      const val = String(v ?? '').replace(/\s*\((AI|reused)\)\s*$/, '').trim();
      if (/^file( repair)?:|^⚠/.test(q)) continue;
      if (!val || /NOT ACCEPTED|repair failed/i.test(val)) continue;
      out[q] = val;
    }
  }
  return out;
}

// Hand-drafted essay answers from application-answers.md at the repo root
// (gitignored — personal content, local-only; absent in CI, which is fine
// since unattended runs never submit anyway). Convention for that file,
// followed here: each `## <question>` section runs until the next `---`
// separator; a paragraph that's ENTIRELY an italic `*(...)*` note is a
// meta-comment (word count, sourcing) and is stripped; a paragraph
// mentioning "not yet drafted" is an unfinished placeholder and is
// stripped; a section containing "⚠" anywhere carries a caution (e.g.
// "verify before using") and is skipped whole, falling through to the LLM
// rather than auto-filling something unverified.
export async function loadDraftedAnswers() {
  let text;
  try {
    text = await readFile(new URL('../../application-answers.md', import.meta.url), 'utf8');
  } catch {
    return {}; // not created yet — nothing drafted, not an error
  }
  const out = {};
  for (const section of text.split(/\n##\s+/).slice(1)) {
    const nl = section.indexOf('\n');
    const question = (nl === -1 ? section : section.slice(0, nl)).trim();
    const body = (nl === -1 ? '' : section.slice(nl + 1)).split(/\n---\s*\n/)[0];
    const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (!question || paragraphs.some((p) => p.includes('⚠'))) continue;
    const usable = paragraphs.filter((p) => !/^\*\(.*\)\*$/s.test(p) && !/not yet drafted/i.test(p));
    if (usable.length) out[question] = usable.join('\n\n');
  }
  return out;
}

// Query params that carry no job identity — safe to drop so tracking variants of
// the same URL unify. Everything else in the query is kept, because some ATSs
// and aggregators put the whole identity there (e.g. google.com/search?q=… apply
// links from intern-list, where dropping the query would merge every posting).
const TRACKING_PARAM = /^(utm_|gh_jid$|mobile$|needsredirect$|mode$|src$|source$|ref$|campaign$|trk$|trackid$|lever-source)/i;

// Canonical identity for a posting, used to collapse the same job seen through
// different sources. Greenhouse jobs are keyed by their globally-unique numeric
// id (from a `?gh_jid=` embed param or a `greenhouse.io/.../jobs/<id>` path), so
// a direct-API row and an aggregator row pointing at the same job unify.
// Everything else is keyed by host + path + meaningful query params (tracking
// junk stripped, remaining params sorted for stability).
export function postingKey(url) {
  url = String(url || '');
  const gh = url.match(/[?&]gh_jid=(\d+)/i) || (/greenhouse\.io/i.test(url) && url.match(/\/jobs\/(\d+)/i));
  if (gh) return 'gh:' + gh[1];
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAM.test(k))
      .map(([k, v]) => k.toLowerCase() + '=' + v.toLowerCase())
      .sort();
    return 'u:' + host + (path || '/') + (params.length ? '?' + params.join('&') : '');
  } catch { return 'raw:' + url.toLowerCase(); }
}

export function detectAts(url) {
  const u = (url || '').toLowerCase();
  // gh_jid= marks a Greenhouse board embedded in a company's own site
  if (u.includes('greenhouse.io') || u.includes('gh_jid=')) return 'greenhouse';
  if (u.includes('lever.co')) return 'lever';
  if (u.includes('ashbyhq.com')) return 'ashby';
  if (u.includes('myworkdayjobs.com')) return 'workday';
  return 'other';
}

export function env(name, fallback = undefined) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}

export async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { accept: 'application/json', ...options.headers } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// Sends via Gmail SMTP using an app password (secrets GMAIL_USER / GMAIL_APP_PASSWORD).
export async function sendEmail(subject, html) {
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  const to = process.env.DIGEST_EMAIL || user;
  if (!user || !pass) { console.warn('Email not configured (GMAIL_USER/GMAIL_APP_PASSWORD); skipping send.'); return; }
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await transport.sendMail({ from: `"Auto-Apply Bot" <${user}>`, to, subject, html });
  console.log(`Email sent to ${to}: ${subject}`);
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
