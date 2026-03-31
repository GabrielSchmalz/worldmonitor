# Seeder Resilience & Freshness — Design Spec

**Date:** 2026-03-31
**Status:** Approved
**Author:** arista + Claude

## Problem

Seeders fail silently (exit 0 on fetch failure), TTLs are misaligned with cron cadence causing data gaps, there is no circuit breaker for LLM providers, and retry timing doesn't account for API-specific cooldowns.

## Fixes

### 1. Exit Code Semantics

**File:** `scripts/_seed-utils.mjs:734`

Current behavior: `runSeed` catches fetch failures, calls `extendExistingTtl`, and exits with code 0. The cron runner interprets this as success.

**New exit codes:**
| Code | Meaning | Runner behavior |
|---|---|---|
| 0 | Success — data written | OK |
| 1 | Hard failure — unrecoverable | FAIL |
| 2 | Stale-extended — fetch failed, TTL extended on existing data | STALE |
| 3 | Skipped — lock contention or missing dependency | SKIP |

**Changes:**
- `_seed-utils.mjs:734` — change `process.exit(0)` to `process.exit(2)` when extending stale TTL
- `_seed-utils.mjs` lock skip path — change to `process.exit(3)`

### 2. Runner Awareness

**Files:** `scripts/run-seeders.sh`, `scripts/run-seeders-crypto.sh`

Update the result parsing to recognize exit code 2 as STALE (not OK, not FAIL):

```sh
if [ $rc -eq 0 ]; then
  printf "OK\n"; ok=$((ok + 1))
elif [ $rc -eq 2 ]; then
  printf "STALE\n"; stale=$((stale + 1))
elif [ $rc -eq 3 ]; then
  printf "SKIP (%s)\n" "$last"; skip=$((skip + 1))
else
  printf "FAIL (%s)\n" "$last"; fail=$((fail + 1))
fi
```

Final summary: `Done: $ok ok, $stale stale, $skip skipped, $fail failed`

### 3. TTL Fixes

| Seeder | File | Current TTL | New TTL | Reason |
|---|---|---|---|---|
| market-quotes | `seed-market-quotes.mjs:10` | 1800s (30min) | 7200s (2h) | Survives 2 missed cron runs. VIX_SPIKE + MARKET_STRESS depend on this key. |
| commodity-quotes | `seed-commodity-quotes.mjs` | 1800s | 7200s | Same logic — COMMODITY_SHOCK depends on it |
| correlation | `seed-correlation.mjs` | 1200s (20min) | 3600s (1h) | Short TTL + 30min cron = guaranteed gaps |

### 4. CoinGecko Fallback for crypto-sectors

**File:** `scripts/seed-crypto-sectors.mjs:55-67`

Currently has no fallback — CoinGecko outage returns empty. Add CoinPaprika fallback matching pattern from `seed-crypto-quotes.mjs:53-73`.

### 5. LLM Circuit Breaker

**File:** `scripts/seed-forecasts.mjs` (around `callForecastLLM`)

Current: Each of 6-8 LLM call sites per forecast run tries all providers sequentially. If Groq is down, each call adds 25s timeout before falling back.

**Fix:** Add provider-level circuit breaker:
- Track consecutive failures per provider (in-memory, per forecast run)
- After 2 consecutive failures on a provider, skip it for remaining calls in this run
- Reset on next forecast run
- Log when circuit opens: `[forecast] circuit-breaker: skipping ${provider} after ${failures} failures`

### 6. Lock TTL Reduction

**File:** `scripts/_seed-utils.mjs:697`

Change `lockTtlMs` from 120,000 (2min) to 60,000 (1min). Most seeders complete in <30s. The 2min lock causes unnecessary skips when cron runs at 5-15min intervals.

### 7. GDELT Retry Alignment

**File:** `scripts/_seed-utils.mjs:215` (`withRetry`)

Current backoff: 1s, 2s, 4s — total 7s. GDELT requires 120s cooldown after exhaustion.

**Fix:** Allow seeders to pass custom retry config:
```js
withRetry(fn, { retries: 3, baseDelay: 1000, ...overrides })
```

GDELT seeder passes `{ baseDelay: 30000, retries: 4 }` (30s, 60s, 120s, 240s).

## Deliverables

1. Exit code semantics in `_seed-utils.mjs` (exit 2 for stale, exit 3 for skip)
2. Runner parsing update in both `run-seeders*.sh`
3. TTL fixes (3 seeders)
4. CoinGecko fallback in crypto-sectors
5. LLM circuit breaker in forecast pipeline
6. Lock TTL reduction
7. Custom retry config support in `withRetry`
8. Tests for exit codes, circuit breaker, and retry logic

## Success Criteria

- Cron log shows STALE count (previously hidden as OK)
- No TTL-related data gaps for market-quotes, commodity-quotes, correlation
- Forecast pipeline completes in <60s even when one LLM provider is down
- Lock contention rate drops (fewer SKIP in logs)

## Out of Scope

- New data sources (Spec 2)
- Signal coverage fixes (Spec 1)
- Forecast pipeline restructuring (Spec 4)
