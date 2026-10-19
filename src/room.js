import { randomInt, randomUUID } from 'node:crypto';
import { XiangqiGame, SIDE, opposite, serializeBoard } from './engine.js';
import { GameClock } from './clock.js';

export const SIDES = [SIDE.RED, SIDE.BLACK];

// Bỏ các ký tự dễ nhầm (0/O, 1/I) để dễ đọc mã phòng cho bạn bè.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomId(exists) {
  let id;
  do {
    id = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  } while (exists(id));
  return id;
}

/** Thông tin ghế gửi cho client (KHÔNG lộ playerId của đối thủ). */
const publicSeat = (seat) =>
  seat ? { name: seat.name, connected: seat.connected, guest: seat.guest } : null;

export class Room {
  /** [timeControl]: null (không giới hạn thời gian) hoặc { baseMs, incrementMs }. */
  constructor(id, timeControl = null) {
    this.id = id;
    this.gameId = randomUUID(); // id dùng để lưu ván và xem lại
    this.startedAt = null; // ms, đặt khi đủ 2 người
    this.moveTimes = []; // ms từ lúc bắt đầu ván đến từng nước đi
    this.game = new XiangqiGame();
    this.clock = timeControl ? new GameClock(timeControl) : null;
    this.flagTimer = null; // hẹn giờ phát hiện hết giờ
    /** @type {{red: Seat|null, black: Seat|null}} */
    this.seats = { red: null, black: null };
    /** 'waiting' (chờ đối thủ) | 'playing' | 'over' */
    this.status = 'waiting';
    this.drawOfferFrom = null; // 'red' | 'black' | null
    this.timers = { red: null, black: null }; // hẹn giờ chờ nối lại
    this.createdAt = Date.now();
    this.endedAt = null;
  }

  sideOf(playerId) {
    return SIDES.find((s) => this.seats[s]?.playerId === playerId) ?? null;
  }

  get isFull() {
    return this.seats.red !== null && this.seats.black !== null;
  }

  freeSides() {
    return SIDES.filter((s) => this.seats[s] === null);
  }

  /** [guest]: true = người chơi không đăng nhập (danh tính chỉ là playerId trên máy họ). */
  seat(side, playerId, name, guest = true, userId = null) {
    this.seats[side] = { playerId, name, guest, userId, connected: true };
  }

  opponentOf(side) {
    return opposite(side);
  }

  /** Toàn bộ trạng thái phòng/ván cờ, dùng cho game:start, session:resume, game:sync. */
  toState(viewerSide = null) {
    const g = this.game;
    return {
      roomId: this.id,
      gameId: this.gameId,
      status: this.status,
      you: viewerSide,
      players: { red: publicSeat(this.seats.red), black: publicSeat(this.seats.black) },
      turn: g.turn,
      isCheck: g.isCheck,
      repetitions: g.repetitionCount, // thế cờ hiện tại đã xuất hiện mấy lần (3 = kết thúc)
      clock: this.clock ? this.clock.snapshot() : null,
      board: serializeBoard(g.board),
      moves: g.history.map((r) => ({
        from: r.from,
        to: r.to,
        pieceId: r.piece.id,
        capturedId: r.captured?.id ?? null,
        givesCheck: r.givesCheck,
      })),
      result: g.isOver ? g.result : null,
      endReason: g.isOver ? g.endReason : null,
      drawOfferFrom: this.drawOfferFrom,
    };
  }

  /**
   * Bản ghi ván đã kết thúc để lưu vào CSDL. KHÔNG chứa playerId của khách (đó là chìa khoá bí mật của họ):
   * khách chỉ được lưu tên và cờ guest; tài khoản được lưu userId.
   */
  toRecord() {
    const g = this.game;
    const seat = (s) => ({ userId: s.userId ?? null, name: s.name, guest: s.guest });
    const snap = this.clock ? this.clock.snapshot() : null;
    return {
      id: this.gameId,
      roomId: this.id,
      red: seat(this.seats.red),
      black: seat(this.seats.black),
      timeControl: this.clock ? { baseMs: this.clock.baseMs, incrementMs: this.clock.incrementMs } : null,
      result: g.result,
      endReason: g.endReason,
      moves: g.history.map((r, i) => ({
        from: r.from,
        to: r.to,
        pieceId: r.piece.id,
        capturedId: r.captured?.id ?? null,
        givesCheck: r.givesCheck,
        elapsedMs: this.moveTimes[i] ?? null,
      })),
      clock: snap ? { redMs: snap.remainingMs.red, blackMs: snap.remainingMs.black } : null,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    };
  }
}
