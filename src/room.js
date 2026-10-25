import { createHash, randomInt, randomUUID } from 'node:crypto';
import { XiangqiGame, SIDE, VARIANT, opposite, redactBoard, serializeBoard } from './engine.js';
import { GameClock } from './clock.js';

export const SIDES = [SIDE.RED, SIDE.BLACK];
export const VARIANTS = [VARIANT.XIANGQI, VARIANT.JIEQI];
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeVariant(value, fallback = VARIANT.XIANGQI) {
  const variant = value ?? fallback;
  if (!VARIANTS.includes(variant)) throw new RangeError('bad_variant');
  return variant;
}

export function generateRoomId(exists) {
  let id;
  do { id = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); } while (exists(id));
  return id;
}

const publicSeat = (seat) => seat ? { name: seat.name, connected: seat.connected, guest: seat.guest } : null;

/** Băm seed bí mật để lưu dấu vết audit nội bộ cùng bản ghi ván. */
export const seedCommitment = (seed) => createHash('sha256').update(String(seed), 'utf8').digest('hex');

export class Room {
  constructor(id, timeControl = null, { variant = VARIANT.XIANGQI, seed = null } = {}) {
    this.id = id;
    this.gameId = randomUUID();
    this.variant = normalizeVariant(variant);
    this.seed = this.variant === VARIANT.JIEQI ? String(seed) : null;
    if (this.variant === VARIANT.JIEQI && !/^[0-9a-f]{32}$/.test(this.seed)) {
      throw new RangeError('bad_jieqi_seed');
    }
    this.seedHash = this.variant === VARIANT.JIEQI ? seedCommitment(this.seed) : null;
    this.startedAt = null;
    this.moveTimes = [];
    this.game = this.variant === VARIANT.JIEQI ? XiangqiGame.jieqiSecure(this.seed) : new XiangqiGame();
    this.clock = timeControl ? new GameClock(timeControl) : null;
    this.flagTimer = null;
    this.seats = { red: null, black: null };
    this.status = 'waiting';
    this.drawOfferFrom = null;
    this.timers = { red: null, black: null };
    this.createdAt = Date.now();
    this.endedAt = null;
    this.spectators = new Map();
    this.chat = [];
    this.chatSeq = 0;
  }

  sideOf(playerId) { return SIDES.find((s) => this.seats[s]?.playerId === playerId) ?? null; }
  get isFull() { return this.seats.red !== null && this.seats.black !== null; }
  freeSides() { return SIDES.filter((s) => this.seats[s] === null); }
  seat(side, playerId, name, guest = true, userId = null) { this.seats[side] = { playerId, name, guest, userId, connected: true }; }
  opponentOf(side) { return opposite(side); }

  /** Nước đi live/history được dựng riêng theo viewer để không lộ quân úp bị ăn. */
  moveForViewer(record, viewerSide = null, moveNumber = null) {
    const captured = record.captured ? {
      id: record.captured.id,
      side: record.captured.side,
      ...(record.captured.roleType ? { roleType: record.captured.roleType } : {}),
      faceDown: Boolean(record.capturedWasFaceDown),
      ...(!record.capturedWasFaceDown || viewerSide === record.piece.side
        ? { type: record.captured.type }
        : {}),
    } : null;
    return {
      ...(moveNumber === null ? {} : { roomId: this.id, moveNumber }),
      from: record.from,
      to: record.to,
      pieceId: record.piece.id,
      capturedId: record.captured?.id ?? null,
      captured,
      capturedWasFaceDown: record.capturedWasFaceDown,
      revealed: record.revealed,
      givesCheck: record.givesCheck,
    };
  }

  toState(viewerSide = null) {
    const g = this.game;
    const jieqi = this.variant === VARIANT.JIEQI;
    return {
      roomId: this.id,
      gameId: this.gameId,
      ...(jieqi ? { variant: this.variant } : {}),
      status: this.status,
      you: viewerSide,
      players: { red: publicSeat(this.seats.red), black: publicSeat(this.seats.black) },
      turn: g.turn,
      isCheck: g.isCheck,
      repetitions: g.repetitionCount,
      clock: this.clock ? this.clock.snapshot() : null,
      board: jieqi ? redactBoard(g.board) : serializeBoard(g.board),
      moves: g.history.map((r) => jieqi ? this.moveForViewer(r, viewerSide) : ({
        from: r.from, to: r.to, pieceId: r.piece.id,
        capturedId: r.captured?.id ?? null, givesCheck: r.givesCheck,
      })),
      result: g.isOver ? g.result : null,
      endReason: g.isOver ? g.endReason : null,
      drawOfferFrom: this.drawOfferFrom,
    };
  }

  toRecord() {
    const g = this.game;
    const seat = (s) => ({ userId: s.userId ?? null, name: s.name, guest: s.guest });
    const snap = this.clock ? this.clock.snapshot() : null;
    return {
      id: this.gameId,
      roomId: this.id,
      variant: this.variant,
      seed: this.seed,
      seedHash: this.seedHash,
      red: seat(this.seats.red),
      black: seat(this.seats.black),
      timeControl: this.clock ? { baseMs: this.clock.baseMs, incrementMs: this.clock.incrementMs } : null,
      result: g.result,
      endReason: g.endReason,
      moves: g.history.map((r, i) => ({
        from: r.from, to: r.to, pieceId: r.piece.id,
        moverSide: r.piece.side,
        capturedId: r.captured?.id ?? null,
        capturedType: r.captured?.type ?? null,
        capturedWasFaceDown: r.capturedWasFaceDown,
        revealedPiece: r.revealed,
        givesCheck: r.givesCheck,
        elapsedMs: this.moveTimes[i] ?? null,
      })),
      clock: snap ? { redMs: snap.remainingMs.red, blackMs: snap.remainingMs.black } : null,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    };
  }
}
