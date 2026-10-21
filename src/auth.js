import {
  createHash, randomBytes, scrypt as scryptCb, timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/** Lỗi nghiệp vụ có mã (gửi cho client) và mã HTTP tương ứng. */
export class AuthError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// ----------------------------------------------------------------- kiểm tra đầu vào

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Tên đăng nhập: 3-20 ký tự a-z, 0-9, _ (không phân biệt hoa thường). Trả về dạng chữ thường. */
export function validateUsername(raw) {
  if (typeof raw !== 'string') throw new AuthError('invalid_username');
  const u = raw.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) throw new AuthError('invalid_username');
  return u;
}

/** Mật khẩu: 8-128 ký tự. */
export function validatePassword(raw) {
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 128) {
    throw new AuthError('invalid_password');
  }
  return raw;
}

/** Tên hiển thị: 2-24 ký tự; bỏ trống thì dùng [fallback]. */
export function validateDisplayName(raw, fallback) {
  const s = String(raw ?? '').replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  if (s === '') return fallback;
  if (s.length < 2 || s.length > 24) throw new AuthError('invalid_display_name');
  return s;
}

// -------------------------------------------------------------------- băm mật khẩu

const DEFAULT_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1 });
const KEY_LEN = 64;

/** Băm mật khẩu bằng scrypt với muối ngẫu nhiên. Định dạng: scrypt$N$r$p$muối$băm (base64). */
export async function hashPassword(password, params = DEFAULT_SCRYPT) {
  const { N, r, p } = params;
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** So khớp mật khẩu với chuỗi đã băm (so sánh thời gian không đổi). */
export async function verifyPassword(password, stored) {
  const [alg, n, r, p, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N, r: R, p: P, maxmem: 128 * N * R * 2,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// --------------------------------------------------------------- giới hạn số lần thử

/** Giới hạn cửa sổ trượt: tối đa [max] lần trong [windowMs] cho mỗi khoá. */
export class RateLimiter {
  constructor({ max, windowMs, now = () => Date.now() }) {
    this.max = max;
    this.windowMs = windowMs;
    this._now = now;
    this.hits = new Map();
  }

  _recent(key) {
    const t = this._now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length > 0) this.hits.set(key, arr);
    else this.hits.delete(key);
    return arr;
  }

  /** Số lần đã ghi nhận trong cửa sổ hiện tại. */
  count(key) {
    return this._recent(key).length;
  }

  /** Ghi nhận một lần thử. Trả về false nếu đã vượt giới hạn (và không ghi thêm). */
  take(key) {
    const arr = this._recent(key);
    if (arr.length >= this.max) return false;
    arr.push(this._now());
    this.hits.set(key, arr);
    if (this.hits.size > 10_000) this.sweep();
    return true;
  }

  reset(key) {
    this.hits.delete(key);
  }

  sweep() {
    for (const key of [...this.hits.keys()]) this._recent(key);
  }
}

// ------------------------------------------------------------------------ AuthService

const DAY_MS = 24 * 60 * 60_000;
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Thông tin công khai của người dùng (không bao giờ có băm mật khẩu hay email). */
export const publicUser = (u) => ({
  id: u.id,
  username: u.username ?? null, // null với tài khoản chỉ đăng nhập bằng Google/Facebook/Zalo
  displayName: u.displayName,
  avatarUrl: u.avatarUrl ?? null,
});

/** Ngữ cảnh yêu cầu: IP và trình duyệt, để ghi lịch sử đăng nhập. Nhận cả chuỗi IP cho gọn. */
const ctxOf = (ctx) => {
  const c = typeof ctx === 'string' ? { ip: ctx } : ctx ?? {};
  return { ip: c.ip ?? 'unknown', userAgent: c.userAgent ?? null };
};

/**
 * Đăng ký / đăng nhập bằng tên đăng nhập + mật khẩu. Đăng nhập thành công trả về token ngẫu nhiên
 * (client gửi lại ở các lần sau). Server chỉ lưu BĂM của token nên lộ cơ sở dữ liệu cũng không lấy được token.
 * Token là phiên "đục" lưu phía server nên đăng xuất là thu hồi được ngay.
 * Mọi lần đăng ký / đăng nhập / đăng xuất (kể cả thất bại) được ghi vào lịch sử đăng nhập.
 */
export class AuthService {
  constructor({
    store,
    now = () => Date.now(),
    sessionTtlMs = 30 * DAY_MS,
    scryptParams = DEFAULT_SCRYPT,
    limits = {},
    log = console,
  }) {
    this.store = store;
    this._now = now;
    this.log = log;
    this.sessionTtlMs = sessionTtlMs;
    this.scryptParams = scryptParams;
    const L = {
      registerPerIp: { max: 10, windowMs: 60 * 60_000 },
      loginPerIp: { max: 30, windowMs: 10 * 60_000 },
      failPerUser: { max: 10, windowMs: 10 * 60_000 },
      ...limits,
    };
    this.registerIp = new RateLimiter({ ...L.registerPerIp, now });
    this.loginIp = new RateLimiter({ ...L.loginPerIp, now });
    this.failUser = new RateLimiter({ ...L.failPerUser, now });
    // Băm giả để đăng nhập tên không tồn tại tốn thời gian ngang tên có thật (chống dò tên).
    this._dummyHash = hashPassword('mat-khau-gia-de-chong-do-ten', scryptParams);
  }

  /**
   * Ghi một sự kiện vào lịch sử đăng nhập. Lỗi ghi log KHÔNG được làm hỏng việc đăng nhập,
   * nên chỉ ghi cảnh báo ra console.
   */
  async recordEvent({ userId = null, event, method, success, detail = null }, ctx) {
    const c = ctxOf(ctx);
    try {
      await this.store.addAuthEvent({
        userId, event, method, success, ip: c.ip, userAgent: c.userAgent, detail, at: this._now(),
      });
    } catch (err) {
      this.log.error('[auth] không ghi được lịch sử đăng nhập:', err.message);
    }
  }

  async register({ username, password, displayName }, ctx) {
    const c = ctxOf(ctx);
    if (!this.registerIp.take(c.ip)) throw new AuthError('rate_limited', 429);
    const name = validateUsername(username);
    validatePassword(password);
    const display = validateDisplayName(displayName, name);
    const passwordHash = await hashPassword(password, this.scryptParams);
    let user;
    try {
      user = await this.store.createUser({ username: name, displayName: display, passwordHash });
    } catch (err) {
      if (err.message === 'username_taken') throw new AuthError('username_taken', 409);
      throw err;
    }
    await this.recordEvent({ userId: user.id, event: 'register', method: 'password', success: true }, c);
    return this.startSession(user, { method: 'password', ...c });
  }

  async login({ username, password }, ctx) {
    const c = ctxOf(ctx);
    if (!this.loginIp.take(c.ip)) throw new AuthError('rate_limited', 429);
    let name;
    try {
      name = validateUsername(username);
    } catch {
      throw new AuthError('invalid_credentials', 401); // không tiết lộ quy tắc đặt tên
    }
    if (this.failUser.count(name) >= this.failUser.max) {
      await this.recordEvent({ event: 'login_failed', method: 'password', success: false, detail: 'locked' }, c);
      throw new AuthError('rate_limited', 429);
    }
    if (typeof password !== 'string' || password.length > 128) {
      throw new AuthError('invalid_credentials', 401);
    }

    const user = await this.store.findUserByUsername(name);
    // Tài khoản chỉ đăng nhập mạng xã hội không có mật khẩu: so với băm giả để thời gian như nhau.
    const hash = user?.passwordHash ?? (await this._dummyHash);
    const ok = (await verifyPassword(password, hash)) && Boolean(user?.passwordHash);
    if (!user || !ok) {
      this.failUser.take(name);
      await this.recordEvent({
        userId: user?.id ?? null, event: 'login_failed', method: 'password', success: false,
        detail: user ? 'bad_password' : 'unknown_user',
      }, c);
      throw new AuthError('invalid_credentials', 401);
    }
    this.failUser.reset(name);
    await this.recordEvent({ userId: user.id, event: 'login', method: 'password', success: true }, c);
    return this.startSession(user, { method: 'password', ...c });
  }

  /** Tạo phiên đăng nhập mới cho [user]. Dùng chung cho mật khẩu và đăng nhập mạng xã hội. */
  async startSession(user, { method, ip = null, userAgent = null }) {
    const token = randomBytes(32).toString('base64url');
    const now = this._now();
    await this.store.createSession({
      tokenHash: sha256(token), userId: user.id, expiresAt: now + this.sessionTtlMs, method, ip, userAgent,
    });
    await this.store.touchLogin(user.id, now);
    return { token, user: publicUser(user) };
  }

  /** Trả về người dùng ứng với token còn hạn, hoặc null. */
  async authenticate(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const session = await this.store.getSession(sha256(token), this._now());
    if (!session) return null;
    const user = await this.store.findUserById(session.userId);
    return user ? publicUser(user) : null;
  }

  /** Thông tin người dùng kèm các nhà cung cấp đã liên kết và việc có mật khẩu hay không. */
  async profile(userId) {
    const user = await this.store.findUserById(userId);
    if (!user) return null;
    const identities = await this.store.listIdentities(userId);
    return {
      ...publicUser(user),
      providers: identities.map((i) => i.provider),
      hasPassword: Boolean(user.passwordHash),
    };
  }

  /** Xác nhận mật khẩu hiện tại của [userId] (dùng cho đổi mật khẩu / xoá tài khoản); sai nhiều lần thì bị khoá tạm. */
  async _confirmPassword(user, password, ctx, event) {
    const c = ctxOf(ctx);
    if (!user.passwordHash) throw new AuthError('no_password', 400);
    const key = `u:${user.id}`;
    if (this.failUser.count(key) >= this.failUser.max) throw new AuthError('rate_limited', 429);
    const ok = typeof password === 'string' && password.length <= 128
      && (await verifyPassword(password, user.passwordHash));
    if (!ok) {
      this.failUser.take(key);
      await this.recordEvent({ userId: user.id, event, method: 'password', success: false, detail: 'bad_password' }, c);
      throw new AuthError('invalid_credentials', 401);
    }
    this.failUser.reset(key);
  }

  /**
   * Đổi mật khẩu (cần mật khẩu hiện tại). Mọi phiên KHÁC phiên đang dùng bị thu hồi, nên kẻ đang giữ token cũ
   * (nếu có) bị đá ra ngay. Trả về số phiên đã thu hồi.
   */
  async changePassword(userId, { currentPassword, newPassword }, currentToken, ctx) {
    const user = await this.store.findUserById(userId);
    if (!user) throw new AuthError('invalid_token', 401);
    await this._confirmPassword(user, currentPassword, ctx, 'password_change_failed');
    validatePassword(newPassword);
    if (newPassword === currentPassword) throw new AuthError('same_password', 400);
    await this.store.setPasswordHash(userId, await hashPassword(newPassword, this.scryptParams));
    const revoked = await this.store.deleteSessionsOfUser(userId, sha256(currentToken ?? ''));
    await this.recordEvent({ userId, event: 'password_change', method: 'password', success: true, detail: `revoked:${revoked}` }, ctx);
    return revoked;
  }

  /**
   * Xoá tài khoản vĩnh viễn. Tài khoản có mật khẩu phải nhập mật khẩu; tài khoản chỉ đăng nhập mạng xã hội
   * phải gửi confirm = 'DELETE' (chỉ chặn bấm nhầm, không phải xác thực). Ván đã chơi được giữ lại ẩn danh hoá liên kết.
   */
  async deleteAccount(userId, { password, confirm }, ctx) {
    const user = await this.store.findUserById(userId);
    if (!user) throw new AuthError('invalid_token', 401);
    if (user.passwordHash) {
      await this._confirmPassword(user, password, ctx, 'delete_account_failed');
    } else if (confirm !== 'DELETE') {
      throw new AuthError('confirmation_required', 400);
    }
    await this.store.deleteUser(userId);
  }

  /** Thu hồi token (đăng xuất). */
  async logout(token, ctx) {
    if (typeof token !== 'string') return;
    const hash = sha256(token);
    const session = await this.store.getSession(hash, this._now());
    await this.store.deleteSession(hash);
    if (session) {
      await this.recordEvent({ userId: session.userId, event: 'logout', method: 'token', success: true }, ctx);
    }
  }
}
