# Auto-Apply — internship scraper + application bot

Finds newly posted **Winter 2026 / Summer 2027** internships hourly, emails a
digest, and auto-applies to the ones you queue from
[elsali.dev/jobs.html](https://elsali.dev/jobs.html).

## How it works

| Piece | Where | What it does |
|---|---|---|
| `scrape.mjs` | GitHub Actions, hourly (`:07`) | Pulls SimplifyJobs listings + Greenhouse/Lever/Ashby public APIs (all free, no keys), dedupes into Supabase `job_postings`, emails a digest of new postings |
| `apply.mjs` | GitHub Actions, every 20 min (only when queue non-empty) | Takes `applications` rows with status `queued`, opens the job form in headless Chromium, uploads resume/transcript, fills every field from your profile / saved answers / Claude, **auto-submits** on Greenhouse, Lever & Ashby, then emails results |
| `jobs.html` | GitHub Pages | Dashboard: browse the feed, queue applications, track status, edit profile & docs |

Statuses: `queued → applying → submitted` ✅, or `needs_review` 👀 (CAPTCHA,
Workday/unsupported site, or no confirmation detected — finish manually via the
link), or `failed` ❌ (fix profile, hit Retry).

## One-time setup

1. **Database** — Supabase Dashboard → SQL Editor → run
   [`supabase/jobs-schema.sql`](../supabase/jobs-schema.sql).

2. **GitHub secrets** — repo → Settings → Secrets and variables → Actions:

   | Secret | Where to get it |
   |---|---|
   | `SUPABASE_URL` | `https://zyfzgezjusyfxmfuhvfk.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` (⚠️ never put this in the site) |
   | `ANTHROPIC_API_KEY` | console.anthropic.com → API keys |
   | `GMAIL_USER` | your gmail address |
   | `GMAIL_APP_PASSWORD` | Google Account → Security → 2-Step Verification → App passwords |
   | `DIGEST_EMAIL` | (optional) where digests go; defaults to `GMAIL_USER` |

3. **Profile** — open `jobs.html`, sign in with Google, fill the Profile tab,
   upload resume (+ transcript) PDFs, save.

4. Kick the tires: repo → Actions → *Job scraper (hourly)* → Run workflow.

## Tuning

- **Companies polled**: edit [`companies.json`](companies.json) (board tokens
  from each company's `boards.greenhouse.io/…`, `jobs.lever.co/…`, or
  `jobs.ashbyhq.com/…` URL).
- **Target terms**: `TARGET_TERMS` in [`lib/util.mjs`](lib/util.mjs).
- **LLM model**: `ANTHROPIC_MODEL` env (default `claude-haiku-4-5`).
- **Batch size**: `MAX_APPLICATIONS_PER_RUN` env (default 8).
- **Review-before-send**: uncheck *Auto-submit* in the dashboard profile — the
  bot fills and validates but flags `needs_review` instead of submitting.

## Local testing

```bash
cd automation && npm install
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scrape.mjs
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… ANTHROPIC_API_KEY=… node apply.mjs
```

## Honest limitations

- **Workday and company-account portals aren't automatable** (login walls,
  multi-page wizards) — those queue as `needs_review` with a direct link.
  A lot of finance/big-co postings from Simplify are Workday.
- CAPTCHAs are never bypassed; the run flags the job for manual apply.
- Form layouts change; anything unconfirmed lands in `needs_review` rather than
  silently pretending it applied. Check the status email after each run.
