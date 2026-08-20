import {
  DomainError,
  businessDateVn,
  maskPhone,
  newId,
  normalizeVnPhone,
  nowIso,
  optionalString,
  parseCsv,
  positiveInt,
  requiredString,
  toCsv,
  validateIdempotencyKey,
} from '../shared/core.js';
import {
  assertOtpUsable,
  devFeatureEnabled,
  distributionFingerprint,
  normalizeReconciliationLine,
  validateEvidenceMeta,
} from '../shared/business.js';
import { hashPassword, secureEqual, sha256, verifyPassword } from '../shared/crypto.js';
import { createActorSession, destroySession, publicActor, requireAdmin, requireCsrf, requireCtv } from './auth.js';
import { all, audit, inventoryRows, one, run } from './db.js';
import { clearSessionCookie, json, readJson, sessionCookie, withSecurityHeaders } from './http.js';
import { requestOtp, verifyOtp } from './otp.js';

const MAX_LIST = 100;
const CSV_MAX = 2 * 1024 * 1024;

function pageParams(url) {
  const limit = Math.min(MAX_LIST, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  return { limit, offset, q };
}

function emailValue(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    throw new DomainError('VALIDATION_ERROR', 'Email không hợp lệ.');
  }
  return email;
}

function ctvStatus(value, fallback = 'ACTIVE') {
  const status = String(value || fallback).toUpperCase();
  if (!['ACTIVE', 'SUSPENDED', 'INACTIVE'].includes(status)) throw new DomainError('VALIDATION_ERROR', 'Trạng thái CTV không hợp lệ.');
  return status;
}

function productStatus(value, fallback = 'ACTIVE') {
  const status = String(value || fallback).toUpperCase();
  if (!['ACTIVE', 'INACTIVE'].includes(status)) throw new DomainError('VALIDATION_ERROR', 'Trạng thái sản phẩm không hợp lệ.');
  return status;
}

async function bodyJson(request) {
  return readJson(request);
}

async function bodyTextLimited(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > CSV_MAX) throw new DomainError('VALIDATION_ERROR', 'File import quá lớn.', 413);
  const text = await request.text();
  if (text.length > CSV_MAX) throw new DomainError('VALIDATION_ERROR', 'File import quá lớn.', 413);
  return text;
}

function csvResponse(filename, rows, columns) {
  return withSecurityHeaders(new Response(toCsv(rows, columns), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  }));
}

async function adminBootstrap(request, env) {
  if (!env.ADMIN_BOOTSTRAP_SECRET) throw new DomainError('CONFIGURATION_ERROR', 'Bootstrap secret chưa được cấu hình.', 503);
  const supplied = request.headers.get('x-bootstrap-secret') || '';
  if (!secureEqual(supplied, env.ADMIN_BOOTSTRAP_SECRET)) throw new DomainError('FORBIDDEN', 'Bootstrap secret không hợp lệ.', 403);
  const count = await one(env.DB, `SELECT COUNT(*) count FROM admins`);
  if (Number(count?.count || 0) > 0) throw new DomainError('FORBIDDEN', 'Admin đã được bootstrap.', 403);
  const payload = await bodyJson(request);
  const email = emailValue(payload.email);
  const name = requiredString(payload.name, 'name', 120);
  const password = requiredString(payload.password, 'password', 300);
  if (password.length < 10) throw new DomainError('VALIDATION_ERROR', 'Mật khẩu phải có ít nhất 10 ký tự.');
  const passwordHash = await hashPassword(password);
  const id = newId('adm');
  const now = nowIso();
  await run(env.DB, `INSERT INTO admins(id,email,password_hash,name,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, [id, email, passwordHash, name, 'ACTIVE', now, now]);
  await audit(env.DB, request, { type: 'SYSTEM', id: null }, 'ADMIN_BOOTSTRAP', 'admin', id, { email });
  const session = await createActorSession(env, 'ADMIN', id);
  return json({ actor: { id, type: 'ADMIN', email, name, csrfToken: session.csrf }, expiresAt: session.expiresAt }, 201, { 'set-cookie': sessionCookie(session.token) });
}

async function adminLogin(request, env) {
  const payload = await bodyJson(request);
  const email = emailValue(payload.email);
  const password = String(payload.password || '');
  const admin = await one(env.DB, `SELECT * FROM admins WHERE email=? LIMIT 1`, [email]);
  if (!admin || admin.status !== 'ACTIVE' || !(await verifyPassword(password, admin.password_hash))) {
    throw new DomainError('UNAUTHORIZED', 'Email hoặc mật khẩu không đúng.', 401);
  }
  const session = await createActorSession(env, 'ADMIN', admin.id);
  await audit(env.DB, request, { type: 'ADMIN', id: admin.id }, 'LOGIN', 'session', null, {});
  return json({ actor: { id: admin.id, type: 'ADMIN', email: admin.email, name: admin.name, csrfToken: session.csrf }, expiresAt: session.expiresAt }, 200, { 'set-cookie': sessionCookie(session.token) });
}

async function adminLogout(request, env) {
  const auth = await requireAdmin(request, env);
  requireCsrf(request, auth);
  await audit(env.DB, request, auth.actor, 'LOGOUT', 'session', auth.session.id, {});
  await destroySession(request, env);
  return json({ loggedOut: true }, 200, { 'set-cookie': clearSessionCookie() });
}


async function ctvLogout(request, env) {
  const auth = await requireCtv(request, env);
  requireCsrf(request, auth);
  await audit(env.DB, request, auth.actor, 'LOGOUT', 'session', auth.session.id, {});
  await destroySession(request, env);
  return json({ loggedOut: true }, 200, { 'set-cookie': clearSessionCookie() });
}

async function listCollaborators(request, env, url) {
  await requireAdmin(request, env);
  const { limit, offset, q } = pageParams(url);
  const like = `%${q}%`;
  const rows = await all(env.DB,
    `SELECT id,code,name,phone,area,team,status,zalo_user_id,created_at,updated_at
       FROM collaborators
      WHERE (?='' OR code LIKE ? OR name LIKE ? OR phone LIKE ?)
      ORDER BY created_at DESC LIMIT ? OFFSET ?`, [q, like, like, like, limit, offset]);
  return json(rows.map((r) => ({ ...r, phone: maskPhone(r.phone) })));
}

async function createCollaborator(request, env) {
  const auth = await requireAdmin(request, env); requireCsrf(request, auth);
  const p = await bodyJson(request);
  const id = newId('ctv');
  const code = requiredString(p.code, 'code', 60).toUpperCase();
  const name = requiredString(p.name, 'name', 120);
  const phone = normalizeVnPhone(p.phone);
  const area = optionalString(p.area, 120);
  const team = optionalString(p.team, 120);
  const status = ctvStatus(p.status);
  const now = nowIso();
  await run(env.DB, `INSERT INTO collaborators(id,code,name,phone,area,team,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`, [id, code, name, phone, area, team, status, now, now]);
  await audit(env.DB, request, auth.actor, 'CTV_CREATE', 'collaborator', id, { code, phone: maskPhone(phone) });
  return json({ id, code, name, phone: maskPhone(phone), area, team, status }, 201);
}

async function patchCollaborator(request, env, id) {
  const auth = await requireAdmin(request, env); requireCsrf(request, auth);
  const existing = await one(env.DB, `SELECT * FROM collaborators WHERE id=?`, [id]);
  if (!existing) throw new DomainError('VALIDATION_ERROR', 'Không tìm thấy CTV.', 404);
  const p = await bodyJson(request);
  const code = p.code == null ? existing.code : requiredString(p.code, 'code', 60).toUpperCase();
  const name = p.name == null ? existing.name : requiredString(p.name, 'name', 120);
  const phone = p.phone == null ? existing.phone : normalizeVnPhone(p.phone);
  const area = p.area === undefined ? existing.area : optionalString(p.area, 120);
  const team = p.team === undefined ? existing.team : optionalString(p.team, 120);
  const status = p.status == null ? existing.status : ctvStatus(p.status);
  const zaloUserId = p.zaloUserId === undefined ? existing.zalo_user_id : optionalString(p.zaloUserId, 200);
  await run(env.DB, `UPDATE collaborators SET code=?,name=?,phone=?,area=?,team=?,status=?,zalo_user_id=?,updated_at=? WHERE id=?`, [code, name, phone, area, team, status, zaloUserId, nowIso(), id]);
  await audit(env.DB, request, auth.actor, 'CTV_UPDATE', 'collaborator', id, { code, status });
  return json({ id, code, name, phone: maskPhone(phone), area, team, status, zaloUserId });
}

async function listProducts(request, env, url) {
  await requireAdmin(request, env);
  const { limit, offset, q } = pageParams(url); const like = `%${q}%`;
  return json(await all(env.DB,
    `SELECT id,sku,name,campaign_code,status,created_at,updated_at FROM sample_products
      WHERE (?='' OR sku LIKE ? OR name LIKE ? OR campaign_code LIKE ?)
      ORDER BY created_at DESC LIMIT ? OFFSET ?`, [q, like, like, like, limit, offset]));
}

async function createProduct(request, env) {
  const auth = await requireAdmin(request, env); requireCsrf(request, auth);
  const p = await bodyJson(request); const id = newId('prd'); const now = nowIso();
  const sku = requiredString(p.sku, 'sku', 80).toUpperCase();
  const name = requiredString(p.name, 'name', 150);
  const campaignCode = requiredString(p.campaignCode, 'campaignCode', 80).toUpperCase();
  const status = productStatus(p.status);
  await run(env.DB, `INSERT INTO sample_products(id,sku,name,campaign_code,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, [id, sku, name, campaignCode, status, now, now]);
  await audit(env.DB, request, auth.actor, 'PRODUCT_CREATE', 'product', id, { sku, campaignCode });
  return json({ id, sku, name, campaign_code: campaignCode, status }, 201);
}

async function patchProduct(request, env, id) {
  const auth = await requireAdmin(request, env); requireCsrf(request, auth);
  const existing = await one(env.DB, `SELECT * FROM sample_products WHERE id=?`, [id]);
  if (!existing) throw new DomainError('VALIDATION_ERROR', 'Không tìm thấy sản phẩm.', 404);
  const p = await bodyJson(request);
  const sku = p.sku == null ? existing.sku : requiredString(p.sku, 'sku', 80).toUpperCase();
  const name = p.name == null ? existing.name : requiredString(p.name, 'name', 150);
  const campaignCode = p.campaignCode == null ? existing.campaign_code : requiredString(p.campaignCode, 'campaignCode', 80).toUpperCase();
  const status = p.status == null ? existing.status : productStatus(p.status);
  await run(env.DB, `UPDATE sample_products SET sku=?,name=?,campaign_code=?,status=?,updated_at=? WHERE id=?`, [sku, name, campaignCode, status, nowIso(), id]);
  await audit(env.DB, request, auth.actor, 'PRODUCT_UPDATE', 'product', id, { sku, campaignCode, status });
  return json({ id, sku, name, campaign_code: campaignCode, status });
}

async function createAllocation(request, env) {
  const auth = await requireAdmin(request, env); requireCsrf(request, auth);
  const p = await bodyJson(request); const quantity = positiveInt(p.quantity, 'quantity');
  const collaboratorId = requiredString(p.collaboratorId, 'collaboratorId', 100);
  const productId = requiredString(p.productId, 'productId', 100);
  if (!(await one(env.DB, `SELECT id FROM collaborators WHERE id=? AND status='ACTIVE'`, [collaboratorId]))) throw new DomainError('VALIDATION_ERROR', 'CTV không hoạt động.');
  if (!(await one(env.DB, `SELECT id FROM sample_products WHERE id=? AND status='ACTIVE'`, [productId]))) throw new DomainError('VALIDATION_ERROR', 'Sản phẩm không hoạt động.');
  const id = newId('alloc'); const sourceRef = optionalString(p.sourceRef, 150);
  await run(env.DB, `INSERT INTO inventory_allocations(id,collaborator_id,product_id,quantity,allocated_at,allocated_by,source_ref,status) VALUES(?,?,?,?,?,?,?,'ACTIVE')`, [id, collaboratorId, productId, quantity, nowIso(), auth.actor.id, sourceRef]);
  await audit(env.DB, request, auth.actor, 'ALLOCATION_CREATE', 'allocation', id, { collaboratorId, productId, quantity });
  return json({ id, collaboratorId, productId, quantity, sourceRef }, 201);
}

async function importCollaborators(request, env) {
  const auth = await requireAdmin(request, env); requireCsrf(request, auth);
  const rows = parseCsv(await bodyTextLimited(request));
  if (!rows.length) throw new DomainError('VALIDATION_ERROR', 'CSV không có dữ liệu.');
  const prepared = [];
  const seenCodes = new Set(); const seenPhones = new Set(); const now = nowIso();
  for (const row of rows) {
    const code = requiredString(row.code, 'code', 60).toUpperCase(); const phone = normalizeVnPhone(row.phone);
    if (seenCodes.has(code) || seenPhones.has(phone)) throw new DomainError('VALIDATION_ERROR', `CSV trùng CTV ${code}.`);
    seenCodes.add(code); seenPhones.add(phone);
    prepared.push(env.DB.prepare(`INSERT INTO collaborators(id,code,name,phone,area,team,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .bind(newId('ctv'), code, requiredString(row.name, 'name', 120), phone, optionalString(row.area, 120), optionalString(row.team, 120), ctvStatus(row.status || 'ACTIVE'), now, now));
  }
  await env.DB.batch(prepared);
  await audit(env.DB, request, auth.actor, 'CTV_IMPORT', 'collaborator', null, { count: rows.length });
  return json({ imported: rows.length }, 201);
}

async function importAllocations(request, env) {
  const auth = await requireAdmin(request, env); requireCsrf(request, auth);
  const rows = parseCsv(await bodyTextLimited(request));
  if (!rows.length) throw new DomainError('VALIDATION_ERROR', 'CSV không có dữ liệu.');
  const prepared = [];
  for (const row of rows) {
    const code = requiredString(row.collaborator_code, 'collaborator_code', 60).toUpperCase();
    const sku = requiredString(row.sku, 'sku', 80).toUpperCase();
    const ctv = await one(env.DB, `SELECT id FROM collaborators WHERE code=? AND status='ACTIVE'`, [code]);
    const product = await one(env.DB, `SELECT id FROM sample_products WHERE sku=? AND status='ACTIVE'`, [sku]);
    if (!ctv) throw new DomainError('VALIDATION_ERROR', `Không tìm thấy CTV ${code}.`);
    if (!product) throw new DomainError('VALIDATION_ERROR', `Không tìm thấy SKU ${sku}.`);
    prepared.push(env.DB.prepare(`INSERT INTO inventory_allocations(id,collaborator_id,product_id,quantity,allocated_at,allocated_by,source_ref,status) VALUES(?,?,?,?,?,?,?,'ACTIVE')`)
      .bind(newId('alloc'), ctv.id, product.id, positiveInt(row.quantity, 'quantity'), nowIso(), auth.actor.id, optionalString(row.source_ref, 150)));
  }
  await env.DB.batch(prepared);
  await audit(env.DB, request, auth.actor, 'ALLOCATION_IMPORT', 'allocation', null, { count: rows.length });
  return json({ imported: rows.length }, 201);
}

async function ctvDevLogin(request, env) {
  if (!devFeatureEnabled(env.ALLOW_DEV_AUTH)) throw new DomainError('FORBIDDEN', 'Dev CTV auth đang bị tắt.', 403);
  const p = await bodyJson(request); const code = requiredString(p.code, 'code', 60).toUpperCase();
  const ctv = await one(env.DB, `SELECT * FROM collaborators WHERE code=? AND status='ACTIVE'`, [code]);
  if (!ctv) throw new DomainError('UNAUTHORIZED', 'CTV không hợp lệ.', 401);
  const session = await createActorSession(env, 'CTV', ctv.id);
  await audit(env.DB, request, { type: 'CTV', id: ctv.id }, 'DEV_LOGIN', 'session', null, {});
  return json({ actor: { id: ctv.id, type: 'CTV', code: ctv.code, name: ctv.name, csrfToken: session.csrf }, expiresAt: session.expiresAt, mode: 'dev' }, 200, { 'set-cookie': sessionCookie(session.token) });
}

async function ctvZaloLogin(request, env) {
  if (!env.ZALO_AUTH_VERIFY_ENDPOINT || !env.ZALO_APP_ID || !env.ZALO_APP_SECRET) throw new DomainError('CONFIGURATION_ERROR', 'Zalo auth chưa được cấu hình.', 503);
  const p = await bodyJson(request); const token = requiredString(p.token, 'token', 4000);
  const response = await fetch(env.ZALO_AUTH_VERIFY_ENDPOINT, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, app_id: env.ZALO_APP_ID, app_secret: env.ZALO_APP_SECRET }),
  });
  if (!response.ok) throw new DomainError('UNAUTHORIZED', 'Không xác thực được tài khoản Zalo.', 401);
  const verified = await response.json(); const zaloUserId = verified?.user_id || verified?.data?.user_id;
  if (!zaloUserId) throw new DomainError('UNAUTHORIZED', 'Zalo verifier không trả user id.', 401);
  const ctv = await one(env.DB, `SELECT * FROM collaborators WHERE zalo_user_id=? AND status='ACTIVE'`, [String(zaloUserId)]);
  if (!ctv) throw new DomainError('FORBIDDEN', 'Tài khoản Zalo chưa được gán CTV.', 403);
  const session = await createActorSession(env, 'CTV', ctv.id);
  await audit(env.DB, request, { type: 'CTV', id: ctv.id }, 'ZALO_LOGIN', 'session', null, {});
  return json({ actor: { id: ctv.id, type: 'CTV', code: ctv.code, name: ctv.name, csrfToken: session.csrf }, expiresAt: session.expiresAt, mode: 'zalo' }, 200, { 'set-cookie': sessionCookie(session.token) });
}

async function uploadEvidence(request, env) {
  const auth = await requireCtv(request, env); requireCsrf(request, auth);
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) throw new DomainError('EVIDENCE_INVALID', 'Ảnh phải gửi bằng multipart/form-data.', 415);
  const form = await request.formData(); const photo = form.get('photo');
  if (!photo || typeof photo.arrayBuffer !== 'function') throw new DomainError('EVIDENCE_REQUIRED', 'Bắt buộc chụp ảnh bằng chứng.');
  const meta = validateEvidenceMeta(photo); const bytes = await photo.arrayBuffer();
  if (bytes.byteLength !== meta.sizeBytes) throw new DomainError('EVIDENCE_INVALID', 'Kích thước ảnh không hợp lệ.');
  const id = newId('ev'); const date = businessDateVn(); const key = `evidence/${date}/${auth.actor.id}/${id}`;
  const digest = await sha256(bytes);
  const latitude = form.get('latitude') === null || form.get('latitude') === '' ? null : Number(form.get('latitude'));
  const longitude = form.get('longitude') === null || form.get('longitude') === '' ? null : Number(form.get('longitude'));
  if ((latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) || (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))) {
    throw new DomainError('EVIDENCE_INVALID', 'Tọa độ ảnh không hợp lệ.');
  }
  await env.EVIDENCE.put(key, bytes, { httpMetadata: { contentType: meta.mimeType }, customMetadata: { collaboratorId: auth.actor.id, sha256: digest } });
  try {
    await run(env.DB, `INSERT INTO evidence_objects(id,r2_key,sha256,mime_type,size_bytes,captured_at_server,latitude,longitude,status,created_by_collaborator_id) VALUES(?,?,?,?,?,?,?,?,?,?)`, [id, key, digest, meta.mimeType, meta.sizeBytes, nowIso(), latitude, longitude, 'PENDING', auth.actor.id]);
  } catch (error) {
    await env.EVIDENCE.delete(key).catch(() => {}); throw error;
  }
  await audit(env.DB, request, auth.actor, 'EVIDENCE_UPLOAD', 'evidence', id, { size: meta.sizeBytes, mime: meta.mimeType });
  return json({ evidenceId: id, sha256: digest, capturedAt: nowIso() }, 201);
}

async function getEvidence(request, env, id) {
  await requireAdmin(request, env);
  const row = await one(env.DB, `SELECT * FROM evidence_objects WHERE id=?`, [id]);
  if (!row) throw new DomainError('VALIDATION_ERROR', 'Không tìm thấy ảnh.', 404);
  const object = await env.EVIDENCE.get(row.r2_key);
  if (!object) throw new DomainError('VALIDATION_ERROR', 'Ảnh không còn trong storage.', 404);
  return withSecurityHeaders(new Response(object.body, { headers: { 'content-type': row.mime_type, 'cache-control': 'private, no-store', 'content-disposition': `inline; filename="${id}"` } }));
}

async function customerPrecheck(request, env) {
  const auth = await requireCtv(request, env); requireCsrf(request, auth);
  const p = await bodyJson(request); const phone = normalizeVnPhone(p.phone); const productId = requiredString(p.productId, 'productId', 100);
  const product = await one(env.DB, `SELECT id,campaign_code,name FROM sample_products WHERE id=? AND status='ACTIVE'`, [productId]);
  if (!product) throw new DomainError('VALIDATION_ERROR', 'Sản phẩm không hợp lệ.');
  const claim = await one(env.DB, `SELECT id,distributed_at FROM sample_distributions WHERE phone_normalized=? AND campaign_code=? AND status='COMPLETED'`, [phone, product.campaign_code]);
  return json({ available: !claim, phoneMasked: maskPhone(phone), campaignCode: product.campaign_code, claimedAt: claim?.distributed_at || null });
}

function mapDistributionDbError(error) {
  const text = String(error?.message || error);
  if (text.includes('INSUFFICIENT_STOCK')) return new DomainError('INSUFFICIENT_STOCK', 'CTV không đủ mẫu để phát.', 409);
  if (text.includes('OTP_INVALID_STATE') || text.includes('otp_challenge_id')) return new DomainError('OTP_ALREADY_CONSUMED', 'OTP không còn hợp lệ.', 409);
  if (text.includes('EVIDENCE_INVALID_STATE') || text.includes('evidence_id')) return new DomainError('EVIDENCE_INVALID', 'Ảnh bằng chứng không còn hợp lệ.', 409);
  if (text.includes('phone_normalized') || text.includes('campaign_code')) return new DomainError('CUSTOMER_ALREADY_CLAIMED', 'Khách hàng đã nhận mẫu trong chiến dịch này.', 409);
  return error;
}

async function createDistribution(request, env) {
  const auth = await requireCtv(request, env); requireCsrf(request, auth);
  const idempotencyKey = validateIdempotencyKey(request.headers.get('idempotency-key'));
  const p = await bodyJson(request); const phone = normalizeVnPhone(p.phone); const quantity = positiveInt(p.quantity || 1, 'quantity');
  const productId = requiredString(p.productId, 'productId', 100); const otpChallengeId = requiredString(p.otpChallengeId, 'otpChallengeId', 100); const evidenceId = requiredString(p.evidenceId, 'evidenceId', 100);
  const fingerprint = await distributionFingerprint({ productId, phone, quantity, otpChallengeId, evidenceId });
  const prior = await one(env.DB, `SELECT * FROM sample_distributions WHERE collaborator_id=? AND idempotency_key=?`, [auth.actor.id, idempotencyKey]);
  if (prior) {
    if (prior.request_fingerprint !== fingerprint) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key đã được dùng cho nội dung khác.', 409);
    return json({ ...prior, idempotent: true });
  }
  const product = await one(env.DB, `SELECT * FROM sample_products WHERE id=? AND status='ACTIVE'`, [productId]);
  if (!product) throw new DomainError('VALIDATION_ERROR', 'Sản phẩm không hoạt động.');
  const otp = await one(env.DB, `SELECT * FROM otp_challenges WHERE id=? AND collaborator_id=? AND phone_normalized=? AND campaign_code=?`, [otpChallengeId, auth.actor.id, phone, product.campaign_code]);
  assertOtpUsable(otp);
  const evidence = await one(env.DB, `SELECT * FROM evidence_objects WHERE id=? AND created_by_collaborator_id=? AND status='PENDING'`, [evidenceId, auth.actor.id]);
  if (!evidence) throw new DomainError('EVIDENCE_REQUIRED', 'Ảnh bằng chứng hợp lệ là bắt buộc.');
  const customerId = newId('cus'); const customerName = requiredString(p.customerName, 'customerName', 150);
  await run(env.DB, `INSERT OR IGNORE INTO customers(id,name,phone_normalized,phone_masked,created_by_collaborator_id,created_at) VALUES(?,?,?,?,?,?)`, [customerId, customerName, phone, maskPhone(phone), auth.actor.id, nowIso()]);
  const customer = await one(env.DB, `SELECT * FROM customers WHERE phone_normalized=?`, [phone]);
  const id = newId('dist'); const distributedAt = nowIso();
  try {
    await run(env.DB,
      `INSERT INTO sample_distributions(id,collaborator_id,customer_id,product_id,campaign_code,phone_normalized,quantity,otp_challenge_id,evidence_id,distributed_at,status,idempotency_key,request_fingerprint)
       VALUES(?,?,?,?,?,?,?,?,?,?, 'COMPLETED', ?,?)`,
      [id, auth.actor.id, customer.id, product.id, product.campaign_code, phone, quantity, otpChallengeId, evidenceId, distributedAt, idempotencyKey, fingerprint]);
  } catch (error) { throw mapDistributionDbError(error); }
  await audit(env.DB, request, auth.actor, 'DISTRIBUTION_CREATE', 'distribution', id, { productId, quantity, phone: maskPhone(phone) });
  return json({ id, productId, campaignCode: product.campaign_code, quantity, phoneMasked: maskPhone(phone), distributedAt, idempotent: false }, 201);
}

async function ctvDistributions(request, env, url) {
  const auth = await requireCtv(request, env); const { limit, offset } = pageParams(url);
  return json(await all(env.DB,
    `SELECT d.id,d.product_id,p.sku,p.name product_name,d.quantity,d.phone_normalized,d.distributed_at,d.status
       FROM sample_distributions d JOIN sample_products p ON p.id=d.product_id
      WHERE d.collaborator_id=? ORDER BY d.distributed_at DESC LIMIT ? OFFSET ?`, [auth.actor.id, limit, offset])
    .then((rows) => rows.map(({ phone_normalized, ...r }) => ({ ...r, phone_masked: maskPhone(phone_normalized) }))));
}

async function reconciliationToday(request, env) {
  const auth = await requireCtv(request, env); const date = businessDateVn();
  const existing = await one(env.DB, `SELECT * FROM daily_reconciliations WHERE collaborator_id=? AND business_date=?`, [auth.actor.id, date]);
  const inventory = await inventoryRows(env.DB, auth.actor.id);
  const lines = inventory.map((r) => ({ productId: r.product_id, sku: r.sku, productName: r.product_name, assigned: Number(r.allocated) + Number(r.adjustments), distributed: Number(r.distributed), currentAvailable: Number(r.available) }));
  return json({ businessDate: date, status: existing?.status || 'OPEN', reconciliationId: existing?.id || null, lines });
}

async function submitReconciliation(request, env) {
  const auth = await requireCtv(request, env); requireCsrf(request, auth); const p = await bodyJson(request);
  if (!Array.isArray(p.lines) || p.lines.length === 0 || p.lines.length > 100) throw new DomainError('VALIDATION_ERROR', 'Dòng đối soát không hợp lệ.');
  const date = businessDateVn();
  if (await one(env.DB, `SELECT id FROM daily_reconciliations WHERE collaborator_id=? AND business_date=?`, [auth.actor.id, date])) throw new DomainError('RECONCILIATION_ALREADY_SUBMITTED', 'Hôm nay đã gửi đối soát.', 409);
  const inventory = await inventoryRows(env.DB, auth.actor.id); const byProduct = new Map(inventory.map((r) => [r.product_id, r]));
  const normalized = [];
  for (const incoming of p.lines) {
    const server = byProduct.get(incoming.productId); if (!server) throw new DomainError('VALIDATION_ERROR', 'Sản phẩm đối soát không thuộc kho CTV.');
    normalized.push(normalizeReconciliationLine({ productId: incoming.productId, assigned: Number(server.allocated) + Number(server.adjustments), distributed: Number(server.distributed), returned: incoming.returned || 0, damaged: incoming.damaged || 0, closing: incoming.closing, reason: incoming.reason }));
  }
  const recId = newId('rec'); const submittedAt = nowIso();
  const statements = [env.DB.prepare(`INSERT INTO daily_reconciliations(id,collaborator_id,business_date,status,submitted_at,note) VALUES(?,?,?,'SUBMITTED',?,?)`).bind(recId, auth.actor.id, date, submittedAt, optionalString(p.note, 500))];
  for (const line of normalized) statements.push(env.DB.prepare(`INSERT INTO daily_reconciliation_lines(id,reconciliation_id,product_id,assigned_qty,distributed_qty,returned_qty,damaged_qty,closing_qty,variance_qty,reason) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(newId('recl'), recId, line.productId, line.assigned, line.distributed, line.returned, line.damaged, line.closing, line.variance, line.reason));
  await env.DB.batch(statements);
  await audit(env.DB, request, auth.actor, 'RECONCILIATION_SUBMIT', 'reconciliation', recId, { date, variance: normalized.reduce((s, x) => s + Math.abs(x.variance), 0) });
  return json({ id: recId, businessDate: date, status: 'SUBMITTED', lines: normalized }, 201);
}

async function listAdminCustomers(request, env, url) {
  await requireAdmin(request, env); const { limit, offset, q } = pageParams(url); const like = `%${q}%`;
  const rows = await all(env.DB, `SELECT c.id,c.name,c.phone_normalized,c.phone_masked,c.created_at,co.code collaborator_code FROM customers c JOIN collaborators co ON co.id=c.created_by_collaborator_id WHERE (?='' OR c.name LIKE ? OR c.phone_normalized LIKE ?) ORDER BY c.created_at DESC LIMIT ? OFFSET ?`, [q, like, like, limit, offset]);
  return json(rows.map(({ phone_normalized, ...r }) => r));
}

async function listAdminDistributions(request, env, url) {
  await requireAdmin(request, env); const { limit, offset, q } = pageParams(url); const like = `%${q}%`;
  const rows = await all(env.DB,
    `SELECT d.id,d.quantity,d.distributed_at,d.status,d.phone_normalized,c.name customer_name,co.code collaborator_code,p.sku,p.name product_name,d.evidence_id
       FROM sample_distributions d JOIN customers c ON c.id=d.customer_id JOIN collaborators co ON co.id=d.collaborator_id JOIN sample_products p ON p.id=d.product_id
      WHERE (?='' OR c.name LIKE ? OR co.code LIKE ? OR p.sku LIKE ? OR d.phone_normalized LIKE ?)
      ORDER BY d.distributed_at DESC LIMIT ? OFFSET ?`, [q, like, like, like, like, limit, offset]);
  return json(rows.map(({ phone_normalized, ...r }) => ({ ...r, phone_masked: maskPhone(phone_normalized) })));
}

async function listReconciliations(request, env, url) {
  await requireAdmin(request, env); const { limit, offset } = pageParams(url);
  return json(await all(env.DB,
    `SELECT r.id,r.business_date,r.status,r.submitted_at,r.approved_at,r.note,c.code collaborator_code,c.name collaborator_name,
            COALESCE(SUM(ABS(l.variance_qty)),0) absolute_variance
       FROM daily_reconciliations r JOIN collaborators c ON c.id=r.collaborator_id LEFT JOIN daily_reconciliation_lines l ON l.reconciliation_id=r.id
      GROUP BY r.id ORDER BY r.submitted_at DESC LIMIT ? OFFSET ?`, [limit, offset]));
}

async function reviewReconciliation(request, env, id, action) {
  const auth = await requireAdmin(request, env); requireCsrf(request, auth);
  const row = await one(env.DB, `SELECT * FROM daily_reconciliations WHERE id=?`, [id]); if (!row) throw new DomainError('VALIDATION_ERROR', 'Không tìm thấy đối soát.', 404);
  if (row.status !== 'SUBMITTED') throw new DomainError('VALIDATION_ERROR', 'Đối soát đã được xử lý.', 409);
  const p = await bodyJson(request).catch(() => ({})); const status = action === 'approve' ? 'APPROVED' : 'REJECTED';
  await run(env.DB, `UPDATE daily_reconciliations SET status=?,approved_at=?,approved_by=?,note=COALESCE(?,note) WHERE id=? AND status='SUBMITTED'`, [status, nowIso(), auth.actor.id, optionalString(p.note, 500), id]);
  await audit(env.DB, request, auth.actor, `RECONCILIATION_${status}`, 'reconciliation', id, {});
  return json({ id, status });
}

async function dashboard(request, env) {
  await requireAdmin(request, env); const date = businessDateVn(); const start = `${date}T00:00:00+07:00`; const end = `${date}T23:59:59+07:00`;
  const active = await one(env.DB, `SELECT COUNT(*) count FROM collaborators WHERE status='ACTIVE'`);
  const allocated = await one(env.DB, `SELECT COALESCE(SUM(quantity),0) value FROM inventory_allocations WHERE status='ACTIVE'`);
  const distributed = await one(env.DB, `SELECT COALESCE(SUM(quantity),0) value FROM sample_distributions WHERE status='COMPLETED'`);
  const customers = await one(env.DB, `SELECT COUNT(*) count FROM customers`);
  const otpFailures = await one(env.DB, `SELECT COALESCE(SUM(attempt_count),0) value FROM otp_challenges WHERE created_at BETWEEN ? AND ?`, [start, end]);
  const unresolved = await one(env.DB, `SELECT COUNT(DISTINCT r.id) count FROM daily_reconciliations r JOIN daily_reconciliation_lines l ON l.reconciliation_id=r.id WHERE r.status='SUBMITTED' AND l.variance_qty!=0`);
  const top = await all(env.DB, `SELECT c.code,c.name,COALESCE(SUM(d.quantity),0) distributed FROM collaborators c LEFT JOIN sample_distributions d ON d.collaborator_id=c.id AND d.status='COMPLETED' GROUP BY c.id ORDER BY distributed DESC LIMIT 10`);
  const trend = await all(env.DB, `SELECT substr(distributed_at,1,10) day,SUM(quantity) distributed FROM sample_distributions WHERE status='COMPLETED' GROUP BY substr(distributed_at,1,10) ORDER BY day DESC LIMIT 14`);
  const allocatedN = Number(allocated?.value || 0), distributedN = Number(distributed?.value || 0);
  return json({ activeCtv: Number(active?.count || 0), allocated: allocatedN, distributed: distributedN, remaining: allocatedN - distributedN, verifiedCustomers: Number(customers?.count || 0), otpFailures: Number(otpFailures?.value || 0), unresolvedReconciliations: Number(unresolved?.count || 0), topCtv: top, trend: trend.reverse() });
}

async function listAudit(request, env, url) {
  await requireAdmin(request, env); const { limit, offset } = pageParams(url);
  return json(await all(env.DB, `SELECT id,actor_type,actor_id,action,entity_type,entity_id,metadata_json,created_at FROM audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?`, [limit, offset]));
}

async function report(request, env, kind) {
  await requireAdmin(request, env);
  if (kind === 'collaborators') {
    const rows = await all(env.DB, `SELECT code,name,phone,area,team,status,created_at FROM collaborators ORDER BY code`);
    return csvResponse('maumoi-collaborators.csv', rows.map((r) => ({ ...r, phone: maskPhone(r.phone) })), ['code','name','phone','area','team','status','created_at']);
  }
  if (kind === 'customers') {
    const rows = await all(env.DB, `SELECT c.name,c.phone_masked,co.code collaborator_code,c.created_at FROM customers c JOIN collaborators co ON co.id=c.created_by_collaborator_id ORDER BY c.created_at DESC`);
    return csvResponse('maumoi-customers.csv', rows, ['name','phone_masked','collaborator_code','created_at']);
  }
  if (kind === 'distributions') {
    const rows = await all(env.DB, `SELECT d.id,co.code collaborator_code,c.name customer_name,c.phone_masked,p.sku,p.name product_name,d.campaign_code,d.quantity,d.distributed_at,d.status FROM sample_distributions d JOIN collaborators co ON co.id=d.collaborator_id JOIN customers c ON c.id=d.customer_id JOIN sample_products p ON p.id=d.product_id ORDER BY d.distributed_at DESC`);
    return csvResponse('maumoi-distributions.csv', rows, ['id','collaborator_code','customer_name','phone_masked','sku','product_name','campaign_code','quantity','distributed_at','status']);
  }
  if (kind === 'inventory') {
    return csvResponse('maumoi-inventory.csv', await inventoryRows(env.DB), ['collaborator_code','collaborator_name','sku','product_name','campaign_code','allocated','adjustments','distributed','available']);
  }
  if (kind === 'reconciliation') {
    const rows = await all(env.DB, `SELECT r.business_date,c.code collaborator_code,p.sku,l.assigned_qty,l.distributed_qty,l.returned_qty,l.damaged_qty,l.closing_qty,l.variance_qty,r.status,r.submitted_at FROM daily_reconciliations r JOIN collaborators c ON c.id=r.collaborator_id JOIN daily_reconciliation_lines l ON l.reconciliation_id=r.id JOIN sample_products p ON p.id=l.product_id ORDER BY r.business_date DESC,c.code,p.sku`);
    return csvResponse('maumoi-reconciliation.csv', rows, ['business_date','collaborator_code','sku','assigned_qty','distributed_qty','returned_qty','damaged_qty','closing_qty','variance_qty','status','submitted_at']);
  }
  throw new DomainError('VALIDATION_ERROR', 'Loại report không hợp lệ.', 404);
}

export async function handleApi(request, env, url) {
  const { pathname } = url; const method = request.method.toUpperCase();
  if (method === 'GET' && pathname === '/api/health') {
    const db = await one(env.DB, `SELECT 1 ok`).catch(() => null);
    return json({ status: db?.ok === 1 ? 'ok' : 'degraded', service: 'maumoi', version: env.APP_VERSION || 'dev', timestamp: nowIso() }, db?.ok === 1 ? 200 : 503);
  }
  if (method === 'GET' && pathname === '/api/version') return json({ service: 'maumoi', version: env.APP_VERSION || 'dev' });
  if (method === 'POST' && pathname === '/api/admin/bootstrap') return adminBootstrap(request, env);
  if (method === 'POST' && pathname === '/api/admin/auth/login') return adminLogin(request, env);
  if (method === 'POST' && pathname === '/api/ctv/auth/dev') return ctvDevLogin(request, env);
  if (method === 'POST' && pathname === '/api/ctv/auth/zalo') return ctvZaloLogin(request, env);
  if (method === 'POST' && pathname === '/api/admin/auth/logout') return adminLogout(request, env);
  if (method === 'POST' && pathname === '/api/ctv/auth/logout') return ctvLogout(request, env);
  if (method === 'GET' && pathname === '/api/admin/auth/me') return json(publicActor(await requireAdmin(request, env)));
  if (method === 'GET' && pathname === '/api/ctv/me') return json(publicActor(await requireCtv(request, env)));

  if (pathname === '/api/admin/collaborators' && method === 'GET') return listCollaborators(request, env, url);
  if (pathname === '/api/admin/collaborators' && method === 'POST') return createCollaborator(request, env);
  const ctvPatch = pathname.match(/^\/api\/admin\/collaborators\/([^/]+)$/); if (ctvPatch && method === 'PATCH') return patchCollaborator(request, env, ctvPatch[1]);
  if (pathname === '/api/admin/collaborators/import' && method === 'POST') return importCollaborators(request, env);

  if (pathname === '/api/admin/products' && method === 'GET') return listProducts(request, env, url);
  if (pathname === '/api/admin/products' && method === 'POST') return createProduct(request, env);
  const productPatch = pathname.match(/^\/api\/admin\/products\/([^/]+)$/); if (productPatch && method === 'PATCH') return patchProduct(request, env, productPatch[1]);
  if (pathname === '/api/admin/allocations' && method === 'POST') return createAllocation(request, env);
  if (pathname === '/api/admin/allocations/import' && method === 'POST') return importAllocations(request, env);
  if (pathname === '/api/admin/inventory' && method === 'GET') { await requireAdmin(request, env); return json(await inventoryRows(env.DB)); }
  if (pathname === '/api/ctv/inventory' && method === 'GET') { const auth = await requireCtv(request, env); return json(await inventoryRows(env.DB, auth.actor.id)); }

  if (pathname === '/api/otp/request' && method === 'POST') { const auth = await requireCtv(request, env); requireCsrf(request, auth); return json(await requestOtp(env, auth.actor, await bodyJson(request)), 201); }
  if (pathname === '/api/otp/verify' && method === 'POST') { const auth = await requireCtv(request, env); requireCsrf(request, auth); return json(await verifyOtp(env, auth.actor, await bodyJson(request))); }
  if (pathname === '/api/evidence' && method === 'POST') return uploadEvidence(request, env);
  const evidenceGet = pathname.match(/^\/api\/admin\/evidence\/([^/]+)$/); if (evidenceGet && method === 'GET') return getEvidence(request, env, evidenceGet[1]);

  if (pathname === '/api/ctv/customers/precheck' && method === 'POST') return customerPrecheck(request, env);
  if (pathname === '/api/ctv/distributions' && method === 'POST') return createDistribution(request, env);
  if (pathname === '/api/ctv/distributions' && method === 'GET') return ctvDistributions(request, env, url);
  if (pathname === '/api/admin/customers' && method === 'GET') return listAdminCustomers(request, env, url);
  if (pathname === '/api/admin/distributions' && method === 'GET') return listAdminDistributions(request, env, url);

  if (pathname === '/api/ctv/reconciliation/today' && method === 'GET') return reconciliationToday(request, env);
  if (pathname === '/api/ctv/reconciliation/submit' && method === 'POST') return submitReconciliation(request, env);
  if (pathname === '/api/admin/reconciliations' && method === 'GET') return listReconciliations(request, env, url);
  const recAction = pathname.match(/^\/api\/admin\/reconciliations\/([^/]+)\/(approve|reject)$/); if (recAction && method === 'POST') return reviewReconciliation(request, env, recAction[1], recAction[2]);

  if (pathname === '/api/admin/dashboard' && method === 'GET') return dashboard(request, env);
  if (pathname === '/api/admin/audit' && method === 'GET') return listAudit(request, env, url);
  const reportMatch = pathname.match(/^\/api\/admin\/reports\/(collaborators|customers|distributions|inventory|reconciliation)\.csv$/); if (reportMatch && method === 'GET') return report(request, env, reportMatch[1]);

  throw new DomainError('VALIDATION_ERROR', 'API endpoint không tồn tại.', 404);
}
