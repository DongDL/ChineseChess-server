import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * JWT HS256 tối giản, chỉ dùng node:crypto nên KHÔNG thêm phụ thuộc mới
 * (cùng cách làm với chữ ký ES256 của Apple trong src/providers.js).
 *
 * Chỉ hỗ trợ đúng một thuật toán: HS256. Mọi token khai báo `alg` khác đều bị từ chối —
 * đây là cách chặn lỗ hổng "alg: none" và lỗ hổng lẫn lộn thuật toán (algorithm confusion).
 */

const b64urlEncode = (buf) => Buffer.from(buf).toString('base64url');
const b64urlJson = (obj) => b64urlEncode(JSON.stringify(obj));

/** Lỗi khi token không hợp lệ. [code] để lớp trên quy ra mã lỗi gửi client. */
export class JwtError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** Sinh khoá bí mật ngẫu nhiên 64 byte (dùng khi thiếu JWT_SECRET, chỉ phù hợp khi phát triển). */
export const randomSecret = () => randomBytes(64).toString('base64url');

/** Chuỗi có đúng dạng 3 phần base64url ngăn bởi dấu chấm (không kiểm tra chữ ký). */
export function looksLikeJwt(token) {
  return typeof token === 'string' && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);
}

const hmac = (secret, data) => createHmac('sha256', secret).update(data).digest();

/**
 * Ký một JWT HS256.
 * [payload] là các claim riêng; `iat` và `exp` (giây, theo chuẩn JWT) được tự thêm từ [now] và [ttlMs].
 */
export function signJwt(payload, secret, { ttlMs, now = Date.now() }) {
  if (typeof secret !== 'string' || secret === '') throw new JwtError('jwt_secret_missing');
  const iat = Math.floor(now / 1000);
  const body = { ...payload, iat, exp: iat + Math.max(1, Math.floor(ttlMs / 1000)) };
  const head = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const data = `${head}.${b64urlJson(body)}`;
  return `${data}.${b64urlEncode(hmac(secret, data))}`;
}

/**
 * Kiểm tra chữ ký và thời hạn, trả về payload. Ném [JwtError] nếu sai.
 * [now] nhận từ ngoài để test dùng được đồng hồ giả (giống AuthService).
 */
export function verifyJwt(token, secret, { now = Date.now() } = {}) {
  if (!looksLikeJwt(token)) throw new JwtError('jwt_malformed');
  if (typeof secret !== 'string' || secret === '') throw new JwtError('jwt_secret_missing');

  const [head, body, sig] = token.split('.');
  const expected = hmac(secret, `${head}.${body}`);
  const given = Buffer.from(sig, 'base64url');
  // So sánh thời gian không đổi; độ dài khác nhau thì timingSafeEqual sẽ ném lỗi nên phải chặn trước.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new JwtError('jwt_bad_signature');
  }

  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('jwt_malformed');
  }
  if (!header || header.alg !== 'HS256') throw new JwtError('jwt_bad_alg');
  if (!claims || typeof claims !== 'object') throw new JwtError('jwt_malformed');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) throw new JwtError('jwt_expired');
  return claims;
}
