# Wingbits Track API — Persistent 400 Errors

**Observed:** 2026-03-26 (~08:22–08:30 UTC)
**Log file:** `logs.1774513970582.errors.log`
**Service:** AIS Relay (`scripts/ais-relay.cjs`)
**Status:** Root cause confirmed via Playwright live-site inspection

## Symptom

`[Wingbits Track] API error: 400` logged continuously — roughly every 1–3 seconds with occasional bursts of 10–15 concurrent 400s. No Wingbits flight data is returned to clients. The relay falls back to `{ positions: [], source: 'wingbits' }` with HTTP 502.

## Root Cause (Confirmed)

**Wingbits fully migrated from v1 to v2.** The relay still calls the old deprecated endpoint. Their live map (confirmed via Playwright network inspection on 2026-03-26) uses a completely different API:

| | **Old (relay uses)** | **New (Wingbits live site)** |
|---|---|---|
| Host | `customer-api.wingbits.com` | `ecs-api.wingbits.com` |
| Path | `/v1/flights` | `/v2/aircraft/batch` |
| Auth | `x-api-key` header | Per-tile bearer tokens (see below) |
| Request format | JSON bbox (`by: 'box'`, `unit: 'nm'`) | JSON tile list + token map |
| Response format | JSON array | **Protobuf binary** (`arraybuffer`) |
| Spatial model | Bounding box | Map tiles (z/x/y) |

## v2 API Contract (Reverse-Engineered)

Source: `wingbits.com/_next/static/chunks/5119-35395cc3f4dc7cd1.js` (2026-03-26)

### Step 1 — Get tile tokens

```
POST https://ecs-api.wingbits.com/v2/aircraft/token
Content-Type: application/json

{
  "tiles": [
    { "time_bucket": <unix_seconds>, "z": <zoom>, "x": <tile_x>, "y": <tile_y> },
    ...
  ]
}
```

Response:
```json
{
  "expires_in": 60,
  "tokens": {
    "<timeBucket>:<z>:<x>:<y>": "<bearer_token>",
    ...
  }
}
```

Tokens are valid for `expires_in` seconds. The client refreshes 60 seconds before expiry.

### Step 2 — Fetch aircraft batch

```
POST https://ecs-api.wingbits.com/v2/aircraft/batch
Content-Type: application/json

{
  "tiles": [
    { "time_bucket": <unix_seconds>, "z": <zoom>, "x": <tile_x>, "y": <tile_y> }
  ],
  "tokens": {
    "<timeBucket>:<z>:<x>:<y>": "<bearer_token>"
  },
  "min_ab": <minAltitudeFeet>,   // optional
  "max_ab": <maxAltitudeFeet>    // optional
}
```

Response: **protobuf binary** (`Uint8Array`), decoded to:
```
{
  timeBucket: BigInt,
  zoom: int,
  tileX: int,
  tileY: int,
  aircraft: [...],
  clusters: [...],
  totalCount: int
}
```

### v2 Aircraft field mapping

Each aircraft in the protobuf payload maps to these display fields:

| Protobuf field | Relay field | Notes |
|---|---|---|
| `icao` (int) | `icao24` | `.toString(16).padStart(6,'0')` |
| `latE7` | `lat` | divide by 1e7 |
| `lonE7` | `lon` | divide by 1e7 |
| `heading` | `trackDeg` | divide by 10 |
| `altitude` | `altitudeM` | feet, not metres — convert |
| `speed` | `groundSpeedKts` | |
| `callsign` | `callsign` | |
| `category` | — | aircraft type category |
| `flags & 1` | `onGround` | bitmask |

## What the relay currently does (broken)

```js
// ais-relay.cjs — BROKEN, v1 endpoint no longer works
const areas = [{ alias: 'viewport', by: 'box', la: centerLat, lo: centerLon,
                 w: widthNm, h: heightNm, unit: 'nm' }];
const resp = await fetch('https://customer-api.wingbits.com/v1/flights', {
  method: 'POST',
  headers: { 'x-api-key': apiKey, ... },
  body: JSON.stringify(areas),
});
// → always returns 400
```

Additionally, the 400 response body is never read — only `resp.status` is captured — so the API error message was never surfaced in logs.

## Migration effort

This is not a simple URL swap. The v2 migration requires:

1. **Tile math**: Convert bbox → map tile coordinates at the appropriate zoom level
2. **Token flow**: Fetch per-tile tokens before each batch call (with 60s expiry cache)
3. **Protobuf decode**: Decode the binary response (the protobuf schema is not public — would need to reverse-engineer from the JS bundle or contact Wingbits)
4. **Field remapping**: `latE7/lonE7` integer format, altitude in feet (not metres × 0.3048)

Alternatively, contact Wingbits support to ask if a **v2 customer API key** can be issued that bypasses the per-tile token flow, or if a JSON wrapper endpoint exists.

## Impact

- All live Wingbits flight position data is unavailable
- Theater posture and military flight tracking panels show no positions
- The relay silently returns `positions: []` — UI shows empty map with no error
- Callsign-only lookups work only if `wingbitsIndex` was seeded before failures started

## Resolution checklist

- [ ] Contact Wingbits: ask for v2 API docs and whether `x-api-key` auth still works on v2
- [ ] Confirm `customer-api.wingbits.com/v1/flights` is deprecated (try curl, expect 4xx/5xx)
- [ ] If Wingbits provides v2 docs: implement tile math + token flow + protobuf decode in relay
- [ ] Add response body logging to error path in `ais-relay.cjs` (quick fix regardless)
- [ ] After relay update, redeploy on Railway and verify `[Wingbits Track]` errors stop
