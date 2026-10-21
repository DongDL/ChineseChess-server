import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
// Chỉ nhận file đánh số (001_init.sql, 002_...): file .sql khác (vd. script xoá CSDL) KHÔNG BAO GIỜ được chạy như migration.
const MIGRATION_FILE = /^\d{3,}_[\w-]+\.sql$/;
const LOCK_ID = 727001; // khoá tư vấn: nhiều server khởi động cùng lúc không chạy migration chồng nhau

/**
 * Áp dụng các file migrations/*.sql chưa được áp dụng, theo thứ tự tên file.
 * Mỗi file chạy trong một transaction; tên file đã áp dụng ghi trong bảng schema_migrations.
 * Thêm thay đổi schema = thêm file mới (002_...sql), KHÔNG sửa file cũ.
 * Trả về danh sách file vừa được áp dụng.
 */
export async function migrate(pool, { log = () => {} } = {}) {
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => MIGRATION_FILE.test(f)).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log(`đã áp dụng migration ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} thất bại: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
  return applied;
}
