import { createHash, randomBytes } from 'node:crypto';
import { AuthError, sha256 } from './auth.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const randomToken = () => b64url(randomBytes(32));

/** Nối tham số vào địa chỉ (hoạt động cả với địa chỉ app như cotuong://auth). */
export function appendQuery(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

/** Tên hiển thị từ hồ sơ mạng xã hội: bỏ ký tự điều khiển, cắt còn 24 ký tự, quá ngắn thì dùng tên mặc định. */
export function socialDisplayName(raw, fallback = 'Người chơi') {
  const s = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = Array.from(s).slice(0, 24).join('').trim();
  return Array.from(cut).length >= 2 ? cut : fallback;
}

const cleanEmail = (e) => (typeof e === 'string' && e.includes('@') && e.length <= 254 ? e : null);
const cleanAvatar = (u) => (typeof u === 'string' && u.startsWith('https://') && u.length <= 500 ? u : null);

/**
 * Đăng nhập bằng Google / Facebook / Zalo qua luồng OAuth 2.0 "authorization code" do SERVER điều khiển:
 *
 *   1. App gọi start()      -> nhận địa chỉ để mở trình duyệt hệ thống
 *   2. Người dùng đăng nhập ở nhà cung cấp, rồi nhà cung cấp chuyển trình duyệt về /auth/oauth/<id>/callback
 *   3. Server handleCallback(): kiểm tra state, đổi mã lấy access token (khoá bí mật nằm ở server, KHÔNG nằm trong app),
 *      đọc hồ sơ, tìm hoặc tạo tài khoản, rồi chuyển trình duyệt về app kèm MỘT MÃ DÙNG MỘT LẦN
 *   4. App gọi exchange(mã) -> nhận token phiên của server
 *
 * Quyết định bảo mật:
 *  - state ngẫu nhiên, lưu băm, dùng một lần, sống 10 phút (chống CSRF) + PKCE.
 *  - appRedirect phải khớp CHÍNH XÁC một địa chỉ trong danh sách cho phép (chống chuyển hướng mở).
 *  - Token phiên không bao giờ nằm trong địa chỉ chuyển hướng; chỉ có mã dùng một lần sống 60 giây.
 *  - KHÔNG tự động gộp tài khoản theo email (email Facebook chưa chắc đã xác minh, gộp tự động là lỗ hổng chiếm
 *    tài khoản kinh điển). Mỗi danh tính mạng xã hội là một tài khoản riêng; muốn gộp phải đăng nhập rồi chủ động "liên kết".
 */
export class OAuthService {
  constructor({
    store,
    auth,
    providers = new Map(),
    publicUrl,
    appRedirects = ['cotuong://auth'],
    now = () => Date.now(),
    fetchImpl = fetch,
    stateTtlMs = 10 * 60_000,
    codeTtlMs = 60_000,
    log = console,
  }) {
    this.store = store;
    this.auth = auth;
    this.providers = providers;
    this.publicUrl = (publicUrl ?? '').replace(/\/+$/, '');
    this.appRedirects = new Set(appRedirects);
    this._now = now;
    this.fetch = fetchImpl;
    this.stateTtlMs = stateTtlMs;
    this.codeTtlMs = codeTtlMs;
    this.log = log;
  }

  /** Danh sách nhà cung cấp đã cấu hình (để app chỉ hiện các nút dùng được). */
  listProviders() {
    return [...this.providers.keys()];
  }

  redirectUriOf(providerId) {
    return `${this.publicUrl}/auth/oauth/${providerId}/callback`;
  }

  /** Bước 1. Trả về địa chỉ cần mở trong trình duyệt. [linkUserId]: liên kết vào tài khoản đang đăng nhập. */
  async start(providerId, { appRedirect, linkUserId = null }) {
    const provider = this.providers.get(providerId);
    if (!provider || !this.publicUrl) throw new AuthError('provider_not_configured', 404);
    if (typeof appRedirect !== 'string' || !this.appRedirects.has(appRedirect)) {
      throw new AuthError('invalid_redirect', 400);
    }
    const state = randomToken();
    const verifier = randomToken();
    await this.store.saveOAuthState({
      stateHash: sha256(state),
      provider: providerId,
      appRedirect,
      codeVerifier: verifier,
      linkUserId,
      expiresAt: this._now() + this.stateTtlMs,
    });
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    return provider.authorizeUrl({ redirectUri: this.redirectUriOf(providerId), state, challenge });
  }

  /**
   * Bước 3. Trả về { redirect } (địa chỉ chuyển trình duyệt về app) hoặc { error: 'invalid_state' }
   * khi không thể chuyển hướng an toàn (state sai/hết hạn nên không biết app nào đang chờ).
   */
  async handleCallback(providerId, query, ctx = {}) {
    const provider = this.providers.get(providerId);
    const state = typeof query.state === 'string' ? query.state : '';
    const saved = state ? await this.store.takeOAuthState(sha256(state), this._now()) : null;
    if (!provider || !saved || saved.provider !== providerId) return { error: 'invalid_state' };

    const back = (params) => ({ redirect: appendQuery(saved.appRedirect, params) });
    const fail = async (detail, code) => {
      await this.auth.recordEvent(
        { userId: saved.linkUserId, event: saved.linkUserId ? 'link_failed' : 'login_failed', method: providerId, success: false, detail },
        ctx,
      );
      return back({ error: code });
    };

    if (query.error) return fail(String(query.error).slice(0, 60), 'access_denied'); // người dùng bấm "Từ chối"
    if (typeof query.code !== 'string' || query.code === '') return fail('missing_code', 'provider_error');

    let profile;
    try {
      const accessToken = await provider.exchange(this.fetch, {
        code: query.code,
        redirectUri: this.redirectUriOf(providerId),
        verifier: saved.codeVerifier,
      });
      profile = await provider.profile(this.fetch, accessToken);
    } catch (err) {
      // Pino nhận object ở tham số đầu; ghi cả mã nhà cung cấp và thông điệp lỗi để dễ chẩn đoán.
      this.log.error(
        { provider: providerId, reason: err.message },
        `[oauth:${providerId}] lỗi khi trao đổi với nhà cung cấp`,
      );
      return fail(`provider_error: ${err.message}`.slice(0, 120), 'provider_error');
    }
    if (typeof profile?.id !== 'string' && typeof profile?.id !== 'number') {
      return fail('no_profile_id', 'provider_error');
    }
    const clean = {
      providerUserId: String(profile.id),
      displayName: socialDisplayName(profile.name),
      email: cleanEmail(profile.email),
      avatarUrl: cleanAvatar(profile.avatarUrl),
    };

    try {
      if (saved.linkUserId) {
        await this._link(providerId, saved.linkUserId, clean, ctx);
        return back({ linked: providerId });
      }
      const user = await this._loginOrSignup(providerId, clean, ctx);
      const code = randomToken();
      await this.store.saveExchangeCode({
        codeHash: sha256(code), userId: user.id, method: providerId, expiresAt: this._now() + this.codeTtlMs,
      });
      return back({ code });
    } catch (err) {
      if (err instanceof AuthError) return fail(err.code, err.code);
      this.log.error(`[oauth:${providerId}] lỗi nội bộ:`, err);
      return fail('internal_error', 'provider_error');
    }
  }

  async _loginOrSignup(providerId, p, ctx) {
    const profile = { email: p.email, displayName: p.displayName, avatarUrl: p.avatarUrl };
    let identity = await this.store.findIdentity(providerId, p.providerUserId);
    let isNew = false;
    let user;
    if (identity) {
      user = await this.store.findUserById(identity.userId);
    } else {
      try {
        user = await this.store.createUserWithIdentity(
          { displayName: p.displayName, email: p.email, avatarUrl: p.avatarUrl },
          { provider: providerId, providerUserId: p.providerUserId, ...profile },
        );
        isNew = true;
      } catch (err) {
        if (err.message !== 'identity_taken') throw err;
        // Hai yêu cầu đăng nhập đầu tiên đến cùng lúc: bên kia đã tạo xong, dùng tài khoản đó.
        identity = await this.store.findIdentity(providerId, p.providerUserId);
        user = identity && (await this.store.findUserById(identity.userId));
      }
    }
    if (!user) throw new AuthError('provider_error');
    await this.store.touchIdentityLogin(providerId, p.providerUserId, this._now(), profile);
    if (isNew) {
      await this.auth.recordEvent({ userId: user.id, event: 'register', method: providerId, success: true }, ctx);
    }
    await this.auth.recordEvent({ userId: user.id, event: 'login', method: providerId, success: true }, ctx);
    return user;
  }

  async _link(providerId, userId, p, ctx) {
    const existing = await this.store.findIdentity(providerId, p.providerUserId);
    if (existing && existing.userId !== userId) throw new AuthError('identity_taken', 409);
    if (!existing) {
      try {
        await this.store.createIdentity({
          userId, provider: providerId, providerUserId: p.providerUserId,
          email: p.email, displayName: p.displayName, avatarUrl: p.avatarUrl,
        });
      } catch (err) {
        if (err.message === 'provider_already_linked') throw new AuthError('provider_already_linked', 409);
        if (err.message === 'identity_taken') throw new AuthError('identity_taken', 409);
        throw err;
      }
    }
    await this.auth.recordEvent({ userId, event: 'link', method: providerId, success: true }, ctx);
  }

  /** Bước 4. Đổi mã dùng một lần lấy token phiên của server. */
  async exchange(code, ctx = {}) {
    if (typeof code !== 'string' || code.length < 20 || code.length > 100) {
      throw new AuthError('invalid_code', 400);
    }
    const taken = await this.store.takeExchangeCode(sha256(code), this._now());
    if (!taken) throw new AuthError('invalid_code', 400);
    const user = await this.store.findUserById(taken.userId);
    if (!user) throw new AuthError('invalid_code', 400);
    const c = typeof ctx === 'string' ? { ip: ctx } : ctx;
    return this.auth.startSession(user, { method: taken.method, ip: c.ip ?? null, userAgent: c.userAgent ?? null });
  }

  /** Gỡ liên kết một nhà cung cấp. Không cho gỡ nếu đó là cách đăng nhập DUY NHẤT còn lại. */
  async unlink(userId, providerId, ctx = {}) {
    const user = await this.store.findUserById(userId);
    const identities = await this.store.listIdentities(userId);
    if (!user || !identities.some((i) => i.provider === providerId)) throw new AuthError('not_linked', 404);
    if (!user.passwordHash && identities.length <= 1) throw new AuthError('last_login_method', 409);
    await this.store.deleteIdentity(userId, providerId);
    await this.auth.recordEvent({ userId, event: 'unlink', method: providerId, success: true }, ctx);
  }
}

