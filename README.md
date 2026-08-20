# MẫuMới

MẫuMới (`maumoi`) is a production-oriented MVP for managing field collaborators (CTV) who distribute trial samples and collect verified new customers.

## What is implemented

- Responsive Admin web app: dashboard, CTV, products, stock allocation, inventory, customers, distributions, private evidence viewer, reconciliation, CSV import/export, audit.
- Responsive CTV flow: inventory, customer precheck, OTP verification, mandatory mobile camera capture, idempotent distribution, history, end-of-day reconciliation.
- Cloudflare Worker REST API with D1 and private R2 bindings.
- One-time Admin bootstrap and secure cookie sessions.
- PBKDF2-SHA256 password hashing through Web Crypto.
- HMAC-SHA256 OTP hashing; no plaintext OTP persistence.
- Dev OTP/auth feature flags that fail closed unless explicitly enabled.
- Zalo auth/ZBS integration adapters that fail closed until approved credentials/endpoints are configured.
- D1 triggers enforcing OTP/evidence one-time use and stock-at-write validation.
- Unique phone/campaign claims and actor-scoped idempotency.
- Excel-compatible UTF-8 CSV import/export with spreadsheet-formula escaping.
- Automated unit, schema smoke and syntax checks.

## Architecture

```text
Admin Browser / CTV Mobile / Zalo Mini App adapter
                      |
                      v
              Cloudflare Worker
                /api/* + SPA
                |          |
                v          v
          D1 maumoi-db   R2 maumoi-evidence
```

The browser client is intentionally dependency-free for the first pilot so the deploy artifact can be reproduced without a frontend package supply chain. API boundaries remain independent, so React/ZMP-specific UI can replace the shell later without changing data contracts.

## Repository map

```text
PLANNING.md
wrangler.jsonc     Worker/D1/R2 deployment bindings (D1 ID filled after provisioning)
migrations/0001_initial.sql
src/shared/       pure domain + crypto rules
src/worker/       Worker API/auth/D1/R2/OTP routing
src/web/          Admin + CTV SPA sources and embedded deployment assets
tests/            Node built-in unit tests
scripts/          syntax + D1 schema smoke tools
samples/          CSV import templates
docs/             architecture, API, implementation plan, deployment notes
```

## Verify locally

No external NPM runtime dependency is needed.

```bash
npm ci --ignore-scripts
npm test
npm run sql:smoke
npm run check
```

## Cloudflare resources

Production target account: `46646bc5777a895df590614528828dd2`.

- Worker: `maumoi`
- D1: `maumoi-db`
- R2: `maumoi-evidence`
- Compatibility date: `2026-08-20`
- D1 binding: `DB`
- R2 binding: `EVIDENCE`

Apply `migrations/0001_initial.sql` before accepting traffic.

## Runtime configuration

Secrets/variables are never committed:

- `ADMIN_BOOTSTRAP_SECRET`
- `OTP_HASH_SECRET`
- `OTP_PROVIDER` (`zalo` for real production; `dev` only controlled pilot)
- `ALLOW_DEV_AUTH` (`false` by default)
- `ALLOW_DEV_OTP` (`false` by default)
- `ZALO_APP_ID`
- `ZALO_APP_SECRET`
- `ZALO_AUTH_VERIFY_ENDPOINT`
- `ZALO_OA_ACCESS_TOKEN`
- `ZALO_ZBS_TEMPLATE_ID`
- `ZALO_ZBS_ENDPOINT`
- `APP_VERSION`

## Bootstrap first Admin

After configuring `ADMIN_BOOTSTRAP_SECRET`, call once:

```bash
curl -X POST https://<worker>/api/admin/bootstrap \
  -H 'Content-Type: application/json' \
  -H 'X-Bootstrap-Secret: <secret>' \
  --data '{"email":"admin@example.com","name":"Admin","password":"use-a-long-unique-password"}'
```

The endpoint permanently refuses bootstrap after the first Admin exists. Rotate/remove the bootstrap secret afterwards where operationally possible.

## Pilot CTV auth / OTP

For internal pilot only, the deployment can deliberately set:

```text
ALLOW_DEV_AUTH=true
ALLOW_DEV_OTP=true
OTP_PROVIDER=dev
```

Then Admin creates a CTV and the CTV can sign in by code. The OTP screen will display the generated pilot OTP. Do not expose this configuration as public production.

For real production, use `OTP_PROVIDER=zalo`, disable both dev flags, supply approved Zalo credentials/template/endpoints, and map each `zalo_user_id` to a CTV.

## Evidence integrity

The mobile UI uses `accept="image/*" capture="environment"`. The server independently enforces JPEG/PNG/WebP, max 8 MiB, server timestamp, SHA-256, actor ownership and private R2 storage. Evidence changes from `PENDING` to `FINALIZED` only through a successful distribution database trigger.

## Inventory and race safety

Authoritative stock is derived as:

```text
allocations + adjustments - completed distributions
```

The D1 `BEFORE INSERT` distribution trigger re-evaluates available stock at write time. The same trigger verifies OTP and evidence state; an `AFTER INSERT` trigger consumes OTP and finalizes evidence. Unique constraints enforce phone/campaign and actor/idempotency invariants.

## Import templates

- `samples/ctv-import.csv`
- `samples/allocation-import.csv`

Exports are CSV with UTF-8 BOM and open directly in Excel.

## Zalo external dependency

Live Zalo OTP and Mini App permissions cannot be truthfully marked verified until the product owner supplies approved Zalo app/OA credentials, the approved ZBS template, and the applicable auth/ZBS endpoints. The code fails closed instead of silently using a fake provider.

See `PLANNING.md`, `docs/API.md`, and `docs/superpowers/plans/2026-08-20-initial-mvp.md` for the full design and implementation plan.
