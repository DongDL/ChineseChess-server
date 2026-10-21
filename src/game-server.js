import { createHash, randomInt } from 'node:crypto';
import { DEFAULT_RATING } from './elo.js';
import { SIDE, opposite } from './engine.js';
import { Room, SIDES, generateRoomId } from './room.js';
import { DEFAULT_CLOCK_LIMITS, normalizeTimeControl, timeControlKey } from './clock.js';

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error) => ({ ok: false, error });

const PLAYER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Giới hạn tần suất: tối đa 60 sự kiện / 5 giây cho mỗi kết nối.
const RATE_WINDOW_MS = 5000;
const RATE_MAX_EVENTS = 60;

// Ghép trận theo Elo (xem GameServer.joinQueue).
const MATCHMAKING_DEFAULTS = { baseWindow: 100, growthPerSec: 10, guestAfterMs: 30_000 };

// Chat trong phòng.
const CHAT_MAX_CHARS = 200;
const CHAT_HISTORY = 50;
const CHAT_RATE = { max: 5, windowMs: 10_000 }; // tối đa 5 tin / 10 giây / người
const MAX_SPECTATORS = 50;

const asObject = (v) => (v && typeof v === 'object' ? v : {});

function parsePos(p) {
  if (!p || typeof p !== 'object') return null;
  const { col, row } = p;
  if (!Number.isInteger(col) || !Number.isInteger(row)) return null;
  if (col < 0 || col > 8 || row < 0 || row > 9) return null;
  return { col, row };
}

/** Tên khách tự sinh, ổn định theo playerId, ví dụ "Khách-3FA9". */
export function guestName(playerId) {
  return `Khách-${createHash('sha1').update(playerId).digest('hex').slice(0, 4).toUpperCase()}`;
}

function cleanName(name, fallback) {
  // eslint-disable-next-line no-control-regex
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return s || fallback;
}

/**
 * Làm sạch tin chat: bỏ ký tự điều khiển (kể cả xuống dòng) và ký tự đảo chiều chữ (U+202A-202E, U+2066-2069, dùng để
 * giả mạo nội dung), gộp khoảng trắng. Server KHÔNG escape HTML: client web phải tự escape khi hiển thị.
 */
export function cleanChat(raw) {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Server làm trọng tài: client chỉ GỬI Ý ĐỊNH đi quân, server kiểm tra bằng engine
 * rồi mới phát nước đi cho cả hai bên. Client không thể gian lận luật hay đi sai lượt.
 *
 * Danh tính người chơi = `playerId` do client tự sinh và lưu lại (gửi qua `auth`).
 * Nhờ vậy mất mạng / tắt app mở lại vẫn vào lại đúng ván đang chơi.
 */
export class GameServer {
  constructor(io, {
    graceMs = 60_000, sweepMs = 60_000, clockLimits = DEFAULT_CLOCK_LIMITS, authService = null, recorder = null,
    ratingOf = null, matchmaking = {}, matchTickMs = 2000, now = Date.now,
  } = {}) {
    this.ratingOf = ratingOf; // async (userId) => Elo hiện tại, dùng để ghép trận theo Elo (null: mọi tài khoản coi như 1500)
    this.matchmaking = { ...MATCHMAKING_DEFAULTS, ...matchmaking };
    this.matchTickMs = matchTickMs;
    this.now = now; // đồng hồ có thể thay trong test
    /** playerId -> roomId của phòng đang xem (khán giả) */
    this.spectating = new Map();
    this.io = io;
    this.authService = authService;
    this.recorder = recorder; // ghi ván đã kết thúc vào CSDL (có thể null)
    this.clockLimits = clockLimits;
    this.graceMs = graceMs;
    this.sweepMs = sweepMs;
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** playerId -> roomId */
    this.playerRoom = new Map();
    /** playerId -> socket đang hoạt động */
    this.sockets = new Map();
    /** Người đang chờ ghép trận: { playerId, key, timeControl } */
    this.queue = [];
    this.sweeper = null;
  }

  attach() {
    // Hai chế độ danh tính:
    //  - Tài khoản: auth.token (lấy từ /auth/login) -> playerId = "u:<id tài khoản>".
    //  - Khách:     auth.playerId (client tự sinh và lưu) -> chơi không cần đăng nhập.
    // Dấu ':' không nằm trong playerId hợp lệ của khách nên khách không thể mạo danh tài khoản.
    this.io.use(async (socket, next) => {
      try {
        const auth = asObject(socket.handshake.auth);
        socket.data.rate = { start: Date.now(), count: 0 };

        if (auth.token !== undefined) {
          const user = typeof auth.token === 'string' && this.authService
            ? await this.authService.authenticate(auth.token)
            : null;
          if (!user) return next(new Error('invalid_token'));
          Object.assign(socket.data, {
            playerId: `u:${user.id}`, name: user.displayName, guest: false, userId: user.id,
          });
          return next();
        }

        if (typeof auth.playerId !== 'string' || !PLAYER_ID_RE.test(auth.playerId)) {
          return next(new Error('invalid_player_id'));
        }
        Object.assign(socket.data, {
          playerId: auth.playerId,
          name: cleanName(auth.name, guestName(auth.playerId)),
          guest: true,
        });
        return next();
      } catch (err) {
        console.error('[auth]', err);
        return next(new Error('auth_error'));
      }
    });
    this.io.on('connection', (socket) => this.onConnection(socket));
    this.sweeper = setInterval(() => this.sweep(), this.sweepMs);
    this.sweeper.unref?.();
    this.matcher = setInterval(() => this.matchTick(), this.matchTickMs);
    this.matcher.unref?.();
  }

  dispose() {
    clearInterval(this.sweeper);
    clearInterval(this.matcher);
    for (const room of this.rooms.values()) {
      for (const side of SIDES) clearTimeout(room.timers[side]);
      clearTimeout(room.flagTimer);
    }
  }

  stats() {
    return { rooms: this.rooms.size, players: this.sockets.size, queue: this.queue.length };
  }

  // ---------------------------------------------------------------- tra cứu

  roomOf(playerId) {
    const id = this.playerRoom.get(playerId);
    return id ? this.rooms.get(id) ?? null : null;
  }

  /** Phòng của người chơi nếu ván CHƯA kết thúc. */
  activeRoomOf(playerId) {
    const room = this.roomOf(playerId);
    return room && room.status !== 'over' ? room : null;
  }

  /** Nếu ván cũ đã kết thúc thì tự rời để người chơi bắt đầu ván mới. */
  leaveIfOver(playerId) {
    const room = this.roomOf(playerId);
    if (room && room.status === 'over') this.detach(playerId);
  }

  removeFromQueue(playerId) {
    this.queue = this.queue.filter((e) => e.playerId !== playerId);
  }

  // ------------------------------------------------------------- kết nối

  onConnection(socket) {
    const { playerId } = socket.data;

    // Cùng một playerId kết nối lại: đóng kết nối cũ.
    const prev = this.sockets.get(playerId);
    this.sockets.set(playerId, socket);
    if (prev && prev.id !== socket.id) {
      prev.emit('session:replaced');
      prev.disconnect(true);
      this.stopSpectating(playerId); // kết nối mới chưa ở trong phòng socket.io của phòng đang xem: xem lại bằng room:spectate
    }

    // Giới hạn tần suất (trả lỗi qua ack, bỏ qua gói tin).
    socket.use((packet, next) => {
      const r = socket.data.rate;
      const now = Date.now();
      if (now - r.start > RATE_WINDOW_MS) {
        r.start = now;
        r.count = 0;
      }
      if (++r.count <= RATE_MAX_EVENTS) return next();
      const ack = packet[packet.length - 1];
      if (typeof ack === 'function') ack(fail('rate_limited'));
      return undefined;
    });

    // Đang có ván dở: đưa vào lại phòng và gửi toàn bộ trạng thái.
    const room = this.roomOf(playerId);
    if (room) this.resume(socket, room);

    const on = (event, handler) => {
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          handler(asObject(payload), reply);
        } catch (err) {
          console.error(`[${event}]`, err);
          reply(fail('internal_error'));
        }
      });
    };

    on('room:create', (p, reply) => this.createRoom(socket, p, reply));
    on('room:join', (p, reply) => this.joinRoom(socket, p, reply));
    on('room:leave', (p, reply) => this.leaveRoom(socket, reply));
    on('room:spectate', (p, reply) => this.spectate(socket, p, reply));
    on('chat:send', (p, reply) => this.handleChat(socket, p, reply));
    on('queue:join', (p, reply) => this.joinQueue(socket, p, reply));
    on('queue:leave', (p, reply) => {
      this.removeFromQueue(playerId);
      reply(ok());
    });
    on('game:move', (p, reply) => this.handleMove(socket, p, reply));
    on('game:resign', (p, reply) => this.handleResign(socket, reply));
    on('game:draw:offer', (p, reply) => this.handleDrawOffer(socket, reply));
    on('game:draw:respond', (p, reply) => this.handleDrawRespond(socket, p, reply));
    on('game:sync', (p, reply) => {
      const r = this.roomOf(playerId);
      if (!r) {
        const watching = this.rooms.get(this.spectating.get(playerId));
        return watching ? reply(ok({ state: watching.toState(null) })) : reply(fail('not_in_room'));
      }
      return reply(ok({ state: r.toState(r.sideOf(playerId)) }));
    });

    socket.on('disconnect', () => this.onDisconnect(socket));
  }

  onDisconnect(socket) {
    const { playerId } = socket.data;
    // Đã bị kết nối mới thay thế thì bỏ qua.
    if (this.sockets.get(playerId) !== socket) return;
    this.sockets.delete(playerId);
    this.removeFromQueue(playerId);
    this.stopSpectating(playerId);

    const room = this.roomOf(playerId);
    if (!room) return;
    const side = room.sideOf(playerId);
    room.seats[side].connected = false;
    if (room.status === 'over') return;

    // Thông báo cho đối thủ và đếm ngược chờ nối lại.
    this.io.to(room.id).emit('opponent:status', { connected: false, graceMs: this.graceMs });
    clearTimeout(room.timers[side]);
    room.timers[side] = setTimeout(() => {
      room.timers[side] = null;
      if (room.status === 'playing') this.finish(room, opposite(side), 'disconnect');
      else if (room.status === 'waiting') this.detach(playerId);
    }, this.graceMs);
  }

  /** Đưa socket vào lại phòng đang có (nối lại sau khi mất kết nối). */
  resume(socket, room) {
    const { playerId } = socket.data;
    const side = room.sideOf(playerId);
    clearTimeout(room.timers[side]);
    room.timers[side] = null;
    room.seats[side].connected = true;
    socket.join(room.id);
    socket.emit('session:resume', room.toState(side));
    if (room.chat.length > 0) socket.emit('chat:history', { roomId: room.id, messages: room.chat });
    socket.to(room.id).emit('opponent:status', { connected: true });
  }

  // ------------------------------------------------------------ phòng chơi

  createRoom(socket, payload, reply) {
    const { playerId, name, guest, userId } = socket.data;
    this.leaveIfOver(playerId);
    if (this.roomOf(playerId)) return reply(fail('already_in_room'));
    let timeControl;
    try {
      timeControl = normalizeTimeControl(payload.timeControl, this.clockLimits);
    } catch {
      return reply(fail('bad_time_control'));
    }
    this.removeFromQueue(playerId);
    this.stopSpectating(playerId);

    const side =
      payload.side === SIDE.RED || payload.side === SIDE.BLACK
        ? payload.side
        : SIDES[randomInt(2)];
    const room = new Room(generateRoomId((id) => this.rooms.has(id)), timeControl);
    room.seat(side, playerId, name, guest, userId);
    this.rooms.set(room.id, room);
    this.playerRoom.set(playerId, room.id);
    socket.join(room.id);
    return reply(ok({ roomId: room.id, side, state: room.toState(side) }));
  }

  joinRoom(socket, payload, reply) {
    const { playerId, name, guest, userId } = socket.data;
    const roomId = String(payload.roomId ?? '').trim().toUpperCase();
    const room = this.rooms.get(roomId);
    if (!room) return reply(fail('room_not_found'));

    // Đã ngồi sẵn trong phòng này (gửi lại join sau khi nối lại): coi như vào lại.
    const existing = room.sideOf(playerId);
    if (existing && this.playerRoom.get(playerId) === room.id) {
      this.resume(socket, room);
      return reply(ok({ roomId, side: existing, state: room.toState(existing) }));
    }

    this.leaveIfOver(playerId);
    if (this.roomOf(playerId)) return reply(fail('already_in_room'));
    if (room.isFull || room.status !== 'waiting') return reply(fail('room_full'));
    this.removeFromQueue(playerId);
    this.stopSpectating(playerId);

    const [side] = room.freeSides();
    room.seat(side, playerId, name, guest, userId);
    this.playerRoom.set(playerId, room.id);
    socket.join(room.id);
    room.status = 'playing'; // đủ 2 người: ack trả về đã ở trạng thái đang chơi
    reply(ok({ roomId, side, state: room.toState(side) }));
    return this.startGame(room);
  }

  /**
   * Xếp hàng ghép trận. Chỉ ghép với người chọn CÙNG mức thời gian, và ưu tiên người có Elo gần nhất:
   * cửa sổ ghép ban đầu là ±matchmaking.baseWindow điểm, nới thêm growthPerSec điểm mỗi giây chờ (nên không ai chờ mãi).
   * Khách (không có Elo) ghép với khách; khách và tài khoản chỉ ghép với nhau khi một bên đã chờ quá guestAfterMs
   * (ván đó không tính điểm). Việc ghép lại được thử mỗi matchTickMs vì cửa sổ nới dần theo thời gian chờ.
   */
  async joinQueue(socket, payload, reply) {
    try {
      const { playerId, userId, guest } = socket.data;
      this.leaveIfOver(playerId);
      if (this.roomOf(playerId)) return reply(fail('already_in_room'));
      let timeControl;
      try {
        timeControl = normalizeTimeControl(payload.timeControl, this.clockLimits);
      } catch {
        return reply(fail('bad_time_control'));
      }
      const key = timeControlKey(timeControl);
      this.removeFromQueue(playerId);

      let rating = null; // khách không có Elo
      if (!guest) {
        rating = DEFAULT_RATING;
        if (userId && this.ratingOf) {
          try {
            rating = (await this.ratingOf(userId)) ?? DEFAULT_RATING;
          } catch (err) {
            console.error('[queue] không đọc được Elo, dùng điểm mặc định:', err.message);
          }
        }
      }
      // Trong lúc chờ đọc Elo, trạng thái có thể đã đổi: kiểm tra lại.
      if (this.sockets.get(playerId) !== socket) return undefined;
      this.leaveIfOver(playerId);
      if (this.roomOf(playerId)) return reply(fail('already_in_room'));
      this.removeFromQueue(playerId);
      this.stopSpectating(playerId);

      const entry = { playerId, key, timeControl, rating, joinedAt: this.now() };
      this.queue.push(entry);
      const room = this.matchEntry(entry);
      if (!room) return reply(ok({ matched: false }));
      reply(ok({ matched: true, roomId: room.id, side: room.sideOf(playerId) }));
      return this.announce(room);
    } catch (err) {
      console.error('[queue:join]', err);
      return reply(fail('internal_error'));
    }
  }

  /** Cửa sổ chênh lệch Elo chấp nhận được của một người đang chờ. */
  matchWindow(entry, now) {
    const { baseWindow, growthPerSec } = this.matchmaking;
    return baseWindow + (growthPerSec * Math.max(0, now - entry.joinedAt)) / 1000;
  }

  /** Hai người đang chờ có được ghép với nhau ở thời điểm [now] không (cùng mức thời gian do người gọi đảm bảo). */
  compatible(a, b, now) {
    if (a.rating === null && b.rating === null) return true;
    if (a.rating !== null && b.rating !== null) {
      return Math.abs(a.rating - b.rating) <= Math.max(this.matchWindow(a, now), this.matchWindow(b, now));
    }
    const { guestAfterMs } = this.matchmaking;
    return now - a.joinedAt >= guestAfterMs || now - b.joinedAt >= guestAfterMs;
  }

  /** Độ "xa" giữa hai người để chọn đối thủ gần nhất (khách-khách = 0, khách-tài khoản = rất xa). */
  matchDistance(a, b) {
    if (a.rating === null && b.rating === null) return 0;
    if (a.rating === null || b.rating === null) return 1_000_000;
    return Math.abs(a.rating - b.rating);
  }

  /** Bỏ khỏi hàng đợi người đã ngắt kết nối hoặc đã vào ván khác. */
  purgeQueue() {
    this.queue = this.queue.filter((e) => {
      if (!this.sockets.has(e.playerId)) return false;
      this.leaveIfOver(e.playerId);
      return !this.roomOf(e.playerId);
    });
  }

  /** Tìm đối thủ phù hợp nhất cho [entry]; nếu có thì xếp cả hai vào phòng mới (chưa phát sự kiện) và trả về phòng. */
  matchEntry(entry) {
    this.purgeQueue();
    const now = this.now();
    let best = null;
    for (const other of this.queue) {
      if (other === entry || other.key !== entry.key || other.playerId === entry.playerId) continue;
      if (!this.compatible(entry, other, now)) continue;
      const d = this.matchDistance(entry, other);
      if (!best || d < best.d) best = { other, d };
    }
    if (!best) return null;
    this.queue = this.queue.filter((e) => e !== entry && e !== best.other);

    const room = new Room(generateRoomId((id) => this.rooms.has(id)), entry.timeControl);
    const socks = [this.sockets.get(entry.playerId), this.sockets.get(best.other.playerId)];
    const [first, second] = randomInt(2) === 0 ? socks : [socks[1], socks[0]];
    room.seat(SIDE.RED, first.data.playerId, first.data.name, first.data.guest, first.data.userId);
    room.seat(SIDE.BLACK, second.data.playerId, second.data.name, second.data.guest, second.data.userId);
    this.rooms.set(room.id, room);
    for (const s of [first, second]) {
      this.playerRoom.set(s.data.playerId, room.id);
      s.join(room.id);
    }
    return room;
  }

  /** Báo cho hai người đã được ghép rồi bắt đầu ván. */
  announce(room) {
    for (const side of SIDES) {
      this.sockets.get(room.seats[side].playerId)?.emit('match:found', { roomId: room.id, side });
    }
    this.startGame(room);
  }

  /** Thử ghép lại những người đang chờ (cửa sổ Elo nới dần theo thời gian chờ). Gọi định kỳ. */
  matchTick() {
    this.purgeQueue();
    for (const entry of [...this.queue]) {
      if (!this.queue.includes(entry)) continue; // đã được ghép trong vòng lặp này
      const room = this.matchEntry(entry);
      if (room) this.announce(room);
    }
  }

  startGame(room) {
    room.status = 'playing';
    room.startedAt = Date.now();
    room.clock?.start(SIDE.RED); // Đỏ đi trước: đồng hồ Đỏ bắt đầu chạy
    this.scheduleFlag(room);
    for (const side of SIDES) {
      this.sockets.get(room.seats[side].playerId)?.emit('game:start', room.toState(side));
    }
    // Khán giả đã vào xem phòng chờ: gửi thế cờ khai cuộc (họ không có ghế nên không nhận game:start).
    for (const pid of room.spectators.keys()) {
      this.sockets.get(pid)?.emit('spectate:state', room.toState(null));
    }
  }

  /** Hẹn giờ phát hiện bên đang chạy hết giờ. Đồng hồ do SERVER tính, không tin client. */
  scheduleFlag(room) {
    clearTimeout(room.flagTimer);
    room.flagTimer = null;
    if (!room.clock || room.status !== 'playing') return;
    const ms = room.clock.msUntilFlag();
    if (!Number.isFinite(ms)) return;
    room.flagTimer = setTimeout(() => this.onFlag(room), ms + 5);
  }

  onFlag(room) {
    room.flagTimer = null;
    if (room.status !== 'playing' || !room.clock) return;
    room.clock.tick();
    const side = room.clock.running;
    if (side && room.clock.isExpired(side)) this.finish(room, opposite(side), 'timeout');
    else this.scheduleFlag(room);
  }

  leaveRoom(socket, reply) {
    const { playerId } = socket.data;
    const room = this.roomOf(playerId);
    if (!room) {
      this.stopSpectating(playerId); // đang xem thì chỉ thôi xem
      return reply(ok());
    }
    if (room.status === 'playing') {
      this.finish(room, opposite(room.sideOf(playerId)), 'resign');
    }
    this.detach(playerId);
    return reply(ok());
  }

  /** Gỡ người chơi khỏi phòng; phòng không còn ai thì xoá. */
  detach(playerId) {
    const room = this.roomOf(playerId);
    if (!room) return;
    const side = room.sideOf(playerId);
    clearTimeout(room.timers[side]);
    room.timers[side] = null;
    this.playerRoom.delete(playerId);
    this.sockets.get(playerId)?.leave(room.id);

    const anyoneLeft = SIDES.some((s) => {
      const seat = room.seats[s];
      return seat && this.playerRoom.get(seat.playerId) === room.id;
    });
    if (!anyoneLeft) this.dropRoom(room);
  }

  /** Xoá phòng; khán giả còn lại được báo để app đóng màn hình xem. */
  dropRoom(room) {
    for (const pid of [...room.spectators.keys()]) {
      this.sockets.get(pid)?.emit('spectate:closed', { roomId: room.id });
      this.stopSpectating(pid);
    }
    this.rooms.delete(room.id);
  }

  // ------------------------------------------------- khán giả và chat

  /**
   * Xem một phòng bằng mã phòng (ai biết mã là xem được; app công bố mã tuỳ người chơi). Khán giả nhận mọi sự kiện của
   * phòng (nước đi, kết quả, chat) nhưng không đi quân được. Khách xem được nhưng không chat được (cần tài khoản).
   */
  spectate(socket, payload, reply) {
    const { playerId, name, guest, userId } = socket.data;
    const roomId = String(payload.roomId ?? '').trim().toUpperCase();
    const room = this.rooms.get(roomId);
    if (!room) return reply(fail('room_not_found'));
    this.leaveIfOver(playerId);
    if (this.roomOf(playerId)) return reply(fail('already_in_room'));
    const already = this.spectating.get(playerId) === roomId;
    if (!already && room.spectators.size >= MAX_SPECTATORS) return reply(fail('too_many_spectators'));
    this.removeFromQueue(playerId);
    if (!already) this.stopSpectating(playerId); // đang xem phòng khác thì chuyển sang
    room.spectators.set(playerId, { name, guest, userId });
    this.spectating.set(playerId, roomId);
    socket.join(roomId);
    this.emitSpectators(room);
    return reply(ok({
      roomId, state: room.toState(null), chat: room.chat, spectators: room.spectators.size,
    }));
  }

  stopSpectating(playerId) {
    const roomId = this.spectating.get(playerId);
    if (!roomId) return;
    this.spectating.delete(playerId);
    this.sockets.get(playerId)?.leave(roomId);
    const room = this.rooms.get(roomId);
    if (room?.spectators.delete(playerId)) this.emitSpectators(room);
  }

  emitSpectators(room) {
    this.io.to(room.id).emit('room:spectators', { roomId: room.id, count: room.spectators.size });
  }

  /** Gửi tin nhắn vào phòng: người chơi (kể cả khách) hoặc khán giả có tài khoản. */
  handleChat(socket, payload, reply) {
    const { playerId, name, guest } = socket.data;
    let room = this.roomOf(playerId);
    let role = room ? room.sideOf(playerId) : null;
    if (!room) {
      const watching = this.spectating.get(playerId);
      room = watching ? this.rooms.get(watching) ?? null : null;
      role = 'spectator';
    }
    if (!room) return reply(fail('not_in_room'));
    if (role === 'spectator' && guest) return reply(fail('login_required'));

    const text = cleanChat(payload.text);
    if (text === '') return reply(fail('empty_message'));
    if ([...text].length > CHAT_MAX_CHARS) return reply(fail('message_too_long'));

    const now = this.now();
    const times = (socket.data.chatTimes ??= []).filter((t) => now - t < CHAT_RATE.windowMs);
    if (times.length >= CHAT_RATE.max) return reply(fail('chat_rate_limited'));
    times.push(now);
    socket.data.chatTimes = times;

    const msg = { id: ++room.chatSeq, roomId: room.id, from: { name, role, guest }, text, at: now };
    room.chat.push(msg);
    if (room.chat.length > CHAT_HISTORY) room.chat.shift();
    this.io.to(room.id).emit('chat:message', msg);
    return reply(ok({ id: msg.id }));
  }

  // ----------------------------------------------------------- ván cờ

  /** Lấy phòng đang chơi + phe của người gửi, hoặc trả lỗi. */
  playing(socket, reply) {
    const { playerId } = socket.data;
    const room = this.roomOf(playerId);
    if (!room || room.status !== 'playing') {
      reply(fail('not_playing'));
      return null;
    }
    return { room, side: room.sideOf(playerId) };
  }

  handleMove(socket, payload, reply) {
    const ctx = this.playing(socket, reply);
    if (!ctx) return;
    const { room, side } = ctx;
    if (room.game.turn !== side) return reply(fail('not_your_turn'));

    // Nước đi đến muộn sau khi đã hết giờ: xử thua ngay, không nhận nước đi.
    if (room.clock) {
      room.clock.tick();
      if (room.clock.isExpired(side)) {
        this.finish(room, opposite(side), 'timeout');
        return reply(fail('time_expired'));
      }
    }

    const from = parsePos(payload.from);
    const to = parsePos(payload.to);
    if (!from || !to) return reply(fail('bad_payload'));

    const record = room.game.play(from, to);
    if (!record) return reply(fail('illegal_move'));

    room.moveTimes.push(Date.now() - room.startedAt);

    // Nước hợp lệ: trừ giờ, cộng thêm giờ, chuyển đồng hồ sang đối thủ.
    room.clock?.press();
    this.scheduleFlag(room);

    room.drawOfferFrom = null;
    this.io.to(room.id).emit('game:move', {
      roomId: room.id,
      moveNumber: room.game.history.length,
      from: record.from,
      to: record.to,
      pieceId: record.piece.id,
      capturedId: record.captured?.id ?? null,
      givesCheck: record.givesCheck,
      turn: room.game.turn,
      isCheck: room.game.isCheck,
      repetitions: room.game.repetitionCount,
      clock: room.clock ? room.clock.snapshot() : null,
    });
    reply(ok());
    if (room.game.isOver) this.finish(room, room.game.result, room.game.endReason);
    return undefined;
  }

  handleResign(socket, reply) {
    const ctx = this.playing(socket, reply);
    if (!ctx) return;
    this.finish(ctx.room, opposite(ctx.side), 'resign');
    reply(ok());
  }

  handleDrawOffer(socket, reply) {
    const ctx = this.playing(socket, reply);
    if (!ctx) return;
    const { room, side } = ctx;
    if (room.drawOfferFrom === side) return reply(fail('already_offered'));
    if (room.drawOfferFrom === opposite(side)) {
      // Cả hai cùng xin hoà: đồng ý luôn.
      this.finish(room, 'draw', 'agreement');
      return reply(ok());
    }
    room.drawOfferFrom = side;
    this.io.to(room.id).emit('game:draw:offered', { roomId: room.id, from: side });
    return reply(ok());
  }

  handleDrawRespond(socket, payload, reply) {
    const ctx = this.playing(socket, reply);
    if (!ctx) return;
    const { room, side } = ctx;
    if (room.drawOfferFrom !== opposite(side)) return reply(fail('no_draw_offer'));
    if (payload.accept === true) {
      this.finish(room, 'draw', 'agreement');
    } else {
      room.drawOfferFrom = null;
      this.io.to(room.id).emit('game:draw:declined', { roomId: room.id, by: side });
    }
    return reply(ok());
  }

  /** Kết thúc ván: result là phe thắng ('red' | 'black') hoặc 'draw'. */
  finish(room, result, reason) {
    if (room.status === 'over') return;
    if (!room.game.isOver) room.game.forceEnd(result, reason);
    room.status = 'over';
    room.endedAt = Date.now();
    room.drawOfferFrom = null;
    for (const side of SIDES) {
      clearTimeout(room.timers[side]);
      room.timers[side] = null;
    }
    room.clock?.stop();
    clearTimeout(room.flagTimer);
    room.flagTimer = null;
    // Lưu ván vào CSDL ở nền; không chờ để việc báo kết quả không bị chậm.
    // Ghi xong (và đã cập nhật Elo) thì báo điểm mới cho hai bên; ván không tính điểm vẫn gửi rated:false để app thôi chờ.
    this.recorder?.record(room.toRecord(), (saved) => {
      const r = saved?.rating ?? null;
      this.io.to(room.id).emit('game:rating', {
        roomId: room.id,
        gameId: room.gameId,
        rated: r !== null,
        red: r?.red ?? null,
        black: r?.black ?? null,
      });
    });
    this.io.to(room.id).emit('game:over', {
      roomId: room.id,
      gameId: room.gameId,
      result: room.game.result,
      reason: room.game.endReason,
      clock: room.clock ? room.clock.snapshot() : null,
    });
  }

  /** Dọn phòng bị bỏ quên: chờ quá 30 phút, hoặc đã kết thúc quá 1 giờ. */
  sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      const staleWaiting = room.status === 'waiting' && now - room.createdAt > 30 * 60_000;
      const staleOver = room.status === 'over' && now - room.endedAt > 60 * 60_000;
      if (!staleWaiting && !staleOver) continue;
      for (const side of SIDES) {
        const seat = room.seats[side];
        if (seat) this.detach(seat.playerId);
      }
      this.dropRoom(room);
    }
  }
}
