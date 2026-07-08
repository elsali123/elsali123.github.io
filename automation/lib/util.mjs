// Shared helpers: term detection, ATS detection, env, email.
import nodemailer from 'nodemailer';

export const TARGET_TERMS = ['Winter 2026', 'Summer 2027'];

const INTERN_RE = /\b(intern|internship|co[- ]?op)\b/i;

// Decide whether a posting looks like an internship for one of the target
// terms. Returns the matched term, 'Unspecified' for intern roles with no
// term in the text, or null to skip the posting entirely.
export function classifyPosting(title, extraText = '') {
  if (!INTERN_RE.test(title)) return null;
  const hay = `${title} ${extraText}`.toLowerCase();
  for (const term of TARGET_TERMS) {
    const [season, year] = term.toLowerCase().split(' ');
    // match "summer 2027", "summer, 2027", "2027 summer"
    if (new RegExp(`${season}[,\\s]*${year}|${year}[,\\s]*${season}`).test(hay)) return term;
  }
  // Explicitly some *other* term (e.g. "Fall 2026") → skip.
  if (/\b(spring|summer|fall|autumn|winter)[,\s]*20\d\d\b/.test(hay)) return null;
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
  'mexico city|argentina|colombia|dubai|uae|saudi|nigeria|south africa|kenya|egypt|emea|apac|latam)\\b',
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
