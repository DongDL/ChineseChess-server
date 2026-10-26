import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { OAuthService } from '../src/oauth.js';
import { GameRecorder } from '../src/recorder.js';
import { facebookProvider, googleProvider, zaloProvider } from '../src/providers.js';
import { MemoryStore } from '../src/stores/memory.js';
import { PgStore } from '../src/stores/pg.js';
import { startMockProviders } from './helpers/mock-providers.js';
import {
  P, connectWith, emit, sleep, waitFor,
} from './helpers/sockets.js';

// Chạy trên cả MemoryStore và PostgreSQL thật (khi có TEST_DATABASE_URL).
// CẢNH BÁO: bản PostgreSQL XOÁ SẠCH mọi bảng trong CSDL test đó.
const PG_URL = process.env.TEST_DATABASE_URL;
const impls = [
  { name: 'MemoryStore', skip: false, isPg: false, make: async () => new MemoryStore(), reopen: async (s) => s },
  {
    name: 'PostgreSQL thật',
    skip: PG_URL ? false : 'bỏ qua: chưa đặt TEST_DATABASE_URL',
    isPg: true,
    make: async () => {
      const s = new PgStore({ connectionString: PG_URL });
      await s.migrate();
      await s._truncateAllForTests();
      return s;
    },
    reopen: async () => new PgStore({ connectionString: PG_URL }), // "khởi động lại": kết nối mới tới cùng CSDL
  },
];

const quiet = { error() {} };
const FAST = { N: 1024, r: 8, p: 1 };
const BIG = { max: 100_000, windowMs: 60 * 60_000 };

for (const impl of impls) {
  describe(impl.name, { skip: impl.skip }, () => {
    let store;
    let mockServer;
    let mock;
    let app;
    let base;
    let auth;
    let oauth;
    const clients = [];
    const clock = { t: Date.now(), now() { return this.t; }, advance(ms) { this.t += ms; } };

    before(async () => {
      store = await impl.make();
      mockServer = await startMockProviders();
      mock = mockServer.mock;
      auth = new AuthService({
        store, scryptParams: FAST, log: quiet, limits: { registerPerIp: BIG, loginPerIp: BIG },
      });
      const providers = new Map([
        ['google', googleProvider({ clientId: 'gid', clientSecret: 'gsecret', urls: mockServer.urls('google') })],
        ['facebook', facebookProvider({ clientId: 'fid', clientSecret: 'fsecret', urls: mockServer.urls('facebook') })],
        ['zalo', zaloProvider({ clientId: 'zid', clientSecret: 'zsecret', urls: mockServer.urls('zalo') })],
      ]);
      oauth = new OAuthService({
        store, auth, providers, publicUrl: 'http://chua-biet', appRedirects: ['cotuong://auth'],
        now: () => clock.now(), log: quiet,
      });
      app = createApp({
        store,
        authService: auth,
        oauth,
        graceMs: 400,
        clockLimits: { minBaseMs: 100, maxBaseMs: 3 * 60 * 60_000, maxIncrementMs: 60_000 },
      });
      await new Promise((resolve) => app.httpServer.listen(0, resolve));
      base = `http://localhost:${app.httpServer.address().port}`;
      oauth.publicUrl = base; // redirect_uri của server phải trỏ đúng về chính nó
    });

    after(async () => {
      for (const c of clients) c.disconnect();
      await app.close();
      await mockServer.close();
      await store.close();
    });

    // ---------------------------------------------------------------- tiện ích

    async function http(method, path, body, token) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    }

    let seq = 0;
    const uniq = (p) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

    async function registerUser(prefix = 'user') {
      const r = await http('POST', '/auth/register', { username: uniq(prefix), password: 'matkhau123' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body; // { token, user }
    }

    /** Mô phỏng trình duyệt: start -> trang cấp quyền của nhà cung cấp -> callback -> chuyển hướng về app. */
    async function browserLogin(provider, { link = false, token } = {}) {
      const start = await http('POST', `/auth/oauth/${provider}/start`, { appRedirect: 'cotuong://auth', ...(link ? { link: true } : {}) }, token);
      if (start.status !== 200) return { start };
      const authz = await fetch(start.body.url, { redirect: 'manual' });
      assert.equal(authz.status, 302, `nhà cung cấp phải chuyển hướng (đã nhận ${authz.status})`);
      const callbackUrl = authz.headers.get('location');
      const cb = await fetch(callbackUrl, { redirect: 'manual' });
      const location = cb.headers.get('location');
      return { start, callbackUrl, status: cb.status, location, params: location ? Object.fromEntries(new URL(location).searchParams) : {} };
    }

    async function socialLogin(provider) {
      const r = await browserLogin(provider);
      assert.ok(r.params.code, `phải có mã dùng một lần: ${JSON.stringify(r.params)}`);
      const ex = await http('POST', '/auth/oauth/exchange', { code: r.params.code });
      assert.equal(ex.status, 200, JSON.stringify(ex.body));
      return { ...r, ...ex.body }; // { token, user, ... }
    }

    // ------------------------------------------------- đăng nhập mạng xã hội

    test('danh sách nhà cung cấp và kiểm tra yêu cầu bắt đầu đăng nhập', async () => {
      const list = await http('GET', '/auth/providers');
      assert.deepEqual(list.body, { ok: true, providers: ['google', 'facebook', 'zalo'] });

      const post = (p, body, token) => http('POST', `/auth/oauth/${p}/start`, body, token);
      assert.deepEqual((await post('twitter', { appRedirect: 'cotuong://auth' })).body, { ok: false, error: 'provider_not_configured' });
      // Chống chuyển hướng mở: chỉ nhận đúng địa chỉ app trong danh sách cho phép
      for (const evil of ['https://evil.example/steal', 'cotuong://auth/', 'cotuong://other', undefined, 42]) {
        const r = await post('google', { appRedirect: evil });
        assert.deepEqual([r.status, r.body.error], [400, 'invalid_redirect'], String(evil));
      }
      // Liên kết cần đang đăng nhập
      const r = await post('google', { appRedirect: 'cotuong://auth', link: true });
      assert.deepEqual([r.status, r.body.error], [401, 'invalid_token']);
    });

    test('địa chỉ cấp quyền đúng chuẩn từng nhà cung cấp (PKCE, redirect_uri, state)', async () => {
      const urlOf = async (p) => new URL((await http('POST', `/auth/oauth/${p}/start`, { appRedirect: 'cotuong://auth' })).body.url);
      const g = await urlOf('google');
      assert.equal(g.searchParams.get('redirect_uri'), `${base}/auth/oauth/google/callback`);
      assert.equal(g.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(g.searchParams.get('code_challenge').length >= 40);
      assert.ok(g.searchParams.get('state').length >= 40);
      assert.equal(g.searchParams.get('scope'), 'openid email profile');

      const f = await urlOf('facebook');
      assert.equal(f.searchParams.get('code_challenge'), null, 'Facebook không dùng PKCE');
      assert.equal(f.searchParams.get('scope'), 'public_profile,email');

      const z = await urlOf('zalo');
      assert.equal(z.searchParams.get('app_id'), 'zid');
      assert.ok(z.searchParams.get('code_challenge'));
      // Mỗi lần bắt đầu có state và PKCE khác nhau
      assert.notEqual((await urlOf('google')).searchParams.get('state'), g.searchParams.get('state'));
    });

    for (const [provider, profileKey] of [['google', 'google'], ['facebook', 'facebook'], ['zalo', 'zalo']]) {
      test(`đăng nhập bằng ${provider}: tạo tài khoản mới, đăng nhập lại cùng một tài khoản`, async () => {
        mock.profiles[profileKey].id = uniq(`${provider}-id`);
        const first = await socialLogin(provider);
        assert.equal(first.user.username, null);
        assert.equal(first.user.displayName, mock.profiles[profileKey].name);
        assert.equal(first.user.avatarUrl, mock.profiles[profileKey].picture);
        assert.ok(first.token.length >= 40);

        const me = await http('GET', '/auth/me', undefined, first.token);
        assert.equal(me.status, 200);
        assert.deepEqual(me.body.user.providers, [provider]);
        assert.equal(me.body.user.hasPassword, false);

        // Đăng nhập lại cùng một danh tính: cùng tài khoản, token mới
        const second = await socialLogin(provider);
        assert.equal(second.user.id, first.user.id);
        assert.notEqual(second.token, first.token);

        // Danh tính khác: tài khoản khác
        mock.profiles[profileKey].id = uniq(`${provider}-id2`);
        const other = await socialLogin(provider);
        assert.notEqual(other.user.id, first.user.id);

        // Lịch sử đăng nhập: lần đầu có "register" + "login", lần sau chỉ "login"
        const events = (await http('GET', '/me/logins', undefined, first.token)).body.events;
        assert.deepEqual(events.map((e) => [e.event, e.method]).reverse(), [
          ['register', provider], ['login', provider], ['login', provider],
        ]);
        assert.equal(events.every((e) => e.success), true);
      });
    }

    test('token và mã dùng một lần: đổi lần hai thất bại, mã rác thất bại, mã hết hạn thất bại', async () => {
      mock.profiles.google.id = uniq('g-once');
      const r = await browserLogin('google');
      const first = await http('POST', '/auth/oauth/exchange', { code: r.params.code });
      assert.equal(first.status, 200);
      const again = await http('POST', '/auth/oauth/exchange', { code: r.params.code });
      assert.deepEqual([again.status, again.body.error], [400, 'invalid_code']);
      for (const bad of ['', 'abc', 'x'.repeat(43), 12345, undefined]) {
        const x = await http('POST', '/auth/oauth/exchange', { code: bad });
        assert.deepEqual([x.status, x.body.error], [400, 'invalid_code'], String(bad));
      }
      // Mã chỉ sống 60 giây
      const r2 = await browserLogin('google');
      clock.advance(61_000);
      const late = await http('POST', '/auth/oauth/exchange', { code: r2.params.code });
      assert.deepEqual([late.status, late.body.error], [400, 'invalid_code']);
    });

    test('state: sai, dùng lại hoặc hết hạn đều bị từ chối bằng trang lỗi (không chuyển hướng)', async () => {
      const bad = await fetch(`${base}/auth/oauth/google/callback?code=abc&state=khong-co`, { redirect: 'manual' });
      assert.equal(bad.status, 400);
      assert.match(await bad.text(), /hết hạn|không hợp lệ/);
      assert.equal((await fetch(`${base}/auth/oauth/google/callback`, { redirect: 'manual' })).status, 400);

      // Dùng lại state: lần hai phải thất bại
      mock.profiles.google.id = uniq('g-state');
      const r = await browserLogin('google');
      assert.ok(r.params.code);
      assert.equal((await fetch(r.callbackUrl, { redirect: 'manual' })).status, 400, 'state chỉ dùng một lần');

      // State quá 10 phút
      const start = await http('POST', '/auth/oauth/google/start', { appRedirect: 'cotuong://auth' });
      const authz = await fetch(start.body.url, { redirect: 'manual' });
      clock.advance(10 * 60_000 + 1000);
      assert.equal((await fetch(authz.headers.get('location'), { redirect: 'manual' })).status, 400);

      // State của nhà cung cấp này không dùng được ở callback của nhà cung cấp khác
      const s2 = await http('POST', '/auth/oauth/google/start', { appRedirect: 'cotuong://auth' });
      const a2 = await fetch(s2.body.url, { redirect: 'manual' });
      const swapped = a2.headers.get('location').replace('/oauth/google/callback', '/oauth/zalo/callback');
      assert.equal((await fetch(swapped, { redirect: 'manual' })).status, 400);
    });

    test('người dùng từ chối hoặc nhà cung cấp lỗi: chuyển về app kèm mã lỗi, không tạo tài khoản', async () => {
      mock.profiles.google.id = uniq('g-denied');
      mock.denyNext = true;
      const denied = await browserLogin('google');
      assert.equal(denied.status, 302);
      assert.deepEqual(denied.params, { error: 'access_denied' });
      assert.equal(await store.findIdentity('google', mock.profiles.google.id), null);

      mock.failTokenNext = true;
      const failed = await browserLogin('google');
      assert.deepEqual(failed.params, { error: 'provider_error' });
      assert.equal(await store.findIdentity('google', mock.profiles.google.id), null);

      // Sau lỗi vẫn đăng nhập bình thường
      const ok = await socialLogin('google');
      assert.ok(ok.token);
    });

    test('KHÔNG tự động gộp tài khoản theo email trùng (chống chiếm tài khoản)', async () => {
      const victim = await store.createUser({
        username: uniq('nan_nhan'), displayName: 'Nạn nhân', passwordHash: 'x', email: 'nannhan@example.com',
      });
      mock.profiles.google.id = uniq('g-attacker');
      mock.profiles.google.email = 'nannhan@example.com'; // kẻ tấn công có email trùng
      mock.profiles.google.emailVerified = true;
      const login = await socialLogin('google');
      assert.notEqual(login.user.id, victim.id, 'phải là tài khoản MỚI, không phải tài khoản nạn nhân');
      assert.equal((await store.listIdentities(victim.id)).length, 0);
    });

    test('hồ sơ từ nhà cung cấp được làm sạch: tên, ảnh, email', async () => {
      const p = mock.profiles.facebook;
      Object.assign(p, { id: uniq('f-clean'), name: '  \u0007\u0001   ', email: 'khong-phai-email', picture: 'http://khong-https.example/a.png' });
      const a = await socialLogin('facebook');
      assert.equal(a.user.displayName, 'Người chơi'); // tên toàn ký tự điều khiển -> tên mặc định
      assert.equal(a.user.avatarUrl, null); // ảnh không phải https bị bỏ
      assert.equal((await store.findUserById(a.user.id)).email, null); // email sai định dạng bị bỏ

      Object.assign(p, { id: uniq('f-long'), name: 'Nguyễn Văn Một Cái Tên Rất Là Dài Dòng Quá Mức', email: 'ok@example.com' });
      const b = await socialLogin('facebook');
      assert.ok(Array.from(b.user.displayName).length <= 24);
      assert.ok(b.user.displayName.startsWith('Nguyễn Văn Một'));
    });

    // --------------------------------------------------- liên kết / gỡ liên kết

    test('liên kết Google vào tài khoản mật khẩu, rồi gỡ ra', async () => {
      const me = await registerUser('lienket');
      mock.profiles.google.id = uniq('g-link');
      const linked = await browserLogin('google', { link: true, token: me.token });
      assert.deepEqual(linked.params, { linked: 'google' });
      assert.deepEqual((await http('GET', '/auth/me', undefined, me.token)).body.user.providers, ['google']);

      // Giờ đăng nhập bằng Google vào đúng tài khoản mật khẩu đó
      const viaGoogle = await socialLogin('google');
      assert.equal(viaGoogle.user.id, me.user.id);
      assert.equal(viaGoogle.user.username, me.user.username);

      const un = await http('DELETE', '/auth/oauth/google', undefined, me.token);
      assert.equal(un.status, 200);
      assert.deepEqual((await http('GET', '/auth/me', undefined, me.token)).body.user.providers, []);
      assert.equal((await http('DELETE', '/auth/oauth/google', undefined, me.token)).body.error, 'not_linked');
      assert.equal((await http('DELETE', '/auth/oauth/google')).status, 401);

      const events = (await http('GET', '/me/logins', undefined, me.token)).body.events.map((e) => e.event);
      assert.ok(events.includes('link') && events.includes('unlink'));
    });

    test('không liên kết được danh tính đã thuộc người khác, hay nhà cung cấp đã liên kết rồi', async () => {
      const a = await registerUser('chu_a');
      const b = await registerUser('chu_b');
      mock.profiles.google.id = uniq('g-share');
      assert.deepEqual((await browserLogin('google', { link: true, token: a.token })).params, { linked: 'google' });
      assert.deepEqual((await browserLogin('google', { link: true, token: b.token })).params, { error: 'identity_taken' });
      // a liên kết lại cùng danh tính: không sao; đổi sang tài khoản Google khác: bị từ chối
      assert.deepEqual((await browserLogin('google', { link: true, token: a.token })).params, { linked: 'google' });
      mock.profiles.google.id = uniq('g-other');
      assert.deepEqual((await browserLogin('google', { link: true, token: a.token })).params, { error: 'provider_already_linked' });
    });

    test('không cho gỡ cách đăng nhập DUY NHẤT; có cách khác thì gỡ được', async () => {
      mock.profiles.zalo.id = uniq('z-only');
      const z = await socialLogin('zalo'); // tài khoản chỉ có Zalo, không mật khẩu
      const refuse = await http('DELETE', '/auth/oauth/zalo', undefined, z.token);
      assert.deepEqual([refuse.status, refuse.body.error], [409, 'last_login_method']);

      mock.profiles.google.id = uniq('g-second');
      assert.deepEqual((await browserLogin('google', { link: true, token: z.token })).params, { linked: 'google' });
      assert.equal((await http('DELETE', '/auth/oauth/zalo', undefined, z.token)).status, 200);
      // Giờ Google là cách duy nhất còn lại
      assert.equal((await http('DELETE', '/auth/oauth/google', undefined, z.token)).body.error, 'last_login_method');
    });

    // ------------------------------------------------- ghi ván và lịch sử

    async function playGame({ a, b, moves = 0, resigner = 'b', timeControl }) {
      const created = await emit(a, 'room:create', { side: 'red', ...(timeControl ? { timeControl } : {}) });
      assert.equal(created.ok, true, JSON.stringify(created));
      const startA = waitFor(a, 'game:start');
      await emit(b, 'room:join', { roomId: created.roomId });
      await startA;
      
      // Nếu không resigner và có timeControl, phải đi nước đầu để bắt đầu đồng hồ
      const needFirstMove = !resigner && timeControl;
      if (needFirstMove || moves >= 1) {
        const seen = waitFor(b, 'game:move');
        assert.equal((await emit(a, 'game:move', { from: P(1, 7), to: P(4, 7) })).ok, true);
        await seen;
      }
      
      const overA = waitFor(a, 'game:over', 3000);
      if (resigner === 'b') await emit(b, 'game:resign');
      else if (resigner === 'a') await emit(a, 'game:resign');
      return overA;
    }

    test('ván đấu được lưu: lịch sử, thống kê, xem lại; khách và tài khoản đều có ván', async () => {
      const acc = await registerUser('thu');
      const a = await connectWith(base, { token: acc.token }, clients);
      const guestId = `guest-${uniq('id')}-xxxxxxxx`;
      const b = await connectWith(base, { playerId: guestId, name: 'Khách Bình' }, clients);

      const over = await playGame({ a, b, moves: 1, resigner: 'b' });
      assert.equal(over.result, 'red');
      assert.match(over.gameId, /^[0-9a-f-]{36}$/);
      await app.recorder.drain();

      const list = await http('GET', '/me/games', undefined, acc.token);
      assert.equal(list.body.games.length, 1);
      const g = list.body.games[0];
      assert.deepEqual(
        [g.id, g.mySide, g.outcome, g.endReason, g.opponentName, g.opponentGuest, g.moveCount],
        [over.gameId, 'red', 'win', 'resign', 'Khách Bình', true, 1],
      );
      assert.deepEqual((await http('GET', '/me/stats', undefined, acc.token)).body.stats, { total: 1, wins: 1, losses: 0, draws: 0 });

      // Xem lại ván: không cần đăng nhập, có đủ nước đi, KHÔNG lộ id tài khoản hay playerId của khách
      const detail = await http('GET', `/games/${over.gameId}`);
      assert.equal(detail.status, 200);
      const game = detail.body.game;
      assert.equal(game.redName, acc.user.displayName);
      assert.equal(game.redGuest, false);
      assert.equal(game.blackGuest, true);
      assert.equal(game.moveCount, 1);
      assert.equal(game.moves[0].pieceId, 'red_cannon_0');
      assert.deepEqual(game.moves[0].from, P(1, 7));
      assert.deepEqual(game.moves[0].to, P(4, 7));
      assert.equal(typeof game.moves[0].elapsedMs, 'number');
      const raw = JSON.stringify(detail.body);
      assert.equal(raw.includes(acc.user.id), false, 'không lộ id tài khoản');
      assert.equal(raw.includes(guestId), false, 'không lộ playerId của khách');

      // Khách không có tài khoản nên không có "lịch sử của tôi", nhưng ván vẫn xem được qua id
      assert.equal((await http('GET', '/me/games')).status, 401);
      assert.equal((await http('GET', '/games/00000000-0000-4000-8000-000000000000')).status, 404);
      assert.equal((await http('GET', '/games/khong-phai-uuid')).status, 404);
    });

    test('ván hết giờ được lưu cùng mức thời gian; phân trang lịch sử', async () => {
      const acc = await registerUser('trang');
      const a = await connectWith(base, { token: acc.token }, clients);
      const b = await connectWith(base, { playerId: `guest-${uniq('p')}-yyyyyyyy` }, clients);

      const timeout = await playGame({ a, b, resigner: null, timeControl: { baseMs: 300, incrementMs: 0 } });
      assert.equal(timeout.reason, 'timeout');
      // Đỏ đi nước đầu để bắt đầu đồng hồ -> Đen hết giờ -> Đỏ thắng
      assert.equal(timeout.result, 'red');
      await sleep(30);
      await playGame({ a, b, resigner: 'a' }); // a đầu hàng -> thua
      await sleep(30);
      await playGame({ a, b, moves: 1, resigner: 'b' });
      await app.recorder.drain();

      const t = (await http('GET', `/games/${timeout.gameId}`)).body.game;
      assert.deepEqual(
        [t.endReason, t.result, t.baseMs, t.incrementMs],
        ['timeout', 'red', 300, 0],
      );

      assert.deepEqual((await http('GET', '/me/stats', undefined, acc.token)).body.stats, { total: 3, wins: 2, losses: 1, draws: 0 });
      const page1 = (await http('GET', '/me/games?limit=2', undefined, acc.token)).body;
      assert.equal(page1.games.length, 2);
      assert.deepEqual(page1.games.map((g) => g.outcome), ['loss', 'win']); // mới nhất trước
      assert.ok(page1.nextBefore);
      const page2 = (await http('GET', `/me/games?limit=2&before=${page1.nextBefore}`, undefined, acc.token)).body;
      assert.equal(page2.games.length, 1);
      assert.equal(page2.games[0].endReason, 'timeout');
      assert.equal(page2.nextBefore, null);
    });

    test('lịch sử đăng nhập của tôi: đủ thông tin, không lẫn của người khác', async () => {
      const me = await registerUser('lichsu');
      const other = await registerUser('khac');
      await http('POST', '/auth/login', { username: me.user.username, password: 'sai-mat-khau' });
      await http('POST', '/auth/login', { username: me.user.username, password: 'matkhau123' });
      const events = (await http('GET', '/me/logins', undefined, me.token)).body.events;
      assert.deepEqual(events.map((e) => [e.event, e.success]).reverse(), [
        ['register', true], ['login_failed', false], ['login', true],
      ]);
      assert.equal(events[0].method, 'password');
      assert.ok(events[0].ip);
      assert.equal('userId' in events[0], false);
      assert.equal((await http('GET', '/me/logins', undefined, other.token)).body.events.length, 1);
      assert.equal((await http('GET', '/me/logins')).status, 401);
    });

    // ------------------------------------------------ độ bền khi khởi động lại

    test('khởi động lại: token, ván và danh tính vẫn còn (dữ liệu nằm trong kho, không nằm trong tiến trình)', async () => {
      const acc = await registerUser('khoidong');
      const reopened = await impl.reopen(store);
      try {
        const auth2 = new AuthService({ store: reopened, scryptParams: FAST, log: quiet });
        assert.equal((await auth2.authenticate(acc.token)).id, acc.user.id);
        assert.ok(await auth2.login({ username: acc.user.username, password: 'matkhau123' }));
        const someGame = (await store.listGamesOfUser((await store.findUserByUsername(
          (await store.findUserById(acc.user.id)).username)).id)).at(0);
        if (someGame) assert.ok(await reopened.getGame(someGame.id));
      } finally {
        if (reopened !== store) await reopened.close();
      }
    });

    if (impl.isPg) {
      test('PostgreSQL: migration chạy lại không đổi gì, bảng và chỉ mục đã có', async () => {
        assert.deepEqual(await store.migrate(), []);
        const tables = (await store.pool.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
        )).rows.map((r) => r.table_name);
        for (const t of ['users', 'oauth_identities', 'sessions', 'oauth_states', 'oauth_codes', 'auth_events', 'games', 'schema_migrations']) {
          assert.ok(tables.includes(t), `thiếu bảng ${t}`);
        }
        const done = (await store.pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name);
        assert.deepEqual(done, ['001_init.sql', '002_ratings.sql', '003_recovery_email.sql', '004_jieqi.sql', '005_secure_jieqi_seed.sql']);
      });

      test('PostgreSQL: chỉ lưu BĂM của token, không lưu token gốc hay mật khẩu gốc', async () => {
        const acc = await registerUser('bam');
        const dump = JSON.stringify((await store.pool.query('SELECT * FROM sessions')).rows)
          + JSON.stringify((await store.pool.query('SELECT * FROM users')).rows);
        assert.equal(dump.includes(acc.token), false, 'token gốc không được nằm trong CSDL');
        assert.equal(dump.includes('matkhau123'), false, 'mật khẩu gốc không được nằm trong CSDL');
        assert.match(dump, /scrypt\$/);
      });
    }
  });
}

// ------------------------------------------------------------ GameRecorder

test('GameRecorder: thử lại khi CSDL lỗi tạm thời rồi lưu được', async () => {
  let calls = 0;
  const saved = [];
  const store = {
    async saveGame(g) {
      calls++;
      if (calls < 3) throw new Error('CSDL tạm thời lỗi');
      saved.push(g.id);
    },
  };
  const rec = new GameRecorder(store, { retryDelaysMs: [0, 1, 1], log: quiet });
  assert.equal(await rec.record({ id: 'g1' }), true);
  assert.equal(calls, 3);
  assert.deepEqual(saved, ['g1']);
});

test('GameRecorder: hết số lần thử thì bỏ cuộc và không làm sập server', async () => {
  let calls = 0;
  const rec = new GameRecorder({ async saveGame() { calls++; throw new Error('hỏng hẳn'); } }, { retryDelaysMs: [0, 1], log: quiet });
  assert.equal(await rec.record({ id: 'g2' }), false);
  assert.equal(calls, 2);
});

test('GameRecorder: drain() chờ các lần ghi đang chạy hoàn tất', async () => {
  const done = [];
  const rec = new GameRecorder(
    { async saveGame(g) { await sleep(40); done.push(g.id); } },
    { retryDelaysMs: [0], log: quiet },
  );
  rec.record({ id: 'a' });
  rec.record({ id: 'b' });
  assert.deepEqual(done, []);
  await rec.drain();
  assert.deepEqual(done.sort(), ['a', 'b']);
  assert.equal(rec.pending.size, 0);
});
