import { performance } from 'node:perf_hooks';
import { SIDE, opposite } from './engine.js';

/** Giới hạn cấu hình đồng hồ (có thể ghi đè khi tạo server, ví dụ để test). */
export const DEFAULT_CLOCK_LIMITS = Object.freeze({
  minBaseMs: 30_000, // tối thiểu 30 giây
  maxBaseMs: 3 * 60 * 60_000, // tối đa 3 giờ
  maxIncrementMs: 60_000, // cộng tối đa 60 giây mỗi nước
});

/**
 * Kiểm tra và chuẩn hoá cấu hình đồng hồ từ client.
 * Trả về null (không giới hạn thời gian), hoặc { baseMs, incrementMs }.
 * Cấu hình sai thì ném lỗi 'bad_time_control'.
 */
export function normalizeTimeControl(raw, limits = DEFAULT_CLOCK_LIMITS) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') throw new Error('bad_time_control');
  const { baseMs, incrementMs = 0 } = raw;
  const valid =
    Number.isInteger(baseMs) &&
    Number.isInteger(incrementMs) &&
    baseMs >= limits.minBaseMs &&
    baseMs <= limits.maxBaseMs &&
    incrementMs >= 0 &&
    incrementMs <= limits.maxIncrementMs;
  if (!valid) throw new Error('bad_time_control');
  return { baseMs, incrementMs };
}

/** Khoá để ghép trận chỉ giữa những người chọn cùng một mức thời gian. */
export const timeControlKey = (tc) => (tc ? `${tc.baseMs}+${tc.incrementMs}` : 'none');

/**
 * Đồng hồ cờ kiểu Fischer: mỗi bên có [baseMs] ms, đi xong một nước được cộng [incrementMs].
 * Chỉ đồng hồ của bên đang đến lượt chạy. Thời gian do SERVER tính, client chỉ hiển thị.
 * Hàm [now] trả về mili-giây đơn điệu; truyền vào hàm giả khi test.
 */
export class GameClock {
  constructor({ baseMs, incrementMs = 0 }, now = () => performance.now()) {
    this.baseMs = baseMs;
    this.incrementMs = incrementMs;
    this.remaining = { [SIDE.RED]: baseMs, [SIDE.BLACK]: baseMs };
    this.running = null; // bên đang bị tính giờ, hoặc null khi dừng
    this.lastTick = 0;
    this._now = now;
  }

  /** Bắt đầu tính giờ cho bên [side]. */
  start(side) {
    this.running = side;
    this.lastTick = this._now();
  }

  /** Cập nhật thời gian đã trôi của bên đang chạy đến thời điểm hiện tại. */
  tick() {
    if (!this.running) return;
    const t = this._now();
    this.remaining[this.running] -= Math.max(0, t - this.lastTick);
    this.lastTick = t;
  }

  isExpired(side) {
    return this.remaining[side] <= 0;
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

  /** Số ms còn lại đến lúc bên đang chạy hết giờ (Infinity nếu đồng hồ đang dừng). */
  msUntilFlag() {
    if (!this.running) return Infinity;
    this.tick();
    return Math.max(0, this.remaining[this.running]);
  }

  /** Ảnh chụp trạng thái để gửi cho client (không làm thay đổi đồng hồ). */
  snapshot() {
    const remainingMs = {
      [SIDE.RED]: Math.max(0, Math.round(this.remaining[SIDE.RED])),
      [SIDE.BLACK]: Math.max(0, Math.round(this.remaining[SIDE.BLACK])),
    };
    if (this.running) {
      const elapsed = Math.max(0, this._now() - this.lastTick);
      remainingMs[this.running] = Math.max(0, Math.round(this.remaining[this.running] - elapsed));
    }
    return {
      baseMs: this.baseMs,
      incrementMs: this.incrementMs,
      remainingMs,
      running: this.running,
    };
  }
}
