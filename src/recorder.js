const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ghi ván đấu đã kết thúc vào kho lưu trữ, chạy NỀN (không làm chậm việc báo kết quả cho người chơi).
 * Nếu CSDL tạm thời lỗi thì thử lại (ngay, sau 1 giây, sau 3 giây); hết lần thử mới bỏ cuộc và ghi log.
 * saveGame là idempotent nên thử lại không bao giờ tạo bản ghi trùng.
 */
export class GameRecorder {
  constructor(store, { retryDelaysMs = [0, 1000, 3000], log = console } = {}) {
    this.store = store;
    this.retryDelaysMs = retryDelaysMs;
    this.log = log;
    this.pending = new Set();
  }

  /** Bắt đầu ghi (không chờ). Trả về promise cho biết đã ghi được hay chưa. */
  record(game) {
    const p = this._save(game).finally(() => this.pending.delete(p));
    this.pending.add(p);
    return p;
  }

  async _save(game) {
    let lastError;
    for (const wait of this.retryDelaysMs) {
      if (wait > 0) await sleep(wait);
      try {
        await this.store.saveGame(game);
        return true;
      } catch (err) {
        lastError = err;
        this.log.error(`[recorder] lỗi lưu ván ${game.id}: ${err.message}`);
      }
    }
    this.log.error(`[recorder] BỎ CUỘC không lưu được ván ${game.id}: ${lastError?.message}`);
    return false;
  }

  /** Chờ mọi lần ghi đang chạy hoàn tất (dùng khi tắt server và trong test). */
  async drain() {
    await Promise.allSettled([...this.pending]);
  }
}
