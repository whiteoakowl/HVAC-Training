// Time-based one-time passwords (RFC 6238, the scheme used by Google
// Authenticator, Microsoft Authenticator, 1Password, Authy...).
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 15;
  const code = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1e6).padStart(6, '0');
}

function totp(secret, time = Date.now()) {
  return hotp(secret, Math.floor(time / 30000));
}

// Accepts the current code or one step either side (clock drift).
function verify(secret, code, time = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) return false;
  const step = Math.floor(time / 30000);
  return [-1, 0, 1].some((d) => crypto.timingSafeEqual(Buffer.from(hotp(secret, step + d)), Buffer.from(c)));
}

function otpauthUri(secret, account, issuer) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, totp, verify, otpauthUri, base32Encode, base32Decode };
