# OSINT Health Remediation Plan

**Date:** 2026-03-31
**Context:** Worldmonitor health check shows 29 CRIT / 24 WARN out of 112 checks.
After today's fixes (`.env` sourcing, `scripts/node_modules`, Redis proxy 10MB limit, crontab full seeder), the remaining issues fall into clear categories.

## Status After Fixes

| Metric | Before | After |
|---|---|---|
| OK | 54 | 62+ (varies by cron freshness) |
| WARN | 24 | ~20 |
| CRIT | 34 | ~29 |
| Cross-source-signals | 3 types, 8 signals | 4 types, 9 signals |
| Seeder scripts | 58 OK / 4 SKIP / 5 FAIL | 60+ OK / 2 SKIP / 2 FAIL |

## Fixes Already Applied (2026-03-31)

1. **`.env` sourcing** in `run-seeders.sh` + `run-seeders-crypto.sh` — host-side seeders now get API keys
2. **`.env` syntax** — quoted `RESEND_FROM_EMAIL` to prevent bash errors
3. **`scripts/node_modules`** — `npm install` for `xlsx`, `sax` → fixed fuel-prices, sanctions-pressure parsing
4. **Redis REST proxy** — body limit 1MB → 10MB → fixed sanctions entities write (19,851 OFAC entries)
5. **Crontab** — added full seeder hourly at :15 alongside crypto seeder every 30min
6. **Git security** — removed hardcoded OpenAI API key from plan doc, pushed clean history
7. **SSO docs** — committed and pushed Google OAuth2 spec+plan

## Remaining CRIT/EMPTY — Categorized

### Category A: AIS-Relay Dependent (disabled for crypto deployment)
These keys are populated by `scripts/ais-relay.cjs` which is disabled in `docker-compose.override.yml`.

| Key | Seeder | Impact on OSINT |
|---|---|---|
| socialVelocity | ais-relay Reddit loop | Low — Reddit sentiment, not primary signal |
| shippingStress | ais-relay vessel aggregation | Medium — supply chain indicator |
| cableHealth | ais-relay warm-ping + RPC | Low — submarine cable health |
| chokepointTransits | ais-relay vessel tracking | Medium — Strait of Hormuz etc. |
| transitSummaries | ais-relay aggregation | Medium — transit pattern summaries |
| satellites | ais-relay / CelesTrak TLE | Low — orbital data |

**Action:** No fix needed for crypto-focused deployment. If supply chain signals become relevant for cryptarista, re-enable ais-relay selectively.

### Category B: Missing API Keys (easy to add)
| Key | API Key Needed | Effort |
|---|---|---|
| defiTokens, aiTokens, otherTokens | `COINGECKO_API_KEY` (free tier) | 5 min |
| ucdpEvents | `UCDP_ACCESS_TOKEN` (free, academic) | 10 min |
| groceryBasket | `EXA_API_KEY` (paid search API) | Low priority |

**Action:** Register CoinGecko free API key and UCDP access token. Add to `.env`.

### Category C: External Source Unavailable
| Key | Issue | Fixable? |
|---|---|---|
| vpdTracker (realtime + historical) | CFR GitHub Pages site unreachable | Wait / find alt source |
| gscpi | NY Fed GSCPI data source | Check if endpoint changed |
| portwatch | World Bank PortWatch API | Check availability |

**Action:** Monitor; these are external dependencies. Not critical for crypto OSINT.

### Category D: Seeder Ran OK but Data Empty
| Key | Reason | Action |
|---|---|---|
| sectors | No `seed-market-sectors.mjs` exists | Create seeder or move to ON_DEMAND_KEYS |
| gdeltIntel | GDELT API rate-limited (429) | Self-heals on next successful request |
| techEvents | Seeder ran but produced 0 results for current period | Normal — depends on event availability |
| iranEvents | Requires manual `data/iran-events-latest.json` file | Needs external scraper (LiveUAMap) |
| insights | Requires upstream `news:digest:v1:full:en` from RSS relay | Enable RSS relay or accept empty |

**Action:** gdeltIntel and techEvents self-heal. Others need relay or manual data.

### Category E: Computed On-Demand (misclassified as CRIT)
| Key | Status | Action |
|---|---|---|
| riskScores | Computed by RPC handler, not seeded | Move to ON_DEMAND_KEYS in health.js |
| positiveGeoEvents | LLM-generated, seed stale between runs | Lower maxStaleMin or accept staleness |

### Category F: Design Limitation (seed-consumer-prices)
| Key | Issue |
|---|---|
| consumerPrices* (5 keys) | `--force` flag required by design; conflicts with publish.ts pipeline |

**Action:** Not a bug. These are intentionally excluded from automatic seeding.

### Category G: Remaining STALE_SEED (scraper-dependent)
| Key | Issue |
|---|---|
| gpsjam | GPS jamming data scraper (external site) |
| usniFleet | USNI fleet tracker scraper |
| notamClosures | Needs `ICAO_API_KEY` |
| newsThreatSummary | LLM-dependent, stale between cycles |
| marketQuotes | Finnhub rate limit on free tier |

**Action:** These are inherent limitations of free-tier APIs and web scrapers.

## Priority Actions

### Immediate (today)
- [x] Source .env in seeder scripts
- [x] Install scripts/node_modules
- [x] Fix Redis proxy body limit
- [x] Add full seeder to crontab
- [x] Push clean git history

### Short-term (this week)
- [ ] Register CoinGecko free API key → fixes 3 token panel keys
- [ ] Register UCDP access token → fixes ucdpEvents
- [ ] Move riskScores to ON_DEMAND_KEYS in health.js (1-line fix)

### Medium-term (when needed)
- [ ] Create seed-market-sectors.mjs for sectors data
- [ ] Re-enable ais-relay for supply chain signals (if needed for cryptarista)
- [ ] Investigate GSCPI/PortWatch data source changes
