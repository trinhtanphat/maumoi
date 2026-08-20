import { DomainError, newId } from '../shared/core.js';
import { parseCookies } from './http.js';
import { createSession, deleteSession, loadSession, one } from './db.js';

function unauthorized(message = 'Bạn cần đăng nhập.') {
  return new DomainError('UNAUTHORIZED', message, 401);
}

export async function getAuth(request, env) {
  const token = parseCookies(request.headers.get('cookie') || '').maumoi_session;
  if (!token) return null;
  const session = await loadSession(env.DB, token);
  if (!session) return null;
  if (session.actor_type === 'ADMIN') {
    const actor = await one(env.DB, `SELECT id,email,name,status FROM admins WHERE id=?`, [session.actor_id]);
    if (!actor || actor.status !== 'ACTIVE') return null;
    return { token, session, actor: { ...actor, type: 'ADMIN' } };
  }
  if (session.actor_type === 'CTV') {
    const actor = await one(env.DB, `SELECT id,code,name,phone,area,team,status,zalo_user_id FROM collaborators WHERE id=?`, [session.actor_id]);
    if (!actor || actor.status !== 'ACTIVE') return null;
    return { token, session, actor: { ...actor, type: 'CTV' } };
  }
  return null;
}

export async function requireAdmin(request, env) {
  const auth = await getAuth(request, env);
  if (!auth) throw unauthorized();
  if (auth.actor.type !== 'ADMIN') throw new DomainError('FORBIDDEN', 'Chỉ Admin được phép thực hiện thao tác này.', 403);
  return auth;
}

export async function requireCtv(request, env) {
  const auth = await getAuth(request, env);
  if (!auth) throw unauthorized();
  if (auth.actor.type !== 'CTV') throw new DomainError('FORBIDDEN', 'Chỉ CTV được phép thực hiện thao tác này.', 403);
  return auth;
}

export function requireCsrf(request, auth) {
  const method = request.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return;
  const supplied = request.headers.get('x-csrf-token');
  if (!supplied || supplied !== auth.session.csrf_token) throw new DomainError('FORBIDDEN', 'CSRF token không hợp lệ.', 403);
}

export async function createActorSession(env, actorType, actorId) {
  return createSession(env.DB, actorType, actorId);
}

export async function destroySession(request, env) {
  const token = parseCookies(request.headers.get('cookie') || '').maumoi_session;
  await deleteSession(env.DB, token);
}

export function publicActor(auth) {
  if (auth.actor.type === 'ADMIN') return { id: auth.actor.id, type: 'ADMIN', email: auth.actor.email, name: auth.actor.name, csrfToken: auth.session.csrf_token };
  return { id: auth.actor.id, type: 'CTV', code: auth.actor.code, name: auth.actor.name, area: auth.actor.area, team: auth.actor.team, csrfToken: auth.session.csrf_token };
}

export function freshCsrf() {
  return newId('csrf');
}
