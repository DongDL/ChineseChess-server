import { performance } from 'node:perf_hooks';
import { SIDE, opposite } from './engine.js';

/** Giới hạn cấu hình đồng hồ (có thể ghi đè khi tạo server, ví dụ để test). */
export const DEFAULT_CLOCK_LIMITS = Object.freeze({
  minBaseMs: 30_000, // tối thiểu 30 giây
  maxBaseMs: 3 * 60 * 60_000, // tối đa 3 giờ
  maxIncrementMs: 60_000, // cộng tối đa 60 giây mỗi nước
  maxPerMoveMs: 5 * 60_000, // giới hạn mỗi nước tối đa 5 phút
});

/**
 * Kiểm tra và chuẩn hoá cấu hình đồng hồ từ client.
 * Trả về null (không giới hạn thời gian), hoặc { baseMs, incrementMs, perMoveMs }.
 * [perMoveMs] là giới hạn thời gian cho MỖI nước đi: quá hạn mà chưa đi thì bị xử thua.
 * perMoveMs = 0 (hoặc thiếu) nghĩa là không giới hạn mỗi nước.
 * Cấu hình sai thì ném lỗi 'bad_time_control'.
 */
export function normalizeTimeControl(raw, limits = DEFAULT_CLOCK_LIMITS) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') throw new Error('bad_time_control');
  const { baseMs, incrementMs = 0, perMoveMs = 0 } = raw;
  // Giới hạn mỗi nước có thể không được khai báo trong limits tuỳ biến (test cũ): dùng mặc định.
  const maxPerMoveMs = limits.maxPerMoveMs ?? DEFAULT_CLOCK_LIMITS.maxPerMoveMs;
  const valid =
    Number.isInteger(baseMs) &&
    Number.isInteger(incrementMs) &&
    Number.isInteger(perMoveMs) &&
    baseMs >= limits.minBaseMs &&
    baseMs <= limits.maxBaseMs &&
    incrementMs >= 0 &&
    incrementMs <= limits.maxIncrementMs &&
    perMoveMs >= 0 &&
    perMoveMs <= maxPerMoveMs;
  if (!valid) throw new Error('bad_time_control');
  return { baseMs, incrementMs, perMoveMs };
}

/** Khoá để ghép trận chỉ giữa những người chọn cùng một mức thời gian. */
export const timeControlKey = (tc) =>
  tc ? `${tc.baseMs}+${tc.incrementMs}+${tc.perMoveMs ?? 0}` : 'none';

/**
 * Đồng hồ cờ kiểu Fischer: mỗi bên có [baseMs] ms, đi xong một nước được cộng [incrementMs].
 * Chỉ đồng hồ của bên đang đến lượt chạy. Thời gian do SERVER tính, client chỉ hiển thị.
 * Hàm [now] trả về mili-giây đơn điệu; truyền vào hàm giả khi test.
 */
export class GameClock {
  constructor({ baseMs, incrementMs = 0, perMoveMs = 0 }, now = () => performance.now()) {
    this.baseMs = baseMs;
    this.incrementMs = incrementMs;
    this.perMoveMs = perMoveMs; // 0 = không giới hạn mỗi nước
    this.remaining = { [SIDE.RED]: baseMs, [SIDE.BLACK]: baseMs };
    // Thời gian còn lại cho NƯỚC hiện tại của bên đang chạy (chỉ dùng khi perMoveMs > 0).
    this.moveRemaining = perMoveMs;
    this.running = null; // bên đang bị tính giờ, hoặc null khi dừng
    this.lastTick = 0;
    this._now = now;
  }

  /** Bắt đầu tính giờ cho bên [side], đặt lại đồng hồ nước đi. */
  start(side) {
    this.running = side;
    this.moveRemaining = this.perMoveMs;
    this.lastTick = this._now();
  }

  /** Cập nhật thời gian đã trôi của bên đang chạy đến thời điểm hiện tại. */
  tick() {
    if (!this.running) return;
    const t = this._now();
    const elapsed = Math.max(0, t - this.lastTick);
    this.remaining[this.running] -= elapsed;
    if (this.perMoveMs > 0) this.moveRemaining -= elapsed;
    this.lastTick = t;
  }

  /** true nếu [side] đã hết tổng giờ, hoặc (khi đang chạy) hết giờ cho nước hiện tại. */
  isExpired(side) {
    if (this.remaining[side] <= 0) return true;
    if (this.perMoveMs > 0 && side === this.running && this.moveRemaining <= 0) return true;
    return false;
  }

  /**
   * Bên đang chạy vừa đi xong một nước: trừ giờ, cộng thêm giờ, chuyển đồng hồ sang đối thủ.
   * Trả về bên hết giờ (nếu có) hoặc null.
   */
  press() {
    this.tick();
    const side = this.running;
    if (side === null) return null;
    if (this.isExpired(side)) return side;
    this.remaining[side] += this.incrementMs;
    this.start(opposite(side));
    return null;
  }

  /** Dừng đồng hồ (ván kết thúc). */
  stop() {
    this.tick();
    this.running = null;
  }

  /**
   * Số ms còn lại đến lúc bên đang chạy hết giờ (Infinity nếu đồng hồ đang dừng).
   * Lấy giá trị nhỏ hơn giữa tổng giờ còn lại và giờ còn lại cho nước hiện tại.
   */
  msUntilFlag() {
    if (!this.running) return Infinity;
    this.tick();
    const total = Math.max(0, this.remaining[this.running]);
    if (this.perMoveMs <= 0) return total;
    return Math.min(total, Math.max(0, this.moveRemaining));
  }

  /** Ảnh chụp trạng thái để gửi cho client (không làm thay đổi đồng hồ). */
  snapshot() {
    const remainingMs = {
      [SIDE.RED]: Math.max(0, Math.round(this.remaining[SIDE.RED])),
      [SIDE.BLACK]: Math.max(0, Math.round(this.remaining[SIDE.BLACK])),
    };
    let moveRemainingMs = this.perMoveMs > 0 ? Math.max(0, Math.round(this.moveRemaining)) : null;
    if (this.running) {
      const elapsed = Math.max(0, this._now() - this.lastTick);
      remainingMs[this.running] = Math.max(0, Math.round(this.remaining[this.running] - elapsed));
      if (this.perMoveMs > 0) moveRemainingMs = Math.max(0, Math.round(this.moveRemaining - elapsed));
    }
    return {
      baseMs: this.baseMs,
      incrementMs: this.incrementMs,
      perMoveMs: this.perMoveMs,
      remainingMs,
      // Giờ còn lại cho nước hiện tại của bên đang chạy (null nếu không giới hạn mỗi nước).
      moveRemainingMs,
      running: this.running,
    };
  }
}
