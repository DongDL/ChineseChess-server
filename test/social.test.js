import {
  describe, test, before, after, beforeEach,
} from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { cleanChat } from '../src/game-server.js';
import { MemoryStore } from '../src/stores/memory.js';
import {
  P, connectWith, emit, sleep, waitFor,
} from './helpers/sockets.js';

const FAST = { N: 1024, r: 8, p: 1 };
const clock = { t: 1_800_000_000_000, now() { return this.t; }, advance(ms) { this.t += ms; } };

describe('Ghép trận theo Elo, khán giả và chat', () => {
  let app; let base; let store; let auth;
  const clients = [];
  let seq = 0;

  before(async () => {
    store = new MemoryStore();
    auth = new AuthService({ store, scryptParams: FAST, log: { error() {} }, limits: { registerPerIp: { max: 1e6, windowMs: 6e4 } } });
    app = createApp({
      store, authService: auth, gameServerOptions: { now: () => clock.now(), matchTickMs: 3_600_000 },
    });
    await new Promise((r) => app.httpServer.listen(0, r));
    base = `http://127.0.0.1:${app.httpServer.address().port}`;
  });
  after(async () => {
    clients.forEach((c) => c.close());
    await app.close();
  });

  /** Tạo tài khoản với Elo cho trước và kết nối socket. */
  async function account(rating) {
    const name = `tk${++seq}`;
    const s = await auth.register({ username: name, password: 'mat-khau-123', displayName: name }, '1.1.1.1');
    store.users.get(s.user.id).rating = rating;
    store.users.get(s.user.id).ratedGames = 40;
    return connectWith(base, { token: s.token }, clients);
  }
  const guest = (n) => connectWith(base, { playerId: `khach-${n}-${++seq}-xxxxxxxx`, name: `Khach${n}` }, clients);
  const queue = (s, tc = null) => emit(s, 'queue:join', tc ? { timeControl: tc } : {});
  const noEvent = async (s, ev) => {
    await sleep(60);
    assert.equal(s.log.some((e) => e.ev === ev), false, `không được có sự kiện ${ev}`);
  };

  describe('ghép trận theo Elo', () => {
    beforeEach(() => { app.gameServer.queue = []; }); // người chờ sót từ test trước không được ảnh hưởng test sau

    test('chênh lệch lớn thì chưa ghép; chờ lâu cửa sổ nới ra thì ghép', async () => {
      const a = await account(1500);
      const b = await account(1900);
      assert.equal((await queue(a)).matched, false);
      assert.equal((await queue(b)).matched, false); // chênh 400 > 100
      app.gameServer.matchTick();
      await noEvent(a, 'match:found');
      clock.advance(20_000); // cửa sổ = 100 + 10 * 20 = 300: vẫn chưa đủ cho chênh 400
      app.gameServer.matchTick();
      await noEvent(a, 'match:found');
      clock.advance(10_000); // 100 + 10 * 30 = 400
      app.gameServer.matchTick();
      const [fa, fb] = await Promise.all([waitFor(a, 'match:found'), waitFor(b, 'match:found')]);
      assert.equal(fa.roomId, fb.roomId);
      await Promise.all([waitFor(a, 'game:start'), waitFor(b, 'game:start')]);
    });

    test('chọn đối thủ gần Elo nhất trong cửa sổ', async () => {
      const far = await account(1580);
      const near = await account(1510);
      const me = await account(1500);
      await queue(far);
      await queue(near); // 1580 vs 1510: chênh 70, ghép luôn
      const m = await waitFor(near, 'match:found');
      assert.ok(m.roomId);
      const lone = await account(1500);
      const third = await account(1530);
      await queue(lone);
      assert.equal((await queue(third)).matched, true); // chênh 30
      assert.equal((await queue(me)).matched, false); // far đã ghép với near; me đứng chờ
    });

    test('khác mức thời gian thì không ghép', async () => {
      const a = await account(1500);
      const b = await account(1500);
      await queue(a, { baseMs: 300_000, incrementMs: 0 });
      assert.equal((await queue(b, { baseMs: 600_000, incrementMs: 0 })).matched, false);
      app.gameServer.matchTick();
      await noEvent(a, 'match:found');
    });

    test('khách có điểm Elo (1500) nên ghép như tài khoản: khách-khách và khách-tài khoản đều theo Elo', async () => {
      // Khách cũng có điểm (mặc định 1500, do client lưu tại máy và gửi lên), nên ghép theo Elo như tài khoản.
      const g1 = await guest(1);
      const g2 = await guest(2);
      await queue(g1);
      assert.equal((await queue(g2)).matched, true); // hai khách 1500 ghép ngay

      // Khách 1500 gặp tài khoản 1500: chênh 0, ghép ngay (không còn phải chờ guestAfterMs).
      const acc = await account(1500);
      const g3 = await guest(3);
      await queue(acc);
      assert.equal((await queue(g3)).matched, true);
      await Promise.all([waitFor(acc, 'match:found'), waitFor(g3, 'match:found')]);
    });

    test('điểm Elo khách do client gửi được dùng để ghép trận; chênh lớn thì chưa ghép', async () => {
      // Khách tự báo điểm cao (1900) sẽ KHÔNG ghép ngay với tài khoản 1500 (chênh 400 > cửa sổ ban đầu).
      const acc = await account(1500);
      const strongGuest = await connectWith(
        base, { playerId: `khach-manh-${++seq}-xxxxxxxx`, name: 'KhachManh', rating: 1900 }, clients,
      );
      await queue(acc);
      assert.equal((await queue(strongGuest)).matched, false);
      app.gameServer.matchTick();
      await noEvent(strongGuest, 'match:found');
      clock.advance(31_000); // cửa sổ nới dần rồi mới ghép
      app.gameServer.matchTick();
      await Promise.all([waitFor(acc, 'match:found'), waitFor(strongGuest, 'match:found')]);
    });

    test('người đã ngắt kết nối bị bỏ khỏi hàng đợi, không bị ghép "ma"', async () => {
      const a = await account(1500);
      const b = await account(1500);
      await queue(a);
      a.close();
      await sleep(80);
      assert.equal((await queue(b)).matched, false);
    });
  });

  describe('khán giả và chat', () => {
    let red; let black; let roomId;
    const setup = async () => {
      red = await account(1500);
      black = await account(1500);
      const created = await emit(red, 'room:create', { side: 'red' });
      roomId = created.roomId;
      await emit(black, 'room:join', { roomId });
      await Promise.all([waitFor(red, 'game:start'), waitFor(black, 'game:start')]);
    };

    test('khán giả có tài khoản xem được, thấy nước đi và chat; người chơi thấy tin của khán giả', async () => {
      await setup();
      assert.equal((await emit(red, 'chat:send', { text: 'Chào bạn' })).ok, true);
      const fan = await account(1500);
      const ack = await emit(fan, 'room:spectate', { roomId });
      assert.equal(ack.ok, true);
      assert.equal(ack.state.you, null);
      assert.equal(ack.state.roomId, roomId);
      assert.equal(ack.spectators, 1);
      assert.deepEqual(ack.chat.map((m) => [m.from.role, m.text]), [['red', 'Chào bạn']]);
      assert.deepEqual(await waitFor(red, 'room:spectators'), { roomId, count: 1 });

      assert.equal((await emit(red, 'game:move', { from: P(1, 9), to: P(2, 7) })).ok, true);
      const mv = await waitFor(fan, 'game:move');
      assert.equal(mv.moveNumber, 1);
      assert.equal((await emit(fan, 'game:move', { from: P(1, 0), to: P(2, 2) })).ok, false); // không đi quân hộ

      assert.equal((await emit(fan, 'chat:send', { text: 'Nước hay đấy!' })).ok, true);
      for (const s of [red, black, fan]) {
        const msg = await waitFor(s, 'chat:message');
        if (msg.text === 'Chào bạn') await waitFor(s, 'chat:message').then((m) => assert.equal(m.from.role, 'spectator'));
        else assert.deepEqual([msg.from.role, msg.text], ['spectator', 'Nước hay đấy!']);
      }
    });

    test('xem phòng đang chờ: khi ván bắt đầu khán giả nhận thế cờ khai cuộc', async () => {
      const host = await account(1500);
      const created = await emit(host, 'room:create', { side: 'red' });
      const fan = await account(1500);
      const ack = await emit(fan, 'room:spectate', { roomId: created.roomId });
      assert.equal(ack.state.status, 'waiting');
      const joiner = await account(1500);
      await emit(joiner, 'room:join', { roomId: created.roomId });
      const st = await waitFor(fan, 'spectate:state');
      assert.equal(st.status, 'playing');
      assert.equal(st.you, null);
      assert.equal(st.board.length, 32);
    });

    test('khách xem được nhưng không chat được; không lộ playerId của ai', async () => {
      await setup();
      const g = await guest(9);
      const ack = await emit(g, 'room:spectate', { roomId });
      assert.equal(ack.ok, true);
      assert.deepEqual(await emit(g, 'chat:send', { text: 'xin chào' }), { ok: false, error: 'login_required' });
      assert.equal(JSON.stringify(ack).includes('khach-9'), false);
    });

    test('kiểm tra tin nhắn: rỗng, quá dài, ký tự lạ, giới hạn tần suất', async () => {
      await setup();
      assert.equal((await emit(red, 'chat:send', { text: '   \n\t ' })).error, 'empty_message');
      assert.equal((await emit(red, 'chat:send', {})).error, 'empty_message');
      assert.equal((await emit(red, 'chat:send', { text: 'a'.repeat(201) })).error, 'message_too_long');
      assert.equal((await emit(red, 'chat:send', { text: 'đ'.repeat(200) })).ok, true); // đếm theo ký tự, không theo byte
      assert.equal(cleanChat('a\nb\u202Ec\u0000  d'), 'a b c d');
      clock.advance(11_000);
      for (let i = 0; i < 5; i++) assert.equal((await emit(black, 'chat:send', { text: `tin ${i}` })).ok, true);
      assert.equal((await emit(black, 'chat:send', { text: 'tin 6' })).error, 'chat_rate_limited');
      clock.advance(11_000);
      assert.equal((await emit(black, 'chat:send', { text: 'tin 7' })).ok, true);
    });

    test('người ngoài phòng không chat được; người chơi không xem phòng khác; vào ván thì thôi xem', async () => {
      await setup();
      const stranger = await account(1500);
      assert.equal((await emit(stranger, 'chat:send', { text: 'alo' })).error, 'not_in_room');
      assert.equal((await emit(red, 'room:spectate', { roomId })).error, 'already_in_room');
      assert.equal((await emit(stranger, 'room:spectate', { roomId: 'KHONGCO' })).error, 'room_not_found');

      await emit(stranger, 'room:spectate', { roomId });
      await waitFor(red, 'room:spectators');
      await emit(stranger, 'room:create', { side: 'red' }); // tự tạo phòng: không còn là khán giả
      assert.deepEqual(await waitFor(red, 'room:spectators'), { roomId, count: 0 });
    });

    test('khán giả rời / mất kết nối thì số người xem giảm; phòng bị xoá thì khán giả được báo', async () => {
      await setup();
      const fan = await account(1500);
      await emit(fan, 'room:spectate', { roomId });
      assert.equal((await waitFor(red, 'room:spectators')).count, 1);
      fan.close();
      assert.equal((await waitFor(red, 'room:spectators')).count, 0);

      const fan2 = await account(1500);
      await emit(fan2, 'room:spectate', { roomId });
      await emit(red, 'game:resign');
      await Promise.all([emit(red, 'room:leave'), emit(black, 'room:leave')]);
      assert.deepEqual(await waitFor(fan2, 'spectate:closed'), { roomId });
      assert.equal((await emit(fan2, 'chat:send', { text: 'còn ai không' })).error, 'not_in_room');
    });

    test('người chơi nối lại nhận lại lịch sử chat', async () => {
      await setup();
      await emit(black, 'chat:send', { text: 'tin trước khi mất mạng' });
      await waitFor(red, 'chat:message');
      red.close();
      await sleep(60);
      const sess = [...app.gameServer.rooms.values()].find((r) => r.id === roomId).seats.red;
      const back = await connectWith(base, { token: await tokenOfUser(sess.userId) }, clients);
      await waitFor(back, 'session:resume');
      const hist = await waitFor(back, 'chat:history');
      assert.deepEqual(hist.messages.map((m) => m.text), ['tin trước khi mất mạng']);
    });
  });

  /** Cấp phiên mới cho một tài khoản đã có (để test nối lại). */
  async function tokenOfUser(userId) {
    const u = await store.findUserById(userId);
    return (await auth.startSession(u, { method: 'password' })).token;
  }
});
