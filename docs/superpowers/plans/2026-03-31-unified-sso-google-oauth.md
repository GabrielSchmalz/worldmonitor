# Unified SSO with Google OAuth2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace HTTP Basic Auth with Google OAuth2 SSO across all protected aristaflow.cloud subdomains, and expose WorldMonitor via `wm.aristaflow.cloud`.

**Architecture:** A single `oauth2-proxy` container handles Google OAuth2. Caddy delegates auth via `forward_auth` to oauth2-proxy. A cookie scoped to `.aristaflow.cloud` provides SSO across all subdomains.

**Tech Stack:** Caddy 2, oauth2-proxy v7, Google OAuth2, Docker Compose

**Spec:** `docs/superpowers/specs/2026-03-31-unified-sso-google-oauth-design.md`

---

### Task 1: Add oauth2-proxy service to docker-compose

**Files:**
- Modify: `/home/arista/src/aristaflow-brain/infra/docker-compose.yml`

**Prerequisites:** `.env` already contains `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH2_COOKIE_SECRET`. Email allowlist file `oauth2-proxy-emails.txt` already exists.

- [ ] **Step 1: Add oauth2-proxy service to docker-compose.yml**

Add the `oauth2-proxy` service after the `grafana` service and before the `caddy` service:

```yaml
  oauth2-proxy:
    image: quay.io/oauth2-proxy/oauth2-proxy:v7
    container_name: oauth2-proxy
    restart: unless-stopped
    ports:
      - "127.0.0.1:4180:4180"
    environment:
      OAUTH2_PROXY_PROVIDER: "google"
      OAUTH2_PROXY_CLIENT_ID: "${GOOGLE_CLIENT_ID}"
      OAUTH2_PROXY_CLIENT_SECRET: "${GOOGLE_CLIENT_SECRET}"
      OAUTH2_PROXY_COOKIE_SECRET: "${OAUTH2_COOKIE_SECRET}"
      OAUTH2_PROXY_COOKIE_DOMAINS: ".aristaflow.cloud"
      OAUTH2_PROXY_WHITELIST_DOMAINS: ".aristaflow.cloud"
      OAUTH2_PROXY_EMAIL_DOMAINS: "*"
      OAUTH2_PROXY_AUTHENTICATED_EMAILS_FILE: "/etc/oauth2-proxy/emails.txt"
      OAUTH2_PROXY_HTTP_ADDRESS: "0.0.0.0:4180"
      OAUTH2_PROXY_REDIRECT_URL: "https://auth.aristaflow.cloud/oauth2/callback"
      OAUTH2_PROXY_COOKIE_SECURE: "true"
      OAUTH2_PROXY_COOKIE_SAMESITE: "lax"
      OAUTH2_PROXY_SET_XAUTHREQUEST: "true"
      OAUTH2_PROXY_REVERSE_PROXY: "true"
      OAUTH2_PROXY_COOKIE_CSRF_PER_REQUEST: "true"
      OAUTH2_PROXY_COOKIE_CSRF_EXPIRE: "300s"
      OAUTH2_PROXY_SKIP_PROVIDER_BUTTON: "true"
    volumes:
      - ./oauth2-proxy-emails.txt:/etc/oauth2-proxy/emails.txt:ro
```

- [ ] **Step 2: Update caddy service dependencies**

Replace the caddy `depends_on` block to depend on `oauth2-proxy` instead of `opik-frontend`:

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on:
      oauth2-proxy:
        condition: service_started
      grafana:
        condition: service_started
    ports:
      - "80:80"
      - "443:443"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./status-site:/srv/status:ro
      - caddy_data:/data
      - caddy_config:/config
    environment:
      DOMAIN: ${DOMAIN}
      CADDY_ACME_EMAIL: ${CADDY_ACME_EMAIL}
```

Note: `CADDY_BASIC_AUTH_USER` and `CADDY_BASIC_AUTH_HASH` are removed from the caddy environment since basic_auth is no longer used.

- [ ] **Step 3: Verify docker-compose config is valid**

Run: `docker compose -f /home/arista/src/aristaflow-brain/infra/docker-compose.yml config --quiet`
Expected: No output (silent success, no YAML errors)

- [ ] **Step 4: Commit**

```bash
cd /home/arista/src/aristaflow-brain
git add infra/docker-compose.yml infra/oauth2-proxy-emails.txt
git commit -m "feat(infra): add oauth2-proxy service for Google SSO"
```

---

### Task 2: Rewrite Caddyfile for Google SSO

**Files:**
- Modify: `/home/arista/src/aristaflow-brain/infra/Caddyfile`

- [ ] **Step 1: Replace Caddyfile with new config**

Replace the entire contents of `/home/arista/src/aristaflow-brain/infra/Caddyfile` with:

```caddyfile
{
    email {$CADDY_ACME_EMAIL}
}

(security_headers) {
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
        -Server
    }
}

(google_auth) {
    forward_auth 127.0.0.1:4180 {
        uri /oauth2/auth
        header_up X-Forwarded-Uri {uri}
        header_up X-Forwarded-Host {host}
        copy_headers X-Auth-Request-Email
    }
}

# OAuth2 callback — must NOT have forward_auth (would cause redirect loop)
auth.{$DOMAIN} {
    import security_headers

    reverse_proxy 127.0.0.1:4180

    log {
        output stdout
        format json
    }
}

# WorldMonitor dashboard
wm.{$DOMAIN} {
    import security_headers
    import google_auth

    reverse_proxy 127.0.0.1:3000

    log {
        output stdout
        format json
    }
}

# Grafana
dash.{$DOMAIN} {
    import security_headers
    import google_auth

    header {
        X-Frame-Options "SAMEORIGIN"
    }

    reverse_proxy 127.0.0.1:13000

    log {
        output stdout
        format json
    }
}

# Status page
status.{$DOMAIN} {
    import security_headers
    import google_auth

    root * /srv/status
    file_server

    log {
        output stdout
        format json
    }
}

# Webhooks — NO SSO, auth handled by HMAC at application layer
hooks.{$DOMAIN} {
    import security_headers
    tls {$CADDY_ACME_EMAIL} {
        ca https://acme-v02.api.letsencrypt.org/directory
    }

    handle /healthz {
        respond 200
    }

    handle /api/hooks/* {
        reverse_proxy 127.0.0.1:14141
    }

    handle /api/telegram/webhook {
        reverse_proxy 127.0.0.1:8787
    }

    respond "aristaflow-brain hooks endpoint" 200
}

# Root domain — no service for now
{$DOMAIN} {
    import security_headers
    respond "aristaflow.cloud" 200
}
```

Key changes from previous Caddyfile:
- Removed `(brain_auth)` snippet (basic_auth)
- Added `(google_auth)` snippet (forward_auth → oauth2-proxy)
- Added `auth.{$DOMAIN}` vhost for OAuth2 callback
- Added `wm.{$DOMAIN}` vhost for WorldMonitor
- Removed `brain.{$DOMAIN}` vhost
- Removed opik reverse proxy from `{$DOMAIN}` — now returns simple 200
- Added `google_auth` to `status.{$DOMAIN}`
- `hooks.{$DOMAIN}` unchanged

- [ ] **Step 2: Validate Caddyfile syntax**

Run: `docker run --rm -v /home/arista/src/aristaflow-brain/infra/Caddyfile:/etc/caddy/Caddyfile:ro caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile 2>&1 || echo "Note: env var warnings are expected"`
Expected: Should not show syntax errors (warnings about unresolved `{$DOMAIN}` env vars are OK)

- [ ] **Step 3: Commit**

```bash
cd /home/arista/src/aristaflow-brain
git add infra/Caddyfile
git commit -m "feat(infra): replace basic_auth with Google SSO via forward_auth

Remove brain and opik vhosts, add wm and auth subdomains.
hooks.aristaflow.cloud remains unprotected (HMAC at app layer)."
```

---

### Task 3: Deploy and verify

- [ ] **Step 1: Pull oauth2-proxy image**

Run: `cd /home/arista/src/aristaflow-brain/infra && docker compose pull oauth2-proxy`
Expected: Image pulled successfully

- [ ] **Step 2: Start oauth2-proxy**

Run: `cd /home/arista/src/aristaflow-brain/infra && docker compose up -d oauth2-proxy`
Expected: Container starts, check with `docker ps | grep oauth2-proxy` — should show "Up"

- [ ] **Step 3: Verify oauth2-proxy is healthy**

Run: `curl -s http://127.0.0.1:4180/ping`
Expected: `OK`

- [ ] **Step 4: Recreate Caddy to load new config**

Run: `cd /home/arista/src/aristaflow-brain/infra && docker compose up -d caddy --force-recreate`
Expected: Caddy recreated with new Caddyfile and without basic_auth env vars

- [ ] **Step 5: Wait for TLS certificates**

Run: `sleep 10 && curl -sI https://wm.aristaflow.cloud/ 2>&1 | head -5`
Expected: Either `HTTP/2 302` (redirect to Google login) or `HTTP/2 403` (auth required). NOT a TLS error.

Run: `curl -sI https://auth.aristaflow.cloud/ 2>&1 | head -5`
Expected: `HTTP/2 200` or `HTTP/2 302` (oauth2-proxy sign-in page)

- [ ] **Step 6: Verify hooks still work without auth**

Run: `curl -s https://hooks.aristaflow.cloud/healthz`
Expected: `200` response with no redirect

- [ ] **Step 7: Verify root domain responds**

Run: `curl -s https://aristaflow.cloud/`
Expected: `aristaflow.cloud` (plain text 200)

- [ ] **Step 8: Test SSO login in browser**

Open `https://wm.aristaflow.cloud/` in a browser:
1. Should redirect to Google login
2. Login with `gabrielschmalz23@gmail.com`
3. Should redirect back to WorldMonitor dashboard
4. Open `https://dash.aristaflow.cloud/` in another tab — should load Grafana WITHOUT re-login (SSO cookie)
5. Open `https://status.aristaflow.cloud/` — should load without re-login

- [ ] **Step 9: Test unauthorized email is rejected**

Open `https://wm.aristaflow.cloud/` in an incognito window:
1. Login with a DIFFERENT Google account
2. Should see a 403 Forbidden page from oauth2-proxy

---

### Task 4: Cleanup

- [ ] **Step 1: Remove stale basic_auth env vars from .env (optional)**

The `CADDY_BASIC_AUTH_USER` and `CADDY_BASIC_AUTH_HASH` variables in `/home/arista/src/aristaflow-brain/infra/.env` are no longer referenced. They can be removed or commented out for cleanliness.

- [ ] **Step 2: Verify no service uses basic_auth**

Run: `grep -r "basic_auth\|BASIC_AUTH" /home/arista/src/aristaflow-brain/infra/`
Expected: No matches (only the .env file if not yet cleaned)
