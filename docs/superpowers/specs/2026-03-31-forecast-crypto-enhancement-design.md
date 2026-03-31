# Forecast Pipeline Crypto Enhancement — Design Spec

**Date:** 2026-03-31
**Status:** Approved
**Author:** arista + Claude
**Depends on:** Spec 2 (Crypto Data Sources)

## Problem

The `crypto_stablecoins` market bucket in the forecast pipeline is the weakest in the system:
- Lowest `edgeWeight: 0.62` (other buckets: 0.70-0.85)
- Lowest `edgeLift: 0.03` and `macroLift: 0.05`
- Highest `reportableScoreFloor: 0.55` (harder to publish)
- Only 4 signal channels: `risk_off_rotation`, `fx_stress`, `liquidity_expansion`, `liquidity_withdrawal`
- No crypto-native signal channels (funding rates, OI, whale movements, exchange flows)
- No temporal anomaly detector for crypto price action (conflict events have one via `_ema-threat-engine.mjs`)

## Changes

### 1. New Signal Channels

Add 4 crypto-native signal channels to `seed-forecasts.mjs:291-295`:

| Channel | Source Key | Trigger |
|---|---|---|
| `funding_rate_extreme` | `market:funding-rates:v1` | BTC funding > 0.05% or < -0.03% |
| `oi_flush` | `market:open-interest:v1` | OI drops > 10% in 1h |
| `whale_movement` | `market:whale-alerts:v1` | Net exchange inflow > $50M/1h |
| `exchange_flow_stress` | `market:exchange-flows:v1` | Sustained inflows > 3 consecutive readings |

These channels add to the existing 4, giving `crypto_stablecoins` 8 total signal channels.

### 2. Bucket Recalibration

Update `seed-forecasts.mjs:291-295` and `seed-forecasts.mjs:407`:

| Parameter | Before | After | Rationale |
|---|---|---|---|
| `edgeWeight` | 0.62 | 0.75 | Align with other market buckets now that native signals exist |
| `reportableScoreFloor` | 0.55 | 0.45 | Lower bar — crypto signals are more direct than macro proxies |
| `edgeLift` | 0.03 | 0.08 | Stronger lift from edge signals (on-chain data is high-signal) |
| `macroLift` | 0.05 | 0.07 | Slight increase — macro still matters for crypto |

### 3. Crypto Price Action EMA Detector

Create a crypto temporal anomaly detector analogous to `_ema-threat-engine.mjs`:

- **Input:** `market:crypto:v1` (price history), `market:funding-rates:v1`, `market:open-interest:v1`
- **Method:** Exponential moving average over 4h, 12h, 24h windows
- **Detects:**
  - Price divergence from EMA (>2 std dev)
  - Funding rate acceleration (rate of change)
  - OI build-up without price movement (potential squeeze)
- **Output:** Array of anomaly signals fed into forecast pipeline at `seed-forecasts.mjs:749`
- **File:** `scripts/_crypto-anomaly-engine.mjs`

### 4. GDELT LLM Enrichment

**File:** `scripts/seed-gdelt-intel.mjs`

After aggregating 6 topic article lists, add a single LLM call:

- **Provider:** Groq (llama-3.1-8b-instant) — fast, cheap
- **Prompt:** "Classify the overall media tone for each topic as 'deteriorating', 'stable', or 'improving' based on these headlines: {headlines}"
- **Max tokens:** 400
- **Output:** Per-topic classification stored alongside existing tone data
- **Why:** Activates `MEDIA_TONE_DETERIORATION` signal type in cross-source-signals. Current 3-point mathematical trend detection is unreliable without this.

### 5. Wire New Data Sources into Forecast Pipeline

**File:** `seed-forecasts.mjs:661-751`

Add reads for Spec 2 keys:

```js
// New crypto-native inputs
const fundingRates = await readKey('market:funding-rates:v1');
const openInterest = await readKey('market:open-interest:v1');
const whaleAlerts = await readKey('market:whale-alerts:v1');
const exchangeFlows = await readKey('market:exchange-flows:v1');
const cryptoFng = await readKey('market:crypto-fng:v1');
const btcDominance = await readKey('market:btc-dominance:v1');
```

These feed into signal extraction for the 4 new channels and the crypto anomaly engine.

## Deliverables

1. 4 new signal channels in forecast bucket definition
2. Recalibrated crypto bucket parameters
3. `_crypto-anomaly-engine.mjs` — EMA-based crypto anomaly detector
4. GDELT LLM enrichment (1 call per seeder run)
5. Wiring of 6 new Redis keys into forecast pipeline
6. Tests for new channels, anomaly detector, and GDELT enrichment

## Success Criteria

- Crypto bucket `edgeWeight` raised to 0.75
- 8 signal channels (up from 4)
- Crypto-native forecasts generated when funding rates or OI are extreme
- MEDIA_TONE_DETERIORATION fires when GDELT tone is classified as 'deteriorating'
- Forecast accuracy for crypto events improves (qualitative, measured over 30-day period)

## Out of Scope

- Additional LLM calls in other seeders (keep to GDELT only for now)
- Backtest framework for forecasts (future)
- UI changes to display new signal types
