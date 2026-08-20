# MẫuMới Initial MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a production MVP for collaborator sample distribution with Admin management, OTP, private evidence capture, idempotent distribution, reconciliation, reports, D1/R2 persistence, and a responsive CTV/Admin web client.

**Architecture:** A dependency-free Cloudflare Worker module serves both REST APIs and a browser SPA. D1 is the source of truth for identity, inventory and workflow transactions; R2 stores private evidence. Business logic is factored into pure modules so Node's built-in test runner can verify the critical rules without third-party packages.

**Tech Stack:** JavaScript ES modules, Cloudflare Workers, D1, R2, Web Crypto, browser-native HTML/CSS/JS, Node `node:test`, GitHub Actions.

**Spec:** `PLANNING.md`

## Global Constraints

- Worker name: `maumoi`.
- D1 database: `maumoi-db`.
- R2 bucket: `maumoi-evidence`.
- Cloudflare account: `46646bc5777a895df590614528828dd2`.
- Compatibility date: `2026-08-20`.
- OTP: 6 digits, 5-minute TTL, max 5 attempts, 60-second resend cooldown.
- Evidence max size: 8 MiB; accepted MIME: JPEG, PNG, WebP.
- Completed distributions and submitted reconciliations are immutable.
- One customer can claim once per campaign.
- Every distribution requires an idempotency key.
- No external runtime dependency is required.
- Zalo credentials are never committed; production integration fails closed when missing.

---

## File Map

- `package.json` — local scripts for tests and syntax checks.
- `wrangler.jsonc` — canonical Worker/D1/R2 deployment configuration.
- `migrations/0001_initial.sql` — complete append-only initial D1 schema.
- `src/shared/core.js` — pure validation, phone, inventory, reconciliation, CSV, ID helpers.
- `src/shared/crypto.js` — Web Crypto password/session/OTP primitives.
- `src/worker/http.js` — JSON/error/cookie/security response helpers.
- `src/worker/db.js` — D1 query helpers and audit/session data access.
- `src/worker/auth.js` — Admin/CTV session authentication + CSRF enforcement.
- `src/worker/otp.js` — dev/Zalo OTP provider selection and challenge lifecycle.
- `src/worker/routes.js` — API route handlers and business transactions.
- `src/worker/index.js` — Worker entrypoint/router and SPA/static asset serving.
- `src/web/index.html` — SPA shell.
- `src/web/app.css` — responsive Admin/CTV UI styling.
- `src/web/app.js` — browser routes, API client, Admin pages and CTV distribution wizard.
- `tests/core.test.js` — test-first critical domain tests.
- `tests/http.test.js` — test-first HTTP/security helper tests.
- `.github/workflows/ci.yml` — test/check gates.
- `.gitignore`, `.editorconfig` — repository hygiene.
- `README.md` — setup, deployment, API/use instructions.

### Task 1: Domain rules and test harness

**Files:**
- Create: `package.json`
- Create: `tests/core.test.js`
- Create: `src/shared/core.js`

**Interfaces:**
- Produces `normalizeVnPhone`, `maskPhone`, `inventoryAvailable`, `reconciliationVariance`, `parseCsv`, `toCsv`, `validateIdempotencyKey`, `newId`.

- [ ] **Step 1: Write failing domain tests** for VN phone normalization, invalid numbers, masking, stock math, reconciliation variance, CSV quoted fields, CSV escaping, and idempotency-key validation.
- [ ] **Step 2: Run `node --test tests/core.test.js` and verify RED** because `src/shared/core.js` does not exist.
- [ ] **Step 3: Implement the minimal pure functions** using deterministic validation and RFC-4180-compatible CSV quoting.
- [ ] **Step 4: Re-run the test and verify GREEN.**
- [ ] **Step 5: Add `npm test` and `npm run check` scripts.**

### Task 2: Cryptography and HTTP security

**Files:**
- Create: `tests/http.test.js`
- Create: `src/shared/crypto.js`
- Create: `src/worker/http.js`

**Interfaces:**
- Produces `hashPassword`, `verifyPassword`, `hashToken`, `hmacOtp`, `secureEqual`, `json`, `fail`, `parseCookies`, `sessionCookie`, `clearSessionCookie`, `withSecurityHeaders`.

- [ ] **Step 1: Write failing tests** for password round-trip, password rejection, stable token hash, OTP HMAC stability, JSON success/error envelopes, cookie parsing and required security headers.
- [ ] **Step 2: Run tests and confirm RED.**
- [ ] **Step 3: Implement Web Crypto helpers** using PBKDF2-SHA256 for passwords, SHA-256 for opaque tokens, HMAC-SHA256 for OTP, and constant-time byte comparison.
- [ ] **Step 4: Implement HTTP helpers** with CSP, `nosniff`, referrer and permissions policies plus Secure/HttpOnly/SameSite cookies.
- [ ] **Step 5: Run all tests and confirm GREEN.**

### Task 3: D1 schema and data-access boundary

**Files:**
- Create: `migrations/0001_initial.sql`
- Create: `src/worker/db.js`

**Interfaces:**
- Produces `one`, `all`, `run`, `audit`, `createSession`, `loadSession`, `deleteSession`, `inventoryRows`.

- [ ] **Step 1: Encode schema constraints** for unique campaign claims, idempotency, one-time OTP/evidence use, positive quantities and immutable reconciliation identity.
- [ ] **Step 2: Add indexes** for phone, actor sessions, collaborator/product inventory, distributions by date, reconciliation date and audit date.
- [ ] **Step 3: Implement only parameterized D1 helpers**; no string interpolation for user values.
- [ ] **Step 4: Run SQL smoke validation against the provisioned D1 after resource creation.**

### Task 4: Session auth and CSRF

**Files:**
- Create: `src/worker/auth.js`

**Interfaces:**
- Produces `requireAdmin`, `requireCtv`, `createActorSession`, `destroySession`, `requireCsrf`.

- [ ] **Step 1: Authenticate from opaque `maumoi_session` cookie** by hashing the token and loading an unexpired session.
- [ ] **Step 2: Resolve the role-specific actor** from D1 and reject inactive users.
- [ ] **Step 3: Enforce `X-CSRF-Token`** for state-changing cookie-authenticated requests.
- [ ] **Step 4: Keep actor IDs server-derived** and never accept a client actor ID as authorization input.

### Task 5: OTP providers and challenge lifecycle

**Files:**
- Create: `src/worker/otp.js`

**Interfaces:**
- Produces `requestOtp`, `verifyOtp`; consumes CTV actor and campaign.

- [ ] **Step 1: Normalize phone and enforce resend cooldown** using the latest challenge row.
- [ ] **Step 2: Generate a cryptographically random six-digit OTP** and store only HMAC.
- [ ] **Step 3: Implement `dev` provider** only when `ALLOW_DEV_OTP=true`.
- [ ] **Step 4: Implement Zalo provider adapter** using configured endpoint/token/template and fail with `CONFIGURATION_ERROR` when incomplete.
- [ ] **Step 5: Verify expiry/attempt count/consumption** and mark verified exactly once.

### Task 6: Admin CRUD, inventory and bootstrap

**Files:**
- Create: `src/worker/routes.js`

**Interfaces:**
- Produces route handlers for bootstrap, Admin login/logout/me, collaborators, products, allocations, inventory, dashboard, audit.

- [ ] **Step 1: Implement one-time Admin bootstrap** requiring `X-Bootstrap-Secret` and refusing once an Admin exists.
- [ ] **Step 2: Implement login/session/logout** with generic invalid-credential errors.
- [ ] **Step 3: Implement paginated/searchable CTV and product CRUD** with normalized phone and unique code/SKU errors mapped to `VALIDATION_ERROR`.
- [ ] **Step 4: Implement allocation writes and derived inventory** using allocation + adjustment - distribution totals.
- [ ] **Step 5: Audit all sensitive mutations.**

### Task 7: CTV auth, evidence and distribution

**Files:**
- Modify: `src/worker/routes.js`

**Interfaces:**
- Produces dev/Zalo CTV auth, `/api/ctv/me`, inventory, customer precheck, evidence upload, distribution create/history.

- [ ] **Step 1: Implement environment-gated dev CTV auth** by CTV code.
- [ ] **Step 2: Implement Zalo adapter endpoint** that fails closed unless a configured verifier endpoint/credential strategy is available.
- [ ] **Step 3: Validate multipart evidence** as JPEG/PNG/WebP <= 8 MiB, hash it, store private R2 bytes and `PENDING` metadata.
- [ ] **Step 4: Precheck phone/campaign uniqueness.**
- [ ] **Step 5: Implement idempotent distribution** validating verified OTP, evidence ownership/status, product campaign, positive quantity and derived stock before D1 batch insert/finalization/OTP consumption.
- [ ] **Step 6: Map uniqueness races to stable domain errors.**

### Task 8: Reconciliation, CSV import/export and reporting

**Files:**
- Modify: `src/worker/routes.js`

**Interfaces:**
- Produces reconciliation today/submit/admin review; CSV collaborator/allocation imports; five CSV reports.

- [ ] **Step 1: Build today's assigned/distributed/current totals** per CTV/product.
- [ ] **Step 2: Validate submission lines and compute `variance = assigned - distributed - returned - damaged - closing`.**
- [ ] **Step 3: Insert reconciliation header + lines and reject duplicate day submissions.**
- [ ] **Step 4: Implement Admin approve/reject status transitions with audit.**
- [ ] **Step 5: Parse UTF-8 CSV imports** with per-row validation and deterministic errors.
- [ ] **Step 6: Generate Excel-compatible UTF-8 CSV exports** with BOM and safe quoting.

### Task 9: Browser SPA and mobile camera workflow

**Files:**
- Create: `src/web/index.html`
- Create: `src/web/app.css`
- Create: `src/web/app.js`

**Interfaces:**
- Calls the API contract in `PLANNING.md` and stores CSRF token only in browser runtime storage.

- [ ] **Step 1: Build login + role-aware navigation** and typed-ish fetch/error wrapper.
- [ ] **Step 2: Build Admin dashboard/CTV/products/allocation/inventory/customers/distributions/reconciliation/import-export/audit views.**
- [ ] **Step 3: Build CTV home/history/reconciliation/profile.**
- [ ] **Step 4: Build five-step distribution wizard** with customer precheck, OTP, `<input accept="image/*" capture="environment">`, multipart evidence upload, and idempotent confirmation.
- [ ] **Step 5: Mask PII in ordinary tables and render clear domain errors.**

### Task 10: Worker entrypoint and deployment configuration

**Files:**
- Create: `src/worker/index.js`
- Create: `wrangler.jsonc`

**Interfaces:**
- Worker `fetch(request, env)` dispatches `/api/*`, `/app.js`, `/app.css`, and SPA fallback.

- [ ] **Step 1: Route all API endpoints** to `routes.js` with centralized exception-to-error-envelope conversion.
- [ ] **Step 2: Serve web assets with correct MIME + security headers.**
- [ ] **Step 3: Add Worker config** with `DB` and `EVIDENCE` bindings and observability.
- [ ] **Step 4: Run `node --check` across all modules.**

### Task 11: CI, docs and repository quality

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.gitignore`
- Create: `.editorconfig`
- Modify: `README.md`

- [ ] **Step 1: Configure GitHub Actions** for `npm test` and `npm run check` on push/PR.
- [ ] **Step 2: Document local tests, Cloudflare resources, bootstrap, dev auth/OTP safety, production Zalo blockers and smoke commands.**
- [ ] **Step 3: Verify no credentials/secrets are present in tracked files.**

### Task 12: Cloudflare production and verification

**Files:** no new source files; deploy exact merged source.

- [ ] **Step 1: Create D1 `maumoi-db` and R2 `maumoi-evidence`.**
- [ ] **Step 2: Apply `0001_initial.sql` and verify tables/indexes.**
- [ ] **Step 3: Upload Worker modules with D1/R2 bindings.**
- [ ] **Step 4: Enable workers.dev subdomain and observability.**
- [ ] **Step 5: Verify `GET /api/health` returns 200 and SPA returns 200.**
- [ ] **Step 6: Verify unauthorized Admin API returns 401.**
- [ ] **Step 7: Verify exact deployed source corresponds to merged `main`.**
- [ ] **Step 8: Record any remaining external Zalo credential/approval dependency without claiming live OTP success.**
