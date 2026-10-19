import { createApp } from './app.js';
import { AuthService } from './auth.js';
import { OAuthService } from './oauth.js';
import { providersFromEnv } from './providers.js';
import { MemoryStore } from './stores/memory.js';
import { PgStore } from './stores/pg.js';

const env = process.env;
const port = Number(env.PORT ?? 3000);
console.log('PostgreSQL env.PORT:'+ port);
console.log('PostgreSQL env.DATABASE_URL:' + env.DATABASE_URL);
// ---- Kho lưu trữ: PostgreSQL nếu có DATABASE_URL, không thì lưu tạm trong bộ nhớ ----
let store;
if (env.DATABASE_URL) {
  store = new PgStore({ connectionString: env.DATABASE_URL });
  if (env.AUTO_MIGRATE !== '0') {
    const applied = await store.migrate({ log: console.log });
    if (applied.length === 0) console.log('CSDL PostgreSQL đã ở phiên bản mới nhất.');
  }
  console.log('Lưu trữ: PostgreSQL');
} else {
  store = new MemoryStore();
  console.warn('CẢNH BÁO: chưa đặt DATABASE_URL, tài khoản và ván đấu chỉ lưu trong bộ nhớ và MẤT khi tắt server.');
}

// ---- Đăng nhập: mật khẩu + Google/Facebook/Zalo (chỉ bật bên nào có đủ khoá trong biến môi trường) ----
const authService = new AuthService({ store });
const providers = providersFromEnv(env);
const oauth = new OAuthService({
  store,
  auth: authService,
  providers,
  publicUrl: env.PUBLIC_URL ?? '',
  appRedirects: (env.OAUTH_APP_REDIRECTS ?? 'cotuong://auth').split(',').map((s) => s.trim()).filter(Boolean),
});
if (providers.size > 0 && !env.PUBLIC_URL) {
  console.warn('CẢNH BÁO: đã cấu hình đăng nhập mạng xã hội nhưng thiếu PUBLIC_URL nên sẽ không dùng được.');
}
console.log(`Đăng nhập mạng xã hội: ${providers.size ? [...providers.keys()].join(', ') : '(chưa bật)'}`);

const app = createApp({
  corsOrigin: env.CORS_ORIGIN ?? '*',
  graceMs: Number(env.RECONNECT_GRACE_MS ?? 60_000),
  trustProxy: env.TRUST_PROXY === '1',
  authEventRetentionDays: Number(env.AUTH_EVENT_RETENTION_DAYS ?? 180),
  store,
  authService,
  oauth,
});

app.httpServer.listen(port, () => {
  console.log(`Xiangqi server đang chạy: http://localhost:${port}  (health: /health)`);
});

const shutdown = async () => {
  console.log('Đang tắt server...');
  await app.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
