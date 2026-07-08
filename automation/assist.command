#!/bin/zsh
# One-click assisted application session (double-click me in Finder).
# Fills every released ("ready") application in a visible browser;
# you review and click submit on each.
cd "$(dirname "$0")"

if [ ! -f .env.local ]; then
  echo "❌ automation/.env.local is missing (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY)"
  exit 1
fi

echo "🤝 Starting assisted application session…"
echo "   I fill each application — YOU review and click submit."
echo
ASSIST=1 node --env-file=.env.local apply.mjs

echo
echo "Session finished — you can close this window."
