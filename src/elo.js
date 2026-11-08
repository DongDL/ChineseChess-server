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

/**
 * Cờ BẬT/TẮT luật "tính điểm cho ván tài khoản đấu KHÁCH".
 *
 * - TẮT (mặc định): giữ luật gốc — chỉ ván giữa HAI tài khoản mới tính điểm (an toàn cho bảng xếp hạng,
 *   vì điểm khách do client tự khai nên không đáng tin).
 * - BẬT: ván có ÍT NHẤT một tài khoản cũng được tính. Khi đó tài khoản được cộng/trừ điểm (lưu server,
 *   lên bảng xếp hạng) dựa trên điểm đối thủ khách (do client gửi lúc kết nối). Khách tự tính tại máy.
 *   ⚠ Cân nhắc gian lận: đối thủ khách có thể khai điểm tuỳ ý để bơm/dìm điểm tài khoản.
 *
 * Bật bằng biến môi trường `RATE_VS_GUEST=1` (xem src/index.js).
 */
export const RATE_VS_GUEST_DEFAULT = false;

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
 *
 * [opts.rateVsGuest] (mặc định [RATE_VS_GUEST_DEFAULT]): BẬT thì chỉ cần ÍT NHẤT một bên là tài khoản
 * (bên kia có thể là khách); TẮT thì giữ luật gốc là CẢ HAI phải là tài khoản.
 */
export function isRatedGame(g, minMoves = RATED_MIN_MOVES, { rateVsGuest = RATE_VS_GUEST_DEFAULT } = {}) {
  if (g.moveCount < minMoves) return false;
  // Luật gốc (flag TẮT): CẢ HAI bên là tài khoản, hai tài khoản khác nhau.
  const bothAccounts = Boolean(
    g.redUserId && g.blackUserId && g.redUserId !== g.blackUserId && !g.redGuest && !g.blackGuest,
  );
  if (!rateVsGuest) return bothAccounts;
  // Flag BẬT: ván có ÍT NHẤT một tài khoản; bên còn lại là tài khoản (khác) hoặc khách.
  const accountIds = [g.redUserId, g.blackUserId].filter(Boolean);
  if (accountIds.length === 0) return false; // hai khách: server không tính (khách tự tính tại máy)
  if (accountIds.length === 2) return bothAccounts; // hai tài khoản: vẫn phải khác nhau
  // Đúng một tài khoản: bên kia phải là khách (không phải tài khoản "thiếu id" do dữ liệu hỏng).
  const redIsGuestSide = !g.redUserId && g.redGuest;
  const blackIsGuestSide = !g.blackUserId && g.blackGuest;
  return redIsGuestSide || blackIsGuestSide;
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
