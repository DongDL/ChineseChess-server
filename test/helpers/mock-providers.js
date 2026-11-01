import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Máy chủ GIẢ mô phỏng Google, Facebook, Zalo theo đúng quy ước từng bên và KIỂM TRA NGHIÊM NGẶT
 * yêu cầu của server mình (tham số, PKCE, khoá bí mật, mã dùng một lần...). Yêu cầu sai thì trả lỗi
 * nên test thất bại. Đây KHÔNG phải máy chủ thật: nó chỉ chứng minh mình gửi đúng như tài liệu mô tả.
 *
 *   Google   : authorize + POST form token + Bearer userinfo, PKCE
 *   Facebook : dialog/oauth + GET oauth/access_token (client_secret trên query) + me?access_token=, KHÔNG PKCE
 *   Zalo     : permission + POST form access_token kèm header secret_key + header access_token cho me, PKCE
 */
const CLIENTS = {
  google: { id: 'gid', secret: 'gsecret' },
  facebook: { id: 'fid', secret: 'fsecret' },
  zalo: { id: 'zid', secret: 'zsecret' },
  // Apple: secret là JWT ES256 server tự ký -> ở đây chỉ kiểm cấu trúc, không kiểm chữ ký.
  apple: { id: 'app.cotuong.test' },
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const b64urlJson = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const unsignedJwt = (payload) => `${b64urlJson({ alg: 'none' })}.${b64urlJson(payload)}.`;

function readForm(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
  });
}

export async function startMockProviders() {
  const codes = new Map(); // mã uỷ quyền -> { provider, challenge, redirectUri }
  const tokens = new Map(); // access token -> provider
  const mock = {
    /** Hồ sơ trả về cho từng nhà cung cấp: { id, name, email, emailVerified, picture } */
    profiles: {
      google: { id: 'g-100', name: 'Gờ Người Dùng', email: 'g@example.com', emailVerified: true, picture: 'https://img.example/g.png' },
      facebook: { id: 'f-100', name: 'Ép Người Dùng', email: 'f@example.com', picture: 'https://img.example/f.png' },
      zalo: { id: 'z-100', name: 'Zờ Người Dùng', picture: 'https://img.example/z.png' },
      apple: { id: 'a-100', email: 'a@privaterelay.appleid.com', emailVerified: true },
    },
    denyNext: false, // lần cấp quyền kế tiếp: người dùng bấm "Từ chối"
    failTokenNext: false, // lần đổi mã kế tiếp: nhà cung cấp báo lỗi
    calls: [],
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://mock');
    const [, provider, ...rest] = u.pathname.split('/');
    const action = rest.join('/');
    const cfg = CLIENTS[provider];
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!cfg) return json(404, { error: 'unknown_provider' });
    mock.calls.push(`${provider}:${action}`);
    const q = u.searchParams;

    // ---- 1. Trang cấp quyền: chuyển hướng về callback của server mình kèm mã ----
    if (['authorize', 'dialog/oauth', 'permission'].includes(action)) {
      if ((q.get('client_id') ?? q.get('app_id')) !== cfg.id) return json(400, { error: 'bad_client' });
      const needsPkce = provider === 'google' || provider === 'zalo';
      if (needsPkce && (!q.get('code_challenge') || q.get('code_challenge_method') !== 'S256')) {
        return json(400, { error: 'pkce_required' });
      }
      if (!needsPkce && q.get('code_challenge')) return json(400, { error: 'unexpected_pkce' });
      if (provider === 'google' && (q.get('response_type') !== 'code' || !(q.get('scope') ?? '').includes('openid'))) {
        return json(400, { error: 'bad_google_params' });
      }
      if (provider === 'facebook' && (q.get('response_type') !== 'code' || !(q.get('scope') ?? '').includes('email'))) {
        return json(400, { error: 'bad_facebook_params' });
      }
      const redirectUri = q.get('redirect_uri');
      const state = q.get('state');
      if (!redirectUri || !state) return json(400, { error: 'missing_redirect_or_state' });
      const back = new URL(redirectUri);
      if (mock.denyNext) {
        mock.denyNext = false;
        back.searchParams.set('error', 'access_denied');
      } else {
        const code = randomBytes(12).toString('hex');
        codes.set(code, { provider, challenge: q.get('code_challenge'), redirectUri });
        back.searchParams.set('code', code);
      }
      back.searchParams.set('state', state);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    // ---- 2. Đổi mã lấy access token (Apple trả id_token) ----
    if (['token', 'oauth/access_token', 'access_token'].includes(action)) {
      let p;
      let secret;
      if (provider === 'facebook') {
        if (req.method !== 'GET') return json(405, { error: 'facebook_expects_get' });
        p = q;
        secret = p.get('client_secret');
      } else {
        if (req.method !== 'POST') return json(405, { error: 'expects_post' });
        p = await readForm(req);
        secret = provider === 'zalo' ? req.headers.secret_key : p.get('client_secret');
      }
      if ((p.get('client_id') ?? p.get('app_id')) !== cfg.id) return json(400, { error: 'bad_client' });
      if (provider === 'apple') {
        // Apple: client_secret là JWT ES256. Kiểm cấu trúc + các claim bắt buộc (không kiểm chữ ký ở mock).
        const claims = (() => {
          try { return JSON.parse(Buffer.from(String(secret).split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { return null; }
        })();
        if (!claims || claims.iss?.length !== 10 || claims.sub !== cfg.id || claims.aud !== 'https://appleid.apple.com') {
          return json(401, { error: 'bad_apple_secret' });
        }
      } else if (secret !== cfg.secret) {
        return json(401, { error: 'bad_secret' });
      }
      if (provider !== 'facebook' && p.get('grant_type') !== 'authorization_code') return json(400, { error: 'bad_grant_type' });
      if (mock.failTokenNext) {
        mock.failTokenNext = false;
        return json(400, { error: 'invalid_grant' });
      }
      const entry = codes.get(p.get('code'));
      codes.delete(p.get('code')); // mã uỷ quyền chỉ dùng được một lần
      if (!entry || entry.provider !== provider) return json(400, { error: 'invalid_code' });
      if (provider !== 'zalo' && entry.redirectUri !== p.get('redirect_uri')) return json(400, { error: 'redirect_mismatch' });
      if (provider === 'google' || provider === 'zalo') {
        const verifier = p.get('code_verifier') ?? '';
        if (b64url(createHash('sha256').update(verifier).digest()) !== entry.challenge) {
          return json(400, { error: 'pkce_mismatch' });
        }
      }
      if (provider === 'apple') {
        const pr = mock.profiles.apple;
        const idToken = unsignedJwt({
          iss: 'https://appleid.apple.com',
          sub: pr.id,
          email: pr.email,
          email_verified: pr.emailVerified,
        });
        return json(200, { access_token: `at_${randomBytes(10).toString('hex')}`, token_type: 'Bearer', expires_in: 3600, id_token: idToken });
      }
      const access = `at_${randomBytes(10).toString('hex')}`;
      tokens.set(access, provider);
      return json(200, { access_token: access, token_type: 'Bearer', expires_in: 3600 });
    }

    // ---- 3. Hồ sơ người dùng ----
    if (['userinfo', 'me'].includes(action)) {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const access = provider === 'google' ? bearer
        : provider === 'facebook' ? q.get('access_token')
          : req.headers.access_token;
      if (!access || tokens.get(access) !== provider) return json(401, { error: 'invalid_token' });
      const pr = mock.profiles[provider];
      if (provider === 'google') {
        return json(200, { sub: pr.id, name: pr.name, email: pr.email, email_verified: pr.emailVerified, picture: pr.picture });
      }
      if (provider === 'facebook') {
        return json(200, { id: pr.id, name: pr.name, email: pr.email, picture: { data: { url: pr.picture } } });
      }
      return json(200, { id: pr.id, name: pr.name, picture: { data: { url: pr.picture } } });
    }
    return json(404, { error: 'unknown_action' });
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  return {
    mock,
    base,
    urls: (provider) => ({
      google: { authorize: `${base}/google/authorize`, token: `${base}/google/token`, userinfo: `${base}/google/userinfo` },
      facebook: { authorize: `${base}/facebook/dialog/oauth`, token: `${base}/facebook/oauth/access_token`, me: `${base}/facebook/me` },
      zalo: { authorize: `${base}/zalo/permission`, token: `${base}/zalo/access_token`, me: `${base}/zalo/me` },
      apple: { authorize: `${base}/apple/authorize`, token: `${base}/apple/token` },
    })[provider],
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
