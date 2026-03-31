# Cross-Source Signal Coverage — Design Spec

**Date:** 2026-03-31
**Status:** Approved
**Author:** arista + Claude

## Problem

Only 4 of 21 cross-source signal types fire (UNREST_SURGE, COMMODITY_SHOCK, RADIATION_ANOMALY, FORECAST_DETERIORATION). The remaining 17 are inactive due to schema mismatches between extractors and seeder output, AIS-relay dependencies, or episodic thresholds that are structurally correct but never met under current data conditions.

## Current State

- `seed-cross-source-signals.mjs` reads 22 Redis source keys and runs 20 extractor functions
- 14/22 source keys are populated
- 8 missing keys: `intelligence:gpsjam:v2`, `military:flights:v1`, `intelligence:gdelt-intel:v1`, `gdelt:intel:tone:military`, `gdelt:intel:tone:nuclear`, `gdelt:intel:tone:maritime`, `weather:alerts:v1`, `risk:scores:sebuf:stale:v1`
- COMPOSITE_ESCALATION (21st type) is synthetic — requires 3+ co-firing categories in same theater

## Signal Type Classification

### Group A — Schema Mismatches (code bugs)

These signals **never fire** because the extractor reads a field that doesn't exist in the seeder output.

1. **SHIPPING_DISRUPTION** (`seed-cross-source-signals.mjs:396`)
   - Extractor reads `payload.routes`
   - Seeder (`seed-supply-chain-trade.mjs:591-593`) writes `{ indices: mergedIndices, fetchedAt, upstreamUnavailable }`
   - No `.routes` field exists. Fallback `Array.isArray(payload)` also fails (payload is object)
   - **Fix:** Rewrite extractor to read `payload.indices` and treat `index.spike === true` as disruption

2. **DISPLACEMENT_SURGE** (`seed-cross-source-signals.mjs:544`)
   - Extractor expects `payload.crises` array with `newDisplacements > 50000 || trend === 'rising'`
   - **Fix:** Validate actual schema from `seed-displacement-summary.mjs` output and align extractor

3. **SANCTIONS_SURGE** (`seed-cross-source-signals.mjs:419`)
   - Extractor requires `newEntryCount >= 5`
   - Sanctions seeder may not expose this field name
   - **Fix:** Verify field name in `seed-sanctions-pressure.mjs` output, align extractor

4. **RISK_SCORE_SPIKE** (`seed-cross-source-signals.mjs:696`)
   - Reads `risk:scores:sebuf:stale:v1` expecting `payload.ciiScores` with `combinedScore > 80`
   - Key is written by `seed-military-flights.mjs` (depends on AISSTREAM — disabled)
   - **Fix:** Decouple CII computation from AIS pipeline. ACLED, GDELT, sanctions, and thermal data can produce risk scores independently.

### Group B — AIS-Relay Dependent (3 types)

These require AISSTREAM credentials or AIS-relay running. Currently disabled for crypto deployment.

1. **MILITARY_FLIGHT_SURGE** — needs `military:flights:v1` (AIS)
2. **GPS_JAMMING** — needs `intelligence:gpsjam:v2` (AIS pipeline)
3. **THERMAL_SPIKE** — reads `thermal:escalation:v1`. Should work WITHOUT AIS if FIRMS data is fresh. Verify independence.

**Decision:** THERMAL_SPIKE should be decoupled from AIS if possible. The other two remain AIS-dependent — acceptable for crypto-focused deployment.

### Group C — Episodic (thresholds correct, fire when events occur)

These are structurally correct. They fire when real-world conditions are met:

| Signal | Threshold | Status |
|---|---|---|
| VIX_SPIKE | VIX >= 25 | Correct — fires during market stress |
| MARKET_STRESS | S&P 500 >= 2% daily change | Correct — fires few times/month |
| EARTHQUAKE_SIGNIFICANT | M >= 6.5 | Correct — fires when occurs |
| WILDFIRE_ESCALATION | >=5 fires, radiativePower >5000 | Correct — seasonal |
| WEATHER_EXTREME | severity === 'extreme' | Correct — verify string match |
| INFRASTRUCTURE_OUTAGE | severity 'major'/'critical' OR users >100K | Correct — verify string match |
| CYBER_ESCALATION | severity 'critical'/'high' | Correct — should fire if data exists |
| OREF_ALERT_CLUSTER | level === 'do not travel' | Correct — verify field name |
| MEDIA_TONE_DETERIORATION | 3 consecutive declining GDELT tone, finalVal < -1.5 | Correct — needs GDELT tone keys populated |

**Action for Group C:** Verify string matching for WEATHER_EXTREME, INFRASTRUCTURE_OUTAGE, CYBER_ESCALATION, OREF_ALERT_CLUSTER against actual seeder output. Fix any case-sensitivity or field name issues.

### Group D — Synthetic

**COMPOSITE_ESCALATION** — requires >=3 different signal categories co-firing in same theater. Activates automatically as more signal types come online. No direct fix needed.

## Deliverables

1. Fix 4 schema mismatches (Group A extractors)
2. Verify and fix string matching for 4 Group C signals
3. Decouple THERMAL_SPIKE from AIS dependency
4. Create `scripts/debug-signal-coverage.mjs` — reads all SOURCE_KEYS, runs extractors in dry-run mode, prints which would produce signals
5. Add contract validation to extractors (validate expected schema fields before processing, log warnings on mismatch)
6. Tests for each fixed extractor

## Success Criteria

- Signal types active: 4 -> 10+ (Group A fixes + verified Group C)
- `debug-signal-coverage.mjs` shows clear status per extractor
- No silent schema mismatches — all mismatches logged

## Out of Scope

- AIS-relay re-enablement (separate concern)
- New data sources (Spec 2)
- Forecast pipeline changes (Spec 4)
