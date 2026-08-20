# MẫuMới — Implementation Planning & Production Design

**Product:** MẫuMới (`maumoi`)  
**Repository:** `trinhtanphat/maumoi`  
**Runtime:** Cloudflare Workers + D1 + R2  
**Clients:** responsive Admin Web + CTV mobile workflow prepared for Zalo Mini App integration.

## 1. Goal

MẫuMới manages the complete daily sample-distribution workflow: Admin manages CTV and sample products, allocates inventory, CTV verifies a new customer's phone with OTP, captures mandatory camera evidence, records a sample handover, and reconciles stock at end of day. The key KPI is verified unique new customers with auditable handovers and zero unexplained inventory variance.

## 2. MVP scope

Included: Admin authentication; CTV session mapping; CTV/product CRUD; stock allocation; customer precheck and de-duplication; OTP provider abstraction with dev and Zalo ZBS adapters; private evidence upload to R2; atomic/idempotent distribution; daily reconciliation; dashboard; CSV/Excel-compatible import/export; audit log; security baseline; tests; Cloudflare deployment.

Excluded from MVP: commission/payroll, offline sync, biometrics/AI image verification, loyalty, multi-tenant billing, advanced BI.

## 3. Architecture

Chosen architecture is a Cloudflare-native monolith:

```text
Admin Browser / CTV Mobile
          |
          v
 Cloudflare Worker: maumoi
  - HTML/CSS/JS SPA shell
  - REST API /api/*
  - auth/session
  - OTP adapter
  - reconciliation
  - report exports
      |         |
      v         v
  D1 maumoi-db  R2 maumoi-evidence
```

For this production MVP the frontend uses a dependency-free browser SPA served by the Worker. This is an intentional implementation optimization over the earlier React/Vite suggestion: it removes build-time dependency/network risk while preserving route, API, component, and Zalo-adapter boundaries. A React client can replace the web shell later without changing API/data contracts.

## 4. Roles

### ADMIN
Can manage CTV, products, allocations, customers, distributions, reconciliation, reports and audit. Completed handovers are immutable; corrections use adjustments.

### CTV
Can view own profile/inventory/history, precheck customers, request/verify OTP, upload own evidence, distribute assigned stock, and submit own daily reconciliation. A CTV can never select another CTV id in a write request.

## 5. Core workflow

1. CTV authenticates and sees assigned/used/remaining stock.
2. CTV enters customer name + phone + product.
3. Server normalizes the Vietnamese phone number and blocks duplicate customer/campaign claims.
4. Server issues a 6-digit OTP challenge (5-minute TTL, 60-second resend cooldown, max 5 attempts).
5. Customer verifies OTP.
6. CTV captures a photo directly from mobile camera (`capture="environment"`) and uploads it.
7. Server stores private evidence in R2 with hash/metadata.
8. CTV submits distribution with `Idempotency-Key`.
9. Server verifies CTV, OTP, evidence ownership, stock and uniqueness before writing distribution and consuming OTP/evidence.
10. End of day CTV submits returned/damaged/closing values; server computes variance.

## 6. Data model

All IDs are random text IDs generated server-side.

### admins
`id`, `email UNIQUE`, `password_hash`, `name`, `status`, `created_at`, `updated_at`.

### sessions
`id`, `actor_type`, `actor_id`, `token_hash UNIQUE`, `csrf_token`, `expires_at`, `created_at`.

### collaborators
`id`, `code UNIQUE`, `name`, `phone UNIQUE`, `zalo_user_id UNIQUE NULL`, `area`, `team`, `status`, timestamps.

### sample_products
`id`, `sku UNIQUE`, `name`, `campaign_code`, `status`, timestamps.

### inventory_allocations
`id`, `collaborator_id`, `product_id`, `quantity CHECK > 0`, `allocated_at`, `allocated_by`, `source_ref`, `status`.

### customers
`id`, `name`, `phone_normalized`, `phone_masked`, `created_by_collaborator_id`, `created_at`.

### otp_challenges
`id`, `phone_normalized`, `collaborator_id`, `campaign_code`, `provider`, `provider_message_id`, `otp_hash`, `attempt_count`, `expires_at`, `verified_at`, `consumed_at`, `created_at`.

### evidence_objects
`id`, `r2_key UNIQUE`, `sha256`, `mime_type`, `size_bytes`, `captured_at_server`, `latitude`, `longitude`, `status`, `created_by_collaborator_id`.

### sample_distributions
`id`, `collaborator_id`, `customer_id`, `product_id`, `campaign_code`, `quantity`, `otp_challenge_id UNIQUE`, `evidence_id UNIQUE`, `distributed_at`, `status`, `idempotency_key`, UNIQUE(`collaborator_id`,`idempotency_key`), UNIQUE(`customer_id`,`campaign_code`).

### daily_reconciliations
`id`, `collaborator_id`, `business_date`, `status`, `submitted_at`, `approved_at`, `approved_by`, `note`, UNIQUE(`collaborator_id`,`business_date`).

### daily_reconciliation_lines
`id`, `reconciliation_id`, `product_id`, `assigned_qty`, `distributed_qty`, `returned_qty`, `damaged_qty`, `closing_qty`, `variance_qty`, `reason`.

### inventory_adjustments
`id`, `collaborator_id`, `product_id`, `quantity_delta`, `reason_code`, `note`, `created_by_admin_id`, `created_at`.

### audit_logs
`id`, `actor_type`, `actor_id`, `action`, `entity_type`, `entity_id`, `metadata_json`, `ip_hash`, `created_at`.

## 7. Inventory formula

For each CTV/product:

```text
available = allocations + adjustments - distributions
```

Inventory is derived from immutable transactions; the browser never maintains an authoritative counter.

## 8. API contract

All endpoints use `/api` and return `{ok:true,data}` or `{ok:false,error:{code,message}}`.

### System
- `GET /api/health`
- `GET /api/version`

### Admin auth
- `POST /api/admin/bootstrap` — requires one-time `X-Bootstrap-Secret`, only works when no Admin exists.
- `POST /api/admin/auth/login`
- `POST /api/admin/auth/logout`
- `GET /api/admin/auth/me`

### Admin CTV/products/inventory
- `GET|POST /api/admin/collaborators`
- `PATCH /api/admin/collaborators/:id`
- `GET|POST /api/admin/products`
- `PATCH /api/admin/products/:id`
- `POST /api/admin/allocations`
- `GET /api/admin/inventory`

### Imports/exports
- `POST /api/admin/collaborators/import` (`text/csv` MVP; Excel-compatible UTF-8 CSV)
- `POST /api/admin/allocations/import`
- `GET /api/admin/reports/{collaborators,customers,distributions,inventory,reconciliation}.csv`

### CTV auth/inventory
- `POST /api/ctv/auth/dev` — disabled unless `ALLOW_DEV_AUTH=true`; production Zalo endpoint is separate.
- `POST /api/ctv/auth/zalo` — adapter endpoint; fails closed until credentials/verifier are configured.
- `GET /api/ctv/me`
- `GET /api/ctv/inventory`

### OTP
- `POST /api/otp/request`
- `POST /api/otp/verify`

### Evidence
- `POST /api/evidence` multipart `photo` (JPEG/PNG/WebP, max 8 MiB)
- `GET /api/admin/evidence/:id`

### Customer/distribution
- `POST /api/ctv/customers/precheck`
- `POST /api/ctv/distributions`
- `GET /api/ctv/distributions`
- `GET /api/admin/customers`
- `GET /api/admin/distributions`

### Reconciliation/dashboard
- `GET /api/ctv/reconciliation/today`
- `POST /api/ctv/reconciliation/submit`
- `GET /api/admin/reconciliations`
- `POST /api/admin/reconciliations/:id/approve`
- `POST /api/admin/reconciliations/:id/reject`
- `GET /api/admin/dashboard`
- `GET /api/admin/audit`

## 9. HTTP errors

Stable codes: `UNAUTHORIZED`, `FORBIDDEN`, `VALIDATION_ERROR`, `RATE_LIMITED`, `OTP_EXPIRED`, `OTP_INVALID`, `OTP_ALREADY_CONSUMED`, `CUSTOMER_ALREADY_CLAIMED`, `INSUFFICIENT_STOCK`, `EVIDENCE_REQUIRED`, `EVIDENCE_INVALID`, `RECONCILIATION_ALREADY_SUBMITTED`, `IDEMPOTENCY_CONFLICT`, `CONFIGURATION_ERROR`.

No internal stack trace is returned to clients.

## 10. Authentication

Admin uses email/password. Password hashing uses PBKDF2-SHA256 with a per-password random salt and high iteration count via Web Crypto, avoiding external native dependencies. Session tokens are opaque random values; only SHA-256 hashes are stored in D1. Cookies are `HttpOnly; Secure; SameSite=Strict; Path=/`.

CTV production auth is adapter-based and requires server-side Zalo credential verification. Development CTV auth is explicitly environment-gated and must be disabled for public production.

Every cookie-authenticated mutation requires `X-CSRF-Token` matching the current session.

## 11. OTP

`OtpProvider.send({phone,otp,challengeId})` has two implementations:

- `dev`: does not send externally; response exposes `devOtp` only when `ALLOW_DEV_OTP=true`.
- `zalo`: calls the configured Zalo endpoint/template using server-side secrets. If credentials are missing, it returns `CONFIGURATION_ERROR` rather than silently falling back.

OTP defaults: six digits, five-minute expiry, max five attempts, sixty-second resend cooldown. Plaintext OTP is never stored; only HMAC-SHA256 using `OTP_HASH_SECRET` is stored.

## 12. Evidence

The CTV UI uses `<input type="file" accept="image/*" capture="environment">`. The backend additionally validates MIME and 8 MiB maximum size, hashes bytes with SHA-256, writes to a private R2 key `evidence/<date>/<ctv>/<id>`, and inserts a `PENDING` evidence row. Distribution finalization changes it to `FINALIZED`.

Evidence is served only through authenticated Admin API. R2 has no public URL requirement.

## 13. Idempotency/concurrency

Every distribution requires `Idempotency-Key`. A repeated key for the same CTV returns the original transaction. A reused key with incompatible request intent returns `IDEMPOTENCY_CONFLICT`. Database constraints additionally block one customer/campaign claim and one-time OTP/evidence reuse.

D1 write operations use `batch()` for the distribution transaction where possible and constraints are treated as the final authority under races.

## 14. Reconciliation

For each product/day:

```text
variance = assigned - distributed - returned - damaged - closing
```

Submission is immutable. Admin can approve or reject; subsequent corrections are represented as inventory adjustments, never destructive edits.

## 15. Admin UI

Routes/views in the SPA:
- Dashboard
- CTV
- Products & allocation
- Inventory
- Customers
- Distributions
- Reconciliation
- Import/export
- Audit

Dashboard shows active CTV, allocated/distributed/remaining samples, verified customers, OTP failures and unresolved variances.

## 16. CTV UI

Screens:
- Home/inventory
- Distribution wizard: Customer → OTP → Camera → Confirm → Done
- History
- Reconciliation
- Profile

The wizard stores only non-sensitive draft state in browser memory/local storage. OTP/evidence validity is always rechecked server-side.

## 17. Security baseline

- parameterized D1 statements only;
- strict role authorization;
- no client-supplied actor IDs;
- CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`;
- CSRF validation for cookie mutations;
- secure session cookies;
- request/body limits;
- MIME validation;
- private R2;
- structured PII-minimized logs;
- masked phone in normal listings;
- rate controls for OTP/login/upload in application logic;
- production dev-auth/dev-OTP guard.

## 18. Retention

Recommended pilot defaults: evidence 90 days; audit 180 days; expired OTPs are safe to purge by scheduled maintenance. No generated report is permanently stored publicly.

## 19. Testing

Automated Node built-in tests cover:
- phone normalization/masking;
- password hashing/verification;
- OTP hash/verification and expiry logic;
- CSV parser/export escaping;
- reconciliation variance;
- idempotency key validation;
- inventory math;
- error envelope/security headers.

Production smoke verifies `/api/health`, SPA, unauthorized admin protection, D1 schema, R2 binding, and deployed version.

## 20. CI quality gates

No network-installed runtime dependency is required. Required commands:

```bash
npm test
npm run check
```

`check` runs syntax checks over production/test JavaScript. GitHub Actions runs both on pushes and PRs.

## 21. Git workflow

```text
main@spec/bootstrap
  <- feat/initial-mvp
       -> tests/checks
       -> PR
       -> merge main
       -> deploy exact merged source
```

## 22. Cloudflare production resources

- Worker: `maumoi`
- D1: `maumoi-db`
- R2: `maumoi-evidence`
- compatibility date: `2026-08-20`
- observability: enabled

Bindings: `DB` (D1), `EVIDENCE` (R2).

Secrets/config:
- `ADMIN_BOOTSTRAP_SECRET`
- `SESSION_SIGNING_SECRET`
- `OTP_HASH_SECRET`
- `OTP_PROVIDER`
- `ALLOW_DEV_AUTH`
- `ALLOW_DEV_OTP`
- `ZALO_APP_ID`
- `ZALO_APP_SECRET`
- `ZALO_OA_ACCESS_TOKEN`
- `ZALO_ZBS_TEMPLATE_ID`

No Zalo secret is committed. Until the business supplies approved Zalo credentials/template, public production must keep dev OTP/auth disabled; internal pilot may deliberately enable them behind controlled access only.

## 23. Deployment order

1. Create D1 `maumoi-db`.
2. Apply `migrations/0001_initial.sql`.
3. Create private R2 bucket `maumoi-evidence`.
4. Configure non-secret vars and secret values available in this environment.
5. Upload Worker modules with D1/R2 bindings.
6. Enable workers.dev subdomain.
7. Bootstrap first Admin only when a bootstrap secret has been securely configured.
8. Smoke test.

## 24. Rollback

Application rollback is a redeploy of the previous Worker version. Database migrations are append-only and non-destructive; schema rollback should be forward-fix. Finalized R2 evidence is immutable and not deleted by application rollback.

## 25. Acceptance criteria

Done means:
- Admin can authenticate and manage CTV/products/allocations.
- CTV can authenticate through configured adapter and view exact remaining inventory.
- Customer phone normalization and campaign duplicate blocking work.
- OTP is required before distribution.
- Evidence is required and private in R2.
- Distribution consumes stock once and retries are idempotent.
- Reconciliation detects variance.
- Reports export clean CSV compatible with Excel.
- Sensitive writes create audit records.
- Automated tests/checks pass.
- D1/R2/Worker are provisioned.
- Worker and API smoke tests are green.
- deployed source matches merged `main`.

## 26. External dependency

Zalo Mini App camera/phone permission and ZBS template approval are external. Code is integration-ready but a live Zalo OTP cannot be truthfully verified until the required approved credentials/template are provided. This is not allowed to block the rest of the operational MVP.
