# Worldmonitor OSINT Configuration for Cryptarista

**Date:** 2026-03-31
**Status:** Approved
**Scope:** Configure worldmonitor as OSINT data source for cryptarista (CR-027b preparation)

---

## Context

Worldmonitor is deployed on VPS (Docker: app + Redis + Redis REST) and serves as the
primary OSINT intelligence feed for the cryptarista trading system. The cryptarista
CR-027a specification is complete but CR-027b (runtime Python adapters) is blocked on
CR-022 and CR-026. This configuration ensures data is flowing when CR-027b unblocks.

### Current State
- 57/67 seeders passing (5 skipped for missing API keys, 5 failing)
- 13/21 cross-source-signals functional (public data only)
- LLM features completely offline (no provider configured)
- AIS relay disabled (not needed for crypto deployment)

### Target State
- 21/21 cross-source-signals functional
- LLM reasoning + tool pipelines active
- All gate-eligible OSINT endpoints producing data for cryptarista

---

## Architecture

```
Seeders (cron 30min) ──> Redis ──> WM App (:3000) ──> Cryptarista (future CR-027b)
                           ^                              │
                           │                              ▼
                      Redis REST (:8079)          IntelligenceEvent → GateDecision → Risk Engine
```

### LLM Routing

| Task Type | Function | Provider | Model | Cost |
|---|---|---|---|---|
| Parsing/extraction | `callLlmTool` | Groq | `llama-3.1-8b-instant` | Free (14.4K req/day) |
| Synthesis/reasoning | `callLlmReasoning` | OpenAI (generic) | `gpt-5.4-mini` | $0.75/$4.50 per 1M tokens |
| Fallback chain | `callLlm` | groq → openrouter → generic → ollama | — | — |

---

## Configuration Layers

### Layer 0: LLM (unlocks all AI-dependent features)

**Env vars:**

```env
GROQ_API_KEY=gsk_...
LLM_API_URL=https://api.openai.com/v1/chat/completions
LLM_API_KEY=sk-svcacct-...    # reused from arista-zero
LLM_MODEL=gpt-5.4-mini
LLM_REASONING_PROVIDER=generic
LLM_TOOL_PROVIDER=groq
```

**Unlocks:** seed-forecasts, seed-insights, seed-fear-greed (enriched), news threat
classification, chat analyst, deduction engine, cross-source-signal FORECAST_DETERIORATION

**Code change required:** `server/_shared/llm.ts` must send `max_completion_tokens`
instead of `max_tokens` for GPT-5.x and o-series models. The API rejects `max_tokens`
for these models. Affects both `callLlm()` and `callLlmReasoningStream()`.

### Layer 1: Macro Data (FRED + EIA)

**Env vars:**

```env
FRED_API_KEY=<register at fred.stlouisfed.org>
EIA_API_KEY=<register at eia.gov/opendata>
```

**Unlocks signals:** VIX_SPIKE, COMMODITY_SHOCK, MARKET_STRESS
**Unlocks seeders:** seed-economy (enriched), seed-bls-series, seed-economic-calendar

### Layer 2: Market Data (Finnhub)

**Env vars:**

```env
FINNHUB_API_KEY=<register at finnhub.io>
```

**Unlocks:** seed-market-quotes (enriched), seed-earnings-calendar, stock analysis
**Rate limit:** 60 req/min free tier

### Layer 3: Conflict Data (ACLED)

**Env vars:**

```env
ACLED_EMAIL=<register at acleddata.com>
ACLED_PASSWORD=<account password>
```

**Unlocks signals:** UNREST_SURGE, SANCTIONS_SURGE
**Note:** Access tokens expire every 24h; email/password enables auto-refresh.

### Layer 4: Satellite & Infrastructure (NASA FIRMS + Cloudflare)

**Env vars:**

```env
NASA_FIRMS_API_KEY=<register at firms.modaps.eosdis.nasa.gov>
CLOUDFLARE_API_TOKEN=<existing CF account or new token with Radar read scope>
```

**Unlocks signals:** WILDFIRE_ESCALATION, INFRASTRUCTURE_OUTAGE

---

## Cross-Source-Signal Coverage

| Signal | Before | After | Layer |
|---|---|---|---|
| THERMAL_SPIKE | OK | OK | — |
| GPS_JAMMING | OK | OK | — |
| MILITARY_FLIGHT_SURGE | OK | OK | — |
| UNREST_SURGE | Partial | Complete | 3 |
| OREF_ALERT_CLUSTER | OK | OK | — |
| VIX_SPIKE | Partial | Complete | 1 |
| COMMODITY_SHOCK | Partial | Complete | 1 |
| CYBER_ESCALATION | OK | OK | — |
| SHIPPING_DISRUPTION | OK | OK | — |
| SANCTIONS_SURGE | Partial | Complete | 3 |
| EARTHQUAKE_SIGNIFICANT | OK | OK | — |
| RADIATION_ANOMALY | OK | OK | — |
| INFRASTRUCTURE_OUTAGE | Skip | Active | 4 |
| WILDFIRE_ESCALATION | Skip | Active | 4 |
| DISPLACEMENT_SURGE | OK | OK | — |
| FORECAST_DETERIORATION | Skip | Active | 0 |
| MARKET_STRESS | Partial | Complete | 1+2 |
| WEATHER_EXTREME | OK | OK | — |
| MEDIA_TONE_DETERIORATION | OK | OK | — |
| RISK_SCORE_SPIKE | OK | OK | — |
| COMPOSITE_ESCALATION | Partial | Complete | all |

**Result: 13/21 → 21/21 signals active**

---

## Code Changes

### 1. `server/_shared/llm.ts` — max_completion_tokens support

GPT-5.x and o-series models reject the `max_tokens` parameter and require
`max_completion_tokens` instead. Add model detection and parameter selection
in both `callLlm()` and `callLlmReasoningStream()`.

Detection regex: `/^(gpt-5|o[1-9])/`

Two locations:
- `callLlm()` body construction (~line 413)
- `callLlmReasoningStream()` body construction (~line 287)

### 2. `docker-compose.override.yml` — pass new env vars

Add all new environment variables to the worldmonitor service section so they
are available inside the container.

### 3. `.env` — add credentials

Add LLM and API key values. No structural changes.

---

## Cryptarista OSINT Endpoints (future CR-027b consumers)

| WM Endpoint | Gate-Eligible | Data |
|---|---|---|
| `/api/intelligence/v1/list-cross-source-signals` | YES | 21 signal types |
| `/api/news/v1/list-feed-digest` | YES | News + threat classification |
| `/api/market/v1/get-fear-greed-index` | NO (annotation) | Composite sentiment |
| `/api/market/v1/list-stablecoin-markets` | NO (annotation) | Depeg monitoring |
| `/api/market/v1/list-crypto-quotes` | NO (research) | Crypto prices |

---

## Implementation Order

1. Patch `server/_shared/llm.ts` (max_completion_tokens)
2. Configure `.env` with Layer 0 vars (LLM)
3. Update `docker-compose.override.yml`
4. Rebuild container, run seeders, validate LLM features
5. Register for Layer 1-4 API keys (user action)
6. Add each key to `.env` + override, re-run affected seeders
7. Validate 21/21 cross-source-signals

---

## Out of Scope

- Auth/billing (Clerk, Dodo Payments) — not needed for OSINT
- AIS relay — disabled for crypto deployment
- Telegram OSINT — deferred to later phase
- Consumer prices core — separate microservice
- Pro tier gating — B2C monetization, irrelevant for cryptarista
- 59 pending TODOs — separate backlog, not blocking OSINT data flow
