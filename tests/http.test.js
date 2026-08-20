import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, hashToken, hmacOtp } from '../src/shared/crypto.js';
import { json, fail, parseCookies, sessionCookie, withSecurityHeaders } from '../src/worker/http.js';

test('password hashing verifies only the correct password', async () => {
  const encoded = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', encoded), true);
  assert.equal(await verifyPassword('wrong', encoded), false);
});

test('token hash is deterministic and non-plaintext', async () => {
  const first = await hashToken('secret-token');
  const second = await hashToken('secret-token');
  assert.equal(first, second);
  assert.notEqual(first, 'secret-token');
});

test('OTP HMAC is stable per secret and challenge', async () => {
  assert.equal(await hmacOtp('123456', 'secret', 'challenge'), await hmacOtp('123456', 'secret', 'challenge'));
  assert.notEqual(await hmacOtp('123456', 'secret', 'challenge'), await hmacOtp('123457', 'secret', 'challenge'));
});

test('HTTP helpers produce stable success and error envelopes', async () => {
  const ok = json({ hello: 'world' });
  assert.deepEqual(await ok.json(), { ok: true, data: { hello: 'world' } });
  const bad = fail(400, 'VALIDATION_ERROR', 'Sai du lieu');
  assert.deepEqual(await bad.json(), { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Sai du lieu' } });
});

test('parseCookies decodes cookie pairs', () => {
  assert.deepEqual(parseCookies('a=1; maumoi_session=abc%20123'), { a: '1', maumoi_session: 'abc 123' });
});

test('session cookie is HttpOnly Secure SameSite Strict', () => {
  const cookie = sessionCookie('abc');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
});

test('security headers include CSP, nosniff and restrictive permissions policy', () => {
  const response = withSecurityHeaders(new Response('ok'));
  assert.ok(response.headers.get('content-security-policy'));
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('permissions-policy'), /camera=\(self\)/);
});
