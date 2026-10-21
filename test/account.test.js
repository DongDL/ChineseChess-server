import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { MemoryStore } from '../src/stores/memory.js';
import { PgStore } from '../src/stores/pg.js';

const PG_URL = process.env.TEST_DATABASE_URL;
const FAST = { N: 1024, r: 8, p: 1 };
const BIG = { max: 100_000, windowMs: 60 * 60_000 };
const impls = [
  ['MemoryStore', () => new MemoryStore(), null],
  ['PostgreSQL thật', async () => {
    const s = new PgStore({ connectionString: PG_URL });
    await s.migrate();
    await s._truncateAllForTests();
    return s;
  }, PG_URL ? null : 'bỏ qua: chưa đặt TEST_DATABASE_URL'],
];

for (const [name, make, skip] of impls) {
  describe(`Đổi mật khẩu / xoá tài khoản: ${name}`, { skip: skip ?? false }, () => {
    let store; let app; let base; let auth;
    before(async () => {
      store = await make();
      auth = new AuthService({
        store, scryptParams: FAST, log: { error() {} },
        limits: { registerPerIp: BIG, loginPerIp: BIG, failPerUser: { max: 3, windowMs: 60_000 } },
      });
      app = createApp({ store, authService: auth });
      await new Promise((r) => app.httpServer.listen(0, r));
      base = `http://127.0.0.1:${app.httpServer.address().port}`;
    });
    after(async () => { await app.close(); await store.close(); });

    const call = async (method, path, body, token) => {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    };
    const signup = (u) => auth.register({ username: u, password: 'mat-khau-cu-1', displayName: u }, '9.9.9.9');

    test('đổi mật khẩu: sai mật khẩu cũ bị từ chối, đúng thì phiên khác bị thu hồi còn phiên hiện tại sống', async () => {
      const a = await signup('doimk');
      const other = await auth.login({ username: 'doimk', password: 'mat-khau-cu-1' }, '9.9.9.9'); // phiên thứ hai
      assert.equal((await call('POST', '/auth/password', { currentPassword: 'sai-sai-sai', newPassword: 'mat-khau-moi-2' }, a.token)).status, 401);
      assert.equal((await call('POST', '/auth/password', { currentPassword: 'mat-khau-cu-1', newPassword: 'ngan' }, a.token)).body.error, 'invalid_password');
      assert.equal((await call('POST', '/auth/password', { currentPassword: 'mat-khau-cu-1', newPassword: 'mat-khau-cu-1' }, a.token)).body.error, 'same_password');
      assert.equal((await call('POST', '/auth/password', { currentPassword: 'mat-khau-cu-1', newPassword: 'mat-khau-moi-2' })).status, 401); // thiếu token

      const ok = await call('POST', '/auth/password', { currentPassword: 'mat-khau-cu-1', newPassword: 'mat-khau-moi-2' }, a.token);
      assert.deepEqual(ok.body, { ok: true, revoked: 1 });
      assert.equal((await call('GET', '/auth/me', null, a.token)).status, 200);
      assert.equal((await call('GET', '/auth/me', null, other.token)).status, 401, 'phiên cũ phải bị đá ra');
      assert.equal((await call('POST', '/auth/login', { username: 'doimk', password: 'mat-khau-cu-1' })).status, 401);
      assert.equal((await call('POST', '/auth/login', { username: 'doimk', password: 'mat-khau-moi-2' })).status, 200);
      const events = (await call('GET', '/me/logins', null, a.token)).body.events.map((e) => e.event);
      assert.ok(events.includes('password_change') && events.includes('password_change_failed'));
    });

    test('đoán mật khẩu cũ qua API đổi mật khẩu cũng bị khoá tạm', async () => {
      const a = await signup('doanmk');
      for (let i = 0; i < 3; i++) {
        assert.equal((await call('POST', '/auth/password', { currentPassword: `sai-lan-${i}-x`, newPassword: 'mat-khau-moi-2' }, a.token)).status, 401);
      }
      const locked = await call('POST', '/auth/password', { currentPassword: 'mat-khau-cu-1', newPassword: 'mat-khau-moi-2' }, a.token);
      assert.equal(locked.status, 429);
    });

    test('xoá tài khoản: cần mật khẩu; xoá xong token chết, tên đăng nhập dùng lại được, ván cũ còn nhưng mất liên kết', async () => {
      const a = await signup('xoatk');
      const b = await signup('doithu');
      const gid = randomUUID();
      await store.saveGame({
        id: gid, roomId: 'DEL234',
        red: { userId: a.user.id, name: 'xoatk', guest: false },
        black: { userId: b.user.id, name: 'doithu', guest: false },
        timeControl: null, result: 'red', endReason: 'resign',
        moves: Array.from({ length: 8 }, (_, i) => ({ from: { col: 0, row: 0 }, to: { col: 0, row: 1 }, pieceId: `x${i}`, capturedId: null, givesCheck: false, elapsedMs: i })),
        clock: null, startedAt: 1_700_000_000_000, endedAt: 1_700_000_001_000,
      });

      assert.equal((await call('POST', '/auth/account/delete', { password: 'sai-sai-sai' }, a.token)).status, 401);
      assert.equal((await call('POST', '/auth/account/delete', {}, a.token)).status, 401);
      assert.equal((await call('GET', '/auth/me', null, a.token)).status, 200, 'nhập sai thì chưa xoá');

      assert.equal((await call('POST', '/auth/account/delete', { password: 'mat-khau-cu-1' }, a.token)).status, 200);
      assert.equal((await call('GET', '/auth/me', null, a.token)).status, 401);
      assert.equal((await call('POST', '/auth/login', { username: 'xoatk', password: 'mat-khau-cu-1' })).status, 401);
      assert.equal(await store.findUserById(a.user.id), null);
      assert.deepEqual(await store.listAuthEvents(a.user.id), []); // lịch sử đăng nhập (có IP) cũng bị xoá

      const g = await store.getGame(gid); // ván còn, tên còn, liên kết tài khoản mất
      assert.equal(g.redName, 'xoatk');
      const mine = await call('GET', '/me/games', null, b.token);
      assert.equal(mine.body.games.length, 1); // đối thủ vẫn thấy ván trong lịch sử của mình
      assert.equal(mine.body.games[0].opponentName, 'xoatk');
      assert.equal((await signup('xoatk')).user.username, 'xoatk');
    });

    test('tài khoản chỉ đăng nhập mạng xã hội: xoá cần confirm=DELETE, đổi mật khẩu bị từ chối', async () => {
      const user = await store.createUserWithIdentity(
        { displayName: 'Chi Fb' }, { provider: 'facebook', providerUserId: 'fb-del-1' },
      );
      const sess = await auth.startSession(user, { method: 'facebook' });
      assert.equal((await call('POST', '/auth/password', { currentPassword: 'x', newPassword: 'mat-khau-moi-2' }, sess.token)).body.error, 'no_password');
      assert.equal((await call('POST', '/auth/account/delete', {}, sess.token)).body.error, 'confirmation_required');
      assert.equal((await call('POST', '/auth/account/delete', { confirm: 'DELETE' }, sess.token)).status, 200);
      assert.equal(await store.findIdentity('facebook', 'fb-del-1'), null);
    });
  });
}
