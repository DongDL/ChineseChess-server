// Định nghĩa các nhà cung cấp đăng nhập (OAuth 2.0, luồng "authorization code").
//
// Mỗi nhà cung cấp có cùng giao diện:
//   id, clientId, clientSecret, pkce
//   authorizeUrl({ redirectUri, state, challenge }) -> địa chỉ trình duyệt cần mở
//   exchange(fetch, { code, redirectUri, verifier }) -> access token (với Apple là id_token)
//   profile(fetch, accessToken) -> { id, name, email, emailVerified, avatarUrl }
//
// Địa chỉ API có thể ghi đè qua `urls` (dùng để test bằng máy chủ giả).
// Lưu ý: chưa được kiểm thử với máy chủ THẬT của Google/Facebook/Zalo/Apple (cần khoá ứng dụng của bạn);
// logic được kiểm thử bằng máy chủ giả tuân theo tài liệu của từng bên.

import { createSign } from 'node:crypto';

/** Gọi HTTP, kỳ vọng JSON. Không đưa nội dung phản hồi vào lỗi vì có thể chứa mã bí mật. */
export async function fetchJson(fetchImpl, url, { timeoutMs = 10_000, ...init } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok || json === null || typeof json !== 'object') {
      throw new Error(`HTTP ${res.status}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export function withQuery(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

function requireAccessToken(json) {
  if (typeof json.access_token !== 'string' || json.access_token === '') {
    throw new Error('no_access_token');
  }
  return json.access_token;
}

// ------------------------------------------------------------------------- Google

export function googleProvider({ clientId, clientSecret, urls = {} }) {
  const u = {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    ...urls,
  };
  return {
    id: 'google',
    clientId,
    clientSecret,
    pkce: true,
    authorizeUrl: ({ redirectUri, state, challenge }) => withQuery(u.authorize, {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }),
    async exchange(fetchImpl, { code, redirectUri, verifier }) {
      const json = await fetchJson(fetchImpl, u.token, {
        method: 'POST',
        headers: FORM,
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        }),
      });
      return requireAccessToken(json);
    },
    async profile(fetchImpl, accessToken) {
      const j = await fetchJson(fetchImpl, u.userinfo, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      return {
        id: j.sub,
        name: j.name,
        email: j.email,
        emailVerified: j.email_verified === true,
        avatarUrl: j.picture,
      };
    },
  };
}

// ----------------------------------------------------------------------- Facebook

/**
 * [apiVersion]: phiên bản Graph API. Facebook cho mỗi phiên bản sống tối thiểu 2 năm rồi ngừng
 * (ví dụ v19.0 hết hạn tháng 5/2026), nên hãy kiểm tra và đặt FACEBOOK_API_VERSION khi cần.
 */
export function facebookProvider({ clientId, clientSecret, apiVersion = 'v24.0', urls = {} }) {
  const u = {
    authorize: `https://www.facebook.com/${apiVersion}/dialog/oauth`,
    token: `https://graph.facebook.com/${apiVersion}/oauth/access_token`,
    me: `https://graph.facebook.com/${apiVersion}/me`,
    ...urls,
  };
  return {
    id: 'facebook',
    clientId,
    clientSecret,
    pkce: false,
    authorizeUrl: ({ redirectUri, state }) => withQuery(u.authorize, {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'public_profile,email',
      state,
    }),
    async exchange(fetchImpl, { code, redirectUri }) {
      const json = await fetchJson(fetchImpl, withQuery(u.token, {
        client_id: clientId,
        redirect_uri: redirectUri,
        client_secret: clientSecret,
        code,
      }));
      return requireAccessToken(json);
    },
    async profile(fetchImpl, accessToken) {
      const j = await fetchJson(fetchImpl, withQuery(u.me, {
        fields: 'id,name,email,picture.type(large)',
        access_token: accessToken,
      }));
      return {
        id: j.id,
        name: j.name,
        email: j.email, // có thể vắng mặt (người dùng không cấp quyền hoặc đăng ký bằng số điện thoại)
        emailVerified: false, // Facebook không đảm bảo email đã được xác minh
        avatarUrl: j.picture?.data?.url,
      };
    },
  };
}

// --------------------------------------------------------------------------- Zalo

export function zaloProvider({ clientId, clientSecret, urls = {} }) {
  const u = {
    authorize: 'https://oauth.zaloapp.com/v4/permission',
    token: 'https://oauth.zaloapp.com/v4/access_token',
    me: 'https://graph.zalo.me/v2.0/me',
    ...urls,
  };
  return {
    id: 'zalo',
    clientId,
    clientSecret,
    pkce: true, // Zalo bắt buộc PKCE
    authorizeUrl: ({ redirectUri, state, challenge }) => withQuery(u.authorize, {
      app_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }),
    async exchange(fetchImpl, { code, verifier }) {
      const json = await fetchJson(fetchImpl, u.token, {
        method: 'POST',
        headers: { ...FORM, secret_key: clientSecret }, // Zalo nhận khoá bí mật qua header secret_key
        body: new URLSearchParams({
          code,
          app_id: clientId,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        }),
      });
      return requireAccessToken(json);
    },
    async profile(fetchImpl, accessToken) {
      const j = await fetchJson(fetchImpl, withQuery(u.me, { fields: 'id,name,picture' }), {
        headers: { access_token: accessToken },
      });
      if (j.error) throw new Error('zalo_profile_error');
      return {
        id: j.id,
        name: j.name,
        email: undefined, // Zalo không trả về email
        emailVerified: false,
        avatarUrl: j.picture?.data?.url,
      };
    },
  };
}

// --------------------------------------------------------------------------- Apple

const b64urlJson = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** Giải mã phần payload của một JWT (id_token) mà KHÔNG kiểm chữ ký. Trả về object hoặc {} nếu lỗi. */
export function decodeJwtPayload(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    if (!part) return {};
    const json = Buffer.from(part, 'base64url').toString('utf8');
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/**
 * Khoá bí mật của Apple KHÔNG phải chuỗi tĩnh mà là một JWT ký bằng ES256 từ khoá riêng (.p8) tải ở
 * Apple Developer. Hàm này tạo client_secret đó, hạn tối đa 6 tháng (ở đây đặt ngắn hơn cho an toàn).
 *   teamId   : Apple Team ID (10 ký tự)
 *   keyId    : Key ID của khoá .p8
 *   clientId : Services ID (định danh ứng dụng web) — dùng làm `sub` và `client_id`
 *   privateKey : nội dung khoá .p8 (PEM, bắt đầu bằng -----BEGIN PRIVATE KEY-----)
 */
export function appleClientSecret({ teamId, keyId, clientId, privateKey, now = Date.now(), ttlSec = 3600 }) {
  const header = b64urlJson({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const iat = Math.floor(now / 1000);
  const payload = b64urlJson({
    iss: teamId,
    iat,
    exp: iat + ttlSec,
    aud: 'https://appleid.apple.com',
    sub: clientId,
  });
  const signingInput = `${header}.${payload}`;
  // Apple yêu cầu chữ ký ES256 ở định dạng JOSE (r||s), đúng là định dạng mà dsaEncoding 'ieee-p1363' tạo ra.
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return `${signingInput}.${signature}`;
}

/**
 * Sign in with Apple (OAuth 2.0 "authorization code").
 *
 * Khác biệt so với các bên khác:
 *  - client_secret là JWT ES256 tạo tại chỗ (xem appleClientSecret), không phải chuỗi cố định.
 *  - KHÔNG có endpoint userinfo: danh tính nằm trong `id_token` (JWT) trả về khi đổi mã. Ta coi id_token
 *    như "access token" của giao diện chung, rồi profile() giải mã nó.
 *  - KHÔNG yêu cầu scope `name` nên dùng response_mode mặc định (query) -> callback vẫn là GET như các bên khác.
 *    Apple chỉ gửi tên một lần duy nhất qua form_post; bỏ qua để giữ luồng đơn giản, tên lấy mặc định.
 *  - Email chỉ chắc chắn có ở lần đăng nhập đầu; những lần sau có thể vắng. Vẫn định danh theo `sub` nên không sao.
 */
export function appleProvider({
  clientId, teamId, keyId, privateKey, urls = {}, now = () => Date.now(),
}) {
  const u = {
    authorize: 'https://appleid.apple.com/auth/authorize',
    token: 'https://appleid.apple.com/auth/token',
    ...urls,
  };
  return {
    id: 'apple',
    clientId,
    pkce: false,
    authorizeUrl: ({ redirectUri, state }) => withQuery(u.authorize, {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'email',
      state,
    }),
    async exchange(fetchImpl, { code, redirectUri }) {
      const clientSecret = appleClientSecret({ teamId, keyId, clientId, privateKey, now: now() });
      const json = await fetchJson(fetchImpl, u.token, {
        method: 'POST',
        headers: FORM,
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      if (typeof json.id_token !== 'string' || json.id_token === '') {
        throw new Error('no_id_token');
      }
      return json.id_token; // dùng id_token làm "access token" cho profile()
    },
    // eslint-disable-next-line no-unused-vars
    async profile(_fetchImpl, idToken) {
      const claims = decodeJwtPayload(idToken);
      if (typeof claims.sub !== 'string' || claims.sub === '') throw new Error('no_apple_sub');
      return {
        id: claims.sub,
        name: undefined, // Apple không trả tên trong id_token (chỉ gửi form_post lần đầu)
        email: typeof claims.email === 'string' ? claims.email : undefined,
        emailVerified: claims.email_verified === true || claims.email_verified === 'true',
        avatarUrl: undefined, // Apple không cung cấp ảnh đại diện
      };
    },
  };
}

/**
 * Dựng danh sách nhà cung cấp ĐÃ CẤU HÌNH từ biến môi trường. Nhà cung cấp nào thiếu
 * client id hoặc secret thì bỏ qua (app sẽ không hiện nút đăng nhập tương ứng).
 */
export function providersFromEnv(env = process.env) {
  const out = new Map();
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    out.set('google', googleProvider({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }));
  }
  if (env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET) {
    out.set('facebook', facebookProvider({
      clientId: env.FACEBOOK_APP_ID,
      clientSecret: env.FACEBOOK_APP_SECRET,
      ...(env.FACEBOOK_API_VERSION ? { apiVersion: env.FACEBOOK_API_VERSION } : {}),
    }));
  }
  if (env.ZALO_APP_ID && env.ZALO_APP_SECRET) {
    out.set('zalo', zaloProvider({ clientId: env.ZALO_APP_ID, clientSecret: env.ZALO_APP_SECRET }));
  }
  if (env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY) {
    out.set('apple', appleProvider({
      clientId: env.APPLE_CLIENT_ID,
      teamId: env.APPLE_TEAM_ID,
      keyId: env.APPLE_KEY_ID,
      // Khoá .p8 trong biến môi trường thường để xuống dòng bằng "\n" literal; chuyển lại thành xuống dòng thật.
      privateKey: env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }));
  }
  return out;
}
