import { readFileSync } from 'node:fs';
import { createApp } from './app.js';
import { AuthService } from './auth.js';
import { OAuthService } from './oauth.js';
import { mailerFromEnv } from './mailer.js';
import { providersFromEnv } from './providers.js';
import { MemoryStore } from './stores/memory.js';
import { PgStore } from './stores/pg.js';
import { tlsOptionsFromEnv } from './tls.js';

const env = process.env;
const port = Number(env.PORT ?? 3000);
const httpsPort = Number(env.HTTPS_PORT ?? 3443);
// Phiên bản server lấy từ package.json để trả về ở GET /version.
let appVersion = '1.0.0';
try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  appVersion = pkg.version ?? appVersion;
} catch (err) {
  console.warn('Không đọc được phiên bản từ package.json:', err.message);
}
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
const mailer = mailerFromEnv(env);
const authService = new AuthService({
  store,
  mailer,
  appName: env.APP_NAME ?? 'Cờ tướng online',
  jwtSecret: env.JWT_SECRET ?? '',
  accessTtlMs: Number(env.JWT_ACCESS_TTL_MS ?? 60 * 60_000),
  sessionTtlMs: Number(env.SESSION_TTL_MS ?? 30 * 24 * 60 * 60_000),
});
if (authService.jwtSecretEphemeral) {
  console.warn(
    'CẢNH BÁO: chưa đặt JWT_SECRET nên đang dùng khoá ngẫu nhiên tạm. Khởi động lại server là mọi người'
    + ' phải đăng nhập lại, và nhiều tiến trình/máy sẽ không hiểu token của nhau.',
  );
}
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

// ---- HTTPS: chỉ bật khi có chứng chỉ TLS (trên Railway/Render thì nền tảng lo TLS, server chỉ cần HTTP) ----
const httpsOptions = tlsOptionsFromEnv(env);

// Thư góp ý (POST /feedback) gửi tới hộp thư quản trị. Mặc định dùng chính SMTP_USER; có thể
// đặt FEEDBACK_TO để chuyển hướng sang hộp thư khác. Thiếu mailer (chưa cấu hình SMTP) -> tính năng tắt.
const feedbackTo = env.FEEDBACK_TO?.trim() || env.SMTP_USER?.trim() || '';
const appName = env.APP_NAME ?? 'Cờ tướng online';
if (mailer && !feedbackTo) {
  console.warn('CẢNH BÁO: có SMTP nhưng thiếu FEEDBACK_TO/SMTP_USER nên thư góp ý sẽ bị TẮT.');
}

const app = createApp({
  corsOrigin: env.CORS_ORIGIN ?? '*',
  graceMs: Number(env.RECONNECT_GRACE_MS ?? 60_000),
  trustProxy: env.TRUST_PROXY === '1',
  appVersion,
  authEventRetentionDays: Number(env.AUTH_EVENT_RETENTION_DAYS ?? 180),
  httpsOptions,
  store,
  authService,
  oauth,
  mailer,
  feedbackTo,
  appName,
});
console.log(`Thư góp ý: ${mailer && feedbackTo ? `bật (gửi tới ${feedbackTo})` : '(chưa bật)'}`);

// 0.0.0.0 để truy cập được từ điện thoại thật, emulator Android (10.0.2.2) và trong Docker.
app.httpServer.listen(port, '0.0.0.0', () => {
  console.log(`HTTP  ▶ http://localhost:${port}   (health: /health)`);
});

if (app.httpsServer) {
  app.httpsServer.listen(httpsPort, '0.0.0.0', () => {
    console.log(`HTTPS ▶ https://localhost:${httpsPort}  (health: /health)`);
  });
  app.httpsServer.on('error', (err) => {
    // Không tắt cả server chỉ vì cổng HTTPS bị chiếm: HTTP vẫn phải phục vụ được.
    console.error(`HTTPS không khởi động được trên cổng ${httpsPort}: ${err.message}`);
  });
}

const shutdown = async () => {
  console.log('Đang tắt server...');
  await app.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
