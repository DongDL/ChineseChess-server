import { readFileSync } from 'node:fs';
import { createApp } from './app.js';
import { AuthService } from './auth.js';
import { OAuthService } from './oauth.js';
import { mailerFromEnv } from './mailer.js';
import { providersFromEnv } from './providers.js';
import { MemoryStore } from './stores/memory.js';
import { PgStore } from './stores/pg.js';
import { tlsOptionsFromEnv } from './tls.js';
import { createLogger, logFn } from './logger.js';
import { RATE_VS_GUEST_DEFAULT } from './elo.js';

const env = process.env;
const logger = createLogger(env);
const port = Number(env.PORT ?? 3000);
const httpsPort = Number(env.HTTPS_PORT ?? 3443);
// Phiên bản server lấy từ package.json để trả về ở GET /version.
let appVersion = '1.0.0';
try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  appVersion = pkg.version ?? appVersion;
} catch (err) {
  logger.warn({ err }, 'Không đọc được phiên bản từ package.json');
}
// ---- Kho lưu trữ: PostgreSQL nếu có DATABASE_URL, không thì lưu tạm trong bộ nhớ ----
// Cờ bật/tắt luật "tính điểm cho ván tài khoản đấu KHÁCH".
// - Có đặt RATE_VS_GUEST trong env: '1'/'true' = BẬT, '0'/'false' = TẮT (env luôn ghi đè).
// - Không đặt: dùng mặc định RATE_VS_GUEST_DEFAULT trong src/elo.js.
const rateVsGuest = env.RATE_VS_GUEST === undefined || env.RATE_VS_GUEST === ''
  ? RATE_VS_GUEST_DEFAULT
  : (env.RATE_VS_GUEST === '1' || env.RATE_VS_GUEST.toLowerCase() === 'true');
let store;
if (env.DATABASE_URL) {
  store = new PgStore({ connectionString: env.DATABASE_URL, rateVsGuest, log: logger });
  if (env.AUTO_MIGRATE !== '0') {
    const applied = await store.migrate({ log: logFn(logger) });
    if (applied.length === 0) logger.info('CSDL PostgreSQL đã ở phiên bản mới nhất.');
  }
  logger.info('Lưu trữ: PostgreSQL');
} else {
  store = new MemoryStore({ rateVsGuest });
  logger.warn('CẢNH BÁO: chưa đặt DATABASE_URL, tài khoản và ván đấu chỉ lưu trong bộ nhớ và MẤT khi tắt server.');
}

// ---- Đăng nhập: mật khẩu + Google/Facebook/Zalo (chỉ bật bên nào có đủ khoá trong biến môi trường) ----
const mailer = mailerFromEnv(env, logger);
const authService = new AuthService({
  store,
  mailer,
  appName: env.APP_NAME ?? 'Cờ tướng online',
  jwtSecret: env.JWT_SECRET ?? '',
  accessTtlMs: Number(env.JWT_ACCESS_TTL_MS ?? 60 * 60_000),
  sessionTtlMs: Number(env.SESSION_TTL_MS ?? 30 * 24 * 60 * 60_000),
});
if (authService.jwtSecretEphemeral) {
  logger.warn(
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
  logger.warn('CẢNH BÁO: đã cấu hình đăng nhập mạng xã hội nhưng thiếu PUBLIC_URL nên sẽ không dùng được.');
}
logger.info(`Đăng nhập mạng xã hội: ${providers.size ? [...providers.keys()].join(', ') : '(chưa bật)'}`);

// ---- HTTPS: chỉ bật khi có chứng chỉ TLS (trên Railway/Render thì nền tảng lo TLS, server chỉ cần HTTP) ----
const httpsOptions = tlsOptionsFromEnv(env, { log: logger });

// Thư góp ý (POST /feedback) gửi tới hộp thư quản trị. Mặc định dùng chính SMTP_USER; có thể
// đặt FEEDBACK_TO để chuyển hướng sang hộp thư khác. Thiếu mailer (chưa cấu hình SMTP) -> tính năng tắt.
const feedbackTo = env.FEEDBACK_TO?.trim() || env.SMTP_USER?.trim() || '';
const appName = env.APP_NAME ?? 'Cờ tướng online';
if (mailer && !feedbackTo) {
  logger.warn('CẢNH BÁO: có SMTP nhưng thiếu FEEDBACK_TO/SMTP_USER nên thư góp ý sẽ bị TẮT.');
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
  docsEnabled: env.DOCS_ENABLED !== '0',
  publicUrl: env.PUBLIC_URL ?? '',
  // Xác thực domain Zalo: phục vụ nội dung Zalo yêu cầu tại đúng đường dẫn Zalo chỉ định.
  // Trong .env, xuống dòng viết bằng "\n" literal nên chuyển lại thành xuống dòng thật.
  zaloVerify: {
    file: env.ZALO_VERIFY_FILE ?? '',
    content: (env.ZALO_VERIFY_CONTENT ?? '').replace(/\\n/g, '\n'),
    code: env.ZALO_VERIFY_CODE ?? '',
    type: env.ZALO_VERIFY_TYPE ?? '',
  },
  logger,
});
logger.info(`Thư góp ý: ${mailer && feedbackTo ? `bật (gửi tới ${feedbackTo})` : '(chưa bật)'}`);

// 0.0.0.0 để truy cập được từ điện thoại thật, emulator Android (10.0.2.2) và trong Docker.
const docsEnabled = env.DOCS_ENABLED !== '0';
app.httpServer.listen(port, '0.0.0.0', () => {
  logger.info({ 'service.address': `http://localhost:${port}`, port }, `HTTP  ▶ http://localhost:${port}   (health: /health)`);
  if (docsEnabled) logger.info(`Tài liệu API (Swagger UI) ▶ http://localhost:${port}/docs`);
});

if (app.httpsServer) {
  app.httpsServer.listen(httpsPort, '0.0.0.0', () => {
    logger.info({ 'service.address': `https://localhost:${httpsPort}`, port: httpsPort }, `HTTPS ▶ https://localhost:${httpsPort}  (health: /health)`);
  });
  app.httpsServer.on('error', (err) => {
    // Không tắt cả server chỉ vì cổng HTTPS bị chiếm: HTTP vẫn phải phục vụ được.
    logger.error({ err, port: httpsPort }, `HTTPS không khởi động được trên cổng ${httpsPort}`);
  });
}

const shutdown = async () => {
  logger.info('Đang tắt server...');
  await app.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
