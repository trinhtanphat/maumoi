import { DomainError, nowIso } from '../shared/core.js';
import { fail, withSecurityHeaders } from './http.js';
import { handleApi } from './routes.js';
import { WEB_CSS, WEB_HTML, WEB_JS } from '../web/assets.js';

function staticResponse(body, contentType, cache = 'no-store') {
  return withSecurityHeaders(new Response(body, { headers: { 'content-type': contentType, 'cache-control': cache } }));
}

function mapUnexpected(error) {
  const text = String(error?.message || error || '');
  if (text.includes('UNIQUE constraint failed')) return new DomainError('VALIDATION_ERROR', 'Dữ liệu bị trùng hoặc đã tồn tại.', 409);
  if (text.includes('FOREIGN KEY constraint failed')) return new DomainError('VALIDATION_ERROR', 'Dữ liệu liên quan không hợp lệ.', 409);
  if (text.includes('CHECK constraint failed')) return new DomainError('VALIDATION_ERROR', 'Dữ liệu không thỏa điều kiện nghiệp vụ.', 400);
  return error;
}

async function fetchHandler(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return withSecurityHeaders(new Response(null, { status: 204 }));
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'VALIDATION_ERROR', 'Method không được hỗ trợ.');
    if (url.pathname === '/app.js') return staticResponse(WEB_JS, 'text/javascript; charset=utf-8', 'public, max-age=300');
    if (url.pathname === '/app.css') return staticResponse(WEB_CSS, 'text/css; charset=utf-8', 'public, max-age=300');
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
    return staticResponse(request.method === 'HEAD' ? null : WEB_HTML, 'text/html; charset=utf-8');
  } catch (raw) {
    const error = mapUnexpected(raw);
    const requestId = request.headers.get('cf-ray') || crypto.randomUUID();
    if (error instanceof DomainError || error?.code && error?.publicMessage) {
      return fail(error.status || 400, error.code || 'VALIDATION_ERROR', error.publicMessage || 'Yêu cầu không hợp lệ.', { 'x-request-id': requestId });
    }
    console.error(JSON.stringify({ level: 'error', service: 'maumoi', requestId, method: request.method, path: url.pathname, at: nowIso(), error: String(error?.message || error).slice(0, 500) }));
    return fail(500, 'INTERNAL_ERROR', 'Hệ thống đang gặp lỗi. Vui lòng thử lại.', { 'x-request-id': requestId });
  }
}

async function scheduledHandler(_event, env, ctx) {
  const cutoffSessions = nowIso();
  const cutoffOtp = new Date(Date.now() - 7 * 86400000).toISOString();
  const cutoffEvidence = new Date(Date.now() - 24 * 3600000).toISOString();
  ctx.waitUntil(env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(cutoffSessions),
    env.DB.prepare(`DELETE FROM otp_challenges WHERE created_at < ? AND consumed_at IS NOT NULL`).bind(cutoffOtp),
    env.DB.prepare(`UPDATE evidence_objects SET status='ORPHANED' WHERE status='PENDING' AND captured_at_server < ?`).bind(cutoffEvidence),
  ]));
}

export default { fetch: fetchHandler, scheduled: scheduledHandler };
