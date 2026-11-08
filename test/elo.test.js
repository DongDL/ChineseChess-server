import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import {
  MIN_RATING, computeRatings, expectedScore, isRatedGame, kFactor,
} from '../src/elo.js';
import { MemoryStore } from '../src/stores/memory.js';
import { PgStore } from '../src/stores/pg.js';
import {
  P, connectWith, emit, waitFor,
} from './helpers/sockets.js';

const PG_URL = process.env.TEST_DATABASE_URL;

describe('elo.js (hàm thuần)', () => {
  test('xác suất kỳ vọng và K', () => {
    assert.equal(expectedScore(1500, 1500), 0.5);
    assert.ok(Math.abs(expectedScore(1900, 1500) - 0.9091) < 1e-3);
    assert.equal(kFactor(1500, 0), 40);
    assert.equal(kFactor(1500, 29), 40);
    assert.equal(kFactor(1500, 30), 20);
    assert.equal(kFactor(2400, 30), 10);
    assert.equal(kFactor(2600, 5), 40); // người mới luôn dùng K tạm
  });

  test('ngang điểm, người mới: thắng +20, thua -20, hoà 0', () => {
    const a = { rating: 1500, games: 0 };
    const w = computeRatings(a, a, 'red');
    assert.deepEqual(w.red, { before: 1500, after: 1520, delta: 20 });
    assert.deepEqual(w.black, { before: 1500, after: 1480, delta: -20 });
    const d = computeRatings(a, a, 'draw');
    assert.equal(d.red.delta, 0);
    assert.equal(d.black.delta, 0);
  });

  test('thắng người mạnh hơn được nhiều điểm hơn; có sàn MIN_RATING', () => {
    const strong = { rating: 1900, games: 50 };
    const weak = { rating: 1500, games: 50 };
    assert.equal(computeRatings(weak, strong, 'red').red.delta, 18); // 20 * (1 - 0.0909)
    assert.equal(computeRatings(strong, weak, 'red').red.delta, 2);
    const floor = computeRatings({ rating: MIN_RATING, games: 0 }, { rating: 1500, games: 0 }, 'black');
    assert.equal(floor.red.after, MIN_RATING);
    assert.equal(floor.red.delta, 0);
  });

  test('kết quả lạ bị từ chối', () => {
    assert.throws(() => computeRatings({ rating: 1500, games: 0 }, { rating: 1500, games: 0 }, 'ongoing'));
  });

  test('isRatedGame: cần 2 tài khoản khác nhau và đủ số nước', () => {
    const ok = {
      redUserId: 'a', blackUserId: 'b', redGuest: false, blackGuest: false, moveCount: 6,
    };
    assert.equal(isRatedGame(ok), true);
    assert.equal(isRatedGame({ ...ok, moveCount: 5 }), false);
    assert.equal(isRatedGame({ ...ok, blackGuest: true }), false);
    assert.equal(isRatedGame({ ...ok, blackUserId: null }), false);
    assert.equal(isRatedGame({ ...ok, blackUserId: 'a' }), false);
    assert.equal(isRatedGame({ ...ok, moveCount: 2 }, 2), true);
  });
});

const impls = [
  ['MemoryStore', () => new MemoryStore(), null],
  ['PgStore (PostgreSQL thật)', async () => {
    const s = new PgStore({ connectionString: PG_URL });
    await s.migrate();
    await s._truncateAllForTests();
    return s;
  }, PG_URL ? null : 'bỏ qua: chưa đặt TEST_DATABASE_URL'],
];

const NOW = 1_700_000_000_000;
const mkUser = (store, tag) => store.createUser({ username: `e_${tag}`, displayName: `E ${tag}`, passwordHash: 'h' });
const mkMoves = (n) => Array.from({ length: n }, (_, i) => ({
  from: P(0, 0), to: P(0, 1), pieceId: `x_${i}`, capturedId: null, givesCheck: false, elapsedMs: i,
}));
const mkGame = (red, black, over = {}) => ({
  id: randomUUID(),
  roomId: 'ELO234',
  red: { userId: red?.id ?? null, name: red?.displayName ?? 'Khách A', guest: !red },
  black: { userId: black?.id ?? null, name: black?.displayName ?? 'Khách B', guest: !black },
  timeControl: null,
  result: 'red',
  endReason: 'resign',
  moves: mkMoves(8),
  clock: null,
  startedAt: NOW,
  endedAt: NOW + 1000,
  ...over,
});

for (const [name, make, skip] of impls) {
  describe(`Elo trong kho lưu trữ: ${name}`, { skip: skip ?? false }, () => {
    let store;
    before(async () => { store = await make(); });
    after(async () => { await store?.close(); });

    test('người mới có 1500 điểm, chưa có hạng, chưa lên bảng', async () => {
      const u = await mkUser(store, 'new');
      assert.deepEqual(await store.getRating(u.id), { rating: 1500, ratedGames: 0, rank: null });
      assert.equal(await store.getRating(randomUUID()), null);
      assert.equal((await store.listLeaderboard()).some((p) => p.userId === u.id), false);
    });

    test('ván tính điểm: đổi điểm hai bên, lưu trước/sau, idempotent khi lưu lại', async () => {
      const a = await mkUser(store, 'a');
      const b = await mkUser(store, 'b');
      const g = mkGame(a, b, { result: 'red' });
      const r1 = await store.saveGame(g);
      assert.equal(r1.inserted, true);
      assert.deepEqual(r1.rating.red, { before: 1500, after: 1520, delta: 20 });
      assert.deepEqual(r1.rating.black, { before: 1500, after: 1480, delta: -20 });
      assert.equal((await store.getRating(a.id)).rating, 1520);
      assert.equal((await store.getRating(b.id)).rating, 1480);

      const r2 = await store.saveGame(g); // thử lại sau lỗi mạng: KHÔNG cộng điểm lần hai
      assert.equal(r2.inserted, false);
      assert.deepEqual(r2.rating, r1.rating);
      assert.deepEqual(await store.getRating(a.id), { rating: 1520, ratedGames: 1, rank: 1 });

      const saved = await store.getGame(g.id);
      assert.equal(saved.rated, true);
      assert.equal(saved.redRatingBefore, 1500);
      assert.equal(saved.blackRatingAfter, 1480);
    });

    test('ván không tính điểm: có khách, quá ngắn, hoặc tài khoản đã bị xoá khỏi ván', async () => {
      const a = await mkUser(store, 'c');
      const b = await mkUser(store, 'd');
      const gGuest = mkGame(a, null);
      const gShort = mkGame(a, b, { moves: mkMoves(5) });
      assert.equal((await store.saveGame(gGuest)).rating, null);
      assert.equal((await store.saveGame(gShort)).rating, null);
      assert.deepEqual(await store.getRating(a.id), { rating: 1500, ratedGames: 0, rank: null });
      assert.equal((await store.getGame(gGuest.id)).rated, false);
      assert.equal((await store.getGame(gShort.id)).rated, false);
    });

    test('hoà giữa hai người ngang điểm không đổi điểm nhưng vẫn tính 1 ván', async () => {
      const a = await mkUser(store, 'e');
      const b = await mkUser(store, 'f');
      const r = await store.saveGame(mkGame(a, b, { result: 'draw', endReason: 'agreement' }));
      assert.equal(r.rating.red.delta, 0);
      assert.deepEqual(await store.getRating(a.id), { rating: 1500, ratedGames: 1, rank: (await store.getRating(a.id)).rank });
    });

    test('bảng xếp hạng: sắp theo điểm, cùng điểm cùng hạng, phân trang', async () => {
      const s = await make();
      try {
        const [p1, p2, p3, p4] = await Promise.all(['p1', 'p2', 'p3', 'p4'].map((t) => mkUser(s, t)));
        await s.saveGame(mkGame(p1, p2)); // p1 1520, p2 1480
        await s.saveGame(mkGame(p3, p4)); // p3 1520, p4 1480
        const all = await s.listLeaderboard({ limit: 10 });
        assert.deepEqual(all.map((p) => [p.rank, p.rating]), [[1, 1520], [1, 1520], [3, 1480], [3, 1480]]);
        assert.deepEqual(new Set(all.slice(0, 2).map((p) => p.userId)), new Set([p1.id, p3.id]));
        assert.equal((await s.getRating(p2.id)).rank, 3);
        const page2 = await s.listLeaderboard({ limit: 2, offset: 2 });
        assert.deepEqual(page2.map((p) => p.rank), [3, 3]);
        assert.deepEqual(Object.keys(all[0]).sort(), ['avatarUrl', 'displayName', 'rank', 'ratedGames', 'rating', 'userId']);
      } finally {
        if (s !== store) await s.close();
      }
    });

    test('nhiều ván đồng thời của cùng một người: không mất cập nhật điểm', async () => {
      const s = await make();
      try {
        const x = await mkUser(s, 'cx');
        const opps = await Promise.all(Array.from({ length: 10 }, (_, i) => mkUser(s, `co${i}`)));
        const games = opps.map((o, i) => mkGame(x, o, { endedAt: NOW + i }));
        await Promise.all(games.map((g) => s.saveGame(g)));
        const final = await s.getRating(x.id);
        assert.equal(final.ratedGames, 10);
        let sum = 0;
        for (const g of games) { const r = await s.getGame(g.id); sum += r.redRatingAfter - r.redRatingBefore; }
        assert.equal(final.rating, 1500 + sum); // mất cập nhật thì tổng thay đổi từng ván sẽ không khớp điểm cuối
      } finally {
        if (s !== store) await s.close();
      }
    });

    test('rebuildRatings cho đúng kết quả như tính dần từng ván, và chạy lại không đổi', async () => {
      const s = await make();
      try {
        const [a, b, c] = await Promise.all(['ra', 'rb', 'rc'].map((t) => mkUser(s, t)));
        const plan = [[a, b, 'red'], [b, c, 'black'], [c, a, 'draw'], [a, c, 'red'], [b, a, 'black'], [c, b, 'red']];
        let t = NOW;
        for (const [x, y, result] of plan) {
          t += 10_000;
          await s.saveGame(mkGame(x, y, { result, startedAt: t - 5000, endedAt: t }));
        }
        await s.saveGame(mkGame(a, null, { endedAt: t + 1 })); // ván với khách: bỏ qua
        const snap = async () => Promise.all([a, b, c].map((u) => s.getRating(u.id)));
        const incremental = await snap();
        assert.ok(incremental.some((r) => r.rating !== 1500));
        const out = await s.rebuildRatings();
        assert.equal(out.rated, plan.length);
        assert.equal(out.games, plan.length + 1);
        assert.deepEqual(await snap(), incremental);
        await s.rebuildRatings();
        assert.deepEqual(await snap(), incremental);
      } finally {
        if (s !== store) await s.close();
      }
    });
  });
}

describe('Cờ RATE_VS_GUEST: tài khoản đấu khách (MemoryStore)', () => {
  test('TẮT (mặc định): ván tài khoản-với-khách KHÔNG tính điểm', async () => {
    const s = new MemoryStore(); // rateVsGuest mặc định false
    const a = await mkUser(s, 'off_a');
    const g = mkGame(a, null, { result: 'red' }); // a (đỏ) thắng khách (đen)
    const res = await s.saveGame(g);
    assert.equal(res.rating, null);
    assert.equal((await s.getRating(a.id)).rating, 1500);
    await s.close();
  });

  test('BẬT: tài khoản được cộng/trừ điểm dựa trên điểm khách; khách KHÔNG lưu server', async () => {
    const s = new MemoryStore({ rateVsGuest: true });
    const a = await mkUser(s, 'on_a');
    // Tài khoản (đỏ) thắng khách (đen) điểm 1500 -> +20.
    const win = mkGame(a, null, {
      result: 'red',
      red: { userId: a.id, name: a.displayName, guest: false },
      black: { userId: null, name: 'Khách', guest: true, rating: 1500 },
    });
    const r = await s.saveGame(win);
    assert.equal(r.inserted, true);
    assert.deepEqual(r.rating.red, { before: 1500, after: 1520, delta: 20 });
    assert.deepEqual(r.rating.black, { before: 1500, after: 1480, delta: -20 }); // chỉ để báo cho khách
    assert.equal((await s.getRating(a.id)).rating, 1520); // tài khoản được lưu +20

    // Khách không có danh tính server nên không có dòng điểm nào được tạo cho khách.
    assert.equal((await s.listLeaderboard()).length, 1);

    // Điểm khách cao (1800) -> tài khoản thắng được ÍT hơn.
    const b = await mkUser(s, 'on_b');
    const vsStrong = mkGame(b, null, {
      result: 'red',
      red: { userId: b.id, name: b.displayName, guest: false },
      black: { userId: null, name: 'KhStrong', guest: true, rating: 1800 },
    });
    const r2 = await s.saveGame(vsStrong);
    assert.ok(r2.rating.red.delta > 20);
    await s.close();
  });

  test('BẬT: hai khách vẫn KHÔNG tính điểm phía server (khách tự tính tại máy)', async () => {
    const s = new MemoryStore({ rateVsGuest: true });
    const g = mkGame(null, null, { result: 'red' });
    assert.equal((await s.saveGame(g)).rating, null);
    await s.close();
  });
});

describe('Elo qua HTTP và Socket.IO (MemoryStore)', () => {
  let app;
  let base;
  let store;
  let auth;
  const clients = [];
  const sessions = {};

  before(async () => {
    store = new MemoryStore();
    auth = new AuthService({ store, scryptParams: { N: 1024, r: 8, p: 1 }, log: { error() {} } });
    app = createApp({ store, authService: auth });
    await new Promise((r) => app.httpServer.listen(0, r));
    base = `http://127.0.0.1:${app.httpServer.address().port}`;
    for (const n of ['hlan', 'hmai']) {
      sessions[n] = await auth.register({ username: n, password: 'mat-khau-123', displayName: n }, '1.1.1.1');
    }
  });
  after(async () => {
    clients.forEach((c) => c.close());
    await app.close();
  });

  const get = async (path, token) => {
    const res = await fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json() };
  };
  const move = (s, from, to) => emit(s, 'game:move', { from, to });

  test('chơi 6 nước rồi đầu hàng: nhận game:rating, bảng xếp hạng và lịch sử khớp', async () => {
    const s1 = await connectWith(base, { token: sessions.hlan.token }, clients);
    const s2 = await connectWith(base, { token: sessions.hmai.token }, clients);
    const created = await emit(s1, 'room:create', { side: 'red' });
    await emit(s2, 'room:join', { roomId: created.roomId });
    const R = [P(1, 9), P(2, 7)];
    const B = [P(1, 0), P(2, 2)];
    for (let i = 0; i < 3; i++) {
      assert.equal((await move(s1, ...(i % 2 === 0 ? R : [R[1], R[0]]))).ok, true);
      assert.equal((await move(s2, ...(i % 2 === 0 ? B : [B[1], B[0]]))).ok, true);
    }
    assert.equal((await emit(s2, 'game:resign')).ok, true);
    const rating = await waitFor(s1, 'game:rating');
    assert.equal(rating.rated, true);
    assert.deepEqual(rating.red, { before: 1500, after: 1520, delta: 20 });
    assert.deepEqual(rating.black, { before: 1500, after: 1480, delta: -20 });

    const me = await get('/me/rating', sessions.hlan.token);
    assert.deepEqual(me.body.rating, { rating: 1520, ratedGames: 1, rank: 1, provisional: true });
    assert.equal((await get('/me/rating')).status, 401);

    const lb = await get('/leaderboard', sessions.hmai.token);
    assert.deepEqual(lb.body.players.map((p) => [p.rank, p.displayName, p.rating, p.isMe]), [
      [1, 'hlan', 1520, false], [2, 'hmai', 1480, true],
    ]);
    assert.equal(JSON.stringify(lb.body).includes(sessions.hlan.user.id), false); // không lộ id tài khoản
    assert.equal((await get('/leaderboard', 'token-sai-token-sai-token-sai')).status, 200); // dữ liệu công khai
    assert.equal((await get('/leaderboard?limit=1&offset=1')).body.players[0].displayName, 'hmai');
    assert.equal((await get('/leaderboard?limit=1')).body.nextOffset, 1);

    const hist = await get('/me/games', sessions.hmai.token);
    assert.equal(hist.body.games[0].rated, true);
    assert.deepEqual(hist.body.games[0].ratingChange, { before: 1500, after: 1480, delta: -20 });
    const detail = await get(`/games/${hist.body.games[0].id}`);
    assert.equal(detail.body.game.rated, true);
    assert.equal(detail.body.game.ratings.red.after, 1520);
  });

  test('ván với khách: game:rating báo rated:false', async () => {
    const s1 = await connectWith(base, { token: sessions.hlan.token }, clients);
    const s2 = await connectWith(base, { playerId: 'a1b2c3d4e5f60718a1b2c3d4e5f60718' }, clients);
    const created = await emit(s1, 'room:create', { side: 'red' });
    await emit(s2, 'room:join', { roomId: created.roomId });
    await emit(s1, 'game:resign');
    const rating = await waitFor(s2, 'game:rating');
    assert.deepEqual(rating, { roomId: created.roomId, gameId: rating.gameId, rated: false, red: null, black: null });
    assert.equal((await get('/me/rating', sessions.hlan.token)).body.rating.rating, 1520);
  });
});
