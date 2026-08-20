const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) throw new Error('invalid hex');
  return Uint8Array.from(hex.match(/../g), (x) => Number.parseInt(x, 16));
}

export function secureEqual(a, b) {
  const aa = typeof a === 'string' ? encoder.encode(a) : new Uint8Array(a);
  const bb = typeof b === 'string' ? encoder.encode(b) : new Uint8Array(b);
  const length = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < length; i += 1) diff |= (aa[i % aa.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  return diff === 0;
}

export async function hashPassword(password, iterations = 210000) {
  const text = String(password ?? '');
  if (text.length < 10) throw new Error('password must be at least 10 characters');
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const material = await crypto.subtle.importKey('raw', encoder.encode(text), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, 256);
  return `pbkdf2_sha256$${iterations}$${bytesToHex(salt)}$${bytesToHex(bits)}`;
}

export async function verifyPassword(password, encoded) {
  try {
    const [kind, iterationText, saltHex, expectedHex] = String(encoded).split('$');
    if (kind !== 'pbkdf2_sha256') return false;
    const iterations = Number(iterationText);
    const material = await crypto.subtle.importKey('raw', encoder.encode(String(password ?? '')), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations }, material, 256);
    return secureEqual(bytesToHex(bits), expectedHex);
  } catch {
    return false;
  }
}

export async function sha256(input) {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  return bytesToHex(await crypto.subtle.digest('SHA-256', data));
}

export async function hashToken(token) {
  return sha256(String(token ?? ''));
}

export async function hmacOtp(otp, secret, challengeId) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${challengeId}:${otp}`));
  return bytesToHex(sig);
}
