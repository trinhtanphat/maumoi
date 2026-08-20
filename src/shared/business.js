import { DomainError, nonNegativeInt, positiveInt, reconciliationVariance, requiredString } from './core.js';
import { sha256 } from './crypto.js';

const EVIDENCE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

export function assertOtpUsable(challenge, now = new Date()) {
  if (!challenge?.verified_at) throw new DomainError('OTP_INVALID', 'OTP chưa được xác thực.');
  if (challenge.consumed_at) throw new DomainError('OTP_ALREADY_CONSUMED', 'OTP đã được sử dụng.');
  if (new Date(challenge.expires_at).getTime() <= now.getTime()) throw new DomainError('OTP_EXPIRED', 'OTP đã hết hạn.');
  return challenge;
}

export function validateEvidenceMeta(file) {
  const mimeType = String(file?.type ?? '').toLowerCase();
  const sizeBytes = Number(file?.size ?? 0);
  if (!EVIDENCE_TYPES.has(mimeType) || !Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_EVIDENCE_BYTES) {
    throw new DomainError('EVIDENCE_INVALID', 'Ảnh bằng chứng phải là JPEG/PNG/WebP và không quá 8 MB.');
  }
  return { mimeType, sizeBytes };
}

export async function distributionFingerprint(input) {
  const canonical = JSON.stringify({
    productId: requiredString(input.productId, 'productId', 80),
    phone: requiredString(input.phone, 'phone', 20),
    quantity: positiveInt(input.quantity, 'quantity'),
    otpChallengeId: requiredString(input.otpChallengeId, 'otpChallengeId', 80),
    evidenceId: requiredString(input.evidenceId, 'evidenceId', 80),
  });
  return sha256(canonical);
}

export function normalizeReconciliationLine(input) {
  const line = {
    productId: requiredString(input.productId, 'productId', 80),
    assigned: nonNegativeInt(input.assigned, 'assigned'),
    distributed: nonNegativeInt(input.distributed, 'distributed'),
    returned: nonNegativeInt(input.returned, 'returned'),
    damaged: nonNegativeInt(input.damaged, 'damaged'),
    closing: nonNegativeInt(input.closing, 'closing'),
    reason: input.reason ? String(input.reason).trim().slice(0, 500) || null : null,
  };
  return { ...line, variance: reconciliationVariance(line) };
}

export function devFeatureEnabled(value) {
  return value === true || value === 'true';
}
