import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connectClient } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { MemoryStore } from '../src/stores/memory.js';
import { guestName } from '../src/game-server.js';

let app;
let url;
const clients = [];

before(async () => {
  const store = new MemoryStore();
  // minBaseMs thấp để test hết giờ không phải chờ lâu
  app = createApp({
    graceMs: 400,
    clockLimits: { minBaseMs: 100, maxBaseMs: 3 * 60 * 60_000, maxIncrementMs: 60_000 },
    // Băm nhẹ + nới giới hạn theo IP (mọi test cùng một IP); giữ nguyên giới hạn sai mật khẩu theo tên.
    store,
    authService: new AuthService({
      store,
      scryptParams: { N: 1024, r: 8, p: 1 },
      limits: {
        registerPerIp: { max: 1000, windowMs: 60 * 60_000 },
        loginPerIp: { max: 1000, windowMs: 60 * 60_000 },
      },
    }),
  });
  await new Promise((resolve) => app.httpServer.listen(0, resolve));
  url = `http://localhost:${app.httpServer.address().port}`;
});

after(async () => {
  for (const c of clients) c.disconnect();
  await app.close();
});

// ---------------------------------------------------------------- tiện ích

const P = (col, row) => ({ col, row });

/** Kết nối 1 client; ghi lại mọi sự kiện để test không bị lỡ sự kiện đến sớm. */
const connect = (playerId, name = playerId) => connectWith({ playerId, name });

/** Kết nối với dữ liệu auth tuỳ ý: { playerId, name } (khách) hoặc { token } (tài khoản). */
function connectWith(auth) {
  return new Promise((resolve, reject) => {
    const s = connectClient(url, {
      auth,
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    s.log = [];
    s.waiters = [];
    s.onAny((ev, ...args) => {
      const i = s.waiters.findIndex((w) => w.ev === ev);
      if (i >= 0) {
        const [w] = s.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(args[0]);
      } else {
        s.log.push({ ev, args });
      }
    });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    clients.push(s);
  });
}

function waitFor(s, ev, ms = 3000) {
  const i = s.log.findIndex((e) => e.ev === ev);
  if (i >= 0) return Promise.resolve(s.log.splice(i, 1)[0].args[0]);
  return new Promise((resolve, reject) => {
    const w = { ev, resolve };
    w.timer = setTimeout(() => {
      s.waiters = s.waiters.filter((x) => x !== w);
      reject(new Error(`timeout chờ sự kiện ${ev}`));
    }, ms);
    s.waiters.push(w);
  });
}

const emit = (s, ev, payload) => new Promise((resolve) => s.emit(ev, payload, resolve));

/** Tạo phòng bằng `a` (Đỏ), `b` vào phòng; trả về roomId sau khi ván bắt đầu. */
async function startRoom(a, b, timeControl) {
  const created = await emit(a, 'room:create', { side: 'red', ...(timeControl ? { timeControl } : {}) });
  assert.equal(created.ok, true);
  const startA = waitFor(a, 'game:start');
  const startB = waitFor(b, 'game:start');
  const joined = await emit(b, 'room:join', { roomId: created.roomId });
  assert.equal(joined.ok, true);
  assert.equal(joined.side, 'black');
  assert.equal(joined.state.status, 'playing'); // ack phản ánh đúng trạng thái đã bắt đầu
  const [sa, sb] = await Promise.all([startA, startB]);
  assert.equal(sa.you, 'red');
  assert.equal(sb.you, 'black');
  assert.equal(sa.board.length, 32);
  assert.equal(sa.turn, 'red');
  return created.roomId;
}

// ------------------------------------------------------------------ test

test('từ chối kết nối khi playerId không hợp lệ', async () => {
  await assert.rejects(connect('abc'), /invalid_player_id/);
});

test('tạo phòng, vào phòng, ván bắt đầu với đủ 32 quân', async () => {
  const a = await connect('player-A-001', 'An');
  const b = await connect('player-B-001', 'Binh');
  await startRoom(a, b);
});

test('server chặn: đi sai lượt, nước sai luật, dữ liệu rác', async () => {
  const a = await connect('player-A-002');
  const b = await connect('player-B-002');
  await startRoom(a, b);

  // Đen đi trước lượt
  let r = await emit(b, 'game:move', { from: { col: 1, row: 2 }, to: { col: 4, row: 2 } });
  assert.deepEqual(r, { ok: false, error: 'not_your_turn' });

  // Xe đỏ không thể nhảy qua Tốt của mình
  r = await emit(a, 'game:move', { from: { col: 0, row: 9 }, to: { col: 0, row: 3 } });
  assert.deepEqual(r, { ok: false, error: 'illegal_move' });

  // Dữ liệu rác
  r = await emit(a, 'game:move', { from: 'x', to: null });
  assert.deepEqual(r, { ok: false, error: 'bad_payload' });
  r = await emit(a, 'game:move', { from: { col: 99, row: 0 }, to: { col: 0, row: 0 } });
  assert.deepEqual(r, { ok: false, error: 'bad_payload' });
});

test('nước đi hợp lệ được phát cho cả hai bên và đổi lượt', async () => {
  const a = await connect('player-A-003');
  const b = await connect('player-B-003');
  await startRoom(a, b);

  const moveA = waitFor(a, 'game:move');
  const moveB = waitFor(b, 'game:move');
  // Pháo đỏ (1,7) -> (4,7)
  const r = await emit(a, 'game:move', { from: { col: 1, row: 7 }, to: { col: 4, row: 7 } });
  assert.equal(r.ok, true);
  const [ea, eb] = await Promise.all([moveA, moveB]);
  assert.deepEqual(ea, eb);
  assert.equal(ea.pieceId, 'red_cannon_0');
  assert.equal(ea.capturedId, null);
  assert.equal(ea.turn, 'black');
  assert.equal(ea.moveNumber, 1);

  // Giờ là lượt Đen, Đỏ đi tiếp bị chặn
  const again = await emit(a, 'game:move', { from: { col: 4, row: 7 }, to: { col: 4, row: 6 } });
  assert.equal(again.error, 'not_your_turn');
});

test('đầu hàng: đối thủ thắng, cả hai nhận game:over', async () => {
  const a = await connect('player-A-004');
  const b = await connect('player-B-004');
  await startRoom(a, b);
  const overA = waitFor(a, 'game:over');
  const overB = waitFor(b, 'game:over');
  assert.equal((await emit(a, 'game:resign')).ok, true);
  const [oa, ob] = await Promise.all([overA, overB]);
  assert.deepEqual(oa, ob);
  assert.equal(oa.result, 'black');
  assert.equal(oa.reason, 'resign');

  // Ván đã xong: không đi được nữa
  const r = await emit(b, 'game:move', { from: { col: 1, row: 2 }, to: { col: 4, row: 2 } });
  assert.equal(r.error, 'not_playing');
});

test('xin hoà: từ chối rồi chấp nhận', async () => {
  const a = await connect('player-A-005');
  const b = await connect('player-B-005');
  await startRoom(a, b);

  let offered = waitFor(b, 'game:draw:offered');
  assert.equal((await emit(a, 'game:draw:offer')).ok, true);
  assert.equal((await offered).from, 'red');
  assert.equal((await emit(a, 'game:draw:offer')).error, 'already_offered');

  const declined = waitFor(a, 'game:draw:declined');
  assert.equal((await emit(b, 'game:draw:respond', { accept: false })).ok, true);
  assert.equal((await declined).by, 'black');

  offered = waitFor(a, 'game:draw:offered');
  await emit(b, 'game:draw:offer');
  await offered;
  const overA = waitFor(a, 'game:over');
  assert.equal((await emit(a, 'game:draw:respond', { accept: true })).ok, true);
  const over = await overA;
  assert.equal(over.result, 'draw');
  assert.equal(over.reason, 'agreement');
});

test('mất kết nối rồi nối lại cùng playerId: vào lại đúng ván, giữ nguyên thế cờ', async () => {
  const a = await connect('player-A-006');
  const b = await connect('player-B-006');
  const roomId = await startRoom(a, b);
  await emit(a, 'game:move', { from: { col: 1, row: 7 }, to: { col: 4, row: 7 } });

  const status = waitFor(a, 'opponent:status');
  b.disconnect();
  const st = await status;
  assert.equal(st.connected, false);

  const statusBack = waitFor(a, 'opponent:status');
  const b2 = await connect('player-B-006');
  const resume = await waitFor(b2, 'session:resume');
  assert.equal(resume.roomId, roomId);
  assert.equal(resume.you, 'black');
  assert.equal(resume.moves.length, 1);
  assert.equal(resume.turn, 'black');
  assert.equal((await statusBack).connected, true);

  // Đen đi tiếp được bình thường
  const r = await emit(b2, 'game:move', { from: { col: 1, row: 2 }, to: { col: 4, row: 2 } });
  assert.equal(r.ok, true);
});

test('mất kết nối quá thời gian chờ: bị xử thua', async () => {
  const a = await connect('player-A-007');
  const b = await connect('player-B-007');
  await startRoom(a, b);
  const over = waitFor(a, 'game:over', 3000);
  b.disconnect();
  const o = await over;
  assert.equal(o.result, 'red');
  assert.equal(o.reason, 'disconnect');
});

test('ghép trận nhanh: hai người xếp hàng được ghép vào cùng một ván', async () => {
  const a = await connect('player-A-008');
  const b = await connect('player-B-008');
  const first = await emit(a, 'queue:join');
  assert.deepEqual(first, { ok: true, matched: false });

  const foundA = waitFor(a, 'match:found');
  const startA = waitFor(a, 'game:start');
  const startB = waitFor(b, 'game:start');
  const second = await emit(b, 'queue:join');
  assert.equal(second.matched, true);
  const [fa, sa, sb] = await Promise.all([foundA, startA, startB]);
  assert.equal(sa.roomId, fa.roomId);
  assert.equal(sb.roomId, fa.roomId);
  assert.notEqual(sa.you, sb.you);
});

test('vào phòng không tồn tại / phòng đầy / đã ở trong phòng', async () => {
  const a = await connect('player-A-009');
  const b = await connect('player-B-009');
  const c = await connect('player-C-009');
  assert.equal((await emit(c, 'room:join', { roomId: 'ZZZZZZ' })).error, 'room_not_found');

  const roomId = await startRoom(a, b);
  assert.equal((await emit(c, 'room:join', { roomId })).error, 'room_full');
  assert.equal((await emit(a, 'room:create', {})).error, 'already_in_room');
});

test('/health trả về thống kê', async () => {
  const res = await fetch(`${url}/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.rooms, 'number');
});

// ------------------------------------------------ đồng hồ, lặp nước, ghép trận

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('đồng hồ: Đỏ chạy ngay khi ván bắt đầu, đi xong được cộng giờ và chuyển sang Đen', async () => {
  const a = await connect('player-A-101');
  const b = await connect('player-B-101');
  const tc = { baseMs: 300_000, incrementMs: 3_000 };
  const created = await emit(a, 'room:create', { side: 'red', timeControl: tc });
  assert.equal(created.state.clock.baseMs, 300_000);
  assert.equal(created.state.clock.running, null); // chưa đủ người: đồng hồ chưa chạy

  const startA = waitFor(a, 'game:start');
  await emit(b, 'room:join', { roomId: created.roomId });
  const start = await startA;
  assert.equal(start.clock.running, 'red');
  assert.equal(start.clock.incrementMs, 3_000);
  assert.ok(start.clock.remainingMs.red <= 300_000 && start.clock.remainingMs.red > 299_000);
  assert.equal(start.clock.remainingMs.black, 300_000);

  await sleep(200); // Đỏ suy nghĩ 200ms
  const moveA = waitFor(a, 'game:move');
  assert.equal((await emit(a, 'game:move', { from: P(1, 7), to: P(4, 7) })).ok, true);
  let ev = await moveA;
  assert.equal(ev.clock.running, 'black');
  // Đỏ mất ~200ms nhưng được cộng 3000ms
  assert.ok(ev.clock.remainingMs.red > 300_000 + 3_000 - 1_000 && ev.clock.remainingMs.red < 300_000 + 3_000);

  await waitFor(b, 'game:move'); // Đen cũng nhận sự kiện nước đi của Đỏ: lấy ra khỏi hàng đợi
  await sleep(200); // Đen suy nghĩ 200ms: đồng hồ Đen phải đang chạy
  const moveB = waitFor(b, 'game:move');
  assert.equal((await emit(b, 'game:move', { from: P(1, 2), to: P(4, 2) })).ok, true);
  ev = await moveB;
  assert.equal(ev.clock.running, 'red');
  assert.ok(ev.clock.remainingMs.black <= 300_000 + 3_000 - 150, 'đồng hồ Đen đã chạy trong lúc suy nghĩ');
});

test('hết giờ: server xử thua bên hết giờ, cả hai nhận game:over', async () => {
  const a = await connect('player-A-102');
  const b = await connect('player-B-102');
  await startRoom(a, b, { baseMs: 300, incrementMs: 0 });
  const overA = waitFor(a, 'game:over', 3000);
  const overB = waitFor(b, 'game:over', 3000);
  const [oa, ob] = await Promise.all([overA, overB]); // Đỏ không đi nên hết giờ
  assert.equal(oa.result, 'black');
  assert.equal(oa.reason, 'timeout');
  assert.deepEqual(oa, ob);
  assert.equal(oa.clock.remainingMs.red, 0);
  assert.equal(oa.clock.running, null);

  const r = await emit(a, 'game:move', { from: P(1, 7), to: P(4, 7) });
  assert.equal(r.error, 'not_playing');
});

test('cấu hình đồng hồ sai bị từ chối', async () => {
  const a = await connect('player-A-103');
  for (const timeControl of [{ baseMs: 5 }, { baseMs: 'x' }, 'abc', { baseMs: 60_000, incrementMs: -1 }]) {
    const r = await emit(a, 'room:create', { timeControl });
    assert.deepEqual(r, { ok: false, error: 'bad_time_control' }, JSON.stringify(timeControl));
  }
  assert.equal((await emit(a, 'queue:join', { timeControl: { baseMs: 5 } })).error, 'bad_time_control');
  // Không có đồng hồ (không giới hạn thời gian) vẫn hợp lệ
  const ok = await emit(a, 'room:create', {});
  assert.equal(ok.ok, true);
  assert.equal(ok.state.clock, null);
});

test('ghép trận nhanh chỉ giữa những người chọn cùng mức thời gian', async () => {
  const a = await connect('player-A-104');
  const b = await connect('player-B-104');
  const c = await connect('player-C-104');
  const tc = { baseMs: 600_000, incrementMs: 5_000 };

  assert.equal((await emit(a, 'queue:join', { timeControl: tc })).matched, false);
  // b chọn mức khác (không giới hạn): không được ghép với a
  assert.equal((await emit(b, 'queue:join', {})).matched, false);

  const startA = waitFor(a, 'game:start');
  const startC = waitFor(c, 'game:start');
  const r = await emit(c, 'queue:join', { timeControl: tc });
  assert.equal(r.matched, true);
  const [sa, sc] = await Promise.all([startA, startC]);
  assert.equal(sa.roomId, sc.roomId);
  assert.equal(sa.clock.baseMs, 600_000);
  assert.equal(sc.clock.incrementMs, 5_000);

  await emit(b, 'queue:leave'); // dọn hàng chờ để không ảnh hưởng test khác
});

test('lặp nước qua server: thế cờ lặp lần 3 thì hoà, sự kiện báo số lần lặp', async () => {
  const a = await connect('player-A-105');
  const b = await connect('player-B-105');
  await startRoom(a, b);

  // Hai bên cùng đưa Mã ra rồi về (4 nước một vòng)
  const cycle = [
    [P(1, 9), P(2, 7)], [P(1, 0), P(2, 2)], [P(2, 7), P(1, 9)], [P(2, 2), P(1, 0)],
  ];
  const players = [a, b];
  const reps = [];
  const over = waitFor(a, 'game:over', 3000);
  for (let i = 0; i < 8; i++) {
    const ev = waitFor(a, 'game:move');
    const [from, to] = cycle[i % 4];
    const r = await emit(players[i % 2], 'game:move', { from, to });
    assert.equal(r.ok, true, `nước ${i + 1}`);
    reps.push((await ev).repetitions);
  }
  assert.deepEqual(reps, [1, 1, 1, 2, 2, 2, 2, 3]);
  const o = await over;
  assert.equal(o.result, 'draw');
  assert.equal(o.reason, 'repetition');
});

// ------------------------------------------------------------ đăng nhập (HTTP + socket)

async function http(method, path, body, token) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

async function register(username, displayName) {
  const r = await http('POST', '/auth/register', { username, password: 'matkhau123', displayName });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body; // { ok, token, user }
}

test('HTTP: đăng ký, đăng nhập, xem thông tin, đăng xuất', async () => {
  const reg = await http('POST', '/auth/register', {
    username: 'E2E_Lam', password: 'matkhau123', displayName: 'Lâm Đồng',
  });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.ok, true);
  assert.equal(reg.body.user.username, 'e2e_lam');
  assert.equal(reg.body.user.displayName, 'Lâm Đồng');
  assert.equal(JSON.stringify(reg.body).includes('passwordHash'), false);
  assert.equal(reg.headers.get('cache-control'), 'no-store');

  const login = await http('POST', '/auth/login', { username: 'e2e_lam', password: 'matkhau123' });
  assert.equal(login.status, 200);
  assert.notEqual(login.body.token, reg.body.token);

  const me = await http('GET', '/auth/me', undefined, login.body.token);
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.user, { ...reg.body.user, providers: [], hasPassword: true });

  assert.equal((await http('POST', '/auth/logout', undefined, login.body.token)).status, 200);
  assert.equal((await http('GET', '/auth/me', undefined, login.body.token)).status, 401);
  // Token của lần đăng ký vẫn dùng được (chỉ thu hồi đúng token đã đăng xuất)
  assert.equal((await http('GET', '/auth/me', undefined, reg.body.token)).status, 200);
});

test('HTTP: mã lỗi cho đầu vào sai, trùng tên, sai mật khẩu, đường dẫn lạ', async () => {
  await register('e2e_dup', 'Dup');
  const cases = [
    [{ username: 'ab', password: 'matkhau123' }, 400, 'invalid_username'],
    [{ username: 'e2e_ok1', password: '123' }, 400, 'invalid_password'],
    [{ username: 'e2e_ok1', password: 'matkhau123', displayName: 'a' }, 400, 'invalid_display_name'],
    [{ username: 'E2E_DUP', password: 'matkhau123' }, 409, 'username_taken'],
  ];
  for (const [body, status, error] of cases) {
    const r = await http('POST', '/auth/register', body);
    assert.deepEqual([r.status, r.body.error], [status, error], JSON.stringify(body));
  }
  const bad = await http('POST', '/auth/login', { username: 'e2e_dup', password: 'sai-mat-khau' });
  assert.deepEqual([bad.status, bad.body.error], [401, 'invalid_credentials']);
  const unknown = await http('POST', '/auth/login', { username: 'khong_ton_tai', password: 'matkhau123' });
  assert.deepEqual([unknown.status, unknown.body.error], [401, 'invalid_credentials']);

  assert.equal((await http('GET', '/auth/me')).status, 401);
  assert.equal((await http('GET', '/auth/me', undefined, 'x'.repeat(43))).status, 401);
  assert.equal((await http('GET', '/auth/khong-co')).status, 404);
  assert.equal((await http('POST', '/auth/login', '{khong phai json')).body.error, 'bad_json');

  const huge = await http('POST', '/auth/register', { username: 'e2e_big', password: 'x'.repeat(5000) })
    .catch(() => ({ status: 413 })); // server có thể ngắt kết nối khi quá lớn
  assert.equal(huge.status, 413);
});

test('HTTP: preflight CORS (OPTIONS) cho app web', async () => {
  const res = await fetch(`${url}/auth/login`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-headers'), /authorization/);
});

test('HTTP: sai mật khẩu quá nhiều lần thì khoá tạm (429), kể cả khi nhập đúng', async () => {
  await register('e2e_brute', 'Brute');
  for (let i = 0; i < 10; i++) {
    const r = await http('POST', '/auth/login', { username: 'e2e_brute', password: `sai-${i}-xxxx` });
    assert.equal(r.status, 401);
  }
  const locked = await http('POST', '/auth/login', { username: 'e2e_brute', password: 'matkhau123' });
  assert.deepEqual([locked.status, locked.body.error], [429, 'rate_limited']);
});

test('hai chế độ cùng chơi: tài khoản (guest=false) đấu với khách (guest=true)', async () => {
  const reg = await register('e2e_an', 'An Nguyễn');
  const a = await connectWith({ token: reg.token });
  const b = await connect('player-B-301', 'Khách Bình');

  const created = await emit(a, 'room:create', { side: 'red' });
  assert.deepEqual(created.state.players.red, { name: 'An Nguyễn', connected: true, guest: false });

  const startA = waitFor(a, 'game:start');
  const joined = await emit(b, 'room:join', { roomId: created.roomId });
  assert.deepEqual(joined.state.players.black, { name: 'Khách Bình', connected: true, guest: true });
  assert.equal(joined.state.players.red.guest, false);
  await startA;

  // Không bao giờ lộ id tài khoản hay playerId cho đối thủ
  const raw = JSON.stringify(joined.state);
  assert.equal(raw.includes(reg.user.id), false);
  assert.equal(raw.includes('u:'), false);
  assert.equal(raw.includes('player-B-301'), false);

  // Chơi bình thường như mọi ván khác
  const move = waitFor(b, 'game:move');
  assert.equal((await emit(a, 'game:move', { from: P(1, 7), to: P(4, 7) })).ok, true);
  assert.equal((await move).pieceId, 'red_cannon_0');
});

test('token sai / đã đăng xuất / không phải chuỗi bị từ chối, KHÔNG rơi về chế độ khách', async () => {
  await assert.rejects(connectWith({ token: 'x'.repeat(43) }), /invalid_token/);
  await assert.rejects(connectWith({ token: 12345 }), /invalid_token/);
  // Có token sai kèm playerId hợp lệ: vẫn từ chối (không âm thầm chuyển thành khách)
  await assert.rejects(connectWith({ token: 'x'.repeat(43), playerId: 'player-ok-401' }), /invalid_token/);

  const reg = await register('e2e_out', 'Out');
  const ok = await connectWith({ token: reg.token });
  ok.disconnect();
  await http('POST', '/auth/logout', undefined, reg.token);
  await assert.rejects(connectWith({ token: reg.token }), /invalid_token/);
});

test('khách không thể mạo danh tài khoản bằng playerId dạng "u:..."', async () => {
  const reg = await register('e2e_victim', 'Nạn nhân');
  for (const fake of [`u:${reg.user.id}`, 'u:12345678', 'user:abcdefgh']) {
    await assert.rejects(connectWith({ playerId: fake, name: 'Kẻ mạo danh' }), /invalid_player_id/, fake);
  }
});

test('khách không đặt tên: server tự sinh tên "Khách-XXXX" ổn định theo playerId', async () => {
  const playerId = 'player-X-501';
  const a = await connectWith({ playerId }); // không gửi name
  const created = await emit(a, 'room:create', { side: 'red' });
  assert.equal(created.state.players.red.name, guestName(playerId));
  assert.match(created.state.players.red.name, /^Khách-[0-9A-F]{4}$/);
  assert.equal(created.state.players.red.guest, true);
  await emit(a, 'room:leave');
  a.disconnect();

  const b = await connectWith({ playerId, name: '   ' }); // tên toàn khoảng trắng cũng coi như trống
  const again = await emit(b, 'room:create', {});
  const seat = again.state.players[again.side];
  assert.equal(seat.name, guestName(playerId));
});

test('cùng một tài khoản mở ở thiết bị thứ hai: thiết bị cũ bị thay thế, thiết bị mới vào lại ván', async () => {
  const reg = await register('e2e_multi', 'Đa thiết bị');
  const first = await connectWith({ token: reg.token });
  const created = await emit(first, 'room:create', { side: 'red' });

  const replaced = waitFor(first, 'session:replaced');
  const second = await connectWith({ token: reg.token });
  await replaced;
  const resume = await waitFor(second, 'session:resume');
  assert.equal(resume.roomId, created.roomId);
  assert.equal(resume.you, 'red');
  assert.equal(resume.players.red.guest, false);
});
