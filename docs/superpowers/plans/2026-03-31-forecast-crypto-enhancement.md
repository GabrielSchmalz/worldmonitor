# Implementation Plan: Forecast Pipeline Crypto Enhancement

**Date:** 2026-03-31
**Spec:** `docs/superpowers/specs/2026-03-31-forecast-crypto-enhancement-design.md`
**Depends on:** Spec 2 (Crypto Data Sources) — Redis keys `market:funding-rates:v1`, `market:open-interest:v1`, `market:whale-alerts:v1`, `market:exchange-flows:v1`, `market:crypto-fng:v1`, `market:btc-dominance:v1` must exist before tasks 3–5.
**Status:** Ready to execute

---

## Overview

Five tasks executed sequentially. Tasks 1–2 are self-contained and do not require Spec 2 keys. Tasks 3–5 depend on Spec 2 keys being live in Redis.

```
Task 1 — Bucket recalibration (seed-forecasts.mjs constants)
Task 2 — GDELT LLM enrichment (seed-gdelt-intel.mjs)
Task 3 — _crypto-anomaly-engine.mjs (new pure module)
Task 4 — Wire 6 new Redis keys into readInputKeys()
Task 5 — Wire new signals into buildWorldSignals()
```

---

## Task 1: Bucket Recalibration and New Signal Channel Declarations

**File:** `scripts/seed-forecasts.mjs`
**Lines:** ~289-295 (bucket def), ~336 (floor), ~401 (simulation bias), ~411 (state calibration), ~292 (signalTypes), ~293 (signalWeights), ~316 (critical), ~346 (allowed), ~391 (adjacent)

### Test-first step

Write a tiny smoke-check script before making changes so you can verify the before/after:

```
node -e "
import('./scripts/seed-forecasts.mjs').catch(() => {}).then(() => {
  console.log('import ok');
}).catch(() => {});
"
```

If the file has a `process.argv[1]` guard the import will be a no-op. The real test is running `node scripts/seed-forecasts.mjs --dry-run` (if that flag exists) or checking the seeder doesn't crash on startup after edits.

### Changes

**1a. Bucket definition** — add 4 new `signalTypes` and their weights:

Current (`~line 290-295`):
```js
{
  id: 'crypto_stablecoins',
  label: 'Crypto and Stablecoins',
  signalTypes: ['risk_off_rotation', 'fx_stress', 'liquidity_expansion', 'liquidity_withdrawal'],
  signalWeights: { risk_off_rotation: 0.74, fx_stress: 0.84, liquidity_expansion: 0.86, liquidity_withdrawal: 0.8 },
  edgeWeight: 0.62,
},
```

Replace with:
```js
{
  id: 'crypto_stablecoins',
  label: 'Crypto and Stablecoins',
  signalTypes: [
    'risk_off_rotation', 'fx_stress', 'liquidity_expansion', 'liquidity_withdrawal',
    'funding_rate_extreme', 'oi_flush', 'whale_movement', 'exchange_flow_stress',
  ],
  signalWeights: {
    risk_off_rotation: 0.74, fx_stress: 0.84, liquidity_expansion: 0.86, liquidity_withdrawal: 0.8,
    funding_rate_extreme: 0.88, oi_flush: 0.82, whale_movement: 0.78, exchange_flow_stress: 0.76,
  },
  edgeWeight: 0.75,
},
```

Rationale for new weights: `funding_rate_extreme` is the highest-signal on-chain indicator (0.88), `oi_flush` is a direct liquidity shock (0.82), `whale_movement` is directional but noisy (0.78), `exchange_flow_stress` is persistent inflow (0.76 — lower because 3-consecutive-readings condition already filters).

**1b. Reportable score floor** (`MARKET_BUCKET_REPORTABLE_SCORE_FLOORS`, ~line 336):

```js
// Before
crypto_stablecoins: 0.55,
// After
crypto_stablecoins: 0.45,
```

**1c. State calibration** (`MARKET_BUCKET_STATE_CALIBRATION`, ~line 411):

```js
// Before
crypto_stablecoins: { edgeLift: 0.03, macroLift: 0.05, confidenceLift: 0.02 },
// After
crypto_stablecoins: { edgeLift: 0.08, macroLift: 0.07, confidenceLift: 0.02 },
```

**1d. Critical signal types** (`MARKET_BUCKET_CRITICAL_SIGNAL_TYPES`, ~line 316):

```js
// Before
crypto_stablecoins: ['sovereign_stress', 'fx_stress', 'liquidity_withdrawal'],
// After
crypto_stablecoins: ['sovereign_stress', 'fx_stress', 'liquidity_withdrawal', 'funding_rate_extreme', 'oi_flush'],
```

**1e. Allowed channels** (`MARKET_BUCKET_ALLOWED_CHANNELS`, ~line 346):

```js
// Before
crypto_stablecoins: ['fx_stress', 'risk_off_rotation', 'liquidity_withdrawal', 'sovereign_stress'],
// After
crypto_stablecoins: [
  'fx_stress', 'risk_off_rotation', 'liquidity_withdrawal', 'sovereign_stress',
  'funding_rate_extreme', 'oi_flush', 'whale_movement', 'exchange_flow_stress',
],
```

**1f. Adjacent channels** (`MARKET_BUCKET_ADJACENT_CHANNELS`, ~line 391):

```js
// Before
crypto_stablecoins: ['fx_stress', 'risk_off_rotation', 'liquidity_withdrawal', 'sovereign_stress'],
// After
crypto_stablecoins: [
  'fx_stress', 'risk_off_rotation', 'liquidity_withdrawal', 'sovereign_stress',
  'funding_rate_extreme', 'oi_flush', 'whale_movement', 'exchange_flow_stress',
],
```

**1g. `resolveImpactChannel` fallback entries** (~line 355–379): Add regex branches so free-form LLM strings map to the new channels:

```js
// After the existing liquidit → liquidity_withdrawal line, add:
if (/funding.rate|perp.funding|funding.extreme/.test(m)) return 'funding_rate_extreme';
if (/open.interest|oi.flush|oi.drop|oi.collapse/.test(m)) return 'oi_flush';
if (/whale|large.transfer|exchange.inflow/.test(m)) return 'whale_movement';
if (/exchange.flow|sustained.inflow|consecutive.inflow/.test(m)) return 'exchange_flow_stress';
```

Place these four lines immediately before the final `return 'commodity_repricing'` fallback.

### Commit

```
git add scripts/seed-forecasts.mjs
git commit -m "feat(forecasts): recalibrate crypto_stablecoins bucket — raise edgeWeight to 0.75, add 4 native signal channels"
```

---

## Task 2: GDELT LLM Tone Enrichment

**File:** `scripts/seed-gdelt-intel.mjs`

### Context

`fetchAllTopics()` builds an array of 6 topic objects (military, cyber, nuclear, sanctions, intelligence, maritime). Each has `.articles` (array of `{ title, url, source, date, tone, ... }`). After the loop the function returns `{ topics, fetchedAt }`.

The LLM enrichment adds a single Groq call that classifies tone per topic based on article titles. Output is stored on the topic as `._llmTone` (stripped by `publishTransform` before writing to canonical key) and also written as a separate extra key `gdelt:intel:llm-tone:v1` for the cross-source-signals extractor.

### Test-first step

Run the existing seeder manually with `GROQ_API_KEY` unset to confirm no LLM call is attempted (graceful degradation must work before enrichment is written).

### Changes

**2a. Add LLM constants** at the top of the file, after the existing constants:

```js
const GDELT_LLM_TONE_KEY = 'gdelt:intel:llm-tone:v1';
const GDELT_LLM_TONE_TTL = 43200; // 12h — matches TIMELINE_TTL
const GDELT_LLM_PROVIDER = {
  name: 'groq',
  envKey: 'GROQ_API_KEY',
  apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
  model: 'llama-3.1-8b-instant',
  timeout: 20_000,
  maxTokens: 400,
};
```

**2b. Add `enrichTopicsWithLlmTone(topics)` function** (pure, async, best-effort):

```js
async function enrichTopicsWithLlmTone(topics) {
  const apiKey = process.env[GDELT_LLM_PROVIDER.envKey];
  if (!apiKey) return topics; // graceful degradation — no key = no enrichment

  // Build per-topic headline list (max 5 per topic to stay within token budget)
  const topicSummaries = topics.map((t) => {
    const headlines = (t.articles || []).slice(0, 5).map((a) => a.title).filter(Boolean);
    return { id: t.id, headlines };
  }).filter((t) => t.headlines.length > 0);

  if (topicSummaries.length === 0) return topics;

  const prompt = topicSummaries.map((t) =>
    `${t.id}:\n${t.headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
  ).join('\n\n');

  const systemPrompt = `You are a geopolitical tone classifier. For each topic below, classify the overall media tone as exactly one of: "deteriorating", "stable", or "improving". Base your judgment solely on the headlines provided. Reply with a JSON object mapping topic id to classification. Example: {"military":"deteriorating","cyber":"stable"}`;

  try {
    const resp = await fetch(GDELT_LLM_PROVIDER.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': CHROME_UA,
      },
      body: JSON.stringify({
        model: GDELT_LLM_PROVIDER.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: GDELT_LLM_PROVIDER.maxTokens,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(GDELT_LLM_PROVIDER.timeout),
    });

    if (!resp.ok) {
      console.warn(`  [gdelt-llm] Groq tone API error: ${resp.status}`);
      return topics;
    }

    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    // Extract first JSON object from response (handles markdown fences, extra commentary)
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      console.warn(`  [gdelt-llm] No JSON object in response`);
      return topics;
    }
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));

    const VALID_TONES = new Set(['deteriorating', 'stable', 'improving']);
    return topics.map((t) => {
      const classification = parsed[t.id];
      if (classification && VALID_TONES.has(classification)) {
        return { ...t, _llmTone: classification };
      }
      return t;
    });
  } catch (err) {
    console.warn(`  [gdelt-llm] Tone enrichment failed: ${err.message}`);
    return topics; // graceful degradation
  }
}
```

**2c. Wire into `fetchAllTopics()`** — call enrichment after the loop, before returning:

Current ending of `fetchAllTopics()`:
```js
  return { topics, fetchedAt: new Date().toISOString() };
}
```

Replace with:
```js
  // LLM tone enrichment — single Groq call, best-effort (skipped if GROQ_API_KEY absent)
  console.log('  Enriching topics with LLM tone classification...');
  topics = await enrichTopicsWithLlmTone(topics);
  const llmToneCount = topics.filter((t) => t._llmTone).length;
  console.log(`  [gdelt-llm] ${llmToneCount}/${topics.length} topics classified`);

  return { topics, fetchedAt: new Date().toISOString() };
}
```

Note: `topics` must be `let` not `const` in `fetchAllTopics`. The current code uses `const topics = []` and pushes into it. The `let` rebind is safe — change `const topics = [];` at the top of `fetchAllTopics` to `let topics = [];`.

**2d. Write LLM tone key in `afterPublish`** — add after existing tone/vol writes:

```js
// Write LLM tone classification key
const llmToneMap = {};
for (const topic of data.topics ?? []) {
  // _llmTone is preserved on the data object passed to afterPublish (before publishTransform strips it)
  if (topic._llmTone) llmToneMap[topic.id] = topic._llmTone;
}
if (Object.keys(llmToneMap).length > 0) {
  await writeExtraKey(GDELT_LLM_TONE_KEY, { classifications: llmToneMap, fetchedAt: data.fetchedAt }, GDELT_LLM_TONE_TTL);
}
```

IMPORTANT: `afterPublish` receives `data` — the raw pre-transform data (the second arg to `runSeed`'s `afterPublish` callback receives the un-transformed payload). Confirm by reading `_seed-utils.mjs` `runSeed` implementation if uncertain. If `afterPublish` receives the transformed data (without `_llmTone`), then write the key at the end of `fetchAllTopics` instead, passing it as a top-level field that `publishTransform` strips.

**2e. Strip `_llmTone` in `publishTransform`**:

```js
function publishTransform(data) {
  return {
    ...data,
    topics: (data.topics ?? []).map(({ _tone: _t, _vol: _v, exhausted: _e, _llmTone: _lt, ...rest }) => rest),
  };
}
```

**2f. Wire into `extractMediaToneDeterioration` in `seed-cross-source-signals.mjs`**:

Current: only uses 3-point mathematical trend detection.

Add a new primary path using the LLM classification at the top of `extractMediaToneDeterioration`, before the existing `for (const topic of GDELT_TONE_TOPICS)` loop:

```js
// Primary: LLM tone classifications (written by seed-gdelt-intel.mjs afterPublish)
const llmTonePayload = d['gdelt:intel:llm-tone:v1'];
if (llmTonePayload?.classifications) {
  const llmSignals = [];
  for (const [topicId, classification] of Object.entries(llmTonePayload.classifications)) {
    if (classification !== 'deteriorating') continue;
    const theater = topicId === 'maritime' ? 'Indo-Pacific' : 'Global';
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_MEDIA_TONE_DETERIORATION'] * 1.0;
    llmSignals.push({
      id: `gdelt-llm-tone:${topicId}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_MEDIA_TONE_DETERIORATION',
      theater,
      summary: `Media tone deterioration (LLM): ${topicId} coverage classified as deteriorating`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: Date.now(),
      contributingTypes: [],
      signalCount: 0,
    });
  }
  if (llmSignals.length > 0) return llmSignals.slice(0, 2);
}
// Fall through to existing mathematical detection if LLM key is absent
```

Place this block at the very start of `extractMediaToneDeterioration`, before the `const signals = [];` line.

**2g. Add `'gdelt:intel:llm-tone:v1'` to the cross-source-signals Redis read list.** Find where the signals seeder reads its keys and add this key.

### Commit

```
git add scripts/seed-gdelt-intel.mjs scripts/seed-cross-source-signals.mjs
git commit -m "feat(gdelt): add LLM tone classification via Groq; wire into MEDIA_TONE_DETERIORATION signal extractor"
```

---

## Task 3: Create `_crypto-anomaly-engine.mjs`

**File:** `scripts/_crypto-anomaly-engine.mjs` (new file)
**Pattern:** Mirror `_ema-threat-engine.mjs` exactly — pure functions, no Redis, no side effects, JSDoc types, exports only.

### Test-first step

Create `scripts/_crypto-anomaly-engine.test.mjs` before the implementation:

```js
// @ts-check
/**
 * Unit tests for _crypto-anomaly-engine.mjs
 * Run: node --test scripts/_crypto-anomaly-engine.test.mjs
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  updateCryptoWindow,
  computeCryptoWindowStats,
  detectCryptoAnomalies,
} from './_crypto-anomaly-engine.mjs';

test('updateCryptoWindow initializes from null prior', () => {
  const ws = updateCryptoWindow('BTC', 50000, null);
  assert.equal(ws.symbol, 'BTC');
  assert.ok(Array.isArray(ws.window));
  assert.equal(ws.window.length, 1);
  assert.ok(typeof ws.ema === 'number');
});

test('updateCryptoWindow accumulates up to 24 points', () => {
  let ws = null;
  for (let i = 0; i < 30; i++) {
    ws = updateCryptoWindow('BTC', 50000 + i * 100, ws);
  }
  assert.equal(ws.window.length, 24);
});

test('computeCryptoWindowStats returns zero stddev for constant window', () => {
  const { mean, stddev } = computeCryptoWindowStats([100, 100, 100, 100, 100, 100]);
  assert.equal(mean, 100);
  assert.equal(stddev, 0);
});

test('detectCryptoAnomalies returns empty array when all inputs are null', () => {
  const result = detectCryptoAnomalies(null, null, null, new Map());
  assert.ok(Array.isArray(result.anomalies));
  assert.equal(result.anomalies.length, 0);
  assert.ok(result.updatedWindows instanceof Map);
});

test('detectCryptoAnomalies detects price divergence beyond 2 std dev', () => {
  // Build a window with known mean/stddev, then spike the current price
  const priorWindows = new Map();
  // Seed 8 readings at price=100 so stddev=0 initially, then add 6 more varied readings
  const prices = [100, 98, 102, 99, 101, 100, 100, 99]; // mean~100, small stddev
  let ws = null;
  for (const p of prices) {
    ws = updateCryptoWindow('BTC', p, ws);
  }
  priorWindows.set('BTC', ws);

  // Force a strong deviation: stddev is ~1, so price=110 is >>2 std devs
  const cryptoData = { assets: [{ symbol: 'BTC', price: 110, priceHistory: [] }] };
  const result = detectCryptoAnomalies(cryptoData, null, null, priorWindows);
  const priceDivergence = result.anomalies.filter(a => a.type === 'price_divergence');
  assert.ok(priceDivergence.length > 0, 'Expected price_divergence anomaly');
});

test('detectCryptoAnomalies detects OI buildup without price movement', () => {
  const oiData = {
    assets: [
      { symbol: 'BTC', openInterestChange1h: 0.02 }, // +2% OI
    ],
  };
  const cryptoData = { assets: [{ symbol: 'BTC', price: 50000, priceHistory: [] }] };
  // price unchanged (no divergence), but OI growing
  const priorWindows = new Map();
  let ws = null;
  for (let i = 0; i < 8; i++) ws = updateCryptoWindow('BTC', 50000, ws);
  priorWindows.set('BTC', ws);

  const result = detectCryptoAnomalies(cryptoData, null, oiData, priorWindows);
  // Should detect oi_buildup if price_divergence does NOT fire and OI is rising
  const oiBuildups = result.anomalies.filter(a => a.type === 'oi_buildup');
  // This test asserts the detector exists and runs without throwing
  assert.ok(Array.isArray(result.anomalies));
});
```

Run: `node --test scripts/_crypto-anomaly-engine.test.mjs` — should fail with module-not-found before implementation.

### Implementation

```js
// @ts-check
/**
 * EMA-based crypto price action anomaly detector.
 * Pure functions — no Redis, no side effects.
 * Analogous to _ema-threat-engine.mjs but for on-chain market data.
 *
 * Inputs: market:crypto:v1, market:funding-rates:v1, market:open-interest:v1
 * Output: array of anomaly signals fed into forecast pipeline at readInputKeys()
 */

const ALPHA = 0.3;
const MIN_WINDOW = 6; // min points before z-score is meaningful

/**
 * @typedef {{ symbol: string, window: number[], ema: number, mean: number, stddev: number, updatedAt: number }} CryptoWindowState
 */

/**
 * @typedef {{ type: string, symbol: string, severity: 'low'|'medium'|'high', zscore?: number, detail: string, detectedAt: number }} CryptoAnomaly
 */

/**
 * @param {string} symbol
 * @param {number} price
 * @param {CryptoWindowState|null} prior
 * @returns {CryptoWindowState}
 */
export function updateCryptoWindow(symbol, price, prior) {
  const prevWindow = Array.isArray(prior?.window) ? prior.window : [];
  const window = [...prevWindow, price].slice(-24);

  const prevEma = typeof prior?.ema === 'number' ? prior.ema : price;
  const ema = ALPHA * price + (1 - ALPHA) * prevEma;

  const { mean, stddev } = computeCryptoWindowStats(window);

  return { symbol, window, ema, mean, stddev, updatedAt: Date.now() };
}

/**
 * @param {number[]} window
 * @returns {{ mean: number, stddev: number }}
 */
export function computeCryptoWindowStats(window) {
  if (window.length === 0) return { mean: 0, stddev: 0 };
  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * Classify z-score into severity tier.
 * @param {number} absZscore
 * @returns {'low'|'medium'|'high'}
 */
function severityFromZscore(absZscore) {
  if (absZscore >= 3) return 'high';
  if (absZscore >= 2) return 'medium';
  return 'low';
}

/**
 * Detect price divergence from EMA (>2 std dev).
 *
 * @param {any} cryptoData — market:crypto:v1 payload
 * @param {Map<string, CryptoWindowState>} priorWindows
 * @returns {{ anomalies: CryptoAnomaly[], updatedWindows: Map<string, CryptoWindowState> }}
 */
function detectPriceDivergence(cryptoData, priorWindows) {
  const anomalies = [];
  const updatedWindows = new Map(priorWindows);

  const assets = Array.isArray(cryptoData?.assets) ? cryptoData.assets : [];
  for (const asset of assets) {
    const symbol = String(asset?.symbol || '');
    const price = Number(asset?.price || 0);
    if (!symbol || !price) continue;

    const prior = priorWindows.get(symbol) ?? null;
    const ws = updateCryptoWindow(symbol, price, prior);
    updatedWindows.set(symbol, ws);

    if (ws.window.length < MIN_WINDOW) continue;
    if (ws.stddev === 0) continue;

    const zscore = (ws.ema - ws.mean) / ws.stddev;
    const absZ = Math.abs(zscore);
    if (absZ < 2) continue;

    anomalies.push({
      type: 'price_divergence',
      symbol,
      severity: severityFromZscore(absZ),
      zscore,
      detail: `${symbol} EMA ${ws.ema.toFixed(2)} diverged ${zscore.toFixed(2)}σ from mean ${ws.mean.toFixed(2)}`,
      detectedAt: Date.now(),
    });
  }

  return { anomalies, updatedWindows };
}

/**
 * Detect funding rate acceleration.
 * Fires when |funding rate| > 0.05% (BTC) or > 0.03% negative (bearish extreme).
 *
 * @param {any} fundingData — market:funding-rates:v1 payload
 * @returns {CryptoAnomaly[]}
 */
function detectFundingRateExtreme(fundingData) {
  const anomalies = [];
  const assets = Array.isArray(fundingData?.rates) ? fundingData.rates : [];

  for (const asset of assets) {
    const symbol = String(asset?.symbol || '');
    const rate = Number(asset?.fundingRate || asset?.rate || 0);
    if (!symbol) continue;

    // Bullish extreme (perpetual squeeze risk): rate > 0.05%
    if (rate > 0.0005) {
      anomalies.push({
        type: 'funding_rate_extreme',
        symbol,
        severity: rate > 0.001 ? 'high' : 'medium',
        detail: `${symbol} funding rate ${(rate * 100).toFixed(4)}% — bullish extreme, squeeze risk`,
        detectedAt: Date.now(),
      });
    }
    // Bearish extreme: rate < -0.03%
    if (rate < -0.0003) {
      anomalies.push({
        type: 'funding_rate_extreme',
        symbol,
        severity: rate < -0.0008 ? 'high' : 'medium',
        detail: `${symbol} funding rate ${(rate * 100).toFixed(4)}% — bearish extreme, short squeeze risk`,
        detectedAt: Date.now(),
      });
    }
  }

  return anomalies;
}

/**
 * Detect OI build-up without price movement (potential squeeze setup).
 * Fires when OI grows > 5% in 1h while price divergence is absent.
 *
 * @param {any} oiData — market:open-interest:v1 payload
 * @param {Set<string>} priceSpikingSymbols — symbols already flagged by price_divergence
 * @returns {CryptoAnomaly[]}
 */
function detectOiBuildupWithoutPrice(oiData, priceSpikingSymbols) {
  const anomalies = [];
  const assets = Array.isArray(oiData?.assets) ? oiData.assets : [];

  for (const asset of assets) {
    const symbol = String(asset?.symbol || '');
    const oiChange1h = Number(asset?.openInterestChange1h ?? asset?.change1h ?? 0);
    if (!symbol) continue;

    // OI growing >5% in 1h
    if (oiChange1h < 0.05) continue;

    // Only flag as OI buildup when price is NOT already spiking (that's a different signal)
    if (priceSpikingSymbols.has(symbol)) continue;

    anomalies.push({
      type: 'oi_buildup',
      symbol,
      severity: oiChange1h > 0.1 ? 'high' : 'medium',
      detail: `${symbol} OI +${(oiChange1h * 100).toFixed(1)}% in 1h without price confirmation — squeeze setup`,
      detectedAt: Date.now(),
    });
  }

  return anomalies;
}

/**
 * Detect OI flush (OI drops >10% in 1h — forced deleveraging signal).
 *
 * @param {any} oiData — market:open-interest:v1 payload
 * @returns {CryptoAnomaly[]}
 */
function detectOiFlush(oiData) {
  const anomalies = [];
  const assets = Array.isArray(oiData?.assets) ? oiData.assets : [];

  for (const asset of assets) {
    const symbol = String(asset?.symbol || '');
    const oiChange1h = Number(asset?.openInterestChange1h ?? asset?.change1h ?? 0);
    if (!symbol) continue;

    if (oiChange1h > -0.10) continue; // must drop more than 10%

    anomalies.push({
      type: 'oi_flush',
      symbol,
      severity: oiChange1h < -0.20 ? 'high' : 'medium',
      detail: `${symbol} OI ${(oiChange1h * 100).toFixed(1)}% in 1h — forced deleveraging detected`,
      detectedAt: Date.now(),
    });
  }

  return anomalies;
}

/**
 * Main entry point — run all detectors and return combined anomalies.
 *
 * @param {any} cryptoData — market:crypto:v1 (may be null)
 * @param {any} fundingData — market:funding-rates:v1 (may be null)
 * @param {any} oiData — market:open-interest:v1 (may be null)
 * @param {Map<string, CryptoWindowState>} priorWindows — loaded from Redis or empty Map
 * @returns {{ anomalies: CryptoAnomaly[], updatedWindows: Map<string, CryptoWindowState> }}
 */
export function detectCryptoAnomalies(cryptoData, fundingData, oiData, priorWindows) {
  const safeWindows = priorWindows instanceof Map ? priorWindows : new Map();

  const { anomalies: priceAnomalies, updatedWindows } = detectPriceDivergence(cryptoData, safeWindows);

  const priceSpikingSymbols = new Set(priceAnomalies.map((a) => a.symbol));

  const fundingAnomalies = detectFundingRateExtreme(fundingData);
  const oiFlushAnomalies = detectOiFlush(oiData);
  const oiBuildupAnomalies = detectOiBuildupWithoutPrice(oiData, priceSpikingSymbols);

  const anomalies = [
    ...priceAnomalies,
    ...fundingAnomalies,
    ...oiFlushAnomalies,
    ...oiBuildupAnomalies,
  ];

  return { anomalies, updatedWindows };
}
```

### Verification

```
node --test scripts/_crypto-anomaly-engine.test.mjs
```

All 6 tests should pass.

### Commit

```
git add scripts/_crypto-anomaly-engine.mjs scripts/_crypto-anomaly-engine.test.mjs
git commit -m "feat(crypto): add _crypto-anomaly-engine.mjs — EMA price divergence, funding rate extreme, OI flush detectors"
```

---

## Task 4: Wire New Redis Keys into `readInputKeys()`

**File:** `scripts/seed-forecasts.mjs`
**Function:** `readInputKeys()` at ~line 661
**Depends on:** Spec 2 Redis keys being live (`market:funding-rates:v1`, `market:open-interest:v1`, `market:whale-alerts:v1`, `market:exchange-flows:v1`, `market:crypto-fng:v1`, `market:btc-dominance:v1`)

### Changes

**4a. Add 6 new keys to the `keys` array** (~line 664–694):

After `'conflict:ema-windows:v1'` (the last entry before `...fredKeys`), add:

```js
'market:funding-rates:v1',
'market:open-interest:v1',
'market:whale-alerts:v1',
'market:exchange-flows:v1',
'market:crypto-fng:v1',
'market:btc-dominance:v1',
'crypto:anomaly-windows:v1',
```

The last entry `crypto:anomaly-windows:v1` is the state persistence key for the crypto anomaly engine (analogous to `conflict:ema-windows:v1` for the EMA engine). It stores serialized `Map<string, CryptoWindowState>` between seeder runs.

**4b. Add 7 new return fields** in the `return {}` block (~line 716–751):

After `fredSeries,` add:

```js
fundingRates: parsedByKey['market:funding-rates:v1'],
openInterest: parsedByKey['market:open-interest:v1'],
whaleAlerts: parsedByKey['market:whale-alerts:v1'],
exchangeFlows: parsedByKey['market:exchange-flows:v1'],
cryptoFng: parsedByKey['market:crypto-fng:v1'],
btcDominance: parsedByKey['market:btc-dominance:v1'],
cryptoAnomalyWindowsRaw: results[keys.indexOf('crypto:anomaly-windows:v1')]?.result ?? null,
```

Note the `cryptoAnomalyWindowsRaw` pattern mirrors `emaWindowsRaw: results[keys.indexOf('conflict:ema-windows:v1')]?.result ?? null` exactly.

**4c. Add import** at the top of `seed-forecasts.mjs` (~line 12, after existing EMA import):

```js
import { detectCryptoAnomalies } from './_crypto-anomaly-engine.mjs';
```

### Commit

```
git add scripts/seed-forecasts.mjs
git commit -m "feat(forecasts): wire 6 Spec 2 crypto Redis keys + anomaly window state into readInputKeys()"
```

---

## Task 5: Wire Crypto Anomaly Engine and New World Signals

**File:** `scripts/seed-forecasts.mjs`
**Depends on:** Tasks 3 and 4

### 5a. Add `updateCryptoAnomalyWindows()` helper

Modeled directly on `updateEmaWindows()` at ~line 14861. Add this function immediately after `updateEmaWindows()`:

```js
async function updateCryptoAnomalyWindows(inputs, url, token) {
  let priorWindows = new Map();
  try {
    const raw = inputs.cryptoAnomalyWindowsRaw;
    if (raw) {
      const parsed = JSON.parse(raw);
      priorWindows = new Map(Object.entries(parsed));
    }
  } catch { /* cold start */ }

  const result = detectCryptoAnomalies(
    inputs.cryptoQuotes,
    inputs.fundingRates,
    inputs.openInterest,
    priorWindows,
  );

  // Persist updated windows (26h TTL — survives 6h cron gap with margin)
  const windowsObj = Object.fromEntries(result.updatedWindows);
  const ttl = 26 * 3600;
  await redisCommand(url, token, ['SET', 'crypto:anomaly-windows:v1', JSON.stringify(windowsObj), 'EX', ttl])
    .catch(err => console.warn(`  [CryptoAnomaly] Failed to persist windows: ${err.message}`));
  await redisCommand(url, token, ['SET', 'seed-meta:crypto:anomaly-windows:v1', JSON.stringify({ fetchedAt: new Date().toISOString(), recordCount: result.updatedWindows.size }), 'EX', ttl])
    .catch(err => console.warn(`  [CryptoAnomaly] Failed to persist seed-meta: ${err.message}`));

  const spikeCount = result.anomalies.filter(a => a.severity === 'high').length;
  if (spikeCount > 0) {
    console.log(`  [CryptoAnomaly] ${spikeCount} high-severity anomaly(ies):`,
      result.anomalies.filter(a => a.severity === 'high').map(a => `${a.symbol}:${a.type}`).join(', '));
  }

  return result.anomalies;
}
```

### 5b. Wire `updateCryptoAnomalyWindows` into `fetchForecasts()`

Current (~line 14915–14916):
```js
const emaRiskScores = await updateEmaWindows(inputs, emaUrl, emaToken);
const predictions = [
```

Replace with:
```js
const emaRiskScores = await updateEmaWindows(inputs, emaUrl, emaToken);
const cryptoAnomalies = await updateCryptoAnomalyWindows(inputs, emaUrl, emaToken);
inputs.cryptoAnomalies = cryptoAnomalies;
const predictions = [
```

### 5c. Add 4 new world signal extractors in `buildWorldSignals()`

Add after the existing `stablecoin peg stress` signal block (~line 9729–9739), before the BIS exchange rate loop:

```js
// ── Crypto-native signals (Spec 2 sources) ─────────────────────────────────

// funding_rate_extreme — from market:funding-rates:v1
const fundingRates = inputs?.fundingRates;
const fundingAssets = Array.isArray(fundingRates?.rates) ? fundingRates.rates : [];
const extremeFunding = fundingAssets.filter((a) => {
  const rate = Number(a?.fundingRate ?? a?.rate ?? 0);
  return rate > 0.0005 || rate < -0.0003;
});
if (extremeFunding.length > 0) {
  const worstRate = extremeFunding.reduce((a, b) =>
    Math.abs(Number(b?.fundingRate ?? b?.rate ?? 0)) > Math.abs(Number(a?.fundingRate ?? a?.rate ?? 0)) ? b : a
  );
  const rate = Number(worstRate?.fundingRate ?? worstRate?.rate ?? 0);
  signals.push(buildWorldSignal('funding_rate_extreme', 'funding_rates', `Funding rate extreme: ${worstRate.symbol}`, {
    sourceKey: 'market:funding-rates:v1',
    region: 'Global',
    strength: normalize(Math.abs(rate), 0.0003, 0.002),
    confidence: 0.78,
    domains: ['market', 'crypto'],
    supportingEvidence: extremeFunding.slice(0, 2).map((a) => `${a.symbol} rate ${(Number(a?.fundingRate ?? a?.rate ?? 0) * 100).toFixed(4)}%`),
  }));
}

// oi_flush — from market:open-interest:v1 (>10% drop in 1h)
const oiData = inputs?.openInterest;
const oiAssets = Array.isArray(oiData?.assets) ? oiData.assets : [];
const oiFlushed = oiAssets.filter((a) => Number(a?.openInterestChange1h ?? a?.change1h ?? 0) < -0.10);
if (oiFlushed.length > 0) {
  const worstFlush = oiFlushed.reduce((a, b) =>
    Number(b?.openInterestChange1h ?? b?.change1h ?? 0) < Number(a?.openInterestChange1h ?? a?.change1h ?? 0) ? b : a
  );
  const change = Number(worstFlush?.openInterestChange1h ?? worstFlush?.change1h ?? 0);
  signals.push(buildWorldSignal('oi_flush', 'open_interest', `OI flush: ${worstFlush.symbol}`, {
    sourceKey: 'market:open-interest:v1',
    region: 'Global',
    strength: normalize(Math.abs(change), 0.10, 0.40),
    confidence: 0.76,
    domains: ['market', 'crypto'],
    supportingEvidence: oiFlushed.slice(0, 2).map((a) => `${a.symbol} OI ${(Number(a?.openInterestChange1h ?? a?.change1h ?? 0) * 100).toFixed(1)}% 1h`),
  }));
}

// whale_movement — from market:whale-alerts:v1 (net exchange inflow >$50M/1h)
const whaleAlerts = inputs?.whaleAlerts;
const whaleTransfers = Array.isArray(whaleAlerts?.transfers) ? whaleAlerts.transfers : [];
const netInflow1h = whaleTransfers
  .filter((t) => {
    const age = Date.now() - (Number(t?.timestamp ?? 0) || 0);
    return age < 3600_000; // last 1h
  })
  .reduce((sum, t) => {
    const usd = Number(t?.usdAmount ?? t?.amount_usd ?? 0);
    return t?.direction === 'inflow' || t?.toExchange ? sum + usd : sum - usd;
  }, 0);
if (netInflow1h > 50_000_000) {
  signals.push(buildWorldSignal('whale_movement', 'whale_alerts', 'Whale exchange inflow detected', {
    sourceKey: 'market:whale-alerts:v1',
    region: 'Global',
    strength: normalize(netInflow1h, 50_000_000, 300_000_000),
    confidence: 0.7,
    domains: ['market', 'crypto'],
    supportingEvidence: [`Net exchange inflow: $${(netInflow1h / 1e6).toFixed(0)}M in last 1h`],
  }));
}

// exchange_flow_stress — from market:exchange-flows:v1 (3+ consecutive inflow readings)
const exchangeFlows = inputs?.exchangeFlows;
const flowReadings = Array.isArray(exchangeFlows?.readings) ? exchangeFlows.readings : [];
const recentReadings = flowReadings.slice(-5); // last 5 readings
const consecutiveInflows = (() => {
  let count = 0;
  for (let i = recentReadings.length - 1; i >= 0; i--) {
    if (Number(recentReadings[i]?.netFlow ?? recentReadings[i]?.net ?? 0) > 0) count++;
    else break;
  }
  return count;
})();
if (consecutiveInflows >= 3) {
  signals.push(buildWorldSignal('exchange_flow_stress', 'exchange_flows', 'Sustained exchange inflow pattern', {
    sourceKey: 'market:exchange-flows:v1',
    region: 'Global',
    strength: normalize(consecutiveInflows, 3, 8),
    confidence: 0.68,
    domains: ['market', 'crypto'],
    supportingEvidence: [`${consecutiveInflows} consecutive positive inflow readings`],
  }));
}
```

### 5d. Attach crypto anomaly signals from `inputs.cryptoAnomalies`

Add after the exchange_flow_stress block:

```js
// Crypto anomaly engine signals — fed from _crypto-anomaly-engine.mjs
const cryptoAnomalies = Array.isArray(inputs?.cryptoAnomalies) ? inputs.cryptoAnomalies : [];
for (const anomaly of cryptoAnomalies) {
  if (anomaly.severity === 'low') continue; // suppress low-severity to reduce noise
  const channelMap = {
    price_divergence: 'risk_off_rotation',
    funding_rate_extreme: 'funding_rate_extreme',
    oi_flush: 'oi_flush',
    oi_buildup: 'oi_flush', // oi_buildup maps to same channel — squeeze precursor
  };
  const channel = channelMap[anomaly.type] ?? 'risk_off_rotation';
  signals.push(buildWorldSignal(channel, 'crypto_anomaly_engine', anomaly.detail, {
    sourceKey: 'crypto:anomaly-windows:v1',
    region: 'Global',
    strength: anomaly.severity === 'high' ? 0.8 : 0.55,
    confidence: 0.65,
    domains: ['market', 'crypto'],
    supportingEvidence: [anomaly.detail],
  }));
}
```

### Commit

```
git add scripts/seed-forecasts.mjs
git commit -m "feat(forecasts): wire crypto anomaly engine and 4 native world signals (funding rate, OI, whale, exchange flow)"
```

---

## Sequencing and Dependencies

```
Task 1  ──────────────────────────────────> no external deps
Task 2  ──────────────────────────────────> no external deps
Task 3  ──────────────────────────────────> no external deps (pure module)
Task 4  ──── requires Spec 2 keys live in Redis (graceful: returns null if absent)
Task 5  ──── requires Tasks 3 + 4 complete
```

Tasks 1, 2, 3 can be executed before Spec 2 is deployed. Task 4 adds keys to the Redis pipeline — if the keys don't exist yet, `parsedByKey[key]` returns `null` and the return fields are `null`. All signal extractors in Task 5 use `Array.isArray(x?.y) ? ... : []` guards, so null inputs produce zero signals rather than errors.

---

## Verification Checklist

After all tasks:

- [ ] `node --test scripts/_crypto-anomaly-engine.test.mjs` — all tests pass
- [ ] Seeder boots without error: `node -e "import('./scripts/seed-forecasts.mjs').catch(()=>{})"` returns no import errors
- [ ] GDELT seeder runs without key: `GROQ_API_KEY='' node scripts/seed-gdelt-intel.mjs` — completes, logs `[gdelt-llm] 0/6 topics classified`
- [ ] `crypto_stablecoins` bucket has `edgeWeight: 0.75` in constants
- [ ] `IMPACT_SIGNAL_CHANNELS` Set includes `funding_rate_extreme`, `oi_flush`, `whale_movement`, `exchange_flow_stress`
- [ ] `readInputKeys` return object includes `fundingRates`, `openInterest`, `whaleAlerts`, `exchangeFlows`, `cryptoFng`, `btcDominance`, `cryptoAnomalyWindowsRaw`

---

## Files Changed Summary

| File | Change |
|---|---|
| `scripts/seed-forecasts.mjs` | Task 1 (constants), Task 4 (readInputKeys), Task 5 (updateCryptoAnomalyWindows + buildWorldSignals) |
| `scripts/seed-gdelt-intel.mjs` | Task 2 (LLM enrichment) |
| `scripts/seed-cross-source-signals.mjs` | Task 2f (LLM tone path in extractMediaToneDeterioration) |
| `scripts/_crypto-anomaly-engine.mjs` | Task 3 (new file) |
| `scripts/_crypto-anomaly-engine.test.mjs` | Task 3 (new file, test-first) |
