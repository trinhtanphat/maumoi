import { newId, nowIso } from '../shared/core.js';
import { hashToken, sha256 } from '../shared/crypto.js';

export async function one(db, sql, params = []) {
  return db.prepare(sql).bind(...params).first();
}

export async function all(db, sql, params = []) {
  const result = await db.prepare(sql).bind(...params).all();
  return result.results ?? [];
}

export async function run(db, sql, params = []) {
  return db.prepare(sql).bind(...params).run();
}

export async function audit(db, request, actor, action, entityType, entityId = null, metadata = {}) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  const ipHash = ip ? await sha256(ip) : null;
  await run(db,
    `INSERT INTO audit_logs(id, actor_type, actor_id, action, entity_type, entity_id, metadata_json, ip_hash, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [newId('audit'), actor?.type || 'SYSTEM', actor?.id || null, action, entityType, entityId, JSON.stringify(metadata), ipHash, nowIso()],
  );
}

export async function createSession(db, actorType, actorId, ttlSeconds = 43200) {
  const token = `${newId('s')}${newId()}`;
  const csrf = newId('csrf');
  const tokenHash = await hashToken(token);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await run(db,
    `INSERT INTO sessions(id, actor_type, actor_id, token_hash, csrf_token, expires_at, created_at)
     VALUES(?,?,?,?,?,?,?)`,
    [newId('sess'), actorType, actorId, tokenHash, csrf, expiresAt, createdAt],
  );
  return { token, csrf, expiresAt };
}

export async function loadSession(db, token) {
  const tokenHash = await hashToken(token);
  return one(db,
    `SELECT id, actor_type, actor_id, csrf_token, expires_at
       FROM sessions WHERE token_hash=? AND expires_at>? LIMIT 1`,
    [tokenHash, nowIso()],
  );
}

export async function deleteSession(db, token) {
  if (!token) return;
  const tokenHash = await hashToken(token);
  await run(db, `DELETE FROM sessions WHERE token_hash=?`, [tokenHash]);
}

export async function deleteActorSessions(db, actorType, actorId) {
  await run(db, `DELETE FROM sessions WHERE actor_type=? AND actor_id=?`, [actorType, actorId]);
}

export async function inventoryRows(db, collaboratorId = null) {
  const where = collaboratorId ? 'WHERE c.id = ?' : 'WHERE 1=1';
  const params = collaboratorId ? [collaboratorId] : [];
  return all(db,
    `SELECT c.id collaborator_id, c.code collaborator_code, c.name collaborator_name,
            p.id product_id, p.sku, p.name product_name, p.campaign_code,
            COALESCE(a.allocated,0) allocated,
            COALESCE(j.adjustments,0) adjustments,
            COALESCE(d.distributed,0) distributed,
            COALESCE(a.allocated,0)+COALESCE(j.adjustments,0)-COALESCE(d.distributed,0) available
       FROM collaborators c
       CROSS JOIN sample_products p
       LEFT JOIN (
         SELECT collaborator_id, product_id, SUM(quantity) allocated
           FROM inventory_allocations WHERE status='ACTIVE' GROUP BY collaborator_id, product_id
       ) a ON a.collaborator_id=c.id AND a.product_id=p.id
       LEFT JOIN (
         SELECT collaborator_id, product_id, SUM(quantity_delta) adjustments
           FROM inventory_adjustments GROUP BY collaborator_id, product_id
       ) j ON j.collaborator_id=c.id AND j.product_id=p.id
       LEFT JOIN (
         SELECT collaborator_id, product_id, SUM(quantity) distributed
           FROM sample_distributions WHERE status='COMPLETED' GROUP BY collaborator_id, product_id
       ) d ON d.collaborator_id=c.id AND d.product_id=p.id
       ${where}
       AND p.status='ACTIVE'
       AND c.status='ACTIVE'
       AND (COALESCE(a.allocated,0) != 0 OR COALESCE(j.adjustments,0) != 0 OR COALESCE(d.distributed,0) != 0)
       ORDER BY c.code, p.sku`,
    params,
  );
}
