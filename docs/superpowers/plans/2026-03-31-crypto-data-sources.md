# Implementation Plan: Crypto Data Sources
**Date:** 2026-03-31
**Spec:** `docs/superpowers/specs/2026-03-31-crypto-data-sources-design.md`
**Status:** Ready to execute

---

## Overview

6 new seeder scripts + health.js + run-seeders-crypto.sh + .env additions.

All seeders follow the exact same pattern as `seed-crypto-quotes.mjs` and `seed-stablecoin-markets.mjs`:
- `loadEnvFile(import.meta.url)` at top
- named `fetchFn` returning domain object
- `validate(data)` function
- `runSeed(domain, resource, CANONICAL_KEY, fetchFn, opts).catch(...)` at bottom
- API key guard: `if (!apiKey) { console.log('  SKIP: ...'); process.exit(0); }`

---

## Task 1: `seed-crypto-fng.mjs` — Crypto Fear & Greed Index

**File:** `scripts/seed-crypto-fng.mjs`
**Redis key:** `market:crypto-fng:v1`
**TTL:** 3600s
**API:** `https://api.alternative.me/fng/?limit=3` (no auth)

### Step 1 — Smoke-test the API
```sh
curl -s 'https://api.alternative.me/fng/?limit=3' | jq .
```
Expected shape:
```json
{
  "name": "Fear and Greed Index",
  "data": [
    { "value": "45", "value_classification": "Fear", "timestamp": "1711843200" },
    ...
  ]
}
```

### Step 2 — Write the seeder

```js
#!/usr/bin/env node

import { loadEnvFile, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:crypto-fng:v1';
const CACHE_TTL = 3600; // 1h — index updates daily, hourly refresh sufficient

async function fetchCryptoFng() {
  const resp = await fetch('https://api.alternative.me/fng/?limit=3', {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`alternative.me HTTP ${resp.status}`);
  const json = await resp.json();

  const data = json?.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('alternative.me returned empty data array');
  }

  const latest = data[0];
  const value = parseInt(latest.value, 10);
  if (!Number.isFinite(value)) throw new Error('alternative.me: non-numeric value in response');

  const history = data.slice(1).map((d) => ({
    value: parseInt(d.value, 10),
    timestamp: parseInt(d.timestamp, 10),
  }));

  return {
    value,
    classification: latest.value_classification,
    timestamp: parseInt(latest.timestamp, 10),
    history,
    fetchedAt: Date.now(),
  };
}

function validate(data) {
  return (
    typeof data?.value === 'number' &&
    data.value >= 0 &&
    data.value <= 100 &&
    typeof data.classification === 'string'
  );
}

runSeed('market', 'crypto-fng', CANONICAL_KEY, fetchCryptoFng, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'alternative-me-fng',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
```

### Step 3 — Test
```sh
cd /home/arista/src/worldmonitor
UPSTASH_REDIS_REST_URL=http://localhost:8079 UPSTASH_REDIS_REST_TOKEN=wm-local-token \
  node scripts/seed-crypto-fng.mjs
```
Expected: `=== Done (XXXms) ===` with no FATAL line.

### Step 4 — Verify Redis
```sh
curl -s http://localhost:8079/get/market:crypto-fng:v1 \
  -H 'Authorization: Bearer wm-local-token' | jq '.result | fromjson | .value'
```

### Step 5 — Commit
```sh
git add scripts/seed-crypto-fng.mjs
git commit -m "feat(seeder): add crypto Fear & Greed Index seeder (market:crypto-fng:v1)"
```

---

## Task 2: `seed-funding-rates.mjs` — BTC/ETH Funding Rates

**File:** `scripts/seed-funding-rates.mjs`
**Redis key:** `market:funding-rates:v1`
**TTL:** 1800s
**API:** `https://open-api.coinglass.com/public/v2/funding`
**Auth:** `COINGLASS_API_KEY` header: `coinglassSecret`

### Step 1 — Register & smoke-test
```sh
# Register at https://www.coinglass.com/pricing (free tier)
# Then:
curl -s 'https://open-api.coinglass.com/public/v2/funding' \
  -H 'coinglassSecret: YOUR_KEY' | jq '.data | .[0:2]'
```
Expected: array of objects with `symbol`, `uFundingRate`, `exchangeName`, `nextFundingTime`.

### Step 2 — Write the seeder

```js
#!/usr/bin/env node

import { loadEnvFile, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:funding-rates:v1';
const CACHE_TTL = 1800; // 30min — funding rates update every 8h, frequent snapshots needed

async function fetchFundingRates() {
  const apiKey = process.env.COINGLASS_API_KEY;
  if (!apiKey) {
    console.log('  SKIP: COINGLASS_API_KEY not set');
    process.exit(0);
  }

  const resp = await fetch('https://open-api.coinglass.com/public/v2/funding', {
    headers: {
      Accept: 'application/json',
      coinglassSecret: apiKey,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Coinglass funding HTTP ${resp.status}`);
  const json = await resp.json();

  if (!json.success) throw new Error(`Coinglass funding error: ${json.msg || 'unknown'}`);

  const rows = json.data ?? [];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Coinglass funding: empty data array');
  }

  // Aggregate: pick highest absolute funding rate per symbol across exchanges
  const bySymbol = new Map();
  for (const row of rows) {
    const sym = (row.symbol || '').toUpperCase();
    if (!['BTC', 'ETH'].includes(sym)) continue;
    const rate = parseFloat(row.uFundingRate ?? row.fundingRate ?? 0);
    const existing = bySymbol.get(sym);
    if (!existing || Math.abs(rate) > Math.abs(existing.rate)) {
      bySymbol.set(sym, {
        rate,
        nextFundingTime: row.nextFundingTime ?? 0,
        exchange: row.exchangeName ?? row.exchange ?? '',
      });
    }
  }

  const btc = bySymbol.get('BTC') ?? null;
  const eth = bySymbol.get('ETH') ?? null;

  // Extreme alert: any rate > 0.1% per 8h
  const extremeAlert =
    (btc != null && Math.abs(btc.rate) > 0.001) ||
    (eth != null && Math.abs(eth.rate) > 0.001);

  return {
    btc,
    eth,
    extremeAlert,
    fetchedAt: Date.now(),
  };
}

function validate(data) {
  return (
    data != null &&
    typeof data.fetchedAt === 'number' &&
    (data.btc != null || data.eth != null)
  );
}

runSeed('market', 'funding-rates', CANONICAL_KEY, fetchFundingRates, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'coinglass-funding-v2',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
```

### Step 3 — Test
```sh
UPSTASH_REDIS_REST_URL=http://localhost:8079 UPSTASH_REDIS_REST_TOKEN=wm-local-token \
COINGLASS_API_KEY=your_key \
  node scripts/seed-funding-rates.mjs
```
Without key: expect `SKIP: COINGLASS_API_KEY not set` then exit 0.
With key: expect `=== Done (XXXms) ===`.

### Step 4 — Verify Redis
```sh
curl -s http://localhost:8079/get/market:funding-rates:v1 \
  -H 'Authorization: Bearer wm-local-token' | jq '.result | fromjson | {btc,eth,extremeAlert}'
```

### Step 5 — Commit
```sh
git add scripts/seed-funding-rates.mjs
git commit -m "feat(seeder): add BTC/ETH funding rates seeder (market:funding-rates:v1)"
```

---

## Task 3: `seed-open-interest.mjs` — BTC/ETH Open Interest

**File:** `scripts/seed-open-interest.mjs`
**Redis key:** `market:open-interest:v1`
**TTL:** 3600s
**API:** `https://open-api.coinglass.com/public/v2/open_interest`
**Auth:** Same `COINGLASS_API_KEY`

### Step 1 — Smoke-test
```sh
curl -s 'https://open-api.coinglass.com/public/v2/open_interest' \
  -H 'coinglassSecret: YOUR_KEY' | jq '.data | .[0:2]'
```
Expected: array with `symbol`, `openInterest`, `openInterestAmount`, `change24h` (or similar).

### Step 2 — Write the seeder

```js
#!/usr/bin/env node

import { loadEnvFile, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:open-interest:v1';
const CACHE_TTL = 3600; // 1h

async function fetchOpenInterest() {
  const apiKey = process.env.COINGLASS_API_KEY;
  if (!apiKey) {
    console.log('  SKIP: COINGLASS_API_KEY not set');
    process.exit(0);
  }

  const resp = await fetch('https://open-api.coinglass.com/public/v2/open_interest', {
    headers: {
      Accept: 'application/json',
      coinglassSecret: apiKey,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Coinglass open_interest HTTP ${resp.status}`);
  const json = await resp.json();

  if (!json.success) throw new Error(`Coinglass open_interest error: ${json.msg || 'unknown'}`);

  const rows = json.data ?? [];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Coinglass open_interest: empty data array');
  }

  // Aggregate total OI per symbol across all exchanges
  const totals = new Map();
  for (const row of rows) {
    const sym = (row.symbol || '').toUpperCase();
    if (!['BTC', 'ETH'].includes(sym)) continue;
    const oi = parseFloat(row.openInterest ?? row.openInterestUsd ?? 0);
    const change24h = parseFloat(row.change24h ?? row.openInterestChange24h ?? 0);
    const prev = totals.get(sym);
    if (prev) {
      totals.set(sym, {
        totalOI: prev.totalOI + oi,
        change24h: prev.change24h + change24h,
        change1h: prev.change1h + parseFloat(row.change1h ?? 0),
      });
    } else {
      totals.set(sym, {
        totalOI: oi,
        change24h: change24h,
        change1h: parseFloat(row.change1h ?? 0),
      });
    }
  }

  return {
    btc: totals.get('BTC') ?? null,
    eth: totals.get('ETH') ?? null,
    fetchedAt: Date.now(),
  };
}

function validate(data) {
  return (
    data != null &&
    typeof data.fetchedAt === 'number' &&
    (data.btc != null || data.eth != null)
  );
}

runSeed('market', 'open-interest', CANONICAL_KEY, fetchOpenInterest, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'coinglass-oi-v2',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
```

### Step 3 — Test
```sh
UPSTASH_REDIS_REST_URL=http://localhost:8079 UPSTASH_REDIS_REST_TOKEN=wm-local-token \
COINGLASS_API_KEY=your_key \
  node scripts/seed-open-interest.mjs
```

### Step 4 — Verify Redis
```sh
curl -s http://localhost:8079/get/market:open-interest:v1 \
  -H 'Authorization: Bearer wm-local-token' | jq '.result | fromjson | {btc,eth}'
```

### Step 5 — Commit
```sh
git add scripts/seed-open-interest.mjs
git commit -m "feat(seeder): add BTC/ETH open interest seeder (market:open-interest:v1)"
```

---

## Task 4: `seed-whale-alerts.mjs` — Whale Transactions

**File:** `scripts/seed-whale-alerts.mjs`
**Redis key:** `market:whale-alerts:v1`
**TTL:** 600s (fast-moving)
**API:** `https://api.whale-alert.io/v1/transactions`
**Auth:** `WHALE_ALERT_API_KEY`
**Rate limit:** 10 req/min, 100/day free tier

### Step 1 — Register & smoke-test
```sh
# Register at https://whale-alert.io/signup (free tier)
# The API requires ?api_key=, ?min_value=1000000, ?start=<unix_timestamp>
WHALE_KEY="your_key"
START=$(date -d '1 hour ago' +%s)
curl -s "https://api.whale-alert.io/v1/transactions?api_key=${WHALE_KEY}&min_value=1000000&start=${START}" | jq '.transactions | .[0:2]'
```
Expected: array with `blockchain`, `symbol`, `amount_usd`, `from.owner_type`, `to.owner_type`, `timestamp`.

### Step 2 — Write the seeder

```js
#!/usr/bin/env node

import { loadEnvFile, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:whale-alerts:v1';
const CACHE_TTL = 600; // 10min — fast-moving data
const MIN_VALUE_USD = 1_000_000; // $1M threshold

async function fetchWhaleAlerts() {
  const apiKey = process.env.WHALE_ALERT_API_KEY;
  if (!apiKey) {
    console.log('  SKIP: WHALE_ALERT_API_KEY not set');
    process.exit(0);
  }

  // Look back 1 hour (free tier limitation: can't look back further)
  const start = Math.floor(Date.now() / 1000) - 3600;
  const url = `https://api.whale-alert.io/v1/transactions?api_key=${encodeURIComponent(apiKey)}&min_value=${MIN_VALUE_USD}&start=${start}`;

  const resp = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Whale Alert HTTP ${resp.status}`);
  const json = await resp.json();

  if (json.result !== 'success') {
    throw new Error(`Whale Alert error: ${json.message || json.result || 'unknown'}`);
  }

  const txs = json.transactions ?? [];

  // Normalize transactions
  const transactions = txs.map((tx) => ({
    blockchain: tx.blockchain ?? '',
    symbol: (tx.symbol ?? '').toUpperCase(),
    amount_usd: tx.amount_usd ?? 0,
    from_owner_type: tx.from?.owner_type ?? 'unknown',
    to_owner_type: tx.to?.owner_type ?? 'unknown',
    timestamp: tx.timestamp ?? 0,
  }));

  // Compute 1h flow summary
  const now = Date.now() / 1000;
  const cutoff = now - 3600;
  const recent = transactions.filter((t) => t.timestamp >= cutoff);

  let exchange_inflow_usd_1h = 0;
  let exchange_outflow_usd_1h = 0;
  for (const t of recent) {
    if (t.to_owner_type === 'exchange') exchange_inflow_usd_1h += t.amount_usd;
    if (t.from_owner_type === 'exchange') exchange_outflow_usd_1h += t.amount_usd;
  }

  return {
    transactions,
    summary: {
      exchange_inflow_usd_1h,
      exchange_outflow_usd_1h,
      net_flow_usd_1h: exchange_inflow_usd_1h - exchange_outflow_usd_1h,
    },
    fetchedAt: Date.now(),
  };
}

function validate(data) {
  return (
    data != null &&
    Array.isArray(data.transactions) &&
    typeof data.fetchedAt === 'number'
  );
}

runSeed('market', 'whale-alerts', CANONICAL_KEY, fetchWhaleAlerts, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'whale-alert-v1',
  recordCount: (data) => data?.transactions?.length ?? 0,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
```

### Step 3 — Test
```sh
UPSTASH_REDIS_REST_URL=http://localhost:8079 UPSTASH_REDIS_REST_TOKEN=wm-local-token \
WHALE_ALERT_API_KEY=your_key \
  node scripts/seed-whale-alerts.mjs
```
Without key: expect `SKIP: WHALE_ALERT_API_KEY not set` then exit 0.

### Step 4 — Verify Redis
```sh
curl -s http://localhost:8079/get/market:whale-alerts:v1 \
  -H 'Authorization: Bearer wm-local-token' | jq '.result | fromjson | .summary'
```

### Step 5 — Commit
```sh
git add scripts/seed-whale-alerts.mjs
git commit -m "feat(seeder): add whale transactions seeder (market:whale-alerts:v1)"
```

---

## Task 5: `seed-exchange-flows.mjs` — BTC Exchange Net Flows

**File:** `scripts/seed-exchange-flows.mjs`
**Redis key:** `market:exchange-flows:v1`
**TTL:** 3600s
**API:** `https://api.cryptoquant.com/v1/btc/exchange-flows/netflow`
**Auth:** `CRYPTOQUANT_API_KEY` as Bearer token
**Rate limit:** 10 req/min free tier

### Step 1 — Register & smoke-test
```sh
# Register at https://cryptoquant.com/product/api (free tier)
CQ_KEY="your_key"
curl -s 'https://api.cryptoquant.com/v1/btc/exchange-flows/netflow?window=hour&limit=2' \
  -H "Authorization: Bearer ${CQ_KEY}" | jq '.result.data | .[0:2]'
```
Expected: array with `netflow_total`, `inflow_total`, `outflow_total`, `reserve` fields.

### Step 2 — Write the seeder

```js
#!/usr/bin/env node

import { loadEnvFile, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:exchange-flows:v1';
const CACHE_TTL = 3600; // 1h

async function fetchExchangeFlows() {
  const apiKey = process.env.CRYPTOQUANT_API_KEY;
  if (!apiKey) {
    console.log('  SKIP: CRYPTOQUANT_API_KEY not set');
    process.exit(0);
  }

  // Fetch last 2 hourly data points (1h flow + reserve)
  const url = 'https://api.cryptoquant.com/v1/btc/exchange-flows/netflow?window=hour&limit=24';
  const resp = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`CryptoQuant exchange-flows HTTP ${resp.status}`);
  const json = await resp.json();

  const rows = json?.result?.data ?? json?.data ?? [];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('CryptoQuant exchange-flows: empty data');
  }

  const latest = rows[rows.length - 1];
  const prev24 = rows[0];

  const netflow_1h = parseFloat(latest.netflow_total ?? latest.netflow ?? 0);
  const inflow_1h = parseFloat(latest.inflow_total ?? latest.inflow ?? 0);
  const outflow_1h = parseFloat(latest.outflow_total ?? latest.outflow ?? 0);
  const exchange_reserve = parseFloat(latest.reserve ?? 0);

  // 24h aggregate
  const netflow_24h = rows.reduce((sum, r) => sum + parseFloat(r.netflow_total ?? r.netflow ?? 0), 0);

  // Trend classification
  let trend;
  if (netflow_1h > 500) trend = 'inflow';
  else if (netflow_1h < -500) trend = 'outflow';
  else trend = 'neutral';

  return {
    btc: {
      netflow_1h,
      netflow_24h,
      inflow_1h,
      outflow_1h,
      exchange_reserve,
      trend,
    },
    fetchedAt: Date.now(),
  };
}

function validate(data) {
  return (
    data != null &&
    data.btc != null &&
    typeof data.btc.netflow_1h === 'number' &&
    typeof data.fetchedAt === 'number'
  );
}

runSeed('market', 'exchange-flows', CANONICAL_KEY, fetchExchangeFlows, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'cryptoquant-exchange-flows-v1',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
```

### Step 3 — Test
```sh
UPSTASH_REDIS_REST_URL=http://localhost:8079 UPSTASH_REDIS_REST_TOKEN=wm-local-token \
CRYPTOQUANT_API_KEY=your_key \
  node scripts/seed-exchange-flows.mjs
```
Without key: expect `SKIP: CRYPTOQUANT_API_KEY not set` then exit 0.

### Step 4 — Verify Redis
```sh
curl -s http://localhost:8079/get/market:exchange-flows:v1 \
  -H 'Authorization: Bearer wm-local-token' | jq '.result | fromjson | .btc'
```

### Step 5 — Commit
```sh
git add scripts/seed-exchange-flows.mjs
git commit -m "feat(seeder): add BTC exchange net flows seeder (market:exchange-flows:v1)"
```

---

## Task 6: `seed-btc-dominance.mjs` — BTC Dominance

**File:** `scripts/seed-btc-dominance.mjs`
**Redis key:** `market:btc-dominance:v1`
**TTL:** 3600s
**API:** `https://api.coingecko.com/api/v3/global` (no auth; or `COINGECKO_API_KEY`)
**Note:** Uses same CoinGecko key pattern as `seed-crypto-quotes.mjs`

### Step 1 — Smoke-test the API
```sh
curl -s 'https://api.coingecko.com/api/v3/global' | jq '.data | {btc_dominance: .market_cap_percentage.btc, total_market_cap: .total_market_cap.usd}'
```
Expected: `btc_dominance` ~40-60%, `total_market_cap` in trillions.

### Step 2 — Write the seeder

```js
#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed, sleep } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:btc-dominance:v1';
const CACHE_TTL = 3600; // 1h

async function fetchBtcDominance() {
  const apiKey = process.env.COINGECKO_API_KEY;
  const baseUrl = apiKey
    ? 'https://pro-api.coingecko.com/api/v3'
    : 'https://api.coingecko.com/api/v3';
  const url = `${baseUrl}/global`;
  const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
  if (apiKey) headers['x-cg-pro-api-key'] = apiKey;

  let resp;
  for (let i = 0; i < 3; i++) {
    resp = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (resp.status === 429) {
      const wait = Math.min(10_000 * (i + 1), 60_000);
      console.warn(`  CoinGecko /global 429 — waiting ${wait / 1000}s (attempt ${i + 1}/3)`);
      await sleep(wait);
      continue;
    }
    break;
  }
  if (!resp.ok) throw new Error(`CoinGecko /global HTTP ${resp.status}`);
  const json = await resp.json();

  const d = json?.data;
  if (!d) throw new Error('CoinGecko /global: missing data field');

  const btcDominance = d.market_cap_percentage?.btc ?? 0;
  const ethDominance = d.market_cap_percentage?.eth ?? 0;
  const totalMarketCap = d.total_market_cap?.usd ?? 0;
  const totalVolume24h = d.total_volume?.usd ?? 0;
  const marketCapChangePercentage24hUsd = d.market_cap_change_percentage_24h_usd ?? 0;

  // Altseason index: simple heuristic — lower BTC dominance = higher altseason probability
  // Scale: 0 (full BTC season) to 100 (full altseason)
  // BTC dom 60%+ = 0; BTC dom 40%- = 100; linear between
  const altseasonIndex = Math.max(0, Math.min(100, Math.round((60 - btcDominance) / 20 * 100)));

  return {
    dominance: +btcDominance.toFixed(4),
    ethDominance: +ethDominance.toFixed(4),
    change24h: +marketCapChangePercentage24hUsd.toFixed(4),
    totalMarketCap,
    totalVolume24h,
    altseasonIndex,
    fetchedAt: Date.now(),
  };
}

function validate(data) {
  return (
    typeof data?.dominance === 'number' &&
    data.dominance > 0 &&
    data.dominance <= 100 &&
    typeof data.totalMarketCap === 'number'
  );
}

runSeed('market', 'btc-dominance', CANONICAL_KEY, fetchBtcDominance, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'coingecko-global',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
```

### Step 3 — Test
```sh
UPSTASH_REDIS_REST_URL=http://localhost:8079 UPSTASH_REDIS_REST_TOKEN=wm-local-token \
  node scripts/seed-btc-dominance.mjs
```
Expected: `=== Done (XXXms) ===` (no API key needed).

### Step 4 — Verify Redis
```sh
curl -s http://localhost:8079/get/market:btc-dominance:v1 \
  -H 'Authorization: Bearer wm-local-token' | jq '.result | fromjson | {dominance,altseasonIndex}'
```

### Step 5 — Commit
```sh
git add scripts/seed-btc-dominance.mjs
git commit -m "feat(seeder): add BTC dominance seeder (market:btc-dominance:v1)"
```

---

## Task 7: Update `api/health.js`

Add 6 entries to `BOOTSTRAP_KEYS` and 6 entries to `SEED_META`.

### Step 1 — Locate insertion points

In `BOOTSTRAP_KEYS` (after `stablecoinMarkets` line ~27):
```js
  stablecoinMarkets: 'market:stablecoins:v1',
```

Add after that line:
```js
  cryptoFng:         'market:crypto-fng:v1',
  fundingRates:      'market:funding-rates:v1',
  openInterest:      'market:open-interest:v1',
  whaleAlerts:       'market:whale-alerts:v1',
  exchangeFlows:     'market:exchange-flows:v1',
  btcDominance:      'market:btc-dominance:v1',
```

In `SEED_META` (after `stablecoinMarkets` entry ~135):
```js
  stablecoinMarkets:{ key: 'seed-meta:market:stablecoins',      maxStaleMin: 60 },
```

Add after that line:
```js
  cryptoFng:        { key: 'seed-meta:market:crypto-fng',       maxStaleMin: 90 },  // 30min cron; 90 = 3x interval
  fundingRates:     { key: 'seed-meta:market:funding-rates',    maxStaleMin: 90 },  // 30min cron; 90 = 3x interval
  openInterest:     { key: 'seed-meta:market:open-interest',    maxStaleMin: 90 },  // 30min cron; 90 = 3x interval
  whaleAlerts:      { key: 'seed-meta:market:whale-alerts',     maxStaleMin: 90 },  // 30min cron; 90 = 3x interval
  exchangeFlows:    { key: 'seed-meta:market:exchange-flows',   maxStaleMin: 90 },  // 30min cron; 90 = 3x interval
  btcDominance:     { key: 'seed-meta:market:btc-dominance',    maxStaleMin: 90 },  // 30min cron; 90 = 3x interval
```

**Important:** `fundingRates`, `whaleAlerts`, and `exchangeFlows` have optional API keys. Add them to `ON_DEMAND_KEYS` so health check shows WARN not CRIT when the key is absent (seeder gracefully skips):

In `ON_DEMAND_KEYS` Set (add these entries):
```js
  'fundingRates',      // optional: requires COINGLASS_API_KEY
  'whaleAlerts',       // optional: requires WHALE_ALERT_API_KEY
  'exchangeFlows',     // optional: requires CRYPTOQUANT_API_KEY
  'openInterest',      // optional: requires COINGLASS_API_KEY
```

> **Rationale:** `cryptoFng` and `btcDominance` use public APIs (no key required) — they should be CRIT if missing. The Coinglass/Whale Alert/CryptoQuant seeders gracefully skip when no key is set — they should be WARN.

### Step 2 — Apply the edits

Use the Edit tool to apply to `/home/arista/src/worldmonitor/api/health.js`:

1. Find `stablecoinMarkets: 'market:stablecoins:v1',` and insert the 6 BOOTSTRAP_KEYS entries after it.
2. Find `stablecoinMarkets:{ key: 'seed-meta:market:stablecoins',` and insert the 6 SEED_META entries after it.
3. Find the `ON_DEMAND_KEYS` Set and add `'fundingRates'`, `'whaleAlerts'`, `'exchangeFlows'`, `'openInterest'`.

### Step 3 — Test health endpoint
```sh
# Ensure local Redis has data from step 1-6 seeds, then:
curl -s 'http://localhost:3000/api/health' | jq '.keys | {cryptoFng, fundingRates, openInterest, whaleAlerts, exchangeFlows, btcDominance}'
```
Expected: each key shows `{ status: "ok" }` or `{ status: "warn" }` for optional-key seeders.

### Step 4 — Commit
```sh
git add api/health.js
git commit -m "feat(health): register 6 new crypto data source keys in health check"
```

---

## Task 8: Update `scripts/run-seeders-crypto.sh`

Add 6 new seeder filenames to `CRYPTO_SEEDERS`.

### Step 1 — Edit

In `run-seeders-crypto.sh`, find:
```sh
CRYPTO_SEEDERS="
seed-crypto-quotes.mjs
```

Change to:
```sh
CRYPTO_SEEDERS="
seed-crypto-quotes.mjs
seed-crypto-fng.mjs
seed-funding-rates.mjs
seed-open-interest.mjs
seed-whale-alerts.mjs
seed-exchange-flows.mjs
seed-btc-dominance.mjs
seed-crypto-sectors.mjs
...
```

The full block after adding (preserving original order, new seeders after `seed-crypto-quotes.mjs`):
```sh
CRYPTO_SEEDERS="
seed-crypto-quotes.mjs
seed-crypto-fng.mjs
seed-funding-rates.mjs
seed-open-interest.mjs
seed-whale-alerts.mjs
seed-exchange-flows.mjs
seed-btc-dominance.mjs
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
```

Also update the `grep -E` pattern that extracts API keys from docker-compose.override.yml to include the new vars:
```sh
  | grep -E '^(GROQ|FINNHUB|FRED|EIA|OPENROUTER_API_KEY|LLM_API_URL|LLM_API_KEY|LLM_MODEL|COINGLASS_API_KEY|WHALE_ALERT_API_KEY|CRYPTOQUANT_API_KEY)' \
```

### Step 2 — Smoke-test the updated script
```sh
cd /home/arista/src/worldmonitor
UPSTASH_REDIS_REST_URL=http://localhost:8079 UPSTASH_REDIS_REST_TOKEN=wm-local-token \
  bash scripts/run-seeders-crypto.sh 2>&1 | tail -20
```
Expected: the 6 new seeders appear in output. `seed-crypto-fng.mjs` → OK; optional-key seeders → SKIP.

### Step 3 — Commit
```sh
git add scripts/run-seeders-crypto.sh
git commit -m "feat(cron): add 6 crypto data source seeders to run-seeders-crypto.sh"
```

---

## Task 9: `.env` — Document New Variables

Add to `.env.example` (or document in README) the 3 new optional API keys:

```sh
# Coinglass — funding rates + open interest (free tier: coinglass.com/pricing)
COINGLASS_API_KEY=

# Whale Alert — large crypto transactions (free tier: whale-alert.io/signup)
WHALE_ALERT_API_KEY=

# CryptoQuant — BTC exchange flows (free tier: cryptoquant.com/product/api)
CRYPTOQUANT_API_KEY=
```

Check if `.env.example` exists:
```sh
ls /home/arista/src/worldmonitor/.env.example 2>/dev/null || ls /home/arista/src/worldmonitor/.env 2>/dev/null
```

If `.env.example` exists, use Edit to append the 3 keys to the crypto section.

If only `.env` exists (and is in `.gitignore`), add the keys to `.env.local` for local dev.

### Commit
```sh
git add .env.example  # or whichever file applies
git commit -m "docs(env): document COINGLASS_API_KEY, WHALE_ALERT_API_KEY, CRYPTOQUANT_API_KEY"
```

---

## Execution Order

1. Task 1 (seed-crypto-fng.mjs) — no API key, can test immediately
2. Task 6 (seed-btc-dominance.mjs) — no API key, can test immediately
3. Task 2 (seed-funding-rates.mjs) — needs COINGLASS_API_KEY
4. Task 3 (seed-open-interest.mjs) — needs COINGLASS_API_KEY (same key as Task 2)
5. Task 4 (seed-whale-alerts.mjs) — needs WHALE_ALERT_API_KEY
6. Task 5 (seed-exchange-flows.mjs) — needs CRYPTOQUANT_API_KEY
7. Task 7 (api/health.js) — after all seeders exist
8. Task 8 (run-seeders-crypto.sh) — after all seeders exist
9. Task 9 (.env docs) — any time

---

## API Registration Guide

| Service | URL | Free Tier | Required Env Var |
|---------|-----|-----------|-----------------|
| Coinglass | https://www.coinglass.com/pricing | 30 req/min, covers funding + OI | `COINGLASS_API_KEY` |
| Whale Alert | https://whale-alert.io/signup | 10 req/min, 100/day | `WHALE_ALERT_API_KEY` |
| CryptoQuant | https://cryptoquant.com/product/api | 10 req/min | `CRYPTOQUANT_API_KEY` |

---

## Pattern Reference (extracted from codebase)

```
SEEDER FILE ANATOMY:
  1. #!/usr/bin/env node
  2. import { loadEnvFile, CHROME_UA, runSeed, sleep } from './_seed-utils.mjs';
  3. loadEnvFile(import.meta.url);
  4. const CANONICAL_KEY = 'domain:resource:v1';
  5. const CACHE_TTL = Nseconds;
  6. async function fetchXxx() { ... return data; }
  7. function validate(data) { return boolean; }
  8. runSeed('domain', 'resource', CANONICAL_KEY, fetchXxx, {
       validateFn: validate,
       ttlSeconds: CACHE_TTL,
       sourceVersion: 'source-name',
     }).catch((err) => { ... process.exit(1); });

API KEY GUARD (when key is optional):
  const apiKey = process.env.SOME_API_KEY;
  if (!apiKey) {
    console.log('  SKIP: SOME_API_KEY not set');
    process.exit(0);
  }

HEALTH.JS SEED_META FORMAT:
  keyName: { key: 'seed-meta:domain:resource', maxStaleMin: N },
  // maxStaleMin = cron_interval_min * 3 (3x buffer is standard)

CATCH BLOCK (exact pattern from existing seeders — one-liner):
  .catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
```

---

## Success Criteria

- [ ] `node scripts/seed-crypto-fng.mjs` → writes `market:crypto-fng:v1` to Redis
- [ ] `node scripts/seed-btc-dominance.mjs` → writes `market:btc-dominance:v1` to Redis
- [ ] `node scripts/seed-funding-rates.mjs` (with key) → writes `market:funding-rates:v1`
- [ ] `node scripts/seed-funding-rates.mjs` (no key) → exits 0 with SKIP message
- [ ] `node scripts/seed-open-interest.mjs` (with key) → writes `market:open-interest:v1`
- [ ] `node scripts/seed-whale-alerts.mjs` (with key) → writes `market:whale-alerts:v1`
- [ ] `node scripts/seed-exchange-flows.mjs` (with key) → writes `market:exchange-flows:v1`
- [ ] `bash scripts/run-seeders-crypto.sh` → all 6 new seeders appear in output
- [ ] `/api/health` → 6 new keys in response (OK for public APIs, WARN/SKIP for optional keys)
