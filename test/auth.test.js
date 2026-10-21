import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthService, AuthError, RateLimiter, hashPassword, verifyPassword,
  validateUsername, validatePassword, validateDisplayName,
} from '../src/auth.js';
import { MemoryStore } from '../src/stores/memory.js';

// Chi phí băm thấp để test chạy nhanh (server thật dùng N=16384).
const FAST = { N: 1024, r: 8, p: 1 };

function makeAuth(overrides = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const store = overrides.store ?? new MemoryStore();
  const auth = new AuthService({ store, now: clock.now, scryptParams: FAST, ...overrides });
  return { auth, store, clock };
}

const rejects = (promise, code) =>
  assert.rejects(promise, (e) => e instanceof AuthError && e.code === code, `cần lỗi ${code}`);

test('băm mật khẩu: mỗi lần băm khác nhau (muối ngẫu nhiên) nhưng đều xác minh đúng', async () => {
  const h1 = await hashPassword('mat-khau-dai-123', FAST);
  const h2 = await hashPassword('mat-khau-dai-123', FAST);
  assert.notEqual(h1, h2);
  assert.match(h1, /^scrypt\$1024\$8\$1\$/);
  assert.equal(await verifyPassword('mat-khau-dai-123', h1), true);
  assert.equal(await verifyPassword('mat-khau-dai-123', h2), true);
  assert.equal(await verifyPassword('sai-mat-khau', h1), false);
  assert.equal(await verifyPassword('mat-khau-dai-123', 'khong-phai-hash'), false);
});

test('kiểm tra tên đăng nhập, mật khẩu, tên hiển thị', () => {
  assert.equal(validateUsername('  LamDong_01 '), 'lamdong_01'); // chuẩn hoá chữ thường
  for (const bad of ['ab', 'a'.repeat(21), 'có dấu', 'a b c', 'a-b-c', '', null, undefined, 123]) {
    assert.throws(() => validateUsername(bad), (e) => e.code === 'invalid_username', String(bad));
  }
  assert.equal(validatePassword('12345678'), '12345678');
  for (const bad of ['1234567', 'a'.repeat(129), '', null, 12345678]) {
    assert.throws(() => validatePassword(bad), (e) => e.code === 'invalid_password', String(bad));
  }
  assert.equal(validateDisplayName('  Lâm   Đồng ', 'x'), 'Lâm Đồng');
  assert.equal(validateDisplayName('', 'lamdong'), 'lamdong'); // bỏ trống: dùng tên đăng nhập
  assert.equal(validateDisplayName(undefined, 'lamdong'), 'lamdong');
  for (const bad of ['a', 'a'.repeat(25)]) {
    assert.throws(() => validateDisplayName(bad, 'x'), (e) => e.code === 'invalid_display_name');
  }
  assert.equal(validateDisplayName('a\u0000b\u0007c', 'x'), 'abc'); // bỏ ký tự điều khiển
});

test('đăng ký trả về token dùng được ngay; tên hiển thị mặc định là tên đăng nhập', async () => {
  const { auth } = makeAuth();
  const { token, user } = await auth.register({ username: 'LamDong', password: 'matkhau123' });
  assert.equal(user.username, 'lamdong');
  assert.equal(user.displayName, 'lamdong');
  assert.ok(token.length >= 40);
  assert.deepEqual(await auth.authenticate(token), user);
  assert.equal('passwordHash' in user, false, 'không bao giờ lộ băm mật khẩu');
});

test('tên đăng nhập là duy nhất, không phân biệt hoa thường', async () => {
  const { auth } = makeAuth();
  await auth.register({ username: 'lamdong', password: 'matkhau123' });
  await rejects(auth.register({ username: 'LAMDONG', password: 'matkhau456' }), 'username_taken');
});

test('đăng nhập: đúng mật khẩu thì nhận token mới; sai mật khẩu hoặc tên lạ cùng một lỗi', async () => {
  const { auth } = makeAuth();
  await auth.register({ username: 'lamdong', password: 'matkhau123', displayName: 'Lâm Đồng' });

  const { token, user } = await auth.login({ username: 'LamDong', password: 'matkhau123' });
  assert.equal(user.displayName, 'Lâm Đồng');
  assert.deepEqual(await auth.authenticate(token), user);

  await rejects(auth.login({ username: 'lamdong', password: 'sai-mat-khau' }), 'invalid_credentials');
  await rejects(auth.login({ username: 'khong_co_ai', password: 'matkhau123' }), 'invalid_credentials');
  await rejects(auth.login({ username: '!!', password: 'matkhau123' }), 'invalid_credentials');
  await rejects(auth.login({ username: 'lamdong', password: 12345 }), 'invalid_credentials');
});

test('đăng xuất thu hồi token ngay; các token khác của cùng tài khoản vẫn dùng được', async () => {
  const { auth } = makeAuth();
  const a = await auth.register({ username: 'lamdong', password: 'matkhau123' });
  const b = await auth.login({ username: 'lamdong', password: 'matkhau123' });
  assert.notEqual(a.token, b.token);
  await auth.logout(a.token);
  assert.equal(await auth.authenticate(a.token), null);
  assert.ok(await auth.authenticate(b.token));
});

test('token không hợp lệ hoặc rác đều bị từ chối', async () => {
  const { auth } = makeAuth();
  for (const bad of [null, undefined, '', 'abc', 'x'.repeat(200), 12345, {}, 'a'.repeat(43)]) {
    assert.equal(await auth.authenticate(bad), null, String(bad));
  }
});

test('phiên hết hạn sau thời hạn quy định (không dùng được nữa) và được dọn khỏi kho định kỳ', async () => {
  const { auth, store, clock } = makeAuth({ sessionTtlMs: 60_000 });
  const { token } = await auth.register({ username: 'lamdong', password: 'matkhau123' });
  clock.advance(59_000);
  assert.ok(await auth.authenticate(token));
  clock.advance(2_000);
  assert.equal(await auth.authenticate(token), null); // hết hạn: không dùng được ngay lập tức
  assert.equal(store.sessions.size, 1); // việc đọc không xoá; chờ dọn định kỳ
  assert.equal(await store.purgeExpired(clock.now()), 1);
  assert.equal(store.sessions.size, 0);
});

test('purgeExpired xoá các phiên đã hết hạn', async () => {
  const { auth, store, clock } = makeAuth({ sessionTtlMs: 60_000 });
  await auth.register({ username: 'u1_test', password: 'matkhau123' });
  clock.advance(30_000);
  await auth.login({ username: 'u1_test', password: 'matkhau123' });
  assert.equal(store.sessions.size, 2);
  clock.advance(40_000); // phiên 1 hết hạn, phiên 2 còn
  assert.equal(await store.purgeExpired(clock.now()), 1);
  assert.equal(store.sessions.size, 1);
});

test('chặn dò mật khẩu: quá số lần sai thì khoá tạm, kể cả khi nhập đúng', async () => {
  const { auth, clock } = makeAuth({ limits: { failPerUser: { max: 3, windowMs: 60_000 } } });
  await auth.register({ username: 'lamdong', password: 'matkhau123' });
  for (let i = 0; i < 3; i++) {
    await rejects(auth.login({ username: 'lamdong', password: 'sai' + i }), 'invalid_credentials');
  }
  await rejects(auth.login({ username: 'lamdong', password: 'matkhau123' }), 'rate_limited');
  clock.advance(61_000); // hết thời gian khoá
  assert.ok(await auth.login({ username: 'lamdong', password: 'matkhau123' }));
});

test('đăng nhập đúng thì xoá bộ đếm sai', async () => {
  const { auth } = makeAuth({ limits: { failPerUser: { max: 3, windowMs: 60_000 } } });
  await auth.register({ username: 'lamdong', password: 'matkhau123' });
  for (let round = 0; round < 3; round++) {
    await rejects(auth.login({ username: 'lamdong', password: 'sai1' }), 'invalid_credentials');
    await rejects(auth.login({ username: 'lamdong', password: 'sai2' }), 'invalid_credentials');
    await auth.login({ username: 'lamdong', password: 'matkhau123' }); // reset bộ đếm
  }
});

test('giới hạn theo IP cho đăng ký và đăng nhập', async () => {
  const { auth } = makeAuth({
    limits: { registerPerIp: { max: 2, windowMs: 60_000 }, loginPerIp: { max: 2, windowMs: 60_000 } },
  });
  await auth.register({ username: 'user_one', password: 'matkhau123' }, '1.1.1.1');
  await auth.register({ username: 'user_two', password: 'matkhau123' }, '1.1.1.1');
  await rejects(auth.register({ username: 'user_three', password: 'matkhau123' }, '1.1.1.1'), 'rate_limited');
  // IP khác không bị ảnh hưởng
  await auth.register({ username: 'user_four', password: 'matkhau123' }, '2.2.2.2');

  await auth.login({ username: 'user_one', password: 'matkhau123' }, '3.3.3.3');
  await auth.login({ username: 'user_one', password: 'matkhau123' }, '3.3.3.3');
  await rejects(auth.login({ username: 'user_one', password: 'matkhau123' }, '3.3.3.3'), 'rate_limited');
});

test('RateLimiter: cửa sổ trượt, count/take/reset', () => {
  let t = 0;
  const rl = new RateLimiter({ max: 2, windowMs: 1000, now: () => t });
  assert.equal(rl.take('k'), true);
  assert.equal(rl.take('k'), true);
  assert.equal(rl.take('k'), false);
  assert.equal(rl.count('k'), 2);
  assert.equal(rl.take('khac'), true); // khoá khác độc lập
  t = 1001;
  assert.equal(rl.count('k'), 0);
  assert.equal(rl.take('k'), true);
  rl.reset('k');
  assert.equal(rl.count('k'), 0);
});

test('lịch sử đăng nhập: ghi đăng ký, đăng nhập, thất bại (kể cả tên lạ) và đăng xuất kèm IP, trình duyệt', async () => {
  const { auth, store } = makeAuth();
  const ctx = { ip: '9.9.9.9', userAgent: 'TestAgent/1.0' };
  const reg = await auth.register({ username: 'lamdong', password: 'matkhau123' }, ctx);
  await auth.login({ username: 'lamdong', password: 'matkhau123' }, ctx);
  await rejects(auth.login({ username: 'lamdong', password: 'sai-mat-khau' }, ctx), 'invalid_credentials');
  await rejects(auth.login({ username: 'khong_co', password: 'matkhau123' }, ctx), 'invalid_credentials');
  await auth.logout(reg.token, ctx);

  const events = await store.listAuthEvents(reg.user.id);
  assert.deepEqual(
    events.map((e) => [e.event, e.success, e.detail]).reverse(),
    [['register', true, null], ['login', true, null], ['login_failed', false, 'bad_password'], ['logout', true, null]],
  );
  assert.equal(events[0].ip, '9.9.9.9');
  assert.equal(events[0].userAgent, 'TestAgent/1.0');
  assert.equal(events.every((e) => e.method === 'password' || e.method === 'token'), true);

  // Đăng nhập tên không tồn tại: ghi lại nhưng không gắn với tài khoản nào, và KHÔNG lưu tên đã gõ
  const orphan = store.events.filter((e) => e.userId === null);
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0].detail, 'unknown_user');
  assert.equal(JSON.stringify(orphan[0]).includes('khong_co'), false);
});

test('phiên lưu phương thức, IP và trình duyệt; đăng nhập cập nhật thời điểm đăng nhập gần nhất', async () => {
  const { auth, store, clock } = makeAuth();
  const { user } = await auth.register({ username: 'lamdong', password: 'matkhau123' }, { ip: '1.2.3.4', userAgent: 'UA1' });
  const [session] = [...store.sessions.values()];
  assert.equal(session.method, 'password');
  assert.equal(session.ip, '1.2.3.4');
  assert.equal(session.userAgent, 'UA1');
  clock.advance(5_000);
  await auth.login({ username: 'lamdong', password: 'matkhau123' }, '1.2.3.4');
  assert.equal((await store.findUserById(user.id)).lastLoginAt, clock.now());
});

test('lỗi khi ghi lịch sử đăng nhập KHÔNG làm hỏng việc đăng nhập', async () => {
  const quiet = { error() {} };
  const { auth, store } = makeAuth({ log: quiet });
  store.addAuthEvent = async () => { throw new Error('CSDL tạm thời lỗi'); };
  const reg = await auth.register({ username: 'lamdong', password: 'matkhau123' });
  assert.ok(reg.token);
  assert.ok(await auth.login({ username: 'lamdong', password: 'matkhau123' }));
});

test('profile: liệt kê nhà cung cấp đã liên kết và cho biết có mật khẩu hay không', async () => {
  const { auth, store } = makeAuth();
  const { user } = await auth.register({ username: 'lamdong', password: 'matkhau123' });
  assert.deepEqual(await auth.profile(user.id), {
    ...user, providers: [], hasPassword: true, recoveryEmail: null, recoveryEmailVerified: false,
  });
  await store.createIdentity({ userId: user.id, provider: 'google', providerUserId: 'g-1' });
  assert.deepEqual((await auth.profile(user.id)).providers, ['google']);
  assert.equal(await auth.profile('00000000-0000-4000-8000-000000000000'), null);
});

test('tài khoản chỉ đăng nhập mạng xã hội (không có mật khẩu) không thể đăng nhập bằng mật khẩu', async () => {
  const { auth, store } = makeAuth();
  // Trường hợp biên: có username nhưng không có mật khẩu
  await store.createUser({ username: 'chi_social', displayName: 'Social', passwordHash: null });
  for (const password of ['bat-ky-mat-khau', '', 'matkhau123']) {
    await rejects(auth.login({ username: 'chi_social', password }), 'invalid_credentials');
  }
  // Người dùng công khai có username = null khi không có tên đăng nhập
  const s = await store.createUser({ displayName: 'Không tên đăng nhập' });
  const { user } = await auth.startSession(s, { method: 'google' });
  assert.equal(user.username, null);
  assert.equal(user.avatarUrl, null);
});
