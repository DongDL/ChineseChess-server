// Tính lại toàn bộ Elo từ lịch sử ván:  npm run ratings:rebuild
// Dùng sau khi nâng cấp lên migration 002 (để ván cũ cũng được tính điểm) hoặc khi nghi ngờ dữ liệu điểm bị lệch.
// Chặn ghi vào bảng users/games trong lúc chạy (vài giây). Chạy bao nhiêu lần cũng cho cùng kết quả.
import { PgStore } from '../src/stores/pg.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Thiếu biến môi trường DATABASE_URL');
  process.exit(1);
}
const store = new PgStore({ connectionString: url });
try {
  await store.migrate({ log: console.log });
  const { games, rated } = await store.rebuildRatings();
  console.log(`Xong: duyệt ${games} ván, ${rated} ván tính điểm.`);
} finally {
  await store.close();
}
