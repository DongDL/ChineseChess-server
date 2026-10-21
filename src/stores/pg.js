import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../migrate.js';
import {
  DEFAULT_RATING, RATED_MIN_MOVES, computeRatings, isRatedGame,
} from '../elo.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toMs = (d) => (d ? d.getTime() : null);
const toDate = (ms) => (ms === null || ms === undefined ? null : new Date(ms));

const userOf = (r) => r && {
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  passwordHash: r.password_hash,
  email: r.email,
  recoveryEmail: r.recovery_email,
  recoveryEmailVerifiedAt: toMs(r.recovery_email_verified_at),
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
  rated: r.rated,
  redRatingBefore: r.red_rating_before,
  redRatingAfter: r.red_rating_after,
  blackRatingBefore: r.black_rating_before,
  blackRatingAfter: r.black_rating_after,
});

/** Điểm trước/sau của một ván đã lưu, hoặc null nếu ván không tính điểm. */
const ratingOfRow = (r) => {
  if (!r.rated) return null;
  const side = (before, after) => ({ before, after, delta: after - before });
  return {
    red: side(r.red_rating_before, r.red_rating_after),
    black: side(r.black_rating_before, r.black_rating_after),
  };
};

/**
 * Kho lưu trữ PostgreSQL. Cùng giao diện với MemoryStore.
 * Mọi truy vấn dùng tham số ($1, $2, ...) nên không có nguy cơ SQL injection.
 */
export class PgStore {
  constructor({ connectionString, pool, ratedMinMoves = RATED_MIN_MOVES } = {}) {
    this.ratedMinMoves = ratedMinMoves;
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

  async setPasswordHash(userId, passwordHash) {
    await this.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
  }

  /**
   * Xoá tài khoản và mọi dữ liệu gắn với nó: phiên, danh tính mạng xã hội (xoá theo khoá ngoại) và lịch sử đăng nhập
   * (có IP, xoá hẳn thay vì chỉ bỏ liên kết). Các ván đã chơi được GIỮ (cột user thành NULL, vẫn còn tên hiển thị).
   */
  async deleteUser(userId) {
    if (!UUID_RE.test(String(userId))) return false;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM auth_events WHERE user_id = $1', [userId]);
      const r = await client.query('DELETE FROM users WHERE id = $1', [userId]);
      await client.query('COMMIT');
      return r.rowCount > 0;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------ email khôi phục

  /** Đặt email khôi phục (CHƯA xác minh) và huỷ mã xác minh cũ. */
  async setRecoveryEmail(userId, email) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET recovery_email = $2, recovery_email_verified_at = NULL WHERE id = $1',
        [userId, email],
      );
      await client.query("DELETE FROM email_codes WHERE user_id = $1 AND purpose = 'verify_email'", [userId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Đánh dấu email đã xác minh. Ném lỗi mã 'email_taken' nếu tài khoản khác đã xác minh cùng email. */
  async markRecoveryEmailVerified(userId, at = Date.now()) {
    try {
      await this.pool.query(
        'UPDATE users SET recovery_email_verified_at = $2 WHERE id = $1 AND recovery_email IS NOT NULL',
        [userId, toDate(at)],
      );
    } catch (err) {
      if (err.code === '23505') throw Object.assign(new Error('email_taken'), { code: 'email_taken' });
      throw err;
    }
  }

  async findUserByVerifiedEmail(email) {
    const { rows } = await this.pool.query(
      'SELECT * FROM users WHERE lower(recovery_email) = lower($1) AND recovery_email_verified_at IS NOT NULL',
      [email],
    );
    return userOf(rows[0]) ?? null;
  }

  /** Lưu mã (chỉ băm) cho (tài khoản, mục đích), thay mã cũ và đặt lại số lần sai. */
  async putEmailCode({ userId, purpose, email, codeHash, expiresAt }) {
    await this.pool.query(
      `INSERT INTO email_codes (user_id, purpose, email, code_hash, attempts, expires_at)
       VALUES ($1, $2, $3, $4, 0, $5)
       ON CONFLICT (user_id, purpose) DO UPDATE
         SET email = $3, code_hash = $4, attempts = 0, expires_at = $5, created_at = now()`,
      [userId, purpose, email, codeHash, toDate(expiresAt)],
    );
  }

  async getEmailCode(userId, purpose) {
    const { rows } = await this.pool.query(
      'SELECT * FROM email_codes WHERE user_id = $1 AND purpose = $2',
      [userId, purpose],
    );
    const r = rows[0];
    return r ? {
      userId: r.user_id, purpose: r.purpose, email: r.email, codeHash: r.code_hash,
      attempts: r.attempts, expiresAt: toMs(r.expires_at),
    } : null;
  }

  /** Tăng số lần nhập sai (nguyên tử), trả về số lần mới. */
  async bumpEmailCodeAttempts(userId, purpose) {
    const { rows } = await this.pool.query(
      'UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = $1 AND purpose = $2 RETURNING attempts',
      [userId, purpose],
    );
    return rows[0]?.attempts ?? 0;
  }

  async deleteEmailCodes(userId, purpose = null) {
    await this.pool.query(
      'DELETE FROM email_codes WHERE user_id = $1 AND ($2::text IS NULL OR purpose = $2)',
      [userId, purpose],
    );
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

  /** Thu hồi mọi phiên của người dùng, trừ phiên [keepTokenHash] (null = thu hồi hết). Trả về số phiên đã xoá. */
  async deleteSessionsOfUser(userId, keepTokenHash = null) {
    const r = await this.pool.query(
      'DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR token_hash <> $2)',
      [userId, keepTokenHash],
    );
    return r.rowCount;
  }

  /** Dọn phiên, state OAuth và mã đổi token đã hết hạn. Trả về số PHIÊN đã xoá. */
  async purgeExpired(now) {
    const d = toDate(now);
    const r = await this.pool.query('DELETE FROM sessions WHERE expires_at <= $1', [d]);
    await this.pool.query('DELETE FROM email_codes WHERE expires_at <= $1', [d]);
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

  /**
   * Lưu ván và (nếu đủ điều kiện) cập nhật Elo của hai bên TRONG CÙNG MỘT transaction, nên không bao giờ có chuyện
   * ván đã lưu mà điểm chưa đổi (hoặc ngược lại). Idempotent: lưu lại cùng một ván không cộng điểm lần hai.
   * Hai dòng người dùng được khoá theo thứ tự id để hai ván đồng thời của cùng một người không gây deadlock.
   * Trả về { inserted, rating }; rating là null nếu ván không tính điểm.
   */
  async saveGame(g) {
    try {
      return await this._saveGameTx(g, g.red.userId ?? null, g.black.userId ?? null);
    } catch (err) {
      // Tài khoản đã bị xoá giữa chừng (vi phạm khoá ngoại): vẫn lưu ván, chỉ bỏ liên kết tài khoản (và không tính điểm).
      if (err.code !== '23503') throw err;
      return this._saveGameTx(g, null, null);
    }
  }

  async _saveGameTx(g, redUserId, blackUserId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Khoá hai dòng người dùng TRƯỚC khi chèn ván (theo thứ tự id). Nếu chèn trước, khoá khoá-ngoại (FOR KEY SHARE)
      // mà INSERT lấy trên dòng người dùng sẽ xung đột khi sau đó xin FOR UPDATE -> deadlock giữa hai ván đồng thời.
      const flat = {
        redUserId, blackUserId, redGuest: g.red.guest, blackGuest: g.black.guest, moveCount: g.moves.length,
      };
      let locked = [];
      if (isRatedGame(flat, this.ratedMinMoves)) {
        locked = (await client.query(
          'SELECT id, rating, rated_games FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [[redUserId, blackUserId]],
        )).rows;
      }
      const ins = await client.query(
        `INSERT INTO games (id, room_id, red_user_id, black_user_id, red_name, black_name, red_guest, black_guest,
           base_ms, increment_ms, result, end_reason, move_count, moves, red_remaining_ms, black_remaining_ms,
           started_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [
          g.id, g.roomId, redUserId, blackUserId, g.red.name, g.black.name, g.red.guest, g.black.guest,
          g.timeControl?.baseMs ?? null, g.timeControl?.incrementMs ?? null, g.result, g.endReason,
          g.moves.length, JSON.stringify(g.moves), g.clock?.redMs ?? null, g.clock?.blackMs ?? null,
          toDate(g.startedAt), toDate(g.endedAt),
        ],
      );
      if (ins.rowCount === 0) {
        const { rows } = await client.query('SELECT * FROM games WHERE id = $1', [g.id]);
        await client.query('COMMIT');
        return { inserted: false, rating: rows[0] ? ratingOfRow(rows[0]) : null };
      }

      let rating = null;
      {
        const red = locked.find((r) => r.id === redUserId);
        const black = locked.find((r) => r.id === blackUserId);
        if (red && black) {
          rating = computeRatings(
            { rating: red.rating, games: red.rated_games },
            { rating: black.rating, games: black.rated_games },
            g.result,
          );
          const upd = 'UPDATE users SET rating = $2, rated_games = rated_games + 1 WHERE id = $1';
          await client.query(upd, [redUserId, rating.red.after]);
          await client.query(upd, [blackUserId, rating.black.after]);
          await client.query(
            `UPDATE games SET rated = true, red_rating_before = $2, red_rating_after = $3,
               black_rating_before = $4, black_rating_after = $5 WHERE id = $1`,
            [g.id, rating.red.before, rating.red.after, rating.black.before, rating.black.after],
          );
        }
      }
      await client.query('COMMIT');
      return { inserted: true, rating };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
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
              started_at, ended_at, rated, red_rating_before, red_rating_after, black_rating_before, black_rating_after
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

  // ------------------------------------------------------------------ xếp hạng Elo

  /** { rating, ratedGames, rank } của một tài khoản; rank là null nếu chưa có ván tính điểm. null nếu không có tài khoản. */
  async getRating(userId) {
    if (!UUID_RE.test(String(userId))) return null;
    const { rows } = await this.pool.query(
      `SELECT rating, rated_games,
         CASE WHEN rated_games > 0
           THEN 1 + (SELECT count(*) FROM users o WHERE o.rated_games > 0 AND o.rating > u.rating) END AS rank
       FROM users u WHERE id = $1`,
      [userId],
    );
    const r = rows[0];
    return r ? { rating: r.rating, ratedGames: r.rated_games, rank: r.rank === null ? null : Number(r.rank) } : null;
  }

  /** Bảng xếp hạng (chỉ người có ít nhất một ván tính điểm). Cùng điểm thì cùng hạng (1, 2, 2, 4). */
  async listLeaderboard({ limit = 50, offset = 0 } = {}) {
    const { rows } = await this.pool.query(
      `SELECT * FROM (
         SELECT id, display_name, avatar_url, rating, rated_games,
                RANK() OVER (ORDER BY rating DESC) AS rank
           FROM users WHERE rated_games > 0
       ) t
       ORDER BY rating DESC, rated_games DESC, id
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map((r) => ({
      rank: Number(r.rank),
      userId: r.id,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      rating: r.rating,
      ratedGames: r.rated_games,
    }));
  }

  /**
   * Tính lại toàn bộ Elo từ lịch sử ván (theo thứ tự thời gian), trong một transaction và chặn ghi trong lúc chạy.
   * Dùng để áp Elo cho ván cũ hoặc vá dữ liệu: npm run ratings:rebuild.
   */
  async rebuildRatings() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE users, games IN EXCLUSIVE MODE');
      await client.query('UPDATE users SET rating = $1, rated_games = 0', [DEFAULT_RATING]);
      await client.query(`UPDATE games SET rated = false, red_rating_before = NULL, red_rating_after = NULL,
        black_rating_before = NULL, black_rating_after = NULL`);
      const { rows: games } = await client.query(
        `SELECT id, red_user_id, black_user_id, red_guest, black_guest, result, move_count
           FROM games ORDER BY ended_at, id`,
      );
      const state = new Map(); // userId -> { rating, games }
      const of = (id) => {
        if (!state.has(id)) state.set(id, { rating: DEFAULT_RATING, games: 0 });
        return state.get(id);
      };
      let rated = 0;
      for (const g of games) {
        const flat = {
          redUserId: g.red_user_id, blackUserId: g.black_user_id,
          redGuest: g.red_guest, blackGuest: g.black_guest, moveCount: g.move_count,
        };
        if (!isRatedGame(flat, this.ratedMinMoves)) continue;
        const red = of(g.red_user_id);
        const black = of(g.black_user_id);
        const r = computeRatings(red, black, g.result);
        red.rating = r.red.after; red.games += 1;
        black.rating = r.black.after; black.games += 1;
        await client.query(
          `UPDATE games SET rated = true, red_rating_before = $2, red_rating_after = $3,
             black_rating_before = $4, black_rating_after = $5 WHERE id = $1`,
          [g.id, r.red.before, r.red.after, r.black.before, r.black.after],
        );
        rated++;
      }
      for (const [id, s] of state) {
        await client.query('UPDATE users SET rating = $2, rated_games = $3 WHERE id = $1', [id, s.rating, s.games]);
      }
      await client.query('COMMIT');
      return { games: games.length, rated };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
