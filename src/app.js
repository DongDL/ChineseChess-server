import http from 'node:http';
import https from 'node:https';
import { Server } from 'socket.io';
import { GameServer } from './game-server.js';
import { AuthService } from './auth.js';
import { OAuthService } from './oauth.js';
import { GameRecorder } from './recorder.js';
import { MemoryStore } from './stores/memory.js';
import { createAuthRoutes } from './auth-http.js';
import { createApiRoutes } from './api-http.js';
import { createFeedbackRoute } from './feedback-http.js';
import { createDocsRoute } from './docs-http.js';
import { createZaloVerifyRoute } from './zalo-verify-http.js';
import { makeJsonSender, logHttpRequest } from './http-util.js';
import { createLogger } from './logger.js';

const DAY_MS = 24 * 60 * 60_000;

const SOCKET_IO_PATH = '/socket.io/';
const isEnginePath = (url) => typeof url === 'string' && url.startsWith(SOCKET_IO_PATH);

/**
 * Gắn một server thứ hai (HTTPS) vào ĐÚNG engine Socket.IO đang có.
 *
 * Không dùng được `io.attach(httpsServer)`: hàm đó ghi đè `io.eio` nên server gắn trước sẽ hỏng.
 * Thay vào đó ta tự chuyển yêu cầu vào `io.engine` — cùng một engine nghĩa là cùng một tập phòng,
 * nên người chơi vào bằng HTTP và người chơi vào bằng HTTPS vẫn gặp được nhau trong một ván.
 */
function bindEngine(io, server, requestHandler) {
  server.on('request', (req, res) => {
    if (isEnginePath(req.url)) io.engine.handleRequest(req, res);
    else requestHandler(req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    if (isEnginePath(req.url)) io.engine.handleUpgrade(req, socket, head);
    else socket.destroy(); // không có WebSocket nào khác ngoài Socket.IO
  });
}

/**
 * Tạo HTTP server (+ HTTPS nếu có chứng chỉ) và Socket.IO.
 * Tách riêng khỏi index.js để test có thể khởi động server trên cổng ngẫu nhiên.
 *
 * [httpsOptions]: tuỳ chọn cho https.createServer (xem src/tls.js). null = chỉ chạy HTTP.
 * Hai server dùng CHUNG một bộ định tuyến và CHUNG một engine Socket.IO.
 *
 * [store]: nơi lưu tài khoản, phiên, lịch sử đăng nhập và ván đấu (MemoryStore hoặc PgStore).
 * Hàm close() KHÔNG đóng [store]; bên tạo ra store tự đóng nó.
 */
export function createApp({
  corsOrigin = '*',
  graceMs = 60_000,
  clockLimits,
  trustProxy = false,
  appVersion = '1.0.0',
  httpsOptions = null,
  store = new MemoryStore(),
  authService = new AuthService({ store }),
  oauth = new OAuthService({ store, auth: authService, providers: new Map(), publicUrl: '' }),
  recorder = new GameRecorder(store),
  authEventRetentionDays = 180,
  maintenanceMs = 60 * 60_000,
  mailer = null, // mailer dùng cho thư góp ý (POST /feedback); null = tắt tính năng
  feedbackTo = '', // địa chỉ nhận thư góp ý; rỗng = tắt tính năng
  appName = 'Cờ tướng online',
  docsEnabled = true, // phục vụ Swagger UI tại /docs (có thể tắt ở production bằng DOCS_ENABLED=0)
  publicUrl = '', // URL công khai (nếu có) để nút "Try it out" trên Swagger gọi đúng host
  zaloVerify = {}, // { entries: [{ file, html, code }] }: phục vụ (các) file xác thực domain cho Zalo Platform
  // Logger Pino dùng chung. index.js luôn truyền logger thật; mặc định này (im lặng) chỉ
  // dùng khi gọi createApp mà không truyền logger — chủ yếu trong test, để output test sạch.
  logger = createLogger(process.env, { level: 'silent' }),
  gameServerOptions = {}, // ghi đè tuỳ chọn của GameServer (ghép trận, đồng hồ...) — chủ yếu cho test
} = {}) {
  let gameServer;
  const authRoutes = createAuthRoutes(authService, oauth, { corsOrigin, trustProxy, log: logger });
  const apiRoutes = createApiRoutes(authService, store, { corsOrigin, log: logger });
  const feedbackRoute = createFeedbackRoute(mailer, {
    corsOrigin, feedbackTo, appName, auth: authService, log: logger,
  });
  const docsRoute = createDocsRoute({ appVersion, publicUrl, enabled: docsEnabled });
  const zaloVerifyRoute = createZaloVerifyRoute(zaloVerify);
  const sendVersion = makeJsonSender(corsOrigin);

  // Một bộ định tuyến duy nhất, dùng chung cho cả HTTP và HTTPS.
  const requestHandler = async (req, res) => {
    // Ghi access log cho mọi yêu cầu HTTP API (gắn x-request-id, log khi phản hồi xong).
    logHttpRequest(logger, req, res, { trustProxy });
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Đặt TRƯỚC authRoutes: đường dẫn xác thực Zalo nằm dưới /auth/oauth/zalo/callback/... nên nếu để
    // authRoutes chạy trước, nó sẽ nuốt yêu cầu và trả 404 (không khớp route OAuth hợp lệ nào).
    if (await zaloVerifyRoute(req, res)) return;
    if (await authRoutes(req, res)) return;
    if (await apiRoutes(req, res)) return;
    if (await feedbackRoute(req, res)) return;
    if (await docsRoute(req, res)) return;
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...gameServer.stats() }));
      return;
    }
    // Phiên bản server, công khai (client dùng cho popup "Giới thiệu").
    // Dùng chung bộ gửi JSON có đủ tiêu đề CORS + xử lý preflight OPTIONS cho bản web.
    if (url.pathname === '/version') {
      if (req.method === 'OPTIONS') sendVersion(res, 204, {});
      else sendVersion(res, 200, { ok: true, version: appVersion });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  };

  const httpServer = http.createServer(requestHandler);

  const io = new Server(httpServer, {
    cors: { origin: corsOrigin },
    pingInterval: 10_000,
    pingTimeout: 8_000,
    maxHttpBufferSize: 10_000, // payload của game rất nhỏ; chặn gói tin lớn bất thường
  });

  // HTTPS chỉ bật khi có chứng chỉ; thiếu thì server vẫn chạy HTTP như trước.
  const httpsServer = httpsOptions ? https.createServer(httpsOptions) : null;
  if (httpsServer) bindEngine(io, httpsServer, requestHandler);

  // Recorder được tạo mặc định với log=console; gắn logger dùng chung nếu nó vẫn đang dùng console.
  if (recorder && recorder.log === console) recorder.log = logger;

  gameServer = new GameServer(io, {
    graceMs,
    authService,
    recorder,
    log: logger,
    ratingOf: async (userId, variant = 'xiangqi') => (await store.getRating(userId, variant))?.rating ?? null,
    ...(clockLimits ? { clockLimits } : {}),
    ...gameServerOptions,
  });
  gameServer.attach();

  // Dọn định kỳ: phiên/state/mã hết hạn, và lịch sử đăng nhập quá hạn lưu trữ (có chứa IP nên không giữ vô hạn).
  const maintenance = setInterval(() => {
    const now = Date.now();
    store.purgeExpired(now).catch((e) => logger.error({ err: e }, 'Lỗi dọn định kỳ (purgeExpired)'));
    store.purgeAuthEvents(now - authEventRetentionDays * DAY_MS)
      .catch((e) => logger.error({ err: e }, 'Lỗi dọn định kỳ (purgeAuthEvents)'));
  }, maintenanceMs);
  maintenance.unref?.();

  return {
    httpServer,
    httpsServer, // null nếu không cấu hình chứng chỉ TLS
    io,
    gameServer,
    authService,
    oauth,
    recorder,
    store,
    logger,
    close: async () => {
      clearInterval(maintenance);
      gameServer.dispose();
      await recorder.drain(); // đảm bảo các ván vừa kết thúc đã được lưu
      // io.close() chỉ biết httpServer (server nó được gắn vào), nên phải tự đóng server HTTPS.
      if (httpsServer?.listening) {
        httpsServer.closeAllConnections?.();
        await new Promise((resolve) => httpsServer.close(() => resolve()));
      }
      await new Promise((resolve) => io.close(() => resolve()));
    },
  };
}
