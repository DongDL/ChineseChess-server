import http from 'node:http';
import { Server } from 'socket.io';
import { GameServer } from './game-server.js';
import { AuthService } from './auth.js';
import { OAuthService } from './oauth.js';
import { GameRecorder } from './recorder.js';
import { MemoryStore } from './stores/memory.js';
import { createAuthRoutes } from './auth-http.js';
import { createApiRoutes } from './api-http.js';

const DAY_MS = 24 * 60 * 60_000;

/**
 * Tạo HTTP server + Socket.IO. Tách riêng khỏi index.js để test có thể khởi động server trên cổng ngẫu nhiên.
 * [store]: nơi lưu tài khoản, phiên, lịch sử đăng nhập và ván đấu (MemoryStore hoặc PgStore).
 * Hàm close() KHÔNG đóng [store]; bên tạo ra store tự đóng nó.
 */
export function createApp({
  corsOrigin = '*',
  graceMs = 60_000,
  clockLimits,
  trustProxy = false,
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

  const httpServer = http.createServer(async (req, res) => {
    if (await authRoutes(req, res)) return;
    if (await apiRoutes(req, res)) return;
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...gameServer.stats() }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });

  const io = new Server(httpServer, {
    cors: { origin: corsOrigin },
    pingInterval: 10_000,
    pingTimeout: 8_000,
    maxHttpBufferSize: 10_000, // payload của game rất nhỏ; chặn gói tin lớn bất thường
  });

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
      await new Promise((resolve) => io.close(() => resolve()));
    },
  };
}
