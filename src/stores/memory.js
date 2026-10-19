import { randomUUID } from 'node:crypto';

/**
 * Kho lưu trong bộ nhớ: dùng cho test và chạy thử khi chưa cấu hình DATABASE_URL.
 * TẮT SERVER LÀ MẤT HẾT DỮ LIỆU. Giao diện và hành vi (kể cả các lỗi như 'username_taken')
 * giống hệt PgStore; bộ test hợp đồng (test/store.test.js) chạy cùng một bộ kiểm tra trên cả hai.
 */
export class MemoryStore {
  constructor() {
    this.users = new Map(); // id -> user
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

  /** Dọn phiên, state OAuth và mã đổi token đã hết hạn. Trả về số PHIÊN đã xoá. */
  async purgeExpired(now) {
    let n = 0;
    for (const [k, s] of this.sessions) {
      if (s.expiresAt <= now) {
        this.sessions.delete(k);
        n++;
      }
    }
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

  async saveGame(g) {
    if (this.games.has(g.id)) return; // idempotent: lưu lại cùng một ván không tạo bản ghi thứ hai
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
    });
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
}
