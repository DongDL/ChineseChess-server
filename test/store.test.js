import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../src/stores/memory.js';
import { PgStore } from '../src/stores/pg.js';

// Cùng MỘT bộ kiểm tra chạy trên cả hai bản cài đặt để chúng có hành vi giống hệt nhau.
// Bản PostgreSQL chỉ chạy khi có TEST_DATABASE_URL, ví dụ:
//   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/xiangqi_test npm test
// CẢNH BÁO: bộ test XOÁ SẠCH mọi bảng trong CSDL đó, chỉ trỏ vào CSDL dành riêng cho test.
const PG_URL = process.env.TEST_DATABASE_URL;

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
const mkUser = (store, tag, extra = {}) =>
  store.createUser({ username: `u_${tag}`, displayName: `User ${tag}`, passwordHash: 'h', ...extra });
const mkGame = (over = {}) => ({
  id: randomUUID(),
  roomId: 'ABC234',
  red: { userId: null, name: 'An', guest: true },
  black: { userId: null, name: 'Bình', guest: true },
  timeControl: { baseMs: 300_000, incrementMs: 3_000 },
  result: 'red',
  endReason: 'resign',
  moves: [
    { from: { col: 1, row: 7 }, to: { col: 4, row: 7 }, pieceId: 'red_cannon_0', capturedId: null, givesCheck: false, elapsedMs: 1200 },
    { from: { col: 1, row: 2 }, to: { col: 4, row: 2 }, pieceId: 'black_cannon_0', capturedId: null, givesCheck: false, elapsedMs: 2500 },
  ],
  clock: { redMs: 290_000, blackMs: 299_000 },
  startedAt: NOW - 60_000,
  endedAt: NOW,
  ...over,
});

for (const [name, make, skip] of impls) {
  describe(name, { skip: skip ?? false }, () => {
    let store;
    before(async () => { store = await make(); });
    after(async () => { await store?.close(); });

    test('người dùng: tạo, tìm, trùng tên, nhiều tài khoản không có username', async () => {
      const u = await mkUser(store, 'a1', { email: 'a1@example.com' });
      assert.match(u.id, /^[0-9a-f-]{36}$/);
      assert.equal(u.username, 'u_a1');
      assert.equal(u.email, 'a1@example.com');
      assert.equal(u.lastLoginAt, null);
      assert.equal((await store.findUserByUsername('u_a1')).id, u.id);
      assert.equal((await store.findUserById(u.id)).displayName, 'User a1');
      assert.equal(await store.findUserByUsername('khong_co'), null);
      assert.equal(await store.findUserById(randomUUID()), null);
      assert.equal(await store.findUserById('khong-phai-uuid'), null);

      await assert.rejects(mkUser(store, 'a1'), /username_taken/);
      // Tài khoản chỉ đăng nhập mạng xã hội: username = null, nhiều tài khoản như vậy cùng tồn tại
      const s1 = await store.createUser({ displayName: 'Social 1' });
      const s2 = await store.createUser({ displayName: 'Social 2' });
      assert.equal(s1.username, null);
      assert.equal(s1.passwordHash, null);
      assert.notEqual(s1.id, s2.id);

      await store.touchLogin(u.id, NOW);
      assert.equal((await store.findUserById(u.id)).lastLoginAt, NOW);
    });

    test('danh tính ngoài: tạo kèm tài khoản, trùng, liên kết, gỡ, cập nhật hồ sơ', async () => {
      const ident = (id, extra = {}) => ({
        provider: 'google', providerUserId: id, email: 'g@example.com', displayName: 'Gờ', avatarUrl: 'https://x/a.png', ...extra,
      });
      const u = await store.createUserWithIdentity({ displayName: 'Social A' }, ident('g-100'));
      const found = await store.findIdentity('google', 'g-100');
      assert.equal(found.userId, u.id);
      assert.equal(found.email, 'g@example.com');
      assert.equal(await store.findIdentity('google', 'khong-co'), null);
      assert.equal(await store.findIdentity('facebook', 'g-100'), null); // khác nhà cung cấp là khác danh tính

      // Danh tính đã thuộc tài khoản khác: không tạo thêm tài khoản nào (tất cả hoặc không gì cả)
      await assert.rejects(
        store.createUserWithIdentity({ username: 'u_atomic', displayName: 'Atomic' }, ident('g-100')),
        /identity_taken/,
      );
      assert.equal(await store.findUserByUsername('u_atomic'), null);

      // Liên kết thêm nhà cung cấp khác cho cùng tài khoản
      await store.createIdentity({ userId: u.id, provider: 'zalo', providerUserId: 'z-1', displayName: 'Zờ' });
      assert.deepEqual((await store.listIdentities(u.id)).map((i) => i.provider), ['google', 'zalo']);
      // Một tài khoản chỉ liên kết một danh tính cho mỗi nhà cung cấp
      await assert.rejects(
        store.createIdentity({ userId: u.id, provider: 'google', providerUserId: 'g-999' }),
        /provider_already_linked/,
      );
      // Danh tính đã có chủ
      const other = await store.createUser({ displayName: 'Other' });
      await assert.rejects(
        store.createIdentity({ userId: other.id, provider: 'zalo', providerUserId: 'z-1' }),
        /identity_taken/,
      );

      // Cập nhật lần đăng nhập và ảnh chụp hồ sơ; giá trị null/undefined giữ nguyên giá trị cũ
      await store.touchIdentityLogin('google', 'g-100', NOW, { displayName: 'Tên mới', email: null });
      const after = await store.findIdentity('google', 'g-100');
      assert.equal(after.lastLoginAt, NOW);
      assert.equal(after.displayName, 'Tên mới');
      assert.equal(after.email, 'g@example.com');

      assert.equal(await store.deleteIdentity(u.id, 'zalo'), true);
      assert.equal(await store.deleteIdentity(u.id, 'zalo'), false);
      assert.equal(await store.findIdentity('zalo', 'z-1'), null);
    });

    test('phiên: hợp lệ, hết hạn, xoá, dọn dẹp', async () => {
      const u = await mkUser(store, 's1');
      await store.createSession({ tokenHash: 'h-ok', userId: u.id, expiresAt: NOW + 1000, method: 'password', ip: '1.2.3.4', userAgent: 'UA' });
      await store.createSession({ tokenHash: 'h-old', userId: u.id, expiresAt: NOW - 1, method: 'google' });
      assert.deepEqual(await store.getSession('h-ok', NOW), { userId: u.id, expiresAt: NOW + 1000 });
      assert.equal(await store.getSession('h-old', NOW), null);
      assert.equal(await store.getSession('khong-co', NOW), null);
      assert.equal(await store.purgeExpired(NOW), 1);
      await store.deleteSession('h-ok');
      assert.equal(await store.getSession('h-ok', NOW), null);
    });

    test('luồng OAuth: state và mã đổi token chỉ dùng được MỘT lần và có hạn', async () => {
      const u = await mkUser(store, 'o1');
      await store.saveOAuthState({
        stateHash: 's1', provider: 'google', appRedirect: 'cotuong://auth', codeVerifier: 'v', linkUserId: u.id, expiresAt: NOW + 1000,
      });
      const st = await store.takeOAuthState('s1', NOW);
      assert.equal(st.provider, 'google');
      assert.equal(st.appRedirect, 'cotuong://auth');
      assert.equal(st.codeVerifier, 'v');
      assert.equal(st.linkUserId, u.id);
      assert.equal(await store.takeOAuthState('s1', NOW), null, 'dùng lần hai phải thất bại');

      await store.saveOAuthState({ stateHash: 's2', provider: 'zalo', appRedirect: 'x', codeVerifier: 'v', expiresAt: NOW - 1 });
      assert.equal(await store.takeOAuthState('s2', NOW), null, 'hết hạn');
      assert.equal((await store.takeOAuthState('khong-co', NOW)), null);

      await store.saveExchangeCode({ codeHash: 'c1', userId: u.id, method: 'facebook', expiresAt: NOW + 1000 });
      assert.deepEqual(
        (({ userId, method }) => ({ userId, method }))(await store.takeExchangeCode('c1', NOW)),
        { userId: u.id, method: 'facebook' },
      );
      assert.equal(await store.takeExchangeCode('c1', NOW), null);
      await store.saveExchangeCode({ codeHash: 'c2', userId: u.id, method: 'zalo', expiresAt: NOW - 1 });
      assert.equal(await store.takeExchangeCode('c2', NOW), null);
    });

    test('lịch sử đăng nhập: mới nhất trước, lọc theo người dùng, giới hạn, xoá bản cũ', async () => {
      const a = await mkUser(store, 'e1');
      const b = await mkUser(store, 'e2');
      await store.addAuthEvent({ userId: a.id, event: 'login', method: 'password', success: true, ip: '1.1.1.1', userAgent: 'UA', at: NOW - 3000 });
      await store.addAuthEvent({ userId: a.id, event: 'login_failed', method: 'password', success: false, detail: 'bad_password', at: NOW - 2000 });
      await store.addAuthEvent({ userId: a.id, event: 'login', method: 'google', success: true, at: NOW - 1000 });
      await store.addAuthEvent({ userId: b.id, event: 'login', method: 'zalo', success: true, at: NOW });
      await store.addAuthEvent({ userId: null, event: 'login_failed', method: 'password', success: false, detail: 'unknown_user', at: NOW });

      const list = await store.listAuthEvents(a.id);
      assert.deepEqual(list.map((e) => e.method), ['google', 'password', 'password']);
      assert.equal(list[2].ip, '1.1.1.1');
      assert.equal(list[2].userAgent, 'UA');
      assert.equal(list[1].success, false);
      assert.equal(list[1].detail, 'bad_password');
      assert.equal(typeof list[0].id, 'number');
      assert.equal((await store.listAuthEvents(a.id, { limit: 2 })).length, 2);
      assert.equal((await store.listAuthEvents(b.id)).length, 1);

      assert.equal(await store.purgeAuthEvents(NOW - 1500), 2); // xoá 2 bản cũ của a
      assert.equal((await store.listAuthEvents(a.id)).length, 1);
    });

    test('ván đấu: lưu, đọc lại đủ nước đi, lưu trùng không nhân đôi, ván của khách', async () => {
      const g = mkGame();
      await store.saveGame(g);
      await store.saveGame(g); // lưu lại cùng một ván (ví dụ thử lại sau lỗi mạng)
      const got = await store.getGame(g.id);
      assert.equal(got.id, g.id);
      assert.equal(got.redName, 'An');
      assert.equal(got.redGuest, true);
      assert.equal(got.redUserId, null);
      assert.equal(got.result, 'red');
      assert.equal(got.endReason, 'resign');
      assert.equal(got.baseMs, 300_000);
      assert.equal(got.incrementMs, 3_000);
      assert.equal(got.moveCount, 2);
      assert.deepEqual(got.moves, g.moves);
      assert.equal(got.redRemainingMs, 290_000);
      assert.equal(got.startedAt, g.startedAt);
      assert.equal(got.endedAt, g.endedAt);

      assert.equal(await store.getGame(randomUUID()), null);
      assert.equal(await store.getGame('khong-phai-uuid'), null);

      // Ván không giới hạn thời gian
      const free = mkGame({ timeControl: null, clock: null });
      await store.saveGame(free);
      const f = await store.getGame(free.id);
      assert.equal(f.baseMs, null);
      assert.equal(f.redRemainingMs, null);
    });

    test('lịch sử và thống kê của một tài khoản', async () => {
      const me = await mkUser(store, 'h1');
      const foe = await mkUser(store, 'h2');
      const as = (side, result, endedAt) => mkGame({
        endedAt,
        startedAt: endedAt - 5000,
        result,
        red: side === 'red' ? { userId: me.id, name: 'Tôi', guest: false } : { userId: foe.id, name: 'Địch', guest: false },
        black: side === 'black' ? { userId: me.id, name: 'Tôi', guest: false } : { userId: foe.id, name: 'Địch', guest: false },
      });
      await store.saveGame(as('red', 'red', NOW + 1000));   // thắng
      await store.saveGame(as('black', 'red', NOW + 2000)); // thua (Đỏ thắng, mình cầm Đen)
      await store.saveGame(as('black', 'draw', NOW + 3000));// hoà
      await store.saveGame(as('black', 'black', NOW + 4000));// thắng

      const list = await store.listGamesOfUser(me.id);
      assert.deepEqual(list.map((g) => g.endedAt), [NOW + 4000, NOW + 3000, NOW + 2000, NOW + 1000]);
      assert.equal('moves' in list[0], false, 'danh sách không kèm nước đi');
      assert.equal(list[0].moveCount, 2);
      assert.equal((await store.listGamesOfUser(me.id, { limit: 2 })).length, 2);
      assert.deepEqual(
        (await store.listGamesOfUser(me.id, { before: NOW + 3000 })).map((g) => g.endedAt),
        [NOW + 2000, NOW + 1000],
      );
      assert.equal((await store.listGamesOfUser(randomUUID())).length, 0);

      assert.deepEqual(await store.statsOfUser(me.id), { total: 4, wins: 2, losses: 1, draws: 1 });
      assert.deepEqual(await store.statsOfUser(foe.id), { total: 4, wins: 1, losses: 2, draws: 1 });
      assert.deepEqual(await store.statsOfUser(randomUUID()), { total: 0, wins: 0, losses: 0, draws: 0 });
    });

    test('ván có tài khoản không còn tồn tại vẫn được lưu (không mất ván)', async () => {
      const g = mkGame({ red: { userId: randomUUID(), name: 'Ma', guest: false } });
      await store.saveGame(g);
      const got = await store.getGame(g.id);
      assert.equal(got.redName, 'Ma');
      assert.equal(got.moveCount, 2);
    });
  });
}
