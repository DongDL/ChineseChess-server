import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../migrate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toMs = (d) => (d ? d.getTime() : null);
const toDate = (ms) => (ms === null || ms === undefined ? null : new Date(ms));

const userOf = (r) => r && {
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  passwordHash: r.password_hash,
  email: r.email,
  avatarUrl: r.avatar_url,
  createdAt: toMs(r.created_at),
  lastLoginAt: toMs(r.last_login_at),
};

const identityOf = (r) => r && {
  provider: r.provider,
  providerUserId: r.provider_user_id,
  userId: r.user_id,
  email: r.email,
  displayName: r.display_name,
  avatarUrl: r.avatar_url,
  createdAt: toMs(r.created_at),
  lastLoginAt: toMs(r.last_login_at),
};

const gameSummaryOf = (r) => ({
  id: r.id,
  roomId: r.room_id,
  redUserId: r.red_user_id,
  blackUserId: r.black_user_id,
  redName: r.red_name,
  blackName: r.black_name,
  redGuest: r.red_guest,
  blackGuest: r.black_guest,
  baseMs: r.base_ms,
  incrementMs: r.increment_ms,
  result: r.result,
  endReason: r.end_reason,
  moveCount: r.move_count,
  redRemainingMs: r.red_remaining_ms,
  blackRemainingMs: r.black_remaining_ms,
  startedAt: toMs(r.started_at),
  endedAt: toMs(r.ended_at),
});

/**
 * Kho lưu trữ PostgreSQL. Cùng giao diện với MemoryStore.
 * Mọi truy vấn dùng tham số ($1, $2, ...) nên không có nguy cơ SQL injection.
 */
export class PgStore {
  constructor({ connectionString, pool } = {}) {
    this.pool = pool ?? new pg.Pool({ connectionString, max: 10 });
    this.pool.on('error', (err) => console.error('[pg] lỗi kết nối nhàn rỗi:', err.message));
  }

  /** Tạo/nâng cấp bảng theo các file trong migrations/. Gọi một lần lúc khởi động. */
  migrate(opts) {
    return migrate(this.pool, opts);
  }

  close() {
    return this.pool.end();
  }

  /** Chỉ dùng trong test: xoá sạch dữ liệu. */
  async _truncateAllForTests() {
    await this.pool.query(`TRUNCATE auth_events, oauth_codes, oauth_states, sessions,
      oauth_identities, games, users RESTART IDENTITY CASCADE`);
  }

  // --------------------------------------------------------------------- người dùng

  async createUser(u, client = this.pool) {
    try {
      const { rows } = await client.query(
        `INSERT INTO users (id, username, display_name, password_hash, email, avatar_url)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [randomUUID(), u.username ?? null, u.displayName, u.passwordHash ?? null, u.email ?? null, u.avatarUrl ?? null],
      );
      return userOf(rows[0]);
    } catch (err) {
      if (err.code === '23505') throw new Error('username_taken');
      throw err;
    }
  }

  async createUserWithIdentity(userData, identity) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = await this.createUser(userData, client);
      await this._insertIdentity(client, { ...identity, userId: user.id });
      await client.query('COMMIT');
      return user;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async findUserByUsername(username) {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return userOf(rows[0]) ?? null;
  }

  async findUserById(id) {
    if (!UUID_RE.test(String(id))) return null;
    const { rows } = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return userOf(rows[0]) ?? null;
  }

  async touchLogin(userId, at = Date.now()) {
    await this.pool.query('UPDATE users SET last_login_at = $2 WHERE id = $1', [userId, toDate(at)]);
  }

  // ------------------------------------------------------------------ danh tính ngoài

  async _insertIdentity(client, i) {
    try {
      const { rows } = await client.query(
        `INSERT INTO oauth_identities (provider, provider_user_id, user_id, email, display_name, avatar_url)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [i.provider, i.providerUserId, i.userId, i.email ?? null, i.displayName ?? null, i.avatarUrl ?? null],
      );
      return identityOf(rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        // PK (provider, provider_user_id): danh tính đã thuộc một tài khoản khác.
        // UNIQUE (user_id, provider): tài khoản này đã liên kết nhà cung cấp đó rồi.
        throw new Error(err.constraint === 'oauth_identities_pkey' ? 'identity_taken' : 'provider_already_linked');
      }
      throw err;
    }
  }

  createIdentity(i) {
    return this._insertIdentity(this.pool, i);
  }

  async findIdentity(provider, providerUserId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM oauth_identities WHERE provider = $1 AND provider_user_id = $2',
      [provider, providerUserId],
    );
    return identityOf(rows[0]) ?? null;
  }

  async listIdentities(userId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM oauth_identities WHERE user_id = $1 ORDER BY created_at, provider',
      [userId],
    );
    return rows.map(identityOf);
  }

  async deleteIdentity(userId, provider) {
    const r = await this.pool.query(
      'DELETE FROM oauth_identities WHERE user_id = $1 AND provider = $2',
      [userId, provider],
    );
    return r.rowCount > 0;
  }

  async touchIdentityLogin(provider, providerUserId, at = Date.now(), profile = {}) {
    await this.pool.query(
      `UPDATE oauth_identities SET last_login_at = $3,
         email = COALESCE($4, email), display_name = COALESCE($5, display_name),
         avatar_url = COALESCE($6, avatar_url)
       WHERE provider = $1 AND provider_user_id = $2`,
      [provider, providerUserId, toDate(at), profile.email ?? null, profile.displayName ?? null, profile.avatarUrl ?? null],
    );
  }

  // ----------------------------------------------------------------------- phiên

  async createSession({ tokenHash, userId, expiresAt, method, ip = null, userAgent = null }) {
    await this.pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at, method, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tokenHash, userId, toDate(expiresAt), method, ip, userAgent],
    );
  }

  async getSession(tokenHash, now) {
    const { rows } = await this.pool.query(
      'SELECT user_id, expires_at FROM sessions WHERE token_hash = $1 AND expires_at > $2',
      [tokenHash, toDate(now)],
    );
    return rows[0] ? { userId: rows[0].user_id, expiresAt: toMs(rows[0].expires_at) } : null;
  }

  async deleteSession(tokenHash) {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  /** Dọn phiên, state OAuth và mã đổi token đã hết hạn. Trả về số PHIÊN đã xoá. */
  async purgeExpired(now) {
    const d = toDate(now);
    const r = await this.pool.query('DELETE FROM sessions WHERE expires_at <= $1', [d]);
    await this.pool.query('DELETE FROM oauth_states WHERE expires_at <= $1', [d]);
    await this.pool.query('DELETE FROM oauth_codes WHERE expires_at <= $1', [d]);
    return r.rowCount;
  }

  // ---------------------------------------------------- dữ liệu tạm của luồng OAuth

  async saveOAuthState({ stateHash, provider, appRedirect, codeVerifier, linkUserId = null, expiresAt }) {
    await this.pool.query(
      `INSERT INTO oauth_states (state_hash, provider, app_redirect, code_verifier, link_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [stateHash, provider, appRedirect, codeVerifier, linkUserId, toDate(expiresAt)],
    );
  }

  /** Lấy và XOÁ trong một câu lệnh (dùng một lần, an toàn khi hai yêu cầu đến cùng lúc). */
  async takeOAuthState(stateHash, now) {
    const { rows } = await this.pool.query(
      'DELETE FROM oauth_states WHERE state_hash = $1 RETURNING *',
      [stateHash],
    );
    const r = rows[0];
    if (!r || r.expires_at.getTime() <= now) return null;
    return {
      provider: r.provider,
      appRedirect: r.app_redirect,
      codeVerifier: r.code_verifier,
      linkUserId: r.link_user_id,
      expiresAt: toMs(r.expires_at),
    };
  }

  async saveExchangeCode({ codeHash, userId, method, expiresAt }) {
    await this.pool.query(
      'INSERT INTO oauth_codes (code_hash, user_id, method, expires_at) VALUES ($1, $2, $3, $4)',
      [codeHash, userId, method, toDate(expiresAt)],
    );
  }

  async takeExchangeCode(codeHash, now) {
    const { rows } = await this.pool.query('DELETE FROM oauth_codes WHERE code_hash = $1 RETURNING *', [codeHash]);
    const r = rows[0];
    if (!r || r.expires_at.getTime() <= now) return null;
    return { userId: r.user_id, method: r.method, expiresAt: toMs(r.expires_at) };
  }

  // ------------------------------------------------------------ lịch sử đăng nhập

  async addAuthEvent({
    userId = null, event, method, success, ip = null, userAgent = null, detail = null, at = Date.now(),
  }) {
    await this.pool.query(
      `INSERT INTO auth_events (user_id, event, method, success, ip, user_agent, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, event, method, success, ip, userAgent, detail, toDate(at)],
    );
  }

  async listAuthEvents(userId, { limit = 50 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT * FROM auth_events WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      userId: r.user_id,
      event: r.event,
      method: r.method,
      success: r.success,
      ip: r.ip,
      userAgent: r.user_agent,
      detail: r.detail,
      createdAt: toMs(r.created_at),
    }));
  }

  async purgeAuthEvents(beforeMs) {
    const r = await this.pool.query('DELETE FROM auth_events WHERE created_at < $1', [toDate(beforeMs)]);
    return r.rowCount;
  }

  // ------------------------------------------------------------------- ván đấu

  async saveGame(g) {
    const insert = (redUserId, blackUserId) => this.pool.query(
      `INSERT INTO games (id, room_id, red_user_id, black_user_id, red_name, black_name, red_guest, black_guest,
         base_ms, increment_ms, result, end_reason, move_count, moves, red_remaining_ms, black_remaining_ms,
         started_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18)
       ON CONFLICT (id) DO NOTHING`,
      [
        g.id, g.roomId, redUserId, blackUserId, g.red.name, g.black.name, g.red.guest, g.black.guest,
        g.timeControl?.baseMs ?? null, g.timeControl?.incrementMs ?? null, g.result, g.endReason,
        g.moves.length, JSON.stringify(g.moves), g.clock?.redMs ?? null, g.clock?.blackMs ?? null,
        toDate(g.startedAt), toDate(g.endedAt),
      ],
    );
    try {
      await insert(g.red.userId ?? null, g.black.userId ?? null);
    } catch (err) {
      // Tài khoản đã bị xoá giữa chừng (vi phạm khoá ngoại): vẫn lưu ván, chỉ bỏ liên kết tài khoản.
      if (err.code !== '23503') throw err;
      await insert(null, null);
    }
  }

  async getGame(id) {
    if (!UUID_RE.test(String(id))) return null;
    const { rows } = await this.pool.query('SELECT * FROM games WHERE id = $1', [id]);
    return rows[0] ? { ...gameSummaryOf(rows[0]), moves: rows[0].moves } : null;
  }

  async listGamesOfUser(userId, { limit = 20, before = null } = {}) {
    const { rows } = await this.pool.query(
      `SELECT id, room_id, red_user_id, black_user_id, red_name, black_name, red_guest, black_guest,
              base_ms, increment_ms, result, end_reason, move_count, red_remaining_ms, black_remaining_ms,
              started_at, ended_at
         FROM games
        WHERE (red_user_id = $1 OR black_user_id = $1) AND ($2::timestamptz IS NULL OR ended_at < $2)
        ORDER BY ended_at DESC
        LIMIT $3`,
      [userId, toDate(before), limit],
    );
    return rows.map(gameSummaryOf);
  }

  async statsOfUser(userId) {
    const { rows } = await this.pool.query(
      `SELECT count(*) AS total,
         count(*) FILTER (WHERE (red_user_id = $1 AND result = 'red') OR (black_user_id = $1 AND result = 'black')) AS wins,
         count(*) FILTER (WHERE (red_user_id = $1 AND result = 'black') OR (black_user_id = $1 AND result = 'red')) AS losses,
         count(*) FILTER (WHERE result = 'draw') AS draws
       FROM games WHERE red_user_id = $1 OR black_user_id = $1`,
      [userId],
    );
    const r = rows[0];
    return { total: Number(r.total), wins: Number(r.wins), losses: Number(r.losses), draws: Number(r.draws) };
  }
}
