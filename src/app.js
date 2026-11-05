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
  httpsOptions = null,
  store = new MemoryStore(),
  authService = new AuthService({ store }),
  oauth = new OAuthService({ store, auth: authService, providers: new Map(), publicUrl: '' }),
  recorder = new GameRecorder(store),
  authEventRetentionDays = 180,
  maintenanceMs = 60 * 60_000,
  gameServerOptions = {}, // ghi đè tuỳ chọn của GameServer (ghép trận, đồng hồ...) — chủ yếu cho test
} = {}) {
  let gameServer;
  const authRoutes = createAuthRoutes(authService, oauth, { corsOrigin, trustProxy });
  const apiRoutes = createApiRoutes(authService, store, { corsOrigin });

  // Một bộ định tuyến duy nhất, dùng chung cho cả HTTP và HTTPS.
  const requestHandler = async (req, res) => {
    if (await authRoutes(req, res)) return;
    if (await apiRoutes(req, res)) return;
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...gameServer.stats() }));
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

  gameServer = new GameServer(io, {
    graceMs,
    authService,
    recorder,
    ratingOf: async (userId, variant = 'xiangqi') => (await store.getRating(userId, variant))?.rating ?? null,
    ...(clockLimits ? { clockLimits } : {}),
    ...gameServerOptions,
  });
  gameServer.attach();

  // Dọn định kỳ: phiên/state/mã hết hạn, và lịch sử đăng nhập quá hạn lưu trữ (có chứa IP nên không giữ vô hạn).
  const maintenance = setInterval(() => {
    const now = Date.now();
    store.purgeExpired(now).catch((e) => console.error('[maintenance]', e.message));
    store.purgeAuthEvents(now - authEventRetentionDays * DAY_MS).catch((e) => console.error('[maintenance]', e.message));
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
