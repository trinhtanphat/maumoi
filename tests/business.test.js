import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertOtpUsable,
  validateEvidenceMeta,
  distributionFingerprint,
  normalizeReconciliationLine,
  devFeatureEnabled,
} from '../src/shared/business.js';

test('assertOtpUsable accepts verified unconsumed non-expired challenge', () => {
  const now = new Date('2026-08-20T10:00:00Z');
  assert.doesNotThrow(() => assertOtpUsable({ verified_at: '2026-08-20T09:59:00Z', consumed_at: null, expires_at: '2026-08-20T10:02:00Z' }, now));
});

test('assertOtpUsable rejects expired and consumed challenges', () => {
  assert.throws(() => assertOtpUsable({ verified_at: 'x', consumed_at: null, expires_at: '2026-08-20T09:59:00Z' }, new Date('2026-08-20T10:00:00Z')), /OTP_EXPIRED/);
  assert.throws(() => assertOtpUsable({ verified_at: 'x', consumed_at: '2026-08-20T09:58:00Z', expires_at: '2026-08-20T10:02:00Z' }, new Date('2026-08-20T10:00:00Z')), /OTP_ALREADY_CONSUMED/);
});

test('validateEvidenceMeta accepts camera image formats and rejects oversized/non-image files', () => {
  assert.deepEqual(validateEvidenceMeta({ type: 'image/jpeg', size: 1024 }), { mimeType: 'image/jpeg', sizeBytes: 1024 });
  assert.throws(() => validateEvidenceMeta({ type: 'application/pdf', size: 100 }), /EVIDENCE_INVALID/);
  assert.throws(() => validateEvidenceMeta({ type: 'image/png', size: 9 * 1024 * 1024 }), /EVIDENCE_INVALID/);
});

test('distributionFingerprint is stable for same business intent and changes with quantity', async () => {
  const a = await distributionFingerprint({ productId: 'p1', phone: '84912345678', quantity: 1, otpChallengeId: 'o1', evidenceId: 'e1' });
  const b = await distributionFingerprint({ evidenceId: 'e1', otpChallengeId: 'o1', quantity: 1, phone: '84912345678', productId: 'p1' });
  const c = await distributionFingerprint({ productId: 'p1', phone: '84912345678', quantity: 2, otpChallengeId: 'o1', evidenceId: 'e1' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('normalizeReconciliationLine computes variance and validates non-negative quantities', () => {
  assert.deepEqual(normalizeReconciliationLine({ productId: 'p1', assigned: 10, distributed: 4, returned: 1, damaged: 1, closing: 4, reason: '' }), {
    productId: 'p1', assigned: 10, distributed: 4, returned: 1, damaged: 1, closing: 4, variance: 0, reason: null,
  });
  assert.throws(() => normalizeReconciliationLine({ productId: 'p1', assigned: 10, distributed: 4, returned: -1, damaged: 0, closing: 7 }), /VALIDATION_ERROR/);
});

test('devFeatureEnabled requires an explicit true string', () => {
  assert.equal(devFeatureEnabled('true'), true);
  assert.equal(devFeatureEnabled(true), true);
  assert.equal(devFeatureEnabled('1'), false);
  assert.equal(devFeatureEnabled(undefined), false);
});
