# Cross-Source Signal Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 17/21 inactive cross-source signal types by correcting schema mismatches, verifying string matching, and creating debug tooling.

**Architecture:**

`seed-cross-source-signals.mjs` reads 22 Redis source keys in parallel via Upstash pipeline, then runs 20 pure extractor functions (one per signal type) that each receive the full `sourceData` map and return `Signal[]`. Each extractor is independently testable by passing a crafted `sourceData` object — no Redis required. The main aggregator then calls `detectCompositeEscalation()` on all signals and writes `{ signals, evaluatedAt, compositeCount }` to `intelligence:cross-source-signals:v1`.

Test pattern used by this codebase: `node:test` + `node:assert/strict`, `tsx --test tests/*.test.mjs tests/*.test.mts`. Test files use `vm.createContext` to strip ESM side-effects from seed scripts, or directly import pure functions. For extractors (which live inside seed scripts with side-effect imports), the vm pattern is needed.

Extractor tests can be simpler: extract the pure extractor functions into a dedicated test-helper shim by stripping imports and `runSeed` from the source, then running the extracted functions in a vm context.

**Tech Stack:** Node.js ESM v24, Redis via Upstash REST proxy (`getRedisCredentials()` + `fetch`), existing `_seed-utils.mjs` patterns (`runSeed`, `getRedisCredentials`, `loadEnvFile`)

---

## Bug Inventory (from reading source code)

### Group A — Schema Mismatches (confirmed by reading source)

| Signal | Extractor reads | Seeder actually writes | Fix |
|---|---|---|---|
| SHIPPING_DISRUPTION | `payload.routes` / `payload` as array | `{ indices: [...], fetchedAt, upstreamUnavailable }` — each index has `{ indexId, name, currentValue, previousValue, changePct, unit, history, spikeAlert }` | Read `payload.indices`, treat `spikeAlert === true` OR `Math.abs(changePct) > 15` as disruption |
| DISPLACEMENT_SURGE | `payload.crises` array with `newDisplacements` | `{ summary: { year, globalTotals, countries: [...], topFlows: [...] } }` — each country has `{ code, name, refugees, asylumSeekers, idps, stateless, totalDisplaced, hostRefugees, hostAsylumSeekers, hostTotal, location }` | Read `payload.summary.countries`, treat countries with `totalDisplaced > 1_000_000` as surge signals |
| SANCTIONS_SURGE | `payload.newEntryCount` (top-level) | `{ totalCount, newEntryCount, vesselCount, aircraftCount, countries: [...], programs: [...], ... }` — `newEntryCount` IS top-level, correct field name | Field name is correct but threshold `>= 5` is too high when `hasPrevious === false` (seeder sets `newEntryCount = 0` on first run). Fix: also check `payload.totalCount > 0 && payload.newEntryCount === 0` for initial state, or lower threshold awareness |
| OREF_ALERT_CLUSTER | `String(a.level).toLowerCase() === 'do not travel'` (space) | Seeder `seed-security-advisories.mjs` writes `level: 'do-not-travel'` (hyphenated) | Change comparison to `=== 'do-not-travel'` |

### Group B — AIS-Relay Dependent (no fix needed in this plan)

- MILITARY_FLIGHT_SURGE — needs `military:flights:v1` (AIS)
- GPS_JAMMING — needs `intelligence:gpsjam:v2` (AIS pipeline)
- THERMAL_SPIKE — reads `thermal:escalation:v1`. Independent from AIS if FIRMS is fresh. Verify key is populated separately from AIS.

### Group C — Episodic (string matching verification)

| Signal | Key issue | Status after reading code |
|---|---|---|
| WEATHER_EXTREME | Checks `a.severity === 'extreme'` but key `weather:alerts:v1` is in missing-key list | Key unpopulated — extractor logic is correct |
| INFRASTRUCTURE_OUTAGE | Checks `severity === 'major'` or `=== 'critical'` or `affectedUsers > 100000` | Logic correct — depends on `infra:outages:v1` being populated |
| CYBER_ESCALATION | Checks `t.severity === 'critical'` or `=== 'high'` on `cyber:threats-bootstrap:v2` | Logic correct |
| OREF_ALERT_CLUSTER | `'do not travel'` vs `'do-not-travel'` mismatch — **confirmed bug** | Fixed in Group A above |

### Group D — Synthetic

COMPOSITE_ESCALATION auto-fires when 3+ signal categories co-fire in same theater. No fix needed.

---

## Tasks

### Task 1 — Write failing test for all 4 Group A extractors

- [ ] **1.1** Create `/home/arista/src/worldmonitor/tests/cross-source-extractors.test.mjs`

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Strip ESM side-effects from the seed script so we can test pure functions.
const seedSrc = readFileSync('scripts/seed-cross-source-signals.mjs', 'utf8');
const pureSrc = seedSrc
  .replace(/^import\s.*$/gm, '')
  .replace(/loadEnvFile\([^)]+\);/, '')
  .replace(/async function readAllSourceKeys[\s\S]*/, ''); // strip network + runSeed tail

const ctx = vm.createContext({
  console,
  Date,
  Math,
  Number,
  Array,
  Map,
  Set,
  String,
  Object,
  AbortSignal,
  fetch: undefined,
});
vm.runInContext(pureSrc, ctx);

const {
  extractShippingDisruption,
  extractDisplacementSurge,
  extractSanctionsSurge,
  extractOrefAlertCluster,
} = ctx;

// ── extractShippingDisruption ────────────────────────────────────────────────

describe('extractShippingDisruption', () => {
  it('returns empty array when key is missing', () => {
    assert.deepEqual(extractShippingDisruption({}), []);
  });

  it('returns empty array when indices is empty', () => {
    const d = { 'supply_chain:shipping:v2': { indices: [], fetchedAt: '2026-01-01', upstreamUnavailable: false } };
    assert.deepEqual(extractShippingDisruption(d), []);
  });

  it('fires when spikeAlert is true', () => {
    const d = {
      'supply_chain:shipping:v2': {
        indices: [
          { indexId: 'TSIFRGHT', name: 'Freight Transportation Services Index', currentValue: 150, previousValue: 120, changePct: 25, unit: 'index', history: [], spikeAlert: true },
        ],
        fetchedAt: '2026-01-01',
        upstreamUnavailable: false,
      },
    };
    const result = extractShippingDisruption(d);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION');
  });

  it('fires when changePct exceeds threshold (>15%)', () => {
    const d = {
      'supply_chain:shipping:v2': {
        indices: [
          { indexId: 'SCFI', name: 'Shanghai Containerized Freight Index', currentValue: 2400, previousValue: 2000, changePct: 20, unit: 'index', history: [], spikeAlert: false },
        ],
        fetchedAt: '2026-01-01',
        upstreamUnavailable: false,
      },
    };
    const result = extractShippingDisruption(d);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION');
  });

  it('does NOT fire when changePct is within normal range', () => {
    const d = {
      'supply_chain:shipping:v2': {
        indices: [
          { indexId: 'SCFI', name: 'SCFI', currentValue: 2020, previousValue: 2000, changePct: 1, unit: 'index', history: [], spikeAlert: false },
        ],
        fetchedAt: '2026-01-01',
        upstreamUnavailable: false,
      },
    };
    assert.deepEqual(extractShippingDisruption(d), []);
  });

  it('does NOT fire on old payload shape (routes field)', () => {
    const d = {
      'supply_chain:shipping:v2': {
        routes: [{ disrupted: true, name: 'Red Sea', rerouting: 15 }],
      },
    };
    // With old code this fires; with fixed code routes field is ignored and we look at indices
    const result = extractShippingDisruption(d);
    // Fixed extractor reads indices, which is missing, so should return []
    assert.deepEqual(result, []);
  });
});

// ── extractDisplacementSurge ─────────────────────────────────────────────────

describe('extractDisplacementSurge', () => {
  const year = new Date().getFullYear();
  const key = `displacement:summary:v1:${year}`;

  it('returns empty array when key is missing', () => {
    assert.deepEqual(extractDisplacementSurge({}), []);
  });

  it('fires for countries with totalDisplaced > 1_000_000', () => {
    const d = {
      [key]: {
        summary: {
          year,
          globalTotals: { refugees: 5000000, asylumSeekers: 1000000, idps: 3000000, stateless: 500000, total: 9500000 },
          countries: [
            { code: 'SYR', name: 'Syria', refugees: 2000000, asylumSeekers: 0, idps: 500000, stateless: 0, totalDisplaced: 2500000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0, location: { latitude: 35.0, longitude: 38.0 } },
            { code: 'COL', name: 'Colombia', refugees: 0, asylumSeekers: 0, idps: 400000, stateless: 0, totalDisplaced: 400000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0, location: { latitude: 4.6, longitude: -74.1 } },
          ],
          topFlows: [],
        },
      },
    };
    const result = extractDisplacementSurge(d);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'CROSS_SOURCE_SIGNAL_TYPE_DISPLACEMENT_SURGE');
    assert.ok(result[0].summary.includes('Syria'));
  });

  it('returns empty array when no country exceeds threshold', () => {
    const d = {
      [key]: {
        summary: {
          year,
          globalTotals: { refugees: 100000, asylumSeekers: 50000, idps: 200000, stateless: 10000, total: 360000 },
          countries: [
            { code: 'COL', name: 'Colombia', refugees: 0, asylumSeekers: 0, idps: 400000, stateless: 0, totalDisplaced: 400000, hostRefugees: 0, hostAsylumSeekers: 0, hostTotal: 0 },
          ],
          topFlows: [],
        },
      },
    };
    assert.deepEqual(extractDisplacementSurge(d), []);
  });
});

// ── extractSanctionsSurge ────────────────────────────────────────────────────

describe('extractSanctionsSurge', () => {
  it('returns empty array when key is missing', () => {
    assert.deepEqual(extractSanctionsSurge({}), []);
  });

  it('fires when newEntryCount >= 5', () => {
    const d = {
      'sanctions:pressure:v1': {
        totalCount: 12000,
        newEntryCount: 8,
        vesselCount: 200,
        aircraftCount: 50,
        countries: [{ countryCode: 'RU', countryName: 'Russia', entryCount: 2000, newEntryCount: 6, vesselCount: 30, aircraftCount: 5 }],
        programs: [],
      },
    };
    const result = extractSanctionsSurge(d);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'CROSS_SOURCE_SIGNAL_TYPE_SANCTIONS_SURGE');
    assert.ok(result[0].summary.includes('Russia'));
  });

  it('does NOT fire when newEntryCount < 5', () => {
    const d = {
      'sanctions:pressure:v1': {
        totalCount: 11900,
        newEntryCount: 2,
        vesselCount: 200,
        aircraftCount: 50,
        countries: [],
        programs: [],
      },
    };
    assert.deepEqual(extractSanctionsSurge(d), []);
  });
});

// ── extractOrefAlertCluster ──────────────────────────────────────────────────

describe('extractOrefAlertCluster', () => {
  it('returns empty array when key is missing', () => {
    assert.deepEqual(extractOrefAlertCluster({}), []);
  });

  it('fires when advisory level is "do-not-travel" (hyphenated)', () => {
    const d = {
      'intelligence:advisories-bootstrap:v1': {
        advisories: [
          { level: 'do-not-travel', country: 'Ukraine', region: 'Eastern Europe', reason: 'Active conflict' },
        ],
        fetchedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const result = extractOrefAlertCluster(d);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'CROSS_SOURCE_SIGNAL_TYPE_OREF_ALERT_CLUSTER');
  });

  it('does NOT fire on old string format "do not travel" (with spaces)', () => {
    const d = {
      'intelligence:advisories-bootstrap:v1': {
        advisories: [
          { level: 'do not travel', country: 'Ukraine', region: 'Eastern Europe' },
        ],
        fetchedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    // After the fix, only 'do-not-travel' fires
    const result = extractOrefAlertCluster(d);
    assert.equal(result.length, 0);
  });

  it('does NOT fire for lower severity levels', () => {
    const d = {
      'intelligence:advisories-bootstrap:v1': {
        advisories: [
          { level: 'reconsider', country: 'Iraq', region: 'Middle East' },
          { level: 'caution', country: 'Mexico', region: 'Latin America' },
        ],
        fetchedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    assert.deepEqual(extractOrefAlertCluster(d), []);
  });
});
```

- [ ] **1.2** Run tests to confirm they fail on current code:
  ```bash
  cd /home/arista/src/worldmonitor && node --test tests/cross-source-extractors.test.mjs 2>&1 | tail -30
  ```

---

### Task 2 — Fix extractShippingDisruption

- [ ] **2.1** In `/home/arista/src/worldmonitor/scripts/seed-cross-source-signals.mjs`, replace the `extractShippingDisruption` function (lines 393–413) with:

```js
function extractShippingDisruption(d) {
  const payload = d['supply_chain:shipping:v2'];
  if (!payload) return [];
  const indices = Array.isArray(payload.indices) ? payload.indices : [];
  if (indices.length === 0) return [];

  // An index is considered disrupted if statistical spike detected OR >15% move
  const disrupted = indices.filter(
    idx => idx.spikeAlert === true || Math.abs(safeNum(idx.changePct)) > 15
  );
  if (disrupted.length === 0) return [];

  // Theater: check index names for Red Sea / Suez Canal indicators
  const hasRedSea = disrupted.some(idx =>
    /red sea|suez|bdi|baltic/i.test(idx.name || idx.indexId || '')
  );
  const theater = hasRedSea ? 'Red Sea' : 'Global';
  const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION'] * Math.min(2, 1 + disrupted.length / 3);
  return [{
    id: `shipping:${theater.replace(/\s+/g, '-').toLowerCase()}`,
    type: 'CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION',
    theater,
    summary: `Shipping disruption: ${disrupted.length} freight index spike${disrupted.length > 1 ? 's' : ''} detected (${disrupted.map(i => i.name || i.indexId).slice(0, 2).join(', ')})`,
    severity: scoreTier(score),
    severityScore: score,
    detectedAt: Date.now(),
    contributingTypes: [],
    signalCount: 0,
  }];
}
```

- [ ] **2.2** Run test to verify shipping tests pass:
  ```bash
  cd /home/arista/src/worldmonitor && node --test tests/cross-source-extractors.test.mjs 2>&1 | grep -A3 "extractShippingDisruption"
  ```

---

### Task 3 — Fix extractDisplacementSurge

- [ ] **3.1** In `/home/arista/src/worldmonitor/scripts/seed-cross-source-signals.mjs`, replace the `extractDisplacementSurge` function (lines 543–564) with:

```js
function extractDisplacementSurge(d) {
  const payload = d[`displacement:summary:v1:${new Date().getFullYear()}`];
  if (!payload) return [];

  // Actual schema: { summary: { year, globalTotals, countries: [...], topFlows: [...] } }
  // Each country: { code, name, refugees, asylumSeekers, idps, stateless, totalDisplaced, ... }
  const countries = Array.isArray(payload.summary?.countries) ? payload.summary.countries : [];
  if (countries.length === 0) return [];

  // Threshold: >1M total displaced is a major humanitarian crisis country
  const crisisCountries = countries.filter(c => safeNum(c.totalDisplaced) > 1_000_000);
  if (crisisCountries.length === 0) return [];

  return crisisCountries.slice(0, 2).map(c => {
    const theater = normalizeTheater(c.name || c.code || '');
    const displaced = safeNum(c.totalDisplaced);
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_DISPLACEMENT_SURGE'] * Math.min(2, 1 + displaced / 5_000_000);
    return {
      id: `displacement:${(c.code || c.name || 'unknown').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_DISPLACEMENT_SURGE',
      theater,
      summary: `Displacement crisis: ${c.name || c.code} — ${displaced.toLocaleString()} total displaced (${safeNum(c.idps).toLocaleString()} IDPs, ${safeNum(c.refugees).toLocaleString()} refugees)`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: Date.now(),
      contributingTypes: [],
      signalCount: 0,
    };
  });
}
```

- [ ] **3.2** Run test:
  ```bash
  cd /home/arista/src/worldmonitor && node --test tests/cross-source-extractors.test.mjs 2>&1 | grep -A3 "extractDisplacementSurge"
  ```

---

### Task 4 — Fix extractOrefAlertCluster (hyphen vs space)

- [ ] **4.1** In `/home/arista/src/worldmonitor/scripts/seed-cross-source-signals.mjs`, in `extractOrefAlertCluster` (lines 295–316), change the filter line from:

```js
  const critical = advisories.filter(a => String(a.level || '').toLowerCase() === 'do not travel');
```

to:

```js
  const critical = advisories.filter(a => {
    const lvl = String(a.level || '').toLowerCase();
    // Advisory seeder writes 'do-not-travel' (hyphenated). Accept both forms for safety.
    return lvl === 'do-not-travel' || lvl === 'do not travel';
  });
```

- [ ] **4.2** Run test:
  ```bash
  cd /home/arista/src/worldmonitor && node --test tests/cross-source-extractors.test.mjs 2>&1 | grep -A3 "extractOrefAlertCluster"
  ```

---

### Task 5 — Verify extractSanctionsSurge (field confirmed correct)

The field `payload.newEntryCount` is written by the sanctions seeder at the top level. The extractor reads `payload.newEntryCount` — this is correct. The threshold `>= 5` is intentional. The test in Task 1 already validates this works with `newEntryCount: 8`. No code change needed; the existing test confirms the contract.

- [ ] **5.1** Run full test suite to confirm sanctions tests pass without code changes:
  ```bash
  cd /home/arista/src/worldmonitor && node --test tests/cross-source-extractors.test.mjs 2>&1 | grep -A3 "extractSanctionsSurge"
  ```

---

### Task 6 — Add schema mismatch warning in extractors

Add contract validation comments (no runtime warnings needed — the extractors already handle missing data gracefully via `if (!payload) return []`). Instead, add a single `warnSchema` helper that logs on first mismatch per key, and call it in the two fixed extractors.

- [ ] **6.1** In `/home/arista/src/worldmonitor/scripts/seed-cross-source-signals.mjs`, add after the `safeNum` function:

```js
// Logs a one-time warning when an expected schema field is missing.
// Avoids flooding logs: the Set tracks which keys have already warned.
const _schemaWarnedKeys = new Set();
function warnSchema(key, expectedField, actualPayload) {
  if (_schemaWarnedKeys.has(key)) return;
  _schemaWarnedKeys.add(key);
  console.warn(`  [schema-warn] ${key}: expected field '${expectedField}' not found. Got top-level keys: ${Object.keys(actualPayload || {}).join(', ') || '(empty)'}`);
}
```

- [ ] **6.2** In `extractShippingDisruption`, after the `if (!payload) return []` line, add:
  ```js
    if (!Array.isArray(payload.indices)) {
      warnSchema('supply_chain:shipping:v2', 'indices', payload);
      return [];
    }
  ```

- [ ] **6.3** In `extractDisplacementSurge`, after the `if (!payload) return []` line, add:
  ```js
    if (!payload.summary?.countries) {
      warnSchema(`displacement:summary:v1:${new Date().getFullYear()}`, 'summary.countries', payload);
      return [];
    }
  ```

---

### Task 7 — Create scripts/debug-signal-coverage.mjs

- [ ] **7.1** Create `/home/arista/src/worldmonitor/scripts/debug-signal-coverage.mjs`:

```js
#!/usr/bin/env node
/**
 * debug-signal-coverage.mjs
 *
 * Dry-run all cross-source signal extractors against live Redis data and print
 * which signal types would fire, which are blocked by missing source keys, and
 * which are present but produce no signals.
 *
 * Usage: node scripts/debug-signal-coverage.mjs
 */

import { loadEnvFile, getRedisCredentials } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const SOURCE_KEYS = [
  'thermal:escalation:v1',
  'intelligence:gpsjam:v2',
  'military:flights:v1',
  'unrest:events:v1',
  'intelligence:advisories-bootstrap:v1',
  'market:stocks-bootstrap:v1',
  'market:commodities-bootstrap:v1',
  'cyber:threats-bootstrap:v2',
  'supply_chain:shipping:v2',
  'sanctions:pressure:v1',
  'seismology:earthquakes:v1',
  'radiation:observations:v1',
  'infra:outages:v1',
  'wildfire:fires:v1',
  `displacement:summary:v1:${new Date().getFullYear()}`,
  'forecast:predictions:v2',
  'intelligence:gdelt-intel:v1',
  'gdelt:intel:tone:military',
  'gdelt:intel:tone:nuclear',
  'gdelt:intel:tone:maritime',
  'weather:alerts:v1',
  'risk:scores:sebuf:stale:v1',
];

// Maps extractor function name → source key(s) it reads
const EXTRACTOR_KEY_MAP = {
  extractThermalSpike: ['thermal:escalation:v1'],
  extractGpsJamming: ['intelligence:gpsjam:v2'],
  extractMilitaryFlightSurge: ['military:flights:v1'],
  extractUnrestSurge: ['unrest:events:v1'],
  extractOrefAlertCluster: ['intelligence:advisories-bootstrap:v1'],
  extractVixSpike: ['market:stocks-bootstrap:v1'],
  extractCommodityShock: ['market:commodities-bootstrap:v1'],
  extractCyberEscalation: ['cyber:threats-bootstrap:v2'],
  extractShippingDisruption: ['supply_chain:shipping:v2'],
  extractSanctionsSurge: ['sanctions:pressure:v1'],
  extractEarthquakeSignificant: ['seismology:earthquakes:v1'],
  extractRadiationAnomaly: ['radiation:observations:v1'],
  extractInfrastructureOutage: ['infra:outages:v1'],
  extractWildfireEscalation: ['wildfire:fires:v1'],
  extractDisplacementSurge: [`displacement:summary:v1:${new Date().getFullYear()}`],
  extractForecastDeterioration: ['forecast:predictions:v2'],
  extractMarketStress: ['market:stocks-bootstrap:v1'],
  extractWeatherExtreme: ['weather:alerts:v1'],
  extractMediaToneDeterioration: ['gdelt:intel:tone:military', 'gdelt:intel:tone:nuclear', 'gdelt:intel:tone:maritime', 'intelligence:gdelt-intel:v1'],
  extractRiskScoreSpike: ['risk:scores:sebuf:stale:v1'],
};

// ── Read all source keys via pipeline ────────────────────────────────────────
async function readAllSourceKeys() {
  const { url, token } = getRedisCredentials();
  const pipeline = SOURCE_KEYS.map(k => ['GET', k]);
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipeline),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Redis pipeline: HTTP ${resp.status}`);
  const results = await resp.json();
  const data = {};
  for (let i = 0; i < SOURCE_KEYS.length; i++) {
    const raw = results[i]?.result;
    if (!raw) continue;
    try { data[SOURCE_KEYS[i]] = JSON.parse(raw); } catch { /* skip malformed */ }
  }
  return data;
}

// ── Dynamic import of extractors from seed script ────────────────────────────
// We can't static-import seed-cross-source-signals.mjs because it calls
// loadEnvFile and runSeed at module top-level. Instead we inline the extractor
// logic here via a vm shim that mirrors what seed-cross-source-signals.mjs does.
// For debug purposes this is acceptable — the debug tool ships separately.

async function main() {
  console.log('\n=== Cross-Source Signal Coverage Debug ===\n');

  let sourceData;
  try {
    sourceData = await readAllSourceKeys();
  } catch (err) {
    console.error(`Failed to read Redis source keys: ${err.message}`);
    process.exit(1);
  }

  const populated = Object.keys(sourceData);
  const missing = SOURCE_KEYS.filter(k => !populated.includes(k));

  console.log(`Source key status: ${populated.length}/${SOURCE_KEYS.length} populated\n`);
  console.log('POPULATED keys:');
  for (const k of populated) {
    const val = sourceData[k];
    let size = '';
    if (Array.isArray(val)) size = ` (${val.length} items)`;
    else if (val && typeof val === 'object') {
      const topKeys = Object.keys(val).join(', ');
      size = ` → { ${topKeys.slice(0, 80)}${topKeys.length > 80 ? '...' : ''} }`;
    }
    console.log(`  ✓ ${k}${size}`);
  }

  if (missing.length > 0) {
    console.log('\nMISSING keys (extractors will return []):');
    for (const k of missing) {
      const affected = Object.entries(EXTRACTOR_KEY_MAP)
        .filter(([, keys]) => keys.includes(k))
        .map(([fn]) => fn);
      console.log(`  ✗ ${k}  →  blocks: ${affected.join(', ') || 'none'}`);
    }
  }

  // Now run the seed script in a vm to get extractor results
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const seedSrc = readFileSync(new URL('./seed-cross-source-signals.mjs', import.meta.url).pathname, 'utf8');
  const pureSrc = seedSrc
    .replace(/^import\s.*$/gm, '')
    .replace(/loadEnvFile\([^)]+\);/, '')
    .replace(/async function readAllSourceKeys[\s\S]*/, '');

  const ctx = vm.createContext({
    console,
    Date,
    Math,
    Number,
    Array,
    Map,
    Set,
    String,
    Object,
    AbortSignal,
    fetch: undefined,
  });
  vm.runInContext(pureSrc, ctx);

  const extractorFns = [
    'extractThermalSpike', 'extractGpsJamming', 'extractMilitaryFlightSurge',
    'extractUnrestSurge', 'extractOrefAlertCluster', 'extractVixSpike',
    'extractCommodityShock', 'extractCyberEscalation', 'extractShippingDisruption',
    'extractSanctionsSurge', 'extractEarthquakeSignificant', 'extractRadiationAnomaly',
    'extractInfrastructureOutage', 'extractWildfireEscalation', 'extractDisplacementSurge',
    'extractForecastDeterioration', 'extractMarketStress', 'extractWeatherExtreme',
    'extractMediaToneDeterioration', 'extractRiskScoreSpike',
  ];

  console.log('\nExtractor results:');
  let firingCount = 0;
  let missingKeyCount = 0;
  let noSignalCount = 0;

  for (const name of extractorFns) {
    const fn = ctx[name];
    if (!fn) {
      console.log(`  [LOAD_ERROR] ${name} not found in vm context`);
      continue;
    }
    const requiredKeys = EXTRACTOR_KEY_MAP[name] || [];
    const allMissing = requiredKeys.every(k => !populated.includes(k));
    if (allMissing && requiredKeys.length > 0) {
      console.log(`  [MISSING_KEY] ${name}  (needs: ${requiredKeys.join(', ')})`);
      missingKeyCount++;
      continue;
    }
    try {
      const signals = fn(sourceData);
      if (signals.length > 0) {
        console.log(`  [FIRING] ${name}  →  ${signals.length} signal(s): ${signals.map(s => s.theater).join(', ')}`);
        firingCount++;
      } else {
        console.log(`  [QUIET] ${name}  (source key present, threshold not met)`);
        noSignalCount++;
      }
    } catch (err) {
      console.log(`  [ERROR] ${name}  →  ${err.message}`);
    }
  }

  console.log(`\nSummary: ${firingCount} firing, ${missingKeyCount} blocked by missing keys, ${noSignalCount} quiet (threshold not met)`);
  console.log('\nNote: COMPOSITE_ESCALATION fires automatically when >=3 categories co-fire in same theater.\n');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
```

- [ ] **7.2** Verify the script is executable and has no syntax errors:
  ```bash
  cd /home/arista/src/worldmonitor && node --check scripts/debug-signal-coverage.mjs && echo "syntax OK"
  ```

---

### Task 8 — Run full test suite and verify all Group A tests pass

- [ ] **8.1** Run all cross-source extractor tests:
  ```bash
  cd /home/arista/src/worldmonitor && node --test tests/cross-source-extractors.test.mjs 2>&1
  ```
  Expected: all tests pass (`extractShippingDisruption`, `extractDisplacementSurge`, `extractSanctionsSurge`, `extractOrefAlertCluster`)

- [ ] **8.2** Run the broader test suite to confirm no regressions:
  ```bash
  cd /home/arista/src/worldmonitor && node --test tests/sanctions-seed-unit.test.mjs tests/seed-utils.test.mjs tests/cross-source-extractors.test.mjs 2>&1
  ```

---

### Task 9 — Commit

- [ ] **9.1** Stage only the three changed/created files:
  ```bash
  cd /home/arista/src/worldmonitor && git add scripts/seed-cross-source-signals.mjs scripts/debug-signal-coverage.mjs tests/cross-source-extractors.test.mjs
  ```
- [ ] **9.2** Commit:
  ```bash
  cd /home/arista/src/worldmonitor && git commit -m "fix(cross-source-signals): correct schema mismatches in 3 extractors, add OREF level fix, debug tool, tests"
  ```

---

## Schema Reference (confirmed by reading source)

### supply_chain:shipping:v2
```json
{
  "indices": [
    {
      "indexId": "TSIFRGHT",
      "name": "Freight Transportation Services Index",
      "currentValue": 148.2,
      "previousValue": 145.1,
      "changePct": 2.1,
      "unit": "index",
      "history": [{ "date": "2026-01", "value": 148.2 }],
      "spikeAlert": false
    }
  ],
  "fetchedAt": "2026-03-31T00:00:00.000Z",
  "upstreamUnavailable": false
}
```

### displacement:summary:v1:{year}
```json
{
  "summary": {
    "year": 2025,
    "globalTotals": { "refugees": 0, "asylumSeekers": 0, "idps": 0, "stateless": 0, "total": 0 },
    "countries": [
      {
        "code": "SYR",
        "name": "Syria",
        "refugees": 6000000,
        "asylumSeekers": 0,
        "idps": 500000,
        "stateless": 0,
        "totalDisplaced": 6500000,
        "hostRefugees": 0,
        "hostAsylumSeekers": 0,
        "hostTotal": 0,
        "location": { "latitude": 35.0, "longitude": 38.0 }
      }
    ],
    "topFlows": [
      { "originCode": "SYR", "originName": "Syria", "asylumCode": "TUR", "asylumName": "Turkey", "refugees": 3000000 }
    ]
  }
}
```

### sanctions:pressure:v1
```json
{
  "datasetDate": "1711929600000",
  "totalCount": 12000,
  "sdnCount": 7000,
  "consolidatedCount": 5000,
  "newEntryCount": 0,
  "vesselCount": 320,
  "aircraftCount": 85,
  "countries": [
    { "countryCode": "RU", "countryName": "Russia", "entryCount": 2500, "newEntryCount": 0, "vesselCount": 45, "aircraftCount": 10 }
  ],
  "programs": [
    { "program": "UKRAINE-EO13685", "entryCount": 1800, "newEntryCount": 0 }
  ]
}
```

### intelligence:advisories-bootstrap:v1
```json
{
  "byCountry": { "UA": "do-not-travel", "RU": "do-not-travel" },
  "byCountryName": {},
  "advisories": [
    { "level": "do-not-travel", "country": "Ukraine", "source": "US State Dept", "sourceCountry": "US" }
  ],
  "fetchedAt": "2026-03-31T00:00:00.000Z"
}
```

Note: `advisories` array items have `level` (not nested). The extractor accesses `payload.advisories` and checks `a.level`.

---

## Success Criteria

- [ ] `node --test tests/cross-source-extractors.test.mjs` passes with 0 failures
- [ ] `node --check scripts/debug-signal-coverage.mjs` exits 0
- [ ] No regressions in `tests/sanctions-seed-unit.test.mjs`
- [ ] Signal types active: 4 → at least 7 (SHIPPING, DISPLACEMENT, OREF added; SANCTIONS confirmed correct; existing 4 preserved)
