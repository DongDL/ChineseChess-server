/**
 * Xếp hạng Elo cho ván cờ tính điểm.
 *
 * Quy tắc "ván tính điểm" (isRatedGame): CẢ HAI bên đều là tài khoản (khách không có điểm), hai tài khoản khác nhau,
 * và ván có ít nhất RATED_MIN_MOVES nước (chống "đầu hàng ngay" để cày điểm / ép đối thủ thua).
 * Hết giờ, đầu hàng, mất kết nối đều tính như thua bình thường.
 *
 * Hệ số K: 40 cho PROVISIONAL_GAMES ván tính điểm đầu tiên (điểm còn "tạm"), sau đó 20, từ 2400 trở lên 10.
 * Điểm không bao giờ thấp hơn MIN_RATING.
 */
export const DEFAULT_RATING = 1500;
export const MIN_RATING = 100;
export const PROVISIONAL_GAMES = 30;
export const RATED_MIN_MOVES = 6;
export const RATING_VARIANTS = Object.freeze(['xiangqi', 'jieqi']);

/** Chuẩn hoá biến thể của một thang Elo; mặc định giữ tương thích Xiangqi. */
export function normalizeRatingVariant(value = 'xiangqi') {
  if (!RATING_VARIANTS.includes(value)) throw new RangeError('bad_variant');
  return value;
}

export function kFactor(rating, ratedGames) {
  if (ratedGames < PROVISIONAL_GAMES) return 40;
  return rating >= 2400 ? 10 : 20;
}

/** Xác suất kỳ vọng thắng của người có điểm [a] trước người có điểm [b]. */
export function expectedScore(a, b) {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

/**
 * Ván có tính điểm không? [g] dạng phẳng: { redUserId, blackUserId, redGuest, blackGuest, moveCount }.
 */
export function isRatedGame(g, minMoves = RATED_MIN_MOVES) {
  return Boolean(
    g.redUserId && g.blackUserId
    && g.redUserId !== g.blackUserId
    && !g.redGuest && !g.blackGuest
    && g.moveCount >= minMoves,
  );
}

/**
 * Tính điểm mới sau một ván.
 * red/black: { rating, games } (điểm hiện tại và số ván tính điểm đã chơi). result: 'red' | 'black' | 'draw'.
 * Trả về { red: { before, after, delta }, black: { ... } }.
 */
export function computeRatings(red, black, result) {
  if (!['red', 'black', 'draw'].includes(result)) throw new Error(`kết quả không hợp lệ: ${result}`);
  const scoreRed = result === 'red' ? 1 : result === 'draw' ? 0.5 : 0;
  const one = (me, other, score) => {
    const k = kFactor(me.rating, me.games);
    const after = Math.max(MIN_RATING, me.rating + Math.round(k * (score - expectedScore(me.rating, other.rating))));
    return { before: me.rating, after, delta: after - me.rating };
  };
  return { red: one(red, black, scoreRed), black: one(black, red, 1 - scoreRed) };
}
