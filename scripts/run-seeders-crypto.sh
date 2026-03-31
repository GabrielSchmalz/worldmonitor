#!/bin/sh
# Run only crypto/finance-relevant seeders.
# Usage: ./scripts/run-seeders-crypto.sh
#
# Subset of run-seeders.sh — targets BTC/USDT trading-relevant data only.
# Saves Redis memory and cron time by skipping geopolitical/military/weather seeders.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source .env for API keys (Docker Compose reads this automatically,
# but host-side seeders need it explicitly).
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  . "$PROJECT_DIR/.env"
  set +a
fi

UPSTASH_REDIS_REST_URL="${UPSTASH_REDIS_REST_URL:-http://localhost:8079}"
UPSTASH_REDIS_REST_TOKEN="${UPSTASH_REDIS_REST_TOKEN:-wm-local-token}"
export UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN

# Source API keys from docker-compose.override.yml if present.
OVERRIDE="$PROJECT_DIR/docker-compose.override.yml"
if [ -f "$OVERRIDE" ]; then
  _env_tmp=$(mktemp)
  grep -E '^\s+[A-Z_]+:' "$OVERRIDE" \
    | grep -v '#' \
    | sed 's/^\s*//' \
    | sed 's/: */=/' \
    | sed "s/[\"']//g" \
    | grep -E '^(GROQ|FINNHUB|FRED|EIA|OPENROUTER_API_KEY|LLM_API_URL|LLM_API_KEY|LLM_MODEL)' \
    | sed 's/^/export /' > "$_env_tmp"
  . "$_env_tmp"
  rm -f "$_env_tmp"
fi

ok=0 fail=0 skip=0

CRYPTO_SEEDERS="
seed-crypto-quotes.mjs
seed-crypto-sectors.mjs
seed-stablecoin-markets.mjs
seed-market-quotes.mjs
seed-commodity-quotes.mjs
seed-fear-greed.mjs
seed-etf-flows.mjs
seed-fx-rates.mjs
seed-ecb-fx-rates.mjs
seed-prediction-markets.mjs
seed-cross-source-signals.mjs
seed-correlation.mjs
seed-cot.mjs
seed-earnings-calendar.mjs
"

for name in $CRYPTO_SEEDERS; do
  f="$SCRIPT_DIR/$name"
  if [ ! -f "$f" ]; then
    printf "→ %s ... SKIP (not found)\n" "$name"
    skip=$((skip + 1))
    continue
  fi
  printf "→ %s ... " "$name"
  output=$(node "$f" 2>&1)
  rc=$?
  last=$(echo "$output" | tail -1)

  if echo "$last" | grep -qi "skip\|not set\|missing.*key\|not found"; then
    printf "SKIP (%s)\n" "$last"
    skip=$((skip + 1))
  elif [ $rc -ne 0 ]; then
    printf "FAIL (%s)\n" "$last"
    fail=$((fail + 1))
  else
    printf "OK\n"
    ok=$((ok + 1))
  fi
done

printf "\n=== Crypto seeders: %d ok / %d skip / %d fail ===\n" "$ok" "$skip" "$fail"
