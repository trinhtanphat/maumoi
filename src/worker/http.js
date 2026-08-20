export function json(data, status = 200, headers = {}) {
  return withSecurityHeaders(new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  }));
}

export function fail(status, code, message, headers = {}) {
  return withSecurityHeaders(new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  }));
}

export function parseCookies(header = '') {
  const result = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(part.slice(index + 1).trim()); }
    catch { result[key] = part.slice(index + 1).trim(); }
  }
  return result;
}

export function sessionCookie(token, maxAge = 43200) {
  return `maumoi_session=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie() {
  return 'maumoi_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict';
}

export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('permissions-policy', 'camera=(self), geolocation=(self), microphone=()');
  headers.set('x-frame-options', 'DENY');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('content-security-policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function readJson(request, limit = 256 * 1024) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > limit) throw Object.assign(new Error('BODY_TOO_LARGE'), { status: 413, code: 'VALIDATION_ERROR', publicMessage: 'Dữ liệu gửi lên quá lớn.' });
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw Object.assign(new Error('BAD_CONTENT_TYPE'), { status: 415, code: 'VALIDATION_ERROR', publicMessage: 'Content-Type phải là application/json.' });
  }
  return request.json();
}
