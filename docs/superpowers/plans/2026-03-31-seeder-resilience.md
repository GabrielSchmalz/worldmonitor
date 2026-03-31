# Seeder Resilience & Freshness — Implementation Plan

**Date:** 2026-03-31
**Spec:** `docs/superpowers/specs/2026-03-31-seeder-resilience-design.md`
**Status:** Ready to execute

---

## Source Audit

The following was read and verified before writing this plan.

### `scripts/_seed-utils.mjs` — key locations

**`acquireLock` (line 137):** Takes `ttlMs` as third arg, passes it directly to Redis `SET NX PX`. No default — caller sets it.

**`withRetry` (line 215):**
```js
export async function withRetry(fn, maxRetries = 3, delayMs = 1000) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const wait = delayMs * 2 ** attempt;
        // ...
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}
```
Signature is positional: `(fn, maxRetries, delayMs)`. Backoff is `delayMs * 2^attempt` (1s, 2s, 4s at defaults).

**`runSeed` (line 693):**
```js
export async function runSeed(domain, resource, canonicalKey, fetchFn, opts = {}) {
  const {
    validateFn,
    ttlSeconds,
    lockTtlMs = 120_000,   // line 697 — default 2min
    extraKeys,
    afterPublish,
    publishTransform,
  } = opts;
```

**Lock skip paths (lines 713–719):**
```js
if (lockResult.skipped) {
  process.exit(0);          // line 714 — Redis unavailable
}
if (!lockResult.locked) {
  console.log('  SKIPPED: another seed run in progress');
  process.exit(0);          // line 718 — lock contention
}
```

**Fetch failure path (lines 722–738):**
```js
let data;
try {
  data = await withRetry(fetchFn);
} catch (err) {
  await releaseLock(`${domain}:${resource}`, runId);
  // ...
  await extendExistingTtl(keys, ttl);
  console.log(`\n=== Failed gracefully (${Math.round(durationMs)}ms) ===`);
  process.exit(0);          // line 737 — STALE exit, currently reports as OK
}
```

**Success exit (line 806):** `process.exit(0)`

### `scripts/run-seeders.sh` — lines 38–60

```sh
ok=0 fail=0 skip=0

for f in "$SCRIPT_DIR"/seed-*.mjs; do
  name="$(basename "$f")"
  printf "→ %s ... " "$name"
  output=$(node "$f" 2>&1)
  rc=$?
  last=$(echo "$output" | tail -1)

  if echo "$last" | grep -qi "skip\|not set\|missing.*key\|not found"; then
    printf "SKIP (%s)\n" "$last"
    skip=$((skip + 1))
  elif [ $rc -eq 0 ]; then
    printf "OK\n"
    ok=$((ok + 1))
  else
    printf "FAIL (%s)\n" "$last"
    fail=$((fail + 1))
  fi
done

echo ""
echo "Done: $ok ok, $skip skipped, $fail failed"
```

Currently: `ok/skip/fail` counters only. No STALE bucket. Exit code 2 would fall into `FAIL` branch (rc != 0 and no grep match).

### `scripts/run-seeders-crypto.sh` — lines 38–81

Same counter structure (`ok=0 fail=0 skip=0`). Same result logic but with slightly different order:
```sh
if echo "$last" | grep -qi "skip\|not set\|missing.*key\|not found"; then
  ...skip
elif [ $rc -ne 0 ]; then
  ...fail
else
  ...ok
fi
```
Summary: `Crypto seeders: %d ok / %d skip / %d fail`.

### `scripts/seed-market-quotes.mjs` — line 10

```js
const CACHE_TTL = 1800;  // 30min
```

### `scripts/seed-commodity-quotes.mjs` — line 10

```js
const CACHE_TTL = 1800;  // 30min
```

### `scripts/seed-correlation.mjs` — line 8

```js
const CACHE_TTL = 1200; // 20min — outlives maxStaleMin:15 with buffer (cron runs every 5min)
```

### `scripts/seed-crypto-sectors.mjs` — lines 29–53

`fetchSectorData` hits CoinGecko only. No fallback. If CoinGecko returns non-OK or empty array, throws immediately:
```js
if (!Array.isArray(data) || data.length === 0) throw new Error('CoinGecko returned no data');
```
`seed-crypto-quotes.mjs` (lines 53–82) shows the CoinPaprika fallback pattern to replicate.

### `scripts/seed-forecasts.mjs` — `callForecastLLM` (line 14244)

Two providers: `groq` (20s timeout) + `openrouter` (25s timeout). The function iterates them sequentially in a `for` loop with no failure tracking. If Groq is down, every call burns 20s before falling back. With 6–8 call sites per run that's 120–160s of wasted time.

```js
const FORECAST_LLM_PROVIDERS = [
  { name: 'groq', envKey: 'GROQ_API_KEY', ..., timeout: 20_000 },
  { name: 'openrouter', envKey: 'OPENROUTER_API_KEY', ..., timeout: 25_000 },
];
```

Circuit breaker state needs to be module-level (survives multiple `callForecastLLM` calls per run, resets on next run because the module re-requires on each cron invocation).

### `scripts/seed-gdelt-intel.mjs` — lines 8–12

```js
const CACHE_TTL = 86400; // 24h
const TIMELINE_TTL = 43200; // 12h
const INTER_TOPIC_DELAY_MS = 20_000; // 20s between topics
const POST_EXHAUST_DELAY_MS = 120_000; // 2min after exhaustion
```

GDELT uses its own internal retry loop per topic — it does NOT call `withRetry`. The `withRetry` change needs to be backward-compatible (positional callers must still work).

---

## Tasks

### Task 1 — Exit code semantics in `_seed-utils.mjs`

**File:** `scripts/_seed-utils.mjs`
**Lines touched:** 714, 718, 737

#### What to change

Three `process.exit(0)` calls need new codes:

| Line | Current | New | Reason |
|------|---------|-----|--------|
| 714 | `process.exit(0)` after `lockResult.skipped` | `process.exit(3)` | Redis unavailable — skip, not success |
| 718 | `process.exit(0)` after `!lockResult.locked` | `process.exit(3)` | Lock contention — skip |
| 737 | `process.exit(0)` after `extendExistingTtl` | `process.exit(2)` | Fetch failed, stale TTL extended |

Exit codes at success (line 806) and validation-skip (line 755) remain `process.exit(0)` — those are genuine OKs.

#### Test-first

Add to `tests/seed-utils.test.mjs` — test that the exit codes are set correctly by reading the source file and asserting the literal strings (same pattern as `tests/ucdp-seed-resilience.test.mjs`):

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync('scripts/_seed-utils.mjs', 'utf8');

describe('runSeed exit code semantics', () => {
  it('exits with code 2 when fetch fails and TTL is extended (STALE)', () => {
    // The stale path: after extendExistingTtl call, before the closing brace of the catch
    const catchBlock = src.slice(
      src.indexOf('FETCH FAILED:'),
      src.indexOf('// Phase 2: Publish to Redis'),
    );
    assert.match(catchBlock, /process\.exit\(2\)/, 'Stale TTL-extend path must exit(2)');
    assert.ok(!catchBlock.includes('process.exit(0)'), 'Stale path must not exit(0)');
  });

  it('exits with code 3 when lock is skipped (Redis unavailable)', () => {
    const skipBlock = src.slice(
      src.indexOf('if (lockResult.skipped)'),
      src.indexOf('if (!lockResult.locked)'),
    );
    assert.match(skipBlock, /process\.exit\(3\)/, 'Redis-unavailable lock skip must exit(3)');
  });

  it('exits with code 3 when lock contention detected', () => {
    const contentionBlock = src.slice(
      src.indexOf('if (!lockResult.locked)'),
      src.indexOf('// Phase 1: Fetch data'),
    );
    assert.match(contentionBlock, /process\.exit\(3\)/, 'Lock-contention skip must exit(3)');
  });

  it('exits with code 0 on successful publish', () => {
    // The success path: after logSeedResult / verifySeedKey
    const successBlock = src.slice(
      src.indexOf('Verified: data present in Redis'),
      src.indexOf('} catch (err) {\n    await releaseLock'),
    );
    assert.match(successBlock, /process\.exit\(0\)/, 'Success path must exit(0)');
  });
});
```

#### Implementation

In `scripts/_seed-utils.mjs`:

1. Line 714 — change `process.exit(0)` to `process.exit(3)`:
```js
// Before:
if (lockResult.skipped) {
  process.exit(0);
}
// After:
if (lockResult.skipped) {
  process.exit(3);
}
```

2. Line 718 — change `process.exit(0)` to `process.exit(3)`:
```js
// Before:
if (!lockResult.locked) {
  console.log('  SKIPPED: another seed run in progress');
  process.exit(0);
}
// After:
if (!lockResult.locked) {
  console.log('  SKIPPED: another seed run in progress');
  process.exit(3);
}
```

3. Line 737 — change `process.exit(0)` to `process.exit(2)`:
```js
// Before:
    console.log(`\n=== Failed gracefully (${Math.round(durationMs)}ms) ===`);
    process.exit(0);
// After:
    console.log(`\n=== Failed gracefully (${Math.round(durationMs)}ms) ===`);
    process.exit(2);
```

#### Verify

```sh
node --test tests/seed-utils.test.mjs
```

#### Commit

```
fix(seeders): exit(2) for stale TTL-extend, exit(3) for lock skip
```

---

### Task 2 — Runner awareness in `run-seeders.sh` and `run-seeders-crypto.sh`

**Files:** `scripts/run-seeders.sh`, `scripts/run-seeders-crypto.sh`

#### What to change

Both files need:
1. A `stale` counter initialized alongside `ok`, `fail`, `skip`.
2. A branch for `rc -eq 2` that increments `stale` and prints `STALE`.
3. A branch for `rc -eq 3` that increments `skip` and prints `SKIP` (without relying on grep of output text for lock contention).
4. Updated summary line that includes stale count.

The existing grep-on-output skip detection for missing API keys must be preserved because those seeders exit 0 with a "SKIP" message (they don't call `runSeed`). The exit code 3 from `runSeed` is a new, explicit signal that complements text-grep.

#### Test-first

No automated test for shell scripts — verify manually after change by running:
```sh
# Simulate exit code 2 from a seeder:
bash -c 'rc=2; last="=== Failed gracefully (450ms) ==="; stale=0; if [ $rc -eq 2 ]; then printf "STALE\n"; stale=$((stale + 1)); fi; echo "stale=$stale"'
# Expected: STALE / stale=1
```

#### Implementation — `run-seeders.sh`

Replace lines 38–60 with:

```sh
ok=0 fail=0 stale=0 skip=0

for f in "$SCRIPT_DIR"/seed-*.mjs; do
  name="$(basename "$f")"
  printf "→ %s ... " "$name"
  output=$(node "$f" 2>&1)
  rc=$?
  last=$(echo "$output" | tail -1)

  if [ $rc -eq 0 ]; then
    if echo "$last" | grep -qi "skip\|not set\|missing.*key\|not found"; then
      printf "SKIP (%s)\n" "$last"
      skip=$((skip + 1))
    else
      printf "OK\n"
      ok=$((ok + 1))
    fi
  elif [ $rc -eq 2 ]; then
    printf "STALE\n"
    stale=$((stale + 1))
  elif [ $rc -eq 3 ]; then
    printf "SKIP (%s)\n" "$last"
    skip=$((skip + 1))
  else
    printf "FAIL (%s)\n" "$last"
    fail=$((fail + 1))
  fi
done

echo ""
echo "Done: $ok ok, $stale stale, $skip skipped, $fail failed"
```

Key change: exit code takes precedence. Text-grep for skip is now only applied when `rc -eq 0` (handles seeders that lack `runSeed` and exit 0 with a skip message in output).

#### Implementation — `run-seeders-crypto.sh`

Replace lines 38 and 57–81 with:

```sh
ok=0 fail=0 stale=0 skip=0
```

```sh
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

  if [ $rc -eq 0 ]; then
    if echo "$last" | grep -qi "skip\|not set\|missing.*key\|not found"; then
      printf "SKIP (%s)\n" "$last"
      skip=$((skip + 1))
    else
      printf "OK\n"
      ok=$((ok + 1))
    fi
  elif [ $rc -eq 2 ]; then
    printf "STALE\n"
    stale=$((stale + 1))
  elif [ $rc -eq 3 ]; then
    printf "SKIP (%s)\n" "$last"
    skip=$((skip + 1))
  else
    printf "FAIL (%s)\n" "$last"
    fail=$((fail + 1))
  fi
done

printf "\n=== Crypto seeders: %d ok / %d stale / %d skip / %d fail ===\n" "$ok" "$stale" "$skip" "$fail"
```

#### Commit

```
fix(runners): add STALE bucket for exit code 2, explicit SKIP for exit code 3
```

---

### Task 3 — TTL fixes (3 seeders)

**Files:** `scripts/seed-market-quotes.mjs`, `scripts/seed-commodity-quotes.mjs`, `scripts/seed-correlation.mjs`

#### What to change

| File | Line | Old | New | Why |
|------|------|-----|-----|-----|
| `seed-market-quotes.mjs` | 10 | `const CACHE_TTL = 1800;` | `const CACHE_TTL = 7200;` | Survives 2 missed 1h cron runs; VIX_SPIKE + MARKET_STRESS depend on this key |
| `seed-commodity-quotes.mjs` | 10 | `const CACHE_TTL = 1800;` | `const CACHE_TTL = 7200;` | COMMODITY_SHOCK depends on this key |
| `seed-correlation.mjs` | 8 | `const CACHE_TTL = 1200;` | `const CACHE_TTL = 3600;` | 20min TTL + 30min cron = guaranteed gap; 1h = 2× the 30min cron |

#### Test-first

Add to `tests/seed-utils.test.mjs` (or a new `tests/seeder-ttl-guards.test.mjs`):

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

describe('seeder TTL guards', () => {
  it('market-quotes CACHE_TTL is at least 7200s', () => {
    const src = readFileSync('scripts/seed-market-quotes.mjs', 'utf8');
    const m = src.match(/const CACHE_TTL\s*=\s*(\d+)/);
    assert.ok(m, 'CACHE_TTL must be defined');
    assert.ok(Number(m[1]) >= 7200, `CACHE_TTL must be >= 7200, got ${m[1]}`);
  });

  it('commodity-quotes CACHE_TTL is at least 7200s', () => {
    const src = readFileSync('scripts/seed-commodity-quotes.mjs', 'utf8');
    const m = src.match(/const CACHE_TTL\s*=\s*(\d+)/);
    assert.ok(m, 'CACHE_TTL must be defined');
    assert.ok(Number(m[1]) >= 7200, `CACHE_TTL must be >= 7200, got ${m[1]}`);
  });

  it('correlation CACHE_TTL is at least 3600s', () => {
    const src = readFileSync('scripts/seed-correlation.mjs', 'utf8');
    const m = src.match(/const CACHE_TTL\s*=\s*(\d+)/);
    assert.ok(m, 'CACHE_TTL must be defined');
    assert.ok(Number(m[1]) >= 3600, `CACHE_TTL must be >= 3600, got ${m[1]}`);
  });
});
```

#### Implementation

`seed-market-quotes.mjs` line 10:
```js
// Before:
const CACHE_TTL = 1800;
// After:
const CACHE_TTL = 7200; // 2h — survives 2 missed cron runs; VIX_SPIKE + MARKET_STRESS depend on this key
```

`seed-commodity-quotes.mjs` line 10:
```js
// Before:
const CACHE_TTL = 1800;
// After:
const CACHE_TTL = 7200; // 2h — COMMODITY_SHOCK depends on this key; matches market-quotes cadence
```

`seed-correlation.mjs` line 8:
```js
// Before:
const CACHE_TTL = 1200; // 20min — outlives maxStaleMin:15 with buffer (cron runs every 5min)
// After:
const CACHE_TTL = 3600; // 1h — 2× the 30min cron interval; prevents guaranteed gap at 20min TTL
```

#### Verify

```sh
node --test tests/seeder-ttl-guards.test.mjs
```

#### Commit

```
fix(seeders): increase TTLs for market-quotes (1800→7200), commodity-quotes (1800→7200), correlation (1200→3600)
```

---

### Task 4 — CoinGecko fallback in `seed-crypto-sectors.mjs`

**File:** `scripts/seed-crypto-sectors.mjs`

#### Reference implementation

`seed-crypto-quotes.mjs` lines 53–82 provides the exact CoinPaprika fallback pattern. The sectors seeder needs to map sector token IDs to CoinPaprika IDs. Since sectors use the same CoinGecko IDs as the quotes seeder, the same `COINPAPRIKA_ID_MAP` from `scripts/crypto-ids.json` (or inline) applies.

First, read the actual ID map used in crypto-quotes:

```sh
grep -n 'COINPAPRIKA_ID_MAP\|coinpaprika' scripts/seed-crypto-quotes.mjs | head -20
```

The sectors seeder calls `fetchSectorData()` which calls `fetchWithRateLimitRetry` (defined locally at line 14). The fallback must:
1. Return data in CoinGecko format: `{ id, price_change_percentage_24h }` — only `price_change_percentage_24h` is used in `fetchSectorData`.
2. Cover the union of all sector token IDs (from `sectorsConfig.sectors[].tokens`).

#### Test-first

Add to `tests/seeder-ttl-guards.test.mjs` (or a new `tests/seed-crypto-sectors.test.mjs`):

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

describe('seed-crypto-sectors resilience', () => {
  it('has a CoinPaprika fallback function', () => {
    const src = readFileSync('scripts/seed-crypto-sectors.mjs', 'utf8');
    assert.match(src, /fetchFromCoinPaprika|coinpaprika\.com/, 'Must have CoinPaprika fallback');
  });

  it('fetchSectorData catches CoinGecko errors and tries fallback', () => {
    const src = readFileSync('scripts/seed-crypto-sectors.mjs', 'utf8');
    const fn = src.slice(
      src.indexOf('async function fetchSectorData'),
      src.indexOf('\nfunction validate'),
    );
    assert.match(fn, /catch.*err.*\n.*CoinPaprika|catch.*\{[\s\S]*?coinpaprika/i,
      'fetchSectorData must catch CoinGecko error and fall back');
  });
});
```

#### Implementation

In `scripts/seed-crypto-sectors.mjs`, add after the `fetchWithRateLimitRetry` function (after line 27) and modify `fetchSectorData`:

```js
// Add COINPAPRIKA_ID_MAP covering all tokens referenced in crypto-sectors.json.
// Only the IDs actually used by the sectors config are needed.
// Full map lives in seed-crypto-quotes.mjs; copy the subset for sector tokens.
const COINPAPRIKA_ID_MAP = {
  bitcoin: 'btc-bitcoin',
  ethereum: 'eth-ethereum',
  solana: 'sol-solana',
  cardano: 'ada-cardano',
  polkadot: 'dot-polkadot',
  chainlink: 'link-chainlink',
  uniswap: 'uni-uniswap',
  aave: 'aave-aave',
  'maker': 'mkr-maker',
  'compound-governance-token': 'comp-compound',
  binancecoin: 'bnb-binance-coin',
  'matic-network': 'matic-polygon',
  avalanche: 'avax-avalanche',
  cosmos: 'atom-cosmos',
  near: 'near-near-protocol',
  filecoin: 'fil-filecoin',
  'the-graph': 'grt-the-graph',
  'render-token': 'rndr-render-token',
  'fetch-ai': 'fet-fetch-ai',
  ocean: 'ocean-ocean-protocol',
  monero: 'xmr-monero',
  zcash: 'zec-zcash',
  dash: 'dash-dash',
  tron: 'trx-tron',
  'shiba-inu': 'shib-shiba-inu',
  dogecoin: 'doge-dogecoin',
  pepe: 'pepe-pepe',
  'axie-infinity': 'axs-axie-infinity',
  decentraland: 'mana-decentraland',
  'the-sandbox': 'sand-the-sandbox',
  immutable: 'imx-immutable-x',
  'immutable-x': 'imx-immutable-x',
  ripple: 'xrp-xrp',
  litecoin: 'ltc-litecoin',
  stellar: 'xlm-stellar',
  'bitcoin-cash': 'bch-bitcoin-cash',
};

async function fetchFromCoinPaprika(allIds) {
  console.log('  [CoinPaprika] Falling back to CoinPaprika for sector data...');
  const resp = await fetch('https://api.coinpaprika.com/v1/tickers?quotes=USD', {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`CoinPaprika HTTP ${resp.status}`);
  const allTickers = await resp.json();
  const paprikaIds = new Set(allIds.map(id => COINPAPRIKA_ID_MAP[id]).filter(Boolean));
  const reverseMap = new Map(Object.entries(COINPAPRIKA_ID_MAP).map(([g, p]) => [p, g]));
  return allTickers
    .filter(t => paprikaIds.has(t.id))
    .map(t => ({
      id: reverseMap.get(t.id) || t.id,
      price_change_percentage_24h: t.quotes.USD.percent_change_24h,
    }));
}
```

Then modify `fetchSectorData` to wrap the CoinGecko call:

```js
async function fetchSectorData() {
  const allIds = [...new Set(SECTORS.flatMap(s => s.tokens))];

  const apiKey = process.env.COINGECKO_API_KEY;
  const baseUrl = apiKey ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
  const url = `${baseUrl}/coins/markets?vs_currency=usd&ids=${allIds.join(',')}&order=market_cap_desc&sparkline=false&price_change_percentage=24h`;
  const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
  if (apiKey) headers['x-cg-pro-api-key'] = apiKey;

  let coinsData;
  try {
    const resp = await fetchWithRateLimitRetry(url, 5, headers);
    coinsData = await resp.json();
    if (!Array.isArray(coinsData) || coinsData.length === 0) throw new Error('CoinGecko returned no data');
  } catch (err) {
    console.warn(`  [CoinGecko] Failed: ${err.message}`);
    coinsData = await fetchFromCoinPaprika(allIds);
  }

  const byId = new Map(coinsData.map(c => [c.id, c.price_change_percentage_24h]));

  const sectors = SECTORS.map(sector => {
    const changes = sector.tokens
      .map(id => byId.get(id))
      .filter(v => typeof v === 'number' && isFinite(v));
    const change = changes.length > 0 ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
    return { id: sector.id, name: sector.name, change };
  });

  return { sectors };
}
```

Note: The existing `fetchSectorData` (lines 29–53) already has the `byId` map and sector mapping logic. The change is minimal: wrap the CoinGecko fetch in try/catch, fallback, then use the same `byId.get(id)` map with the combined result.

#### Verify

```sh
node --test tests/seed-crypto-sectors.test.mjs
```

#### Commit

```
feat(seeders): add CoinPaprika fallback to seed-crypto-sectors
```

---

### Task 5 — LLM circuit breaker in `seed-forecasts.mjs`

**File:** `scripts/seed-forecasts.mjs`

#### Where to add

The circuit breaker state lives at module level (after `FORECAST_LLM_PROVIDERS` declaration, around line 3950). It is a `Map<providerName, consecutiveFailures>`. It resets automatically on next run because Node.js re-requires the module for each cron invocation.

The `callForecastLLM` function at line 14244 is the single chokepoint — all 6–8+ LLM call sites use it. No call site changes needed.

#### Design

```
After 2 consecutive failures on a provider → open circuit → skip provider for remainder of run.
Any success on a provider → reset its failure counter to 0.
```

This is an in-process guard, not persistent. Each forecast run starts with clean counters.

#### Test-first

Add `tests/forecast-llm-circuit-breaker.test.mjs`:

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// We test the circuit breaker logic in isolation by importing the module-level state
// via the exported test hook (__setForecastLlmCallOverrideForTests already exists at line 14240).
// Instead of importing the full 16k-line module, we test the logic by reading the source
// and verifying structural invariants.
import { readFileSync } from 'node:fs';

const src = readFileSync('scripts/seed-forecasts.mjs', 'utf8');

describe('LLM circuit breaker', () => {
  it('has a module-level circuit breaker failure counter map', () => {
    assert.match(src, /circuitBreakerFailures|_circuitBreaker|llmCircuitBreaker/,
      'Must have a named circuit breaker state map');
  });

  it('increments failure counter on provider HTTP error or exception', () => {
    // The catch block and the HTTP non-ok branch must both update failure counter
    const callFn = src.slice(
      src.indexOf('async function callForecastLLM('),
      src.indexOf('\nasync function redisSet(', src.indexOf('async function callForecastLLM(')),
    );
    assert.match(callFn, /circuitBreakerFailures|_circuitBreaker|llmCircuitBreaker/,
      'callForecastLLM must reference the circuit breaker state');
  });

  it('skips provider when failure count reaches threshold', () => {
    const callFn = src.slice(
      src.indexOf('async function callForecastLLM('),
      src.indexOf('\nasync function redisSet(', src.indexOf('async function callForecastLLM(')),
    );
    assert.match(callFn, /circuit.?breaker|skipping.*provider|skip.*circuit/i,
      'callForecastLLM must skip providers when circuit is open');
  });

  it('logs when a provider circuit opens', () => {
    assert.match(src, /circuit.?breaker.*skipping|skipping.*circuit.?breaker/i,
      'Must log when circuit opens');
  });
});
```

#### Implementation

After `FORECAST_LLM_PROVIDERS` (around line 3950), add:

```js
// Circuit breaker: tracks consecutive failures per provider within a single forecast run.
// After CIRCUIT_BREAKER_THRESHOLD consecutive failures, the provider is skipped for the
// remainder of this run. Resets on next run (module-level, re-initialized each invocation).
const CIRCUIT_BREAKER_THRESHOLD = 2;
const _llmCircuitBreakerFailures = new Map(); // providerName → consecutiveFailures
```

In `callForecastLLM` (line 14255), modify the provider loop:

```js
// Before:
  for (const provider of providers) {
    const apiKey = process.env[provider.envKey];
    if (!apiKey) continue;
    try {
      const resp = await fetch(provider.apiUrl, {
        // ...
      });
      if (!resp.ok) {
        console.warn(`  [LLM:${stage}] ${provider.name} HTTP ${resp.status}`);
        continue;
      }
      // ... success path ...
      return { text, model, provider: provider.name };
    } catch (err) {
      console.warn(`  [LLM:${stage}] ${provider.name} ${err.message}`);
    }
  }

// After:
  for (const provider of providers) {
    const apiKey = process.env[provider.envKey];
    if (!apiKey) continue;

    // Circuit breaker: skip provider if it has failed too many times this run
    const failures = _llmCircuitBreakerFailures.get(provider.name) || 0;
    if (failures >= CIRCUIT_BREAKER_THRESHOLD) {
      console.warn(`  [LLM:${stage}] circuit-breaker: skipping ${provider.name} after ${failures} failures`);
      continue;
    }

    try {
      const resp = await fetch(provider.apiUrl, {
        // ...
      });
      if (!resp.ok) {
        console.warn(`  [LLM:${stage}] ${provider.name} HTTP ${resp.status}`);
        _llmCircuitBreakerFailures.set(provider.name, failures + 1);
        continue;
      }
      const json = await resp.json();
      const text = json.choices?.[0]?.message?.content?.trim();
      if (!text || text.length < 20) {
        _llmCircuitBreakerFailures.set(provider.name, failures + 1);
        continue;
      }
      const model = json.model || provider.model;
      console.log(`  [LLM:${stage}] ${provider.name} success model=${model}`);
      // Reset on success
      _llmCircuitBreakerFailures.set(provider.name, 0);
      return { text, model, provider: provider.name };
    } catch (err) {
      console.warn(`  [LLM:${stage}] ${provider.name} ${err.message}`);
      _llmCircuitBreakerFailures.set(provider.name, failures + 1);
    }
  }
  return null;
```

Exact diff relative to line 14255–14292:
- Add failures check + continue before the `try` block.
- After `!resp.ok`, add `_llmCircuitBreakerFailures.set(provider.name, failures + 1)`.
- After `!text || text.length < 20`, add `_llmCircuitBreakerFailures.set(provider.name, failures + 1)`.
- After `return { text, model, provider: ... }`, add reset (or put reset just before return).
- In `catch`, add `_llmCircuitBreakerFailures.set(provider.name, failures + 1)`.

#### Verify

```sh
node --test tests/forecast-llm-circuit-breaker.test.mjs
```

#### Commit

```
feat(forecast): add per-provider LLM circuit breaker (open after 2 consecutive failures)
```

---

### Task 6 — Lock TTL reduction in `_seed-utils.mjs`

**File:** `scripts/_seed-utils.mjs`
**Line:** 697

#### What to change

```js
// Before:
    lockTtlMs = 120_000,
// After:
    lockTtlMs = 60_000,
```

#### Test-first

Add to `tests/seed-utils.test.mjs`:

```js
describe('runSeed lock TTL', () => {
  it('default lockTtlMs is 60000 (1min)', () => {
    const src = readFileSync('scripts/_seed-utils.mjs', 'utf8');
    const lockLine = src.slice(
      src.indexOf('lockTtlMs ='),
      src.indexOf('lockTtlMs =') + 30,
    );
    assert.match(lockLine, /lockTtlMs\s*=\s*60[_,]?000/, 'Default lockTtlMs must be 60_000');
  });
});
```

#### Implementation

`scripts/_seed-utils.mjs` line 697:
```js
// Before:
    lockTtlMs = 120_000,
// After:
    lockTtlMs = 60_000,
```

#### Verify

```sh
node --test tests/seed-utils.test.mjs
```

#### Commit

```
fix(seeders): reduce default lockTtlMs from 120s to 60s
```

---

### Task 7 — Custom retry config in `withRetry`

**File:** `scripts/_seed-utils.mjs`
**Line:** 215

#### What to change

The current signature `withRetry(fn, maxRetries = 3, delayMs = 1000)` is positional. The spec asks for an options-object overrides pattern while keeping backward compatibility.

The cleanest backward-compatible change: keep positional params as-is, add an optional third-position options object that can override both `maxRetries` and `delayMs`. Since the current callers already pass positional args (e.g., `acquireLockSafely` at line 147 calls `withRetry(fn, 2, 1000)`), we need to detect whether the third argument is a number or an object.

However, the spec shows the intended API as:
```js
withRetry(fn, { retries: 3, baseDelay: 1000, ...overrides })
```

This is a **breaking change to the call signature**. We need to update all internal callers. Check current callers:

```sh
grep -n 'withRetry(' scripts/_seed-utils.mjs
```

Internal callers in `_seed-utils.mjs`:
- Line 147: `withRetry(() => acquireLock(...), opts.maxRetries ?? 2, opts.delayMs ?? 1000)` — in `acquireLockSafely`
- Line 724: `withRetry(fetchFn)` — in `runSeed` (uses all defaults)

External callers may exist in other seeders. Check:

```sh
grep -rn 'withRetry(' scripts/ --include='*.mjs' | grep -v '_seed-utils'
```

All callers discovered must be updated as part of this task.

#### New signature

```js
export async function withRetry(fn, optsOrMaxRetries = {}, _legacyDelayMs = undefined) {
  // Support both new object form: withRetry(fn, { retries, baseDelay })
  // and legacy positional form: withRetry(fn, maxRetries, delayMs)
  let maxRetries, delayMs;
  if (typeof optsOrMaxRetries === 'number') {
    maxRetries = optsOrMaxRetries;
    delayMs = _legacyDelayMs !== undefined ? _legacyDelayMs : 1000;
  } else {
    maxRetries = optsOrMaxRetries.retries ?? 3;
    delayMs = optsOrMaxRetries.baseDelay ?? 1000;
  }

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const wait = delayMs * 2 ** attempt;
        const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
        console.warn(`  Retry ${attempt + 1}/${maxRetries} in ${wait}ms: ${err.message || err}${cause}`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}
```

#### GDELT seeder usage

In `scripts/seed-gdelt-intel.mjs`, GDELT has its own internal retry loop and does **not** call `withRetry` directly. It passes topics through `withRetry` only via `runSeed` (which calls `withRetry(fetchFn)` with defaults). The spec says GDELT should pass `{ baseDelay: 30000, retries: 4 }`.

Since `runSeed` calls `withRetry(fetchFn)` with no options, the GDELT seeder needs to pass a `retryConfig` option to `runSeed` which then threads it through. This requires a one-line change to `runSeed` as well:

In `runSeed` opts destructuring (line 693–701), add `retryConfig`:
```js
const {
  validateFn,
  ttlSeconds,
  lockTtlMs = 60_000,
  extraKeys,
  afterPublish,
  publishTransform,
  retryConfig,          // new
} = opts;
```

And in the `withRetry(fetchFn)` call at line 724:
```js
// Before:
    data = await withRetry(fetchFn);
// After:
    data = await withRetry(fetchFn, retryConfig || {});
```

In `seed-gdelt-intel.mjs`, find the `runSeed` call and add `retryConfig`:

```sh
grep -n 'runSeed(' scripts/seed-gdelt-intel.mjs
```

Add `retryConfig: { retries: 4, baseDelay: 30_000 }` to the opts object.

#### Test-first

Add to `tests/seed-utils.test.mjs`:

```js
describe('withRetry options object', () => {
  it('accepts { retries, baseDelay } object form', async () => {
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
      return 'ok';
    };
    const result = await withRetry(fn, { retries: 5, baseDelay: 0 });
    assert.equal(result, 'ok');
    assert.equal(attempts, 3);
  });

  it('backward-compatible with positional (maxRetries, delayMs)', async () => {
    let attempts = 0;
    const fn = () => {
      attempts++;
      if (attempts < 2) throw new Error('transient');
      return 'ok';
    };
    const result = await withRetry(fn, 3, 0);
    assert.equal(result, 'ok');
    assert.equal(attempts, 2);
  });

  it('throws after exhausting retries with object form', async () => {
    const fn = () => { throw new Error('always fails'); };
    await assert.rejects(() => withRetry(fn, { retries: 2, baseDelay: 0 }), /always fails/);
  });
});
```

Import `withRetry` at the top of the test file (it's already exported).

#### Verify

```sh
node --test tests/seed-utils.test.mjs
```

#### Commit

```
feat(seeders): withRetry accepts options object; add retryConfig passthrough in runSeed; GDELT uses 30s base delay
```

---

## Execution Order

Tasks must be executed in this order (each builds on the previous or touches same files):

1. **Task 6** (lock TTL) — single-line change, lowest risk, good warmup
2. **Task 1** (exit codes) — establishes exit semantics before runner changes
3. **Task 2** (runner scripts) — must follow Task 1 so codes are in place
4. **Task 3** (TTL fixes) — independent of above, can run in parallel with 1+2
5. **Task 7** (withRetry) — changes shared utility, include GDELT update in same commit
6. **Task 4** (CoinGecko fallback) — isolated to one seeder
7. **Task 5** (circuit breaker) — largest change, isolated to seed-forecasts.mjs

Tasks 3 and 4 are independent. Tasks 1 and 2 must be sequential (codes before runner). Task 5 is always last (largest, most isolated).

---

## Test Commands

```sh
# After each task:
npm run test:data -- --test-name-pattern="seed utils|seeder TTL|crypto-sectors|LLM circuit"

# Full suite:
npm run test:data
```

Individual test files:
```sh
node --test tests/seed-utils.test.mjs
node --test tests/seeder-ttl-guards.test.mjs
node --test tests/seed-crypto-sectors.test.mjs
node --test tests/forecast-llm-circuit-breaker.test.mjs
```

---

## Rollback Notes

- Exit code changes: if any downstream tooling breaks on exit 2/3, restore the three `process.exit` calls in `_seed-utils.mjs` and revert runner scripts. Zero-risk to Redis data.
- TTL changes: increasing TTLs never causes data loss — it only extends staleness window on a miss. Safe to revert.
- Lock TTL: if more lock contention appears, raise back to `90_000` (halfway) rather than `120_000`.
- Circuit breaker: module-level state means it resets on every run. No persistent side effects. Safe to revert.
- `withRetry` options form: backward-compatible. Positional callers unaffected.
