import { AuthError } from './auth.js';
import { PROVISIONAL_GAMES, normalizeRatingVariant } from './elo.js';
import { bearerToken, makeJsonSender, sendError } from './http-util.js';

const GAME_ID = /^\/games\/([0-9a-f-]{36})$/i;

const clampInt = (raw, def, min, max) => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

const parseVariant = (raw) => {
  try { return normalizeRatingVariant(raw ?? 'xiangqi'); } catch { throw new AuthError('bad_variant', 400); }
};

const ratingChangeOf = (g, side) => {
  const before = side === 'red' ? g.redRatingBefore : g.blackRatingBefore;
  const after = side === 'red' ? g.redRatingAfter : g.blackRatingAfter;
  return { before, after, delta: after - before };
};

/** Tóm tắt một ván theo góc nhìn của [userId]. */
function summaryFor(g, userId) {
  const mySide = g.redUserId === userId ? 'red' : 'black';
  return {
    id: g.id,
    variant: g.variant ?? 'xiangqi',
    mySide,
    rated: g.rated,
    ratingChange: g.rated ? ratingChangeOf(g, mySide) : null,
    outcome: g.result === 'draw' ? 'draw' : g.result === mySide ? 'win' : 'loss',
    result: g.result,
    endReason: g.endReason,
    opponentName: mySide === 'red' ? g.blackName : g.redName,
    opponentGuest: mySide === 'red' ? g.blackGuest : g.redGuest,
    moveCount: g.moveCount,
    baseMs: g.baseMs,
    incrementMs: g.incrementMs,
    startedAt: g.startedAt,
    endedAt: g.endedAt,
  };
}

const replayMovesFor = (g, viewerUserId) => {
  const viewerSide = viewerUserId && g.redUserId === viewerUserId
    ? 'red'
    : viewerUserId && g.blackUserId === viewerUserId ? 'black' : null;
  return g.moves.map((move, index) => {
    const moverSide = move.moverSide ?? (index % 2 === 0 ? 'red' : 'black');
    const projected = { ...move };
    delete projected.moverSide;
    if (projected.capturedType == null
        || (projected.capturedWasFaceDown === true && viewerSide !== moverSide)) {
      delete projected.capturedType;
    }
    return projected;
  });
};

/** Chi tiết replay công khai, có thêm bí mật đúng từng nước cho participant xác thực. */
function gameDetailFor(g, viewerUserId = null) {
  return {
    id: g.id,
    variant: g.variant ?? 'xiangqi',
    redName: g.redName,
    blackName: g.blackName,
    redGuest: g.redGuest,
    blackGuest: g.blackGuest,
    baseMs: g.baseMs,
    incrementMs: g.incrementMs,
    result: g.result,
    endReason: g.endReason,
    moveCount: g.moveCount,
    moves: replayMovesFor(g, viewerUserId),
    rated: g.rated,
    ratings: g.rated
      ? {
        red: { before: g.redRatingBefore, after: g.redRatingAfter },
        black: { before: g.blackRatingBefore, after: g.blackRatingAfter },
      }
      : null,
    redRemainingMs: g.redRemainingMs,
    blackRemainingMs: g.blackRemainingMs,
    startedAt: g.startedAt,
    endedAt: g.endedAt,
  };
}

/**
 * Lịch sử và ván đấu:
 *
 *   GET /me/games?limit=20&before=<endedAt ms>  (Bearer) -> { ok, games: [...], nextBefore }
 *   GET /me/stats                               (Bearer) -> { ok, stats: { total, wins, losses, draws } }
 *   GET /me/logins?limit=30                     (Bearer) -> { ok, events: [...] }  (lịch sử đăng nhập của chính bạn)
 *   GET /me/rating                              (Bearer) -> { ok, rating: { rating, ratedGames, rank, provisional } }
 *   GET /leaderboard?limit=50&offset=0          (Bearer tuỳ chọn, để đánh dấu isMe) -> { ok, players: [...], nextOffset }
 *   GET /games/:id                              -> { ok, game }  (công khai đã che; Bearer tuỳ chọn cấp góc nhìn participant)
 *
 * Chi tiết ván không lộ id tài khoản, mã phòng, seed hoặc loại thật quân úp ngoài quyền.
 */
export function createApiRoutes(auth, store, { corsOrigin = '*' } = {}) {
  const send = makeJsonSender(corsOrigin);

  const requireUser = async (req) => {
    const user = await auth.authenticate(bearerToken(req));
    if (!user) throw new AuthError('invalid_token', 401);
    return user;
  };

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    if (!pathname.startsWith('/me/') && !pathname.startsWith('/games/') && pathname !== '/leaderboard') return false;

    if (req.method === 'OPTIONS') {
      send(res, 204, {});
      return true;
    }

    try {
      if (req.method !== 'GET') throw new AuthError('not_found', 404);
      const q = url.searchParams;
      const gameMatch = GAME_ID.exec(pathname);

      if (pathname === '/me/games') {
        const user = await requireUser(req);
        const variant = parseVariant(q.get('variant'));
        const limit = clampInt(q.get('limit'), 20, 1, 50);
        const beforeRaw = q.get('before');
        const before = beforeRaw === null ? null : clampInt(beforeRaw, null, 0, Number.MAX_SAFE_INTEGER);
        const games = await store.listGamesOfUser(user.id, { limit, before, variant });
        send(res, 200, {
          ok: true,
          games: games.map((g) => summaryFor(g, user.id)),
          nextBefore: games.length === limit ? games[games.length - 1].endedAt : null,
        });
      } else if (pathname === '/me/stats') {
        const user = await requireUser(req);
        const variant = parseVariant(q.get('variant'));
        send(res, 200, { ok: true, variant, stats: await store.statsOfUser(user.id, { variant }) });
      } else if (pathname === '/me/rating') {
        const user = await requireUser(req);
        const variant = parseVariant(q.get('variant'));
        const r = await store.getRating(user.id, variant);
        if (!r) throw new AuthError('not_found', 404);
        send(res, 200, { ok: true, variant, rating: { ...r, provisional: r.ratedGames < PROVISIONAL_GAMES } });
      } else if (pathname === '/leaderboard') {
        const me = await auth.authenticate(bearerToken(req)).catch(() => null);
        const variant = parseVariant(q.get('variant'));
        const limit = clampInt(q.get('limit'), 50, 1, 100);
        const offset = clampInt(q.get('offset'), 0, 0, 100_000);
        const rows = await store.listLeaderboard({ limit, offset, variant });
        send(res, 200, {
          ok: true,
          variant,
          // Không lộ id tài khoản của ai; chỉ cờ isMe cho chính người đang xem.
          players: rows.map((p) => ({
            rank: p.rank,
            displayName: p.displayName,
            avatarUrl: p.avatarUrl ?? null,
            rating: p.rating,
            ratedGames: p.ratedGames,
            provisional: p.ratedGames < PROVISIONAL_GAMES,
            isMe: me !== null && p.userId === me.id,
          })),
          nextOffset: rows.length === limit ? offset + limit : null,
        });
      } else if (pathname === '/me/logins') {
        const user = await requireUser(req);
        const events = await store.listAuthEvents(user.id, { limit: clampInt(q.get('limit'), 30, 1, 100) });
        send(res, 200, {
          ok: true,
          events: events.map(({ userId, ...e }) => e),
        });
      } else if (gameMatch) {
        const viewer = await auth.authenticate(bearerToken(req)).catch(() => null);
        const g = await store.getGame(gameMatch[1]);
        if (!g) throw new AuthError('not_found', 404);
        send(res, 200, { ok: true, game: gameDetailFor(g, viewer?.id ?? null) }, {
          vary: 'Authorization',
        });
      } else {
        throw new AuthError('not_found', 404);
      }
    } catch (err) {
      sendError(send, res, err);
    }
    return true;
  };
}
