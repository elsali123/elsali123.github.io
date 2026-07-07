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

export function detectAts(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('greenhouse.io')) return 'greenhouse';
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
