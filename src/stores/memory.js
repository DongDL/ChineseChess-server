import { randomUUID } from 'node:crypto';
import {
  DEFAULT_RATING, RATED_MIN_MOVES, computeRatings, isRatedGame,
} from '../elo.js';

/**
 * Kho lưu trong bộ nhớ: dùng cho test và chạy thử khi chưa cấu hình DATABASE_URL.
 * TẮT SERVER LÀ MẤT HẾT DỮ LIỆU. Giao diện và hành vi (kể cả các lỗi như 'username_taken')
 * giống hệt PgStore; bộ test hợp đồng (test/store.test.js) chạy cùng một bộ kiểm tra trên cả hai.
 */
export class MemoryStore {
  constructor({ ratedMinMoves = RATED_MIN_MOVES } = {}) {
    this.ratedMinMoves = ratedMinMoves;
    this.users = new Map();
    /** `${userId}:${purpose}` -> mã email đang hiệu lực */
    this.emailCodes = new Map(); // id -> user
    this.byUsername = new Map(); // username -> id
    this.identities = new Map(); // `${provider}\u0000${providerUserId}` -> identity
    this.sessions = new Map(); // tokenHash -> session
    this.oauthStates = new Map();
    this.exchangeCodes = new Map();
    this.events = [];
    this.nextEventId = 1;
    this.games = new Map(); // id -> game
  }

  async close() {}

  // --------------------------------------------------------------------- người dùng

  async createUser({ username = null, displayName, passwordHash = null, email = null, avatarUrl = null }) {
    if (username !== null && this.byUsername.has(username)) throw new Error('username_taken');
    const user = {
      id: randomUUID(), username, displayName, passwordHash, email, avatarUrl,
      createdAt: Date.now(), lastLoginAt: null,
      rating: DEFAULT_RATING, ratedGames: 0,
      recoveryEmail: null, recoveryEmailVerifiedAt: null,
    };
    this.users.set(user.id, user);
    if (username !== null) this.byUsername.set(username, user.id);
    return { ...user };
  }

  /** Tạo tài khoản kèm danh tính mạng xã hội trong một bước (tất cả hoặc không gì cả). */
  async createUserWithIdentity(userData, identityData) {
    if (this.identities.has(this._ikey(identityData.provider, identityData.providerUserId))) {
      throw new Error('identity_taken');
    }
    const user = await this.createUser(userData);
    await this.createIdentity({ ...identityData, userId: user.id });
    return user;
  }

  async findUserByUsername(username) {
    const id = this.byUsername.get(username);
    return id ? { ...this.users.get(id) } : null;
  }

  async findUserById(id) {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }

  async setPasswordHash(userId, passwordHash) {
    const u = this.users.get(userId);
    if (u) u.passwordHash = passwordHash;
  }

  /**
   * Xoá tài khoản và mọi dữ liệu gắn với nó: phiên, danh tính mạng xã hội, lịch sử đăng nhập (có IP).
   * Các ván đã chơi được GIỮ (chỉ bỏ liên kết tài khoản, vẫn còn tên hiển thị lúc chơi) để đối thủ còn lịch sử.
   */
  async deleteUser(userId) {
    const u = this.users.get(userId);
    if (!u) return false;
    await this.deleteEmailCodes(userId);
    this.users.delete(userId);
    if (u.username !== null) this.byUsername.delete(u.username);
    for (const [k, i] of this.identities) if (i.userId === userId) this.identities.delete(k);
    for (const [k, s] of this.sessions) if (s.userId === userId) this.sessions.delete(k);
    this.events = this.events.filter((e) => e.userId !== userId);
    for (const g of this.games.values()) {
      if (g.redUserId === userId) g.redUserId = null;
      if (g.blackUserId === userId) g.blackUserId = null;
    }
    return true;
  }

  // ------------------------------------------------------ email khôi phục

  /** Đặt email khôi phục (CHƯA xác minh) và huỷ mã xác minh cũ. */
  async setRecoveryEmail(userId, email) {
    const u = this.users.get(userId);
    if (!u) return;
    u.recoveryEmail = email;
    u.recoveryEmailVerifiedAt = null;
    this.emailCodes.delete(`${userId}:verify_email`);
  }

  /** Đánh dấu email đã xác minh. Ném lỗi mã 'email_taken' nếu tài khoản khác đã xác minh cùng email. */
  async markRecoveryEmailVerified(userId, at = Date.now()) {
    const u = this.users.get(userId);
    if (!u?.recoveryEmail) return;
    const key = u.recoveryEmail.toLowerCase();
    for (const o of this.users.values()) {
      if (o.id !== userId && o.recoveryEmailVerifiedAt && o.recoveryEmail.toLowerCase() === key) {
        throw Object.assign(new Error('email_taken'), { code: 'email_taken' });
      }
    }
    u.recoveryEmailVerifiedAt = at;
  }

  async findUserByVerifiedEmail(email) {
    const key = email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.recoveryEmailVerifiedAt && u.recoveryEmail.toLowerCase() === key) return u;
    }
    return null;
  }

  /** Lưu mã (chỉ băm) cho (tài khoản, mục đích), thay mã cũ và đặt lại số lần sai. */
  async putEmailCode({ userId, purpose, email, codeHash, expiresAt }) {
    this.emailCodes.set(`${userId}:${purpose}`, {
      userId, purpose, email, codeHash, attempts: 0, expiresAt,
    });
  }

  async getEmailCode(userId, purpose) {
    const c = this.emailCodes.get(`${userId}:${purpose}`);
    return c ? { ...c } : null;
  }

  /** Tăng số lần nhập sai, trả về số lần mới. */
  async bumpEmailCodeAttempts(userId, purpose) {
    const c = this.emailCodes.get(`${userId}:${purpose}`);
    if (!c) return 0;
    c.attempts += 1;
    return c.attempts;
  }

  async deleteEmailCodes(userId, purpose = null) {
    for (const k of [...this.emailCodes.keys()]) {
      if (k.startsWith(`${userId}:`) && (purpose === null || k.endsWith(`:${purpose}`))) this.emailCodes.delete(k);
    }
  }

  async touchLogin(userId, at = Date.now()) {
    const u = this.users.get(userId);
    if (u) u.lastLoginAt = at;
  }

  // ------------------------------------------------------------------ danh tính ngoài

  _ikey(provider, providerUserId) {
    return `${provider}\u0000${providerUserId}`;
  }

  async findIdentity(provider, providerUserId) {
    const i = this.identities.get(this._ikey(provider, providerUserId));
    return i ? { ...i } : null;
  }

  async createIdentity({
    userId, provider, providerUserId, email = null, displayName = null, avatarUrl = null,
  }) {
    const key = this._ikey(provider, providerUserId);
    if (this.identities.has(key)) throw new Error('identity_taken');
    for (const i of this.identities.values()) {
      if (i.userId === userId && i.provider === provider) throw new Error('provider_already_linked');
    }
    const identity = {
      provider, providerUserId, userId, email, displayName, avatarUrl,
      createdAt: Date.now(), lastLoginAt: null,
    };
    this.identities.set(key, identity);
    return { ...identity };
  }

  async listIdentities(userId) {
    return [...this.identities.values()]
      .filter((i) => i.userId === userId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((i) => ({ ...i }));
  }

  async deleteIdentity(userId, provider) {
    for (const [key, i] of this.identities) {
      if (i.userId === userId && i.provider === provider) {
        this.identities.delete(key);
        return true;
      }
    }
    return false;
  }

  /** Cập nhật lần đăng nhập gần nhất và ảnh chụp hồ sơ từ nhà cung cấp. */
  async touchIdentityLogin(provider, providerUserId, at = Date.now(), profile = {}) {
    const i = this.identities.get(this._ikey(provider, providerUserId));
    if (!i) return;
    i.lastLoginAt = at;
    if (profile.email != null) i.email = profile.email;
    if (profile.displayName != null) i.displayName = profile.displayName;
    if (profile.avatarUrl != null) i.avatarUrl = profile.avatarUrl;
  }

  // ----------------------------------------------------------------------- phiên

  async createSession({ tokenHash, userId, expiresAt, method, ip = null, userAgent = null }) {
    this.sessions.set(tokenHash, { userId, expiresAt, method, ip, userAgent, createdAt: Date.now() });
  }

  async getSession(tokenHash, now) {
    const s = this.sessions.get(tokenHash);
    return s && s.expiresAt > now ? { userId: s.userId, expiresAt: s.expiresAt } : null;
  }

  async deleteSession(tokenHash) {
    this.sessions.delete(tokenHash);
  }

  /** Thu hồi mọi phiên của người dùng, trừ phiên [keepTokenHash] (null = thu hồi hết). Trả về số phiên đã xoá. */
  async deleteSessionsOfUser(userId, keepTokenHash = null) {
    let n = 0;
    for (const [k, s] of this.sessions) {
      if (s.userId === userId && k !== keepTokenHash) {
        this.sessions.delete(k);
        n++;
      }
    }
    return n;
  }

  /** Dọn phiên, state OAuth và mã đổi token đã hết hạn. Trả về số PHIÊN đã xoá. */
  async purgeExpired(now) {
    let n = 0;
    for (const [k, s] of this.sessions) {
      if (s.expiresAt <= now) {
        this.sessions.delete(k);
        n++;
      }
    }
    for (const [k, c] of this.emailCodes) if (c.expiresAt <= now) this.emailCodes.delete(k);
    for (const m of [this.oauthStates, this.exchangeCodes]) {
      for (const [k, v] of m) if (v.expiresAt <= now) m.delete(k);
    }
    return n;
  }

  // ---------------------------------------------------- dữ liệu tạm của luồng OAuth

  async saveOAuthState({ stateHash, provider, appRedirect, codeVerifier, linkUserId = null, expiresAt }) {
    this.oauthStates.set(stateHash, { provider, appRedirect, codeVerifier, linkUserId, expiresAt });
  }

  /** Lấy và XOÁ (dùng một lần). Trả về null nếu không có hoặc đã hết hạn. */
  async takeOAuthState(stateHash, now) {
    const s = this.oauthStates.get(stateHash);
    this.oauthStates.delete(stateHash);
    return s && s.expiresAt > now ? { ...s } : null;
  }

  async saveExchangeCode({ codeHash, userId, method, expiresAt }) {
    this.exchangeCodes.set(codeHash, { userId, method, expiresAt });
  }

  async takeExchangeCode(codeHash, now) {
    const c = this.exchangeCodes.get(codeHash);
    this.exchangeCodes.delete(codeHash);
    return c && c.expiresAt > now ? { ...c } : null;
  }

  // ------------------------------------------------------------ lịch sử đăng nhập

  async addAuthEvent({
    userId = null, event, method, success, ip = null, userAgent = null, detail = null, at = Date.now(),
  }) {
    this.events.push({
      id: this.nextEventId++, userId, event, method, success, ip, userAgent, detail, createdAt: at,
    });
  }

  /** Mới nhất trước. */
  async listAuthEvents(userId, { limit = 50 } = {}) {
    return this.events
      .filter((e) => e.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  /** Xoá sự kiện cũ hơn [beforeMs]. Trả về số sự kiện đã xoá. */
  async purgeAuthEvents(beforeMs) {
    const keep = this.events.filter((e) => e.createdAt >= beforeMs);
    const removed = this.events.length - keep.length;
    this.events = keep;
    return removed;
  }

  // ------------------------------------------------------------------- ván đấu

  /**
   * Lưu ván và (nếu đủ điều kiện) cập nhật Elo của hai bên. Idempotent: lưu lại cùng một ván không tạo bản ghi
   * thứ hai và KHÔNG cộng điểm lần nữa. Trả về { inserted, rating }; rating là null nếu ván không tính điểm.
   */
  async saveGame(g) {
    const existing = this.games.get(g.id);
    if (existing) return { inserted: false, rating: ratingOfGame(existing) };
    const flat = {
      redUserId: g.red.userId ?? null,
      blackUserId: g.black.userId ?? null,
      redGuest: g.red.guest,
      blackGuest: g.black.guest,
      moveCount: g.moves.length,
    };
    const red = this.users.get(flat.redUserId);
    const black = this.users.get(flat.blackUserId);
    let rating = null;
    if (red && black && isRatedGame(flat, this.ratedMinMoves)) {
      rating = computeRatings(
        { rating: red.rating, games: red.ratedGames },
        { rating: black.rating, games: black.ratedGames },
        g.result,
      );
      red.rating = rating.red.after;
      red.ratedGames += 1;
      black.rating = rating.black.after;
      black.ratedGames += 1;
    }
    this.games.set(g.id, {
      id: g.id,
      roomId: g.roomId,
      redUserId: g.red.userId ?? null,
      blackUserId: g.black.userId ?? null,
      redName: g.red.name,
      blackName: g.black.name,
      redGuest: g.red.guest,
      blackGuest: g.black.guest,
      baseMs: g.timeControl?.baseMs ?? null,
      incrementMs: g.timeControl?.incrementMs ?? null,
      result: g.result,
      endReason: g.endReason,
      moveCount: g.moves.length,
      moves: structuredClone(g.moves),
      redRemainingMs: g.clock?.redMs ?? null,
      blackRemainingMs: g.clock?.blackMs ?? null,
      startedAt: g.startedAt,
      endedAt: g.endedAt,
      rated: rating !== null,
      redRatingBefore: rating?.red.before ?? null,
      redRatingAfter: rating?.red.after ?? null,
      blackRatingBefore: rating?.black.before ?? null,
      blackRatingAfter: rating?.black.after ?? null,
    });
    return { inserted: true, rating };
  }

  async getGame(id) {
    const g = this.games.get(id);
    return g ? structuredClone(g) : null;
  }

  /** Các ván của một tài khoản (mới nhất trước), không kèm danh sách nước đi. */
  async listGamesOfUser(userId, { limit = 20, before = null } = {}) {
    return [...this.games.values()]
      .filter((g) => g.redUserId === userId || g.blackUserId === userId)
      .filter((g) => before === null || g.endedAt < before)
      .sort((a, b) => b.endedAt - a.endedAt)
      .slice(0, limit)
      .map(({ moves, ...summary }) => ({ ...summary }));
  }

  async statsOfUser(userId) {
    let total = 0;
    let wins = 0;
    let losses = 0;
    let draws = 0;
    for (const g of this.games.values()) {
      const side = g.redUserId === userId ? 'red' : g.blackUserId === userId ? 'black' : null;
      if (!side) continue;
      total++;
      if (g.result === 'draw') draws++;
      else if (g.result === side) wins++;
      else losses++;
    }
    return { total, wins, losses, draws };
  }

  // ------------------------------------------------------------------ xếp hạng Elo

  /** { rating, ratedGames, rank } của một tài khoản; rank là null nếu chưa có ván tính điểm. null nếu không có tài khoản. */
  async getRating(userId) {
    const u = this.users.get(userId);
    if (!u) return null;
    const rank = u.ratedGames === 0
      ? null
      : 1 + [...this.users.values()].filter((x) => x.ratedGames > 0 && x.rating > u.rating).length;
    return { rating: u.rating, ratedGames: u.ratedGames, rank };
  }

  /**
   * Bảng xếp hạng: chỉ người có ít nhất một ván tính điểm. Cùng điểm thì CÙNG hạng (hạng kiểu thi đấu: 1, 2, 2, 4).
   * Trong cùng hạng: nhiều ván hơn đứng trước, rồi theo id.
   */
  async listLeaderboard({ limit = 50, offset = 0 } = {}) {
    const rated = [...this.users.values()]
      .filter((u) => u.ratedGames > 0)
      .sort((a, b) => b.rating - a.rating || b.ratedGames - a.ratedGames || (a.id < b.id ? -1 : 1));
    return rated.slice(offset, offset + limit).map((u) => ({
      rank: 1 + rated.filter((x) => x.rating > u.rating).length,
      userId: u.id,
      displayName: u.displayName,
      avatarUrl: u.avatarUrl,
      rating: u.rating,
      ratedGames: u.ratedGames,
    }));
  }

  /** Tính lại toàn bộ Elo từ lịch sử ván (theo thứ tự thời gian). Dùng để vá dữ liệu hoặc áp Elo cho ván cũ. */
  async rebuildRatings() {
    for (const u of this.users.values()) {
      u.rating = DEFAULT_RATING;
      u.ratedGames = 0;
    }
    let rated = 0;
    const games = [...this.games.values()].sort((a, b) => a.endedAt - b.endedAt || (a.id < b.id ? -1 : 1));
    for (const g of games) {
      Object.assign(g, {
        rated: false, redRatingBefore: null, redRatingAfter: null, blackRatingBefore: null, blackRatingAfter: null,
      });
      const red = this.users.get(g.redUserId);
      const black = this.users.get(g.blackUserId);
      if (!red || !black || !isRatedGame(g, this.ratedMinMoves)) continue;
      const r = computeRatings(
        { rating: red.rating, games: red.ratedGames },
        { rating: black.rating, games: black.ratedGames },
        g.result,
      );
      red.rating = r.red.after; red.ratedGames += 1;
      black.rating = r.black.after; black.ratedGames += 1;
      Object.assign(g, {
        rated: true,
        redRatingBefore: r.red.before, redRatingAfter: r.red.after,
        blackRatingBefore: r.black.before, blackRatingAfter: r.black.after,
      });
      rated++;
    }
    return { games: games.length, rated };
  }
}

/** Điểm trước/sau của một ván đã lưu, hoặc null nếu ván không tính điểm. */
function ratingOfGame(g) {
  if (!g.rated) return null;
  const side = (before, after) => ({ before, after, delta: after - before });
  return {
    red: side(g.redRatingBefore, g.redRatingAfter),
    black: side(g.blackRatingBefore, g.blackRatingAfter),
  };
}
