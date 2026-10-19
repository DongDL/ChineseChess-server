// Chạy migration thủ công:  DATABASE_URL=postgres://... npm run migrate
import pg from 'pg';
import { migrate } from '../src/migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Thiếu biến môi trường DATABASE_URL (ví dụ postgres://user:pass@localhost:5432/xiangqi)');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });
try {
  const applied = await migrate(pool, { log: console.log });
  console.log(applied.length ? `Xong: ${applied.length} migration mới.` : 'CSDL đã ở phiên bản mới nhất.');
} finally {
  await pool.end();
}
