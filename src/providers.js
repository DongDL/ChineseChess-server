// Định nghĩa các nhà cung cấp đăng nhập (OAuth 2.0, luồng "authorization code").
//
// Mỗi nhà cung cấp có cùng giao diện:
//   id, clientId, clientSecret, pkce
//   authorizeUrl({ redirectUri, state, challenge }) -> địa chỉ trình duyệt cần mở
//   exchange(fetch, { code, redirectUri, verifier }) -> access token
//   profile(fetch, accessToken) -> { id, name, email, emailVerified, avatarUrl }
//
// Địa chỉ API có thể ghi đè qua `urls` (dùng để test bằng máy chủ giả).
// Lưu ý: chưa được kiểm thử với máy chủ THẬT của Google/Facebook/Zalo (cần khoá ứng dụng của bạn);
// logic được kiểm thử bằng máy chủ giả tuân theo tài liệu của từng bên.

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
  return out;
}
