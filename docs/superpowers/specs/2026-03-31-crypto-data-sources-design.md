# Crypto Data Sources — Design Spec

**Date:** 2026-03-31
**Status:** Approved
**Author:** arista + Claude

## Problem

The worldmonitor has zero crypto-native data sources. The `market:crypto:v1` key contains only price/market cap data from CoinGecko. There is no coverage for funding rates, open interest, whale transactions, exchange flows, stablecoin mint/burn, or crypto-specific sentiment. The forecast pipeline's `crypto_stablecoins` bucket relies entirely on indirect macro signals.

## New Data Sources

### 1. Crypto Fear & Greed Index

- **API:** `https://api.alternative.me/fng/?limit=3`
- **Auth:** None (public API)
- **Rate limit:** Generous (no documented limit)
- **Redis key:** `market:crypto-fng:v1`
- **TTL:** 3600s (index updates daily, hourly refresh is sufficient)
- **Schema:** `{ value: number (0-100), classification: string, timestamp: number, history: [{value, timestamp}] }`
- **Why:** `seed-fear-greed.mjs:398` reads `cryptoFg` from `economic:macro-signals:v1` but this value is never populated from the primary source. This seeder fills the gap.
- **Cron group:** crypto (every 30min)

### 2. Funding Rates (BTC/ETH)

- **API:** Coinglass `https://open-api.coinglass.com/public/v2/funding`
- **Auth:** Free tier API key (register at coinglass.com)
- **Rate limit:** 30 req/min on free tier
- **Redis key:** `market:funding-rates:v1`
- **TTL:** 1800s (funding rates update every 8h, but we want frequent snapshots)
- **Schema:** `{ btc: { rate: number, nextFundingTime: number, exchange: string }, eth: { ... }, extremeAlert: boolean, fetchedAt: number }`
- **Why:** Extreme funding rates (+0.1%/8h) signal overleveraged longs with ~4h predictive window. Directly actionable for cryptarista.
- **Cron group:** crypto (every 30min)

### 3. Open Interest

- **API:** Coinglass `https://open-api.coinglass.com/public/v2/open_interest`
- **Auth:** Same Coinglass key as funding rates
- **Rate limit:** Same pool (30 req/min)
- **Redis key:** `market:open-interest:v1`
- **TTL:** 3600s
- **Schema:** `{ btc: { totalOI: number, change24h: number, change1h: number }, eth: { ... }, fetchedAt: number }`
- **Why:** OI flush (rapid decline) signals forced liquidations. Combined with funding rates, detects leverage unwind events.
- **Cron group:** crypto (every 30min)

### 4. Whale Transactions

- **API:** Whale Alert `https://api.whale-alert.io/v1/transactions`
- **Auth:** Free tier API key (10 req/min, register at whale-alert.io)
- **Rate limit:** 10 req/min, 100 per day on free tier
- **Redis key:** `market:whale-alerts:v1`
- **TTL:** 600s (fast-moving data)
- **Schema:** `{ transactions: [{ blockchain, symbol, amount_usd, from_owner_type, to_owner_type, timestamp }], summary: { exchange_inflow_usd_1h, exchange_outflow_usd_1h, net_flow_usd_1h }, fetchedAt }`
- **Why:** Large movements (>$1M) to exchanges precede sell pressure. Movements from exchanges signal accumulation.
- **Cron group:** crypto (every 30min)
- **Note:** Free tier is limited. Consider upgrading if cryptarista goes live.

### 5. Exchange Net Flows

- **API:** CryptoQuant `https://api.cryptoquant.com/v1/btc/exchange-flows/netflow`
- **Auth:** Free tier API key (register at cryptoquant.com)
- **Rate limit:** 10 req/min on free tier
- **Redis key:** `market:exchange-flows:v1`
- **TTL:** 3600s
- **Schema:** `{ btc: { netflow_1h: number, netflow_24h: number, exchange_reserve: number, trend: 'inflow'|'outflow'|'neutral' }, fetchedAt }`
- **Why:** Sustained exchange inflows = sell pressure building. Leading indicator for price drops.
- **Cron group:** crypto (every 30min)
- **Fallback:** If CryptoQuant free tier is too limited, use Glassnode or derive from Whale Alert data.

### 6. BTC Dominance

- **API:** CoinGecko `https://api.coingecko.com/api/v3/global`
- **Auth:** None (or COINGECKO_API_KEY if configured)
- **Rate limit:** Shared with existing CoinGecko seeders
- **Redis key:** `market:btc-dominance:v1`
- **TTL:** 3600s
- **Schema:** `{ dominance: number, change24h: number, totalMarketCap: number, altseasonIndex: number, fetchedAt }`
- **Why:** Rising BTC dominance = risk-off rotation in crypto. Falling = altseason. Key signal for portfolio allocation.
- **Cron group:** crypto (every 30min)
- **Note:** Consider combining with existing CoinGecko calls to avoid redundant API hits.

## Integration Points

1. All 6 seeders follow existing patterns in `_seed-utils.mjs` (runSeed, atomicPublish, seed-meta)
2. Add all 6 to `scripts/run-seeders-crypto.sh` CRYPTO_SEEDERS list
3. Add health check entries to `api/health.js` BOOTSTRAP_KEYS + SEED_META
4. New env vars: `COINGLASS_API_KEY`, `WHALE_ALERT_API_KEY`, `CRYPTOQUANT_API_KEY`
5. No new env vars for Fear & Greed, BTC Dominance (public APIs)

## Deliverables

1. 6 new seeder scripts
2. Health check entries (6 keys)
3. Updated `run-seeders-crypto.sh`
4. API key registration guide (Coinglass, Whale Alert, CryptoQuant)
5. Tests for each seeder

## Success Criteria

- All 6 seeders running in crypto cron cycle
- Health check shows 6 new OK entries
- Data visible in Redis within first cron cycle

## Out of Scope

- Forecast pipeline integration (Spec 4)
- Social sentiment (LunarCrush, Santiment) — future phase
- Mempool congestion — future phase
- Stablecoin mint/burn on-chain (requires blockchain RPC) — future phase, derive from Whale Alert initially
