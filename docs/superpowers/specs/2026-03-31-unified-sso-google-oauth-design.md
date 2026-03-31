# Unified SSO with Google OAuth2 — Design Spec

**Date:** 2026-03-31
**Status:** Approved
**Author:** arista + Claude (security brainstorm)

## Problem

The VPS at `aristaflow.cloud` runs multiple services (WorldMonitor, Grafana, status page) behind Caddy reverse proxy. Currently all protected services share a single HTTP Basic Auth credential (`arista:<bcrypt-hash>`). This has several issues:

- No 2FA — anyone who discovers the password has full access
- No SSO — must re-enter credentials per subdomain/browser session
- Shared credential — cannot revoke access granularly
- WorldMonitor was previously exposed on port 3000 without any auth

## Solution

Deploy **oauth2-proxy** (official image) as a Google OAuth2 gateway. Caddy delegates authentication to oauth2-proxy via `forward_auth`. A single Google login produces a cookie scoped to `.aristaflow.cloud`, granting SSO across all protected subdomains.

## Architecture

```
Browser → Caddy (443/HTTPS)
            │
            ├─ *.aristaflow.cloud
            │    ↓ forward_auth
            │    oauth2-proxy (127.0.0.1:4180)
            │       ↓ Google OAuth2
            │       cookie: _oauth2_proxy (domain=.aristaflow.cloud)
            │    ↓ auth OK → route to backend
            │
            ├─ wm.aristaflow.cloud     → 127.0.0.1:3000  (WorldMonitor)
            ├─ dash.aristaflow.cloud   → 127.0.0.1:13000 (Grafana)
            ├─ status.aristaflow.cloud → static files     (Status page)
            ├─ hooks.aristaflow.cloud  → 127.0.0.1:14141 (Webhooks, NO auth — uses HMAC)
            ├─ auth.aristaflow.cloud   → 127.0.0.1:4180  (OAuth2 callback/login)
            └─ aristaflow.cloud        → (no service, returns 404 or empty)
```

### Auth Flow

1. User accesses `wm.aristaflow.cloud`
2. Caddy sends `forward_auth` subrequest to oauth2-proxy at `/oauth2/auth`
3. No valid `_oauth2_proxy` cookie → oauth2-proxy returns 401
4. Caddy redirects user to `auth.aristaflow.cloud/oauth2/start?rd=<original_url>`
5. oauth2-proxy redirects to Google OAuth consent screen
6. User authenticates with Google (inherits Google's 2FA)
7. Google redirects to `auth.aristaflow.cloud/oauth2/callback` with auth code
8. oauth2-proxy validates the code, checks email allowlist
9. oauth2-proxy sets `_oauth2_proxy` cookie with `domain=.aristaflow.cloud`
10. User is redirected back to `wm.aristaflow.cloud` — cookie present, access granted
11. User navigates to `dash.aristaflow.cloud` — same cookie, no re-auth needed

## Subdomain Map

| Subdomain | Backend | Auth | Notes |
|---|---|---|---|
| `aristaflow.cloud` | *(none)* | — | No service, respond 404 |
| `wm.aristaflow.cloud` | WorldMonitor `127.0.0.1:3000` | Google SSO | NEW |
| `dash.aristaflow.cloud` | Grafana `127.0.0.1:13000` | Google SSO | Replace basic_auth |
| `status.aristaflow.cloud` | Static files `/srv/status` | Google SSO | Replace no-auth |
| `hooks.aristaflow.cloud` | Brain `127.0.0.1:14141` | HMAC (app-layer) | No change |
| `auth.aristaflow.cloud` | oauth2-proxy `127.0.0.1:4180` | — | NEW (callback endpoint) |

## Changes Required

### 1. New DNS Records

```
wm.aristaflow.cloud    A    72.60.158.121
auth.aristaflow.cloud  A    72.60.158.121
```

(`dash`, `status`, `hooks` assumed to already exist)

### 2. Google Cloud Console Setup (manual, ~5 min)

1. Go to console.cloud.google.com → APIs & Services → Credentials
2. Create OAuth 2.0 Client ID → Web Application
3. Authorized redirect URI: `https://auth.aristaflow.cloud/oauth2/callback`
4. Save CLIENT_ID and CLIENT_SECRET to infra `.env` file

### 3. oauth2-proxy Container

Add to `/home/arista/src/aristaflow-brain/infra/docker-compose.yml`:

```yaml
oauth2-proxy:
  image: quay.io/oauth2-proxy/oauth2-proxy:v7
  container_name: oauth2-proxy
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
  restart: unless-stopped
```

### 4. Email Allowlist File

Create `/home/arista/src/aristaflow-brain/infra/oauth2-proxy-emails.txt` with the user's Google email (one email per line).

### 5. Environment Variables

Add to `/home/arista/src/aristaflow-brain/infra/.env`:

```
GOOGLE_CLIENT_ID=<from Google Console>
GOOGLE_CLIENT_SECRET=<from Google Console>
OAUTH2_COOKIE_SECRET=<openssl rand -base64 32>
```

### 6. Caddy Configuration

Replace the entire Caddyfile with:

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

auth.{$DOMAIN} {
    import security_headers
    reverse_proxy 127.0.0.1:4180

    log {
        output stdout
        format json
    }
}

wm.{$DOMAIN} {
    import security_headers
    import google_auth

    reverse_proxy 127.0.0.1:3000

    log {
        output stdout
        format json
    }
}

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

{$DOMAIN} {
    import security_headers
    respond "aristaflow.cloud" 200
}
```

### 7. Removals

- Remove `brain_auth` snippet (basic_auth) from Caddyfile
- Remove `CADDY_BASIC_AUTH_USER` and `CADDY_BASIC_AUTH_HASH` from `.env` (optional, no longer referenced)
- Remove `brain.{$DOMAIN}` vhost (brain service removed)
- Remove `opik.{$DOMAIN}` vhost (opik service removed)

## Security Considerations

- **Email allowlist**: Only the owner's Google email can authenticate. All other Google accounts are rejected.
- **Cookie security**: `Secure`, `SameSite=lax`, scoped to `.aristaflow.cloud`. Transmitted only over HTTPS.
- **2FA**: Inherited from Google account settings. If the Google account has 2FA enabled, it applies automatically.
- **CSRF protection**: `COOKIE_CSRF_PER_REQUEST=true` with 5-minute expiry prevents CSRF on the OAuth flow.
- **No skip-provider-button**: `SKIP_PROVIDER_BUTTON=true` means users go straight to Google login, no intermediary page.
- **Secrets management**: All secrets (CLIENT_ID, CLIENT_SECRET, COOKIE_SECRET) stored in `.env` file on server, never committed to git.
- **Hooks endpoint**: Remains unprotected at reverse proxy level — authentication is handled at application layer via HMAC signature verification.

## What Does NOT Change

- Docker network topology (all services bound to 127.0.0.1)
- UFW firewall rules (22, 80, 443 only)
- WorldMonitor internal architecture
- Redis configuration
- Hooks HMAC authentication
- TLS certificate management (Caddy auto-HTTPS)

## Testing Plan

1. Create DNS records for `wm` and `auth` subdomains
2. Configure Google OAuth Client ID
3. Deploy oauth2-proxy container
4. Update Caddy configuration
5. Test: access `wm.aristaflow.cloud` → should redirect to Google login
6. Test: after Google login, access `dash.aristaflow.cloud` → should work without re-login (SSO cookie)
7. Test: access `hooks.aristaflow.cloud/healthz` → should respond 200 without auth
8. Test: access from a different Google account → should be rejected
9. Test: access `aristaflow.cloud` → should return simple 200 response

## Rollback Plan

If anything goes wrong:
1. Revert Caddyfile to the previous version (restore `basic_auth` snippets)
2. Stop oauth2-proxy container
3. Reload Caddy: `docker exec infra-caddy-1 caddy reload --config /etc/caddy/Caddyfile`

The previous Caddyfile should be committed to git before making changes, enabling easy rollback.
