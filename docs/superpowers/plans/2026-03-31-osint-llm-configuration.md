# OSINT LLM Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Patch worldmonitor's LLM layer to support GPT-5.x models and configure Groq + OpenAI as LLM providers for OSINT data generation.

**Architecture:** Single file patch in `server/_shared/llm.ts` adds model-aware token parameter selection (GPT-5.x and o-series require `max_completion_tokens` instead of `max_tokens`). Configuration via `.env` and `docker-compose.override.yml` activates Groq for parsing and OpenAI gpt-5.4-mini for reasoning.

**Tech Stack:** TypeScript (Node.js), Docker Compose, Upstash Redis REST

---

### File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `server/_shared/llm.ts` | Add `max_completion_tokens` support for GPT-5.x/o-series |
| Modify | `tests/shared-llm.test.mts` | Add test for new token param behavior |
| Modify | `.env` | Add LLM credentials |
| Modify | `docker-compose.override.yml` | Pass LLM env vars to container |

---

### Task 1: Add max_completion_tokens support to llm.ts

**Files:**
- Modify: `server/_shared/llm.ts:280-295,405-420`
- Test: `tests/shared-llm.test.mts`

- [ ] **Step 1: Write the failing test**

Add a new test to `tests/shared-llm.test.mts` that verifies GPT-5.x models receive `max_completion_tokens` instead of `max_tokens`:

```typescript
it('sends max_completion_tokens instead of max_tokens for GPT-5.x models', async () => {
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OLLAMA_API_URL;
  process.env.LLM_API_URL = 'https://api.openai.com/v1/chat/completions';
  process.env.LLM_API_KEY = 'test-openai-key';
  process.env.LLM_MODEL = 'gpt-5.4-mini';

  const postBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if ((init?.method || 'GET') === 'GET') {
      return new Response('', { status: 200 });
    }

    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    postBodies.push(body);

    return new Response(JSON.stringify({
      choices: [{ message: { content: 'gpt-5.4 response' } }],
      usage: { total_tokens: 50 },
    }), { status: 200 });
  }) as typeof fetch;

  const result = await callLlm({
    messages: [{ role: 'user', content: 'Test GPT-5.4 token param.' }],
    maxTokens: 1000,
  });

  assert.ok(result);
  assert.equal(result.provider, 'generic');
  assert.equal(result.model, 'gpt-5.4-mini');
  assert.equal(postBodies.length, 1);
  assert.equal(postBodies[0]?.max_completion_tokens, 1000);
  assert.equal(postBodies[0]?.max_tokens, undefined);
});

it('sends max_tokens for non-GPT-5.x models', async () => {
  process.env.GROQ_API_KEY = 'groq-test-key';
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OLLAMA_API_URL;
  delete process.env.LLM_API_URL;
  delete process.env.LLM_API_KEY;

  const postBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if ((init?.method || 'GET') === 'GET') {
      return new Response('', { status: 200 });
    }

    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    postBodies.push(body);

    return new Response(JSON.stringify({
      choices: [{ message: { content: 'groq response' } }],
      usage: { total_tokens: 30 },
    }), { status: 200 });
  }) as typeof fetch;

  const result = await callLlm({
    messages: [{ role: 'user', content: 'Test Groq token param.' }],
    maxTokens: 500,
  });

  assert.ok(result);
  assert.equal(result.provider, 'groq');
  assert.equal(postBodies.length, 1);
  assert.equal(postBodies[0]?.max_tokens, 500);
  assert.equal(postBodies[0]?.max_completion_tokens, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/shared-llm.test.mts`

Expected: First test FAILS because `callLlm` sends `max_tokens` for all models.
The body will have `max_tokens: 1000` and `max_completion_tokens` will be `undefined`.

- [ ] **Step 3: Add the model detection helper and patch callLlm**

In `server/_shared/llm.ts`, add the helper function after the `PROVIDER_SET` declaration (after line 128):

```typescript
/**
 * GPT-5.x and o-series models require `max_completion_tokens` instead of
 * `max_tokens`. Sending the wrong parameter causes a 400 error.
 */
function buildTokenParam(model: string, maxTokens: number): Record<string, number> {
  const needsNewParam = /^(gpt-5|o[1-9])/.test(model);
  return needsNewParam
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}
```

Then replace the body construction in `callLlm()` (~line 405-415). Find:

```typescript
          body: JSON.stringify({
            ...creds.extraBody,
            model: creds.model,
            messages,
            temperature,
            max_tokens: maxTokens,
          }),
```

Replace with:

```typescript
          body: JSON.stringify({
            ...creds.extraBody,
            model: creds.model,
            messages,
            temperature,
            ...buildTokenParam(creds.model, maxTokens),
          }),
```

Then replace the same pattern in `callLlmReasoningStream()` (~line 280-290). Find:

```typescript
              model: creds.model,
              messages,
              temperature,
              max_tokens: maxTokens,
              stream: true,
```

Replace with:

```typescript
              model: creds.model,
              messages,
              temperature,
              ...buildTokenParam(creds.model, maxTokens),
              stream: true,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test tests/shared-llm.test.mts`

Expected: All 5 tests PASS (3 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add server/_shared/llm.ts tests/shared-llm.test.mts
git commit -m "feat(llm): support max_completion_tokens for GPT-5.x and o-series models

GPT-5.x and o-series models reject the max_tokens parameter and require
max_completion_tokens instead. Adds model detection via regex and applies
the correct parameter in both callLlm() and callLlmReasoningStream()."
```

---

### Task 2: Configure .env with LLM credentials

**Files:**
- Modify: `.env`

- [ ] **Step 1: Add OpenAI generic provider credentials**

Add/update these lines in `.env` (the `GROQ_API_KEY` is already set):

```env
LLM_API_URL=https://api.openai.com/v1/chat/completions
LLM_API_KEY=<your-openai-service-account-key>
LLM_MODEL=gpt-5.4-mini
LLM_REASONING_PROVIDER=generic
LLM_TOOL_PROVIDER=groq
```

- [ ] **Step 2: Verify env vars parse correctly**

Run: `grep -E '^(GROQ_API_KEY|LLM_)' .env | sed 's/=.*/=<set>/'`

Expected output:
```
GROQ_API_KEY=<set>
LLM_API_URL=<set>
LLM_API_KEY=<set>
LLM_MODEL=<set>
LLM_REASONING_PROVIDER=<set>
LLM_TOOL_PROVIDER=<set>
```

Note: `.env` is in `.gitignore` — do NOT commit this file.

---

### Task 3: Update docker-compose.override.yml

**Files:**
- Modify: `docker-compose.override.yml`

- [ ] **Step 1: Add LLM env vars to the worldmonitor service**

Replace the current `docker-compose.override.yml` contents with:

```yaml
services:
  # Disable ais-relay (maritime tracking — not needed for crypto OSINT)
  ais-relay:
    entrypoint: ["echo", "ais-relay disabled"]
    restart: "no"

  worldmonitor:
    environment:
      # LLM — Tool provider (parsing, extraction)
      GROQ_API_KEY: "${GROQ_API_KEY}"

      # LLM — Reasoning provider (synthesis, analysis)
      LLM_API_URL: "${LLM_API_URL}"
      LLM_API_KEY: "${LLM_API_KEY}"
      LLM_MODEL: "${LLM_MODEL:-gpt-5.4-mini}"
      LLM_REASONING_PROVIDER: "${LLM_REASONING_PROVIDER:-generic}"
      LLM_TOOL_PROVIDER: "${LLM_TOOL_PROVIDER:-groq}"

      # Markets (fill when API key is obtained)
      FINNHUB_API_KEY: "${FINNHUB_API_KEY:-}"

      # Macro (fill when API key is obtained)
      FRED_API_KEY: "${FRED_API_KEY:-}"
      EIA_API_KEY: "${EIA_API_KEY:-}"

      # Conflict (fill when registered)
      ACLED_EMAIL: "${ACLED_EMAIL:-}"
      ACLED_PASSWORD: "${ACLED_PASSWORD:-}"
      ACLED_ACCESS_TOKEN: "${ACLED_ACCESS_TOKEN:-}"

      # Satellite & Infra (fill when API key is obtained)
      NASA_FIRMS_API_KEY: "${NASA_FIRMS_API_KEY:-}"
      CLOUDFLARE_API_TOKEN: "${CLOUDFLARE_API_TOKEN:-}"

  redis:
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru --requirepass "${REDIS_PASSWORD:-wm-redis-secure}"

  redis-rest:
    environment:
      SRH_TOKEN: "${REDIS_TOKEN:-wm-local-token}"
      SRH_CONNECTION_STRING: "redis://:${REDIS_PASSWORD:-wm-redis-secure}@redis:6379"
```

- [ ] **Step 2: Validate compose config parses**

Run: `docker compose config --quiet 2>&1 && echo "OK" || echo "FAIL"`

Expected: `OK` (no syntax errors)

Note: `docker-compose.override.yml` is in `.gitignore` — do NOT commit this file.

---

### Task 4: Rebuild container and validate LLM

**Files:** None (operational validation)

- [ ] **Step 1: Rebuild the worldmonitor container**

Run: `docker compose up -d --build worldmonitor`

Expected: Container rebuilds with new `llm.ts` code and starts healthy.

- [ ] **Step 2: Verify container sees the env vars**

Run: `docker exec worldmonitor printenv | grep -E '^(GROQ_API_KEY|LLM_)' | sed 's/=.*/=<set>/'`

Expected output:
```
GROQ_API_KEY=<set>
LLM_API_URL=<set>
LLM_API_KEY=<set>
LLM_MODEL=<set>
LLM_REASONING_PROVIDER=<set>
LLM_TOOL_PROVIDER=<set>
```

- [ ] **Step 3: Run seeders to validate LLM-dependent features activate**

Run: `./scripts/run-seeders.sh 2>&1 | grep -E "seed-forecast|seed-insights|seed-fear-greed"`

Expected: These seeders should now show `OK` instead of `SKIP` (they were skipping due to missing LLM provider).

- [ ] **Step 4: Smoke-test the cross-source-signals endpoint**

Run: `curl -s http://localhost:3000/api/intelligence/v1/list-cross-source-signals | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'signals: {len(d.get(\"signals\",d.get(\"items\",[])))}'); print(f'types: {set(s.get(\"type\",\"?\")[:40] for s in (d.get(\"signals\",d.get(\"items\",[])))[:10])}')" 2>/dev/null || echo "endpoint not reachable — check container logs"`

Expected: Signal count > 0, with various signal types listed.

- [ ] **Step 5: Smoke-test the LLM reasoning endpoint**

Run: `curl -s http://localhost:3000/api/intelligence/v1/deduct-situation -X POST -H "Content-Type: application/json" -d '{"context":"Test deduction"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('LLM response received' if d else 'empty')" 2>/dev/null || echo "endpoint error — check container logs"`

Expected: A response from the deduction engine (confirms OpenAI gpt-5.4-mini is reachable from the container).

- [ ] **Step 6: Commit the llm.ts change (if not already committed in Task 1)**

Verify: `git status` — only `server/_shared/llm.ts` and `tests/shared-llm.test.mts` should show as modified (`.env` and `docker-compose.override.yml` are gitignored).

---

### Task 5: Document Layer 1-4 API key slots (informational)

**Files:** None (user action reference)

This task is a checklist for the user to register for API keys at their own pace. No code changes needed — once a key is obtained, add it to `.env` and the override will pass it to the container automatically.

- [ ] **Step 1: FRED API key**

Register at: https://fred.stlouisfed.org/docs/api/api_key.html
Add to `.env`: `FRED_API_KEY=<your-key>`
Restart: `docker compose up -d worldmonitor`
Verify: `./scripts/run-seeders.sh 2>&1 | grep seed-economy`

- [ ] **Step 2: EIA API key**

Register at: https://www.eia.gov/opendata/register.php
Add to `.env`: `EIA_API_KEY=<your-key>`
Restart: `docker compose up -d worldmonitor`
Verify: `./scripts/run-seeders.sh 2>&1 | grep seed-economy`

- [ ] **Step 3: Finnhub API key**

Register at: https://finnhub.io/register
Add to `.env`: `FINNHUB_API_KEY=<your-key>`
Restart: `docker compose up -d worldmonitor`
Verify: `./scripts/run-seeders.sh 2>&1 | grep seed-market-quotes`

- [ ] **Step 4: ACLED credentials**

Register at: https://acleddata.com/register/
Add to `.env`: `ACLED_EMAIL=<your-email>` and `ACLED_PASSWORD=<your-password>`
Restart: `docker compose up -d worldmonitor`
Verify: `./scripts/run-seeders.sh 2>&1 | grep seed-conflict`

- [ ] **Step 5: NASA FIRMS API key**

Register at: https://firms.modaps.eosdis.nasa.gov/api/area/
Add to `.env`: `NASA_FIRMS_API_KEY=<your-key>`
Restart: `docker compose up -d worldmonitor`
Verify: `./scripts/run-seeders.sh 2>&1 | grep seed-fire`

- [ ] **Step 6: Cloudflare Radar API token**

Create at: Cloudflare Dashboard > My Profile > API Tokens > Create Token > Radar: Read
Add to `.env`: `CLOUDFLARE_API_TOKEN=<your-token>`
Restart: `docker compose up -d worldmonitor`
Verify: `./scripts/run-seeders.sh 2>&1 | grep seed-internet-outages`

- [ ] **Step 7: Validate all 21 cross-source-signals active**

Run: `node scripts/seed-cross-source-signals.mjs && curl -s http://localhost:3000/api/intelligence/v1/list-cross-source-signals | python3 -c "import sys,json; d=json.load(sys.stdin); types=set(s['type'] for s in d.get('signals',d.get('items',[]))); print(f'{len(types)} signal types active'); [print(f'  {t}') for t in sorted(types)]"`

Expected: 21 distinct signal types listed.
