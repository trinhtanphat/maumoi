# MẫuMới API

Base path: `/api`. JSON responses use `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code", "message" } }`.

## Public/system

- `GET /api/health`
- `GET /api/version`
- `POST /api/admin/bootstrap` with `X-Bootstrap-Secret` — one-time only.
- `POST /api/admin/auth/login`
- `POST /api/ctv/auth/dev` — only when `ALLOW_DEV_AUTH=true`.
- `POST /api/ctv/auth/zalo` — requires configured verifier endpoint/credentials.

## Authenticated Admin

- `GET /api/admin/auth/me`
- `POST /api/admin/auth/logout`
- `GET|POST /api/admin/collaborators`
- `PATCH /api/admin/collaborators/:id`
- `POST /api/admin/collaborators/import`
- `GET|POST /api/admin/products`
- `PATCH /api/admin/products/:id`
- `POST /api/admin/allocations`
- `POST /api/admin/allocations/import`
- `GET /api/admin/inventory`
- `GET /api/admin/customers`
- `GET /api/admin/distributions`
- `GET /api/admin/evidence/:id`
- `GET /api/admin/reconciliations`
- `POST /api/admin/reconciliations/:id/approve`
- `POST /api/admin/reconciliations/:id/reject`
- `GET /api/admin/dashboard`
- `GET /api/admin/audit`
- `GET /api/admin/reports/{collaborators,customers,distributions,inventory,reconciliation}.csv`

## Authenticated CTV

- `GET /api/ctv/me`
- `POST /api/ctv/auth/logout`
- `GET /api/ctv/inventory`
- `POST /api/ctv/customers/precheck`
- `POST /api/otp/request`
- `POST /api/otp/verify`
- `POST /api/evidence` multipart field `photo`
- `POST /api/ctv/distributions` with `Idempotency-Key`
- `GET /api/ctv/distributions`
- `GET /api/ctv/reconciliation/today`
- `POST /api/ctv/reconciliation/submit`

All cookie-authenticated state-changing requests require `X-CSRF-Token` returned at login or `/me`.
