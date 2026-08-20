import { DomainError, newId, normalizeVnPhone, nowIso, randomDigits, requiredString } from '../shared/core.js';
import { devFeatureEnabled } from '../shared/business.js';
import { hmacOtp, secureEqual } from '../shared/crypto.js';
import { one, run } from './db.js';

const TTL_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

async function sendViaZalo(env, { phone, otp, challengeId }) {
  if (!env.ZALO_ZBS_ENDPOINT || !env.ZALO_OA_ACCESS_TOKEN || !env.ZALO_ZBS_TEMPLATE_ID) {
    throw new DomainError('CONFIGURATION_ERROR', 'Zalo ZBS chưa được cấu hình đầy đủ.', 503);
  }
  const response = await fetch(env.ZALO_ZBS_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'access_token': env.ZALO_OA_ACCESS_TOKEN },
    body: JSON.stringify({ phone, template_id: env.ZALO_ZBS_TEMPLATE_ID, template_data: { otp, challenge_id: challengeId } }),
  });
  if (!response.ok) throw new DomainError('CONFIGURATION_ERROR', 'Không gửi được OTP qua Zalo.', 503);
  const body = await response.json().catch(() => ({}));
  return { providerMessageId: body?.data?.message_id || body?.message_id || null };
}

async function sendOtp(env, input) {
  const provider = String(env.OTP_PROVIDER || 'zalo').toLowerCase();
  if (provider === 'dev') {
    if (!devFeatureEnabled(env.ALLOW_DEV_OTP)) throw new DomainError('CONFIGURATION_ERROR', 'Dev OTP đang bị tắt.', 503);
    return { provider: 'dev', providerMessageId: null, devOtp: input.otp };
  }
  if (provider === 'zalo') return { provider: 'zalo', ...(await sendViaZalo(env, input)) };
  throw new DomainError('CONFIGURATION_ERROR', 'OTP provider không hợp lệ.', 503);
}

export async function requestOtp(env, actor, payload) {
  if (!env.OTP_HASH_SECRET) throw new DomainError('CONFIGURATION_ERROR', 'OTP hash secret chưa cấu hình.', 503);
  const phone = normalizeVnPhone(payload.phone);
  const campaignCode = requiredString(payload.campaignCode, 'campaignCode', 80);
  const latest = await one(env.DB,
    `SELECT created_at FROM otp_challenges WHERE collaborator_id=? AND phone_normalized=? AND campaign_code=? ORDER BY created_at DESC LIMIT 1`,
    [actor.id, phone, campaignCode],
  );
  if (latest && Date.now() - new Date(latest.created_at).getTime() < COOLDOWN_MS) {
    throw new DomainError('RATE_LIMITED', 'Vui lòng chờ 60 giây trước khi gửi lại OTP.', 429);
  }
  const id = newId('otp');
  const otp = randomDigits(6);
  const otpHash = await hmacOtp(otp, env.OTP_HASH_SECRET, id);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  const sent = await sendOtp(env, { phone, otp, challengeId: id });
  await run(env.DB,
    `INSERT INTO otp_challenges(id,phone_normalized,collaborator_id,campaign_code,provider,provider_message_id,otp_hash,attempt_count,expires_at,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [id, phone, actor.id, campaignCode, sent.provider, sent.providerMessageId, otpHash, 0, expiresAt, createdAt],
  );
  const data = { challengeId: id, expiresAt, resendAfterSeconds: 60 };
  if (sent.provider === 'dev' && devFeatureEnabled(env.ALLOW_DEV_OTP)) data.devOtp = sent.devOtp;
  return data;
}

export async function verifyOtp(env, actor, payload) {
  if (!env.OTP_HASH_SECRET) throw new DomainError('CONFIGURATION_ERROR', 'OTP hash secret chưa cấu hình.', 503);
  const challengeId = requiredString(payload.challengeId, 'challengeId', 100);
  const otp = requiredString(payload.otp, 'otp', 10);
  if (!/^\d{6}$/.test(otp)) throw new DomainError('OTP_INVALID', 'OTP không hợp lệ.');
  const row = await one(env.DB, `SELECT * FROM otp_challenges WHERE id=? AND collaborator_id=?`, [challengeId, actor.id]);
  if (!row) throw new DomainError('OTP_INVALID', 'OTP không hợp lệ.');
  if (row.consumed_at) throw new DomainError('OTP_ALREADY_CONSUMED', 'OTP đã được sử dụng.');
  if (row.verified_at) return { challengeId, verifiedAt: row.verified_at };
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new DomainError('OTP_EXPIRED', 'OTP đã hết hạn.');
  if (row.attempt_count >= MAX_ATTEMPTS) throw new DomainError('OTP_INVALID', 'OTP đã vượt quá số lần thử.', 429);
  const expected = await hmacOtp(otp, env.OTP_HASH_SECRET, challengeId);
  if (!secureEqual(expected, row.otp_hash)) {
    await run(env.DB, `UPDATE otp_challenges SET attempt_count=attempt_count+1 WHERE id=?`, [challengeId]);
    throw new DomainError('OTP_INVALID', 'OTP không đúng.');
  }
  const verifiedAt = nowIso();
  await run(env.DB, `UPDATE otp_challenges SET verified_at=? WHERE id=? AND verified_at IS NULL`, [verifiedAt, challengeId]);
  return { challengeId, verifiedAt };
}
