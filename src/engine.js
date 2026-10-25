import { createHmac } from 'node:crypto';

// Engine luật Cờ Tướng/Cờ Úp — JavaScript thuần, không phụ thuộc thư viện ngoài Node.js.
// Port 1-1 từ xiangqi_engine.dart; server luôn giữ loại thật của quân Cờ Úp.

export const SIDE = Object.freeze({ RED: 'red', BLACK: 'black' });
export const TYPE = Object.freeze({
  GENERAL: 'general', ADVISOR: 'advisor', ELEPHANT: 'elephant', HORSE: 'horse',
  CHARIOT: 'chariot', CANNON: 'cannon', SOLDIER: 'soldier',
});
export const VARIANT = Object.freeze({ XIANGQI: 'xiangqi', JIEQI: 'jieqi' });

const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const BACK = [
  TYPE.CHARIOT, TYPE.HORSE, TYPE.ELEPHANT, TYPE.ADVISOR, TYPE.GENERAL,
  TYPE.ADVISOR, TYPE.ELEPHANT, TYPE.HORSE, TYPE.CHARIOT,
];
const JIEQI_POOL = [
  TYPE.ADVISOR, TYPE.ADVISOR, TYPE.ELEPHANT, TYPE.ELEPHANT,
  TYPE.HORSE, TYPE.HORSE, TYPE.CHARIOT, TYPE.CHARIOT,
  TYPE.CANNON, TYPE.CANNON,
  TYPE.SOLDIER, TYPE.SOLDIER, TYPE.SOLDIER, TYPE.SOLDIER, TYPE.SOLDIER,
];

export const toIndex = (col, row) => row * 9 + col;
export const toPos = (i) => ({ col: i % 9, row: Math.floor(i / 9) });
export const opposite = (side) => (side === SIDE.RED ? SIDE.BLACK : SIDE.RED);
export const inBoard = (c, r) => c >= 0 && c <= 8 && r >= 0 && r <= 9;
const inPalace = (side, c, r) => c >= 3 && c <= 5
  && (side === SIDE.RED ? r >= 7 && r <= 9 : r >= 0 && r <= 2);
const ownHalf = (side, r) => (side === SIDE.RED ? r >= 5 : r <= 4);

export function createInitialBoard() {
  const board = new Map();
  for (const side of [SIDE.BLACK, SIDE.RED]) {
    const backRow = side === SIDE.BLACK ? 0 : 9;
    const cannonRow = side === SIDE.BLACK ? 2 : 7;
    const soldierRow = side === SIDE.BLACK ? 3 : 6;
    const put = (col, row, type, index) => board.set(toIndex(col, row), {
      id: `${side}_${type}_${index}`, side, type, index,
    });
    const seen = {};
    BACK.forEach((type, col) => {
      const index = seen[type] ?? 0;
      seen[type] = index + 1;
      put(col, backRow, type, index);
    });
    put(1, cannonRow, TYPE.CANNON, 0);
    put(7, cannonRow, TYPE.CANNON, 1);
    for (let i = 0; i < 5; i++) put(i * 2, soldierRow, TYPE.SOLDIER, i);
  }
  return board;
}

export class Mulberry32 {
  constructor(seed) { this.state = Number(seed) >>> 0; }

  nextUint32() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 15), z | 1) >>> 0;
    z ^= (z + Math.imul(z ^ (z >>> 7), z | 61)) >>> 0;
    return (z ^ (z >>> 14)) >>> 0;
  }

  nextInt(upperExclusive) {
    if (!Number.isInteger(upperExclusive) || upperExclusive <= 0) throw new RangeError('upperExclusive');
    return Math.floor((this.nextUint32() / 0x100000000) * upperExclusive);
  }
}

export function jieqiStartingSlots(side) {
  const backRow = side === SIDE.BLACK ? 0 : 9;
  const cannonRow = side === SIDE.BLACK ? 2 : 7;
  const soldierRow = side === SIDE.BLACK ? 3 : 6;
  return [
    ...Array.from({ length: 9 }, (_, col) => col).filter((col) => col !== 4).map((col) => ({ col, row: backRow })),
    { col: 1, row: cannonRow }, { col: 7, row: cannonRow },
    ...[0, 2, 4, 6, 8].map((col) => ({ col, row: soldierRow })),
  ];
}

export function jieqiRoleAt(side, pos) {
  const slots = jieqiStartingSlots(side);
  const i = slots.findIndex((p) => p.col === pos.col && p.row === pos.row);
  if (i < 0) throw new RangeError('Không phải ô khai cuộc Cờ Úp');
  if (i < 8) return BACK[pos.col];
  if (i < 10) return TYPE.CANNON;
  return TYPE.SOLDIER;
}

function createJieqiBoard(random) {
  const board = new Map();
  for (const side of [SIDE.BLACK, SIDE.RED]) {
    const prefix = side === SIDE.BLACK ? 'b' : 'r';
    board.set(toIndex(4, side === SIDE.BLACK ? 0 : 9), {
      id: `jq-${prefix}-15`, side, type: TYPE.GENERAL, roleType: TYPE.GENERAL, index: 0, faceDown: false,
    });
    const shuffled = [...JIEQI_POOL];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = random.nextInt(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const seen = {};
    const slots = jieqiStartingSlots(side);
    slots.forEach((pos, i) => {
      const type = shuffled[i];
      const index = seen[type] ?? 0;
      seen[type] = index + 1;
      board.set(toIndex(pos.col, pos.row), {
        id: `jq-${prefix}-${String(i).padStart(2, '0')}`,
        side, type, roleType: jieqiRoleAt(side, pos), index, faceDown: true,
      });
    });
  }
  return board;
}

/** Contract test/offline: uint32 + Mulberry32 + Fisher–Yates giảm dần; Đen trước Đỏ. */
export function createJieqiInitialBoard(seed) {
  return createJieqiBoard(new Mulberry32(seed));
}

/**
 * Bộ sinh tất định dùng khóa seed 128-bit cho ván online.
 * HMAC ngăn vét cạn không gian uint32 từ các cặp slot/type đã lật công khai.
 */
export class HmacRandom {
  constructor(seed) {
    if (typeof seed !== 'string' || !/^[0-9a-f]{32}$/.test(seed)) throw new RangeError('seed');
    this.key = Buffer.from(seed, 'hex');
    this.counter = 0;
    this.words = [];
  }

  nextUint32() {
    if (this.words.length === 0) {
      const counter = Buffer.alloc(8);
      counter.writeBigUInt64BE(BigInt(this.counter++));
      const digest = createHmac('sha256', this.key).update(counter).digest();
      for (let i = 0; i < digest.length; i += 4) this.words.push(digest.readUInt32BE(i));
    }
    return this.words.shift();
  }

  nextInt(upperExclusive) {
    if (!Number.isInteger(upperExclusive) || upperExclusive <= 0) throw new RangeError('upperExclusive');
    const limit = Math.floor(0x100000000 / upperExclusive) * upperExclusive;
    let value;
    do { value = this.nextUint32(); } while (value >= limit);
    return value % upperExclusive;
  }
}

/** Khởi tạo online từ seed hex 128-bit bí mật, không bao giờ serialize seed ra client. */
export function createSecureJieqiInitialBoard(seed) {
  return createJieqiBoard(new HmacRandom(seed));
}

/** Dựng bàn từ tuple cũ hoặc object fixture. */
export function boardFrom(list) {
  const board = new Map();
  for (const entry of list) {
    if (Array.isArray(entry)) {
      const [col, row, side, type, index = 0] = entry;
      board.set(toIndex(col, row), { id: `${side}_${type}_${index}`, side, type, index });
    } else {
      const { at: [col, row], ...piece } = entry;
      board.set(toIndex(col, row), { index: 0, ...piece });
    }
  }
  return board;
}

/** Serializer đầy đủ chỉ dùng nội bộ server; không gửi cho client Cờ Úp. */
export function serializeBoard(board) {
  return [...board.entries()].map(([i, p]) => ({ ...p, ...toPos(i) }));
}

/** Serializer live Cờ Úp: opaque ID là định danh duy nhất; không phát index theo loại thật. */
export function redactBoard(board) {
  return [...board.entries()].map(([i, p]) => {
    const common = { id: p.id, side: p.side, ...toPos(i) };
    if (!p.faceDown) return { ...common, type: p.type, ...(p.roleType ? { roleType: p.roleType, faceDown: false } : {}) };
    return { ...common, roleType: p.roleType, faceDown: true };
  });
}

export const effectiveType = (piece) => (piece.faceDown ? piece.roleType : piece.type);

export function pseudoMoves(board, from) {
  const piece = board.get(from);
  if (!piece) return [];
  const { side } = piece;
  const type = effectiveType(piece);
  const fc = from % 9;
  const fr = Math.floor(from / 9);
  const out = [];
  // Trong Cờ Úp (quân có roleType), Sĩ và Tượng đã lộ KHÔNG bị ràng buộc cung/hà:
  // Sĩ đi chéo khắp bàn, Tượng đi chữ điền qua hà (vẫn bị cản mắt tượng). Nhờ vậy
  // Sĩ/Tượng có thể tham gia chiếu bí. Cờ Tướng thường giữ nguyên luật chuẩn.
  const jieqi = piece.roleType !== undefined;
  const tryAdd = (c, r) => {
    if (!inBoard(c, r)) return;
    const i = toIndex(c, r);
    const target = board.get(i);
    if (!target || target.side !== side) out.push(i);
  };
  switch (type) {
    case TYPE.GENERAL:
      for (const [dc, dr] of ORTH) if (inPalace(side, fc + dc, fr + dr)) tryAdd(fc + dc, fr + dr);
      break;
    case TYPE.ADVISOR:
      for (const [dc, dr] of DIAG) if (jieqi || inPalace(side, fc + dc, fr + dr)) tryAdd(fc + dc, fr + dr);
      break;
    case TYPE.ELEPHANT:
      for (const [dc, dr] of DIAG) {
        const c = fc + 2 * dc; const r = fr + 2 * dr;
        if (!inBoard(c, r) || (!jieqi && !ownHalf(side, r)) || board.has(toIndex(fc + dc, fr + dr))) continue;
        tryAdd(c, r);
      }
      break;
    case TYPE.HORSE:
      for (const [dc, dr] of ORTH) {
        const lc = fc + dc; const lr = fr + dr;
        if (!inBoard(lc, lr) || board.has(toIndex(lc, lr))) continue;
        if (dc !== 0) { tryAdd(fc + 2 * dc, fr + 1); tryAdd(fc + 2 * dc, fr - 1); }
        else { tryAdd(fc + 1, fr + 2 * dr); tryAdd(fc - 1, fr + 2 * dr); }
      }
      break;
    case TYPE.CHARIOT:
      for (const [dc, dr] of ORTH) {
        let c = fc + dc; let r = fr + dr;
        while (inBoard(c, r)) {
          const i = toIndex(c, r); const target = board.get(i);
          if (!target) out.push(i);
          else { if (target.side !== side) out.push(i); break; }
          c += dc; r += dr;
        }
      }
      break;
    case TYPE.CANNON:
      for (const [dc, dr] of ORTH) {
        let c = fc + dc; let r = fr + dr; let hasScreen = false;
        while (inBoard(c, r)) {
          const i = toIndex(c, r); const target = board.get(i);
          if (!hasScreen) { if (!target) out.push(i); else hasScreen = true; }
          else if (target) { if (target.side !== side) out.push(i); break; }
          c += dc; r += dr;
        }
      }
      break;
    case TYPE.SOLDIER: {
      const forward = side === SIDE.RED ? -1 : 1;
      tryAdd(fc, fr + forward);
      if (side === SIDE.RED ? fr <= 4 : fr >= 5) { tryAdd(fc - 1, fr); tryAdd(fc + 1, fr); }
      break;
    }
    default: break;
  }
  return out;
}

export function findGeneral(board, side) {
  for (const [i, p] of board) if (p.type === TYPE.GENERAL && p.side === side) return i;
  return -1;
}

export function generalsFacing(board) {
  const red = findGeneral(board, SIDE.RED); const black = findGeneral(board, SIDE.BLACK);
  if (red < 0 || black < 0 || red % 9 !== black % 9) return false;
  const col = red % 9; const rr = Math.floor(red / 9); const br = Math.floor(black / 9);
  for (let r = Math.min(rr, br) + 1; r < Math.max(rr, br); r++) if (board.has(toIndex(col, r))) return false;
  return true;
}

export function isInCheck(board, side) {
  const general = findGeneral(board, side);
  if (general < 0 || generalsFacing(board)) return true;
  for (const [i, p] of board) if (p.side !== side && pseudoMoves(board, i).includes(general)) return true;
  return false;
}

export function legalMoves(board, from) {
  const piece = board.get(from);
  if (!piece) return [];
  return pseudoMoves(board, from).filter((to) => {
    const next = new Map(board); next.delete(from); next.set(to, piece);
    return !isInCheck(next, piece.side);
  });
}

export function hasAnyLegalMove(board, side) {
  for (const [i, p] of [...board]) if (p.side === side && legalMoves(board, i).length > 0) return true;
  return false;
}

const KEY_CHAR = {
  [TYPE.GENERAL]: 'k', [TYPE.ADVISOR]: 'a', [TYPE.ELEPHANT]: 'b', [TYPE.HORSE]: 'n',
  [TYPE.CHARIOT]: 'r', [TYPE.CANNON]: 'c', [TYPE.SOLDIER]: 'p',
};
const keyChar = (type, side) => side === SIDE.RED ? KEY_CHAR[type].toUpperCase() : KEY_CHAR[type];

export function positionKey(board, turn) {
  const rows = [];
  for (let r = 0; r < 10; r++) {
    let row = '';
    for (let c = 0; c < 9; c++) {
      const p = board.get(toIndex(c, r));
      if (!p) row += '.';
      else if (p.faceDown) row += `[${keyChar(p.type, p.side)}|${keyChar(p.roleType, p.side)}]`;
      else row += keyChar(p.type, p.side);
    }
    rows.push(row);
  }
  return `${rows.join('/')} ${turn === SIDE.RED ? 'r' : 'b'}`;
}

export function judgeRepetition(cycle) {
  const seen = { red: false, black: false }; const allCheck = { red: true, black: true };
  for (const m of cycle) { seen[m.side] = true; if (!m.givesCheck) allCheck[m.side] = false; }
  const red = seen.red && allCheck.red; const black = seen.black && allCheck.black;
  if (red && !black) return { result: SIDE.BLACK, reason: 'perpetual_check' };
  if (black && !red) return { result: SIDE.RED, reason: 'perpetual_check' };
  return { result: 'draw', reason: 'repetition' };
}

export const NO_CAPTURE_LIMIT_PLIES = 120;

export class XiangqiGame {
  constructor({ board = createInitialBoard(), turn = SIDE.RED, variant = VARIANT.XIANGQI, seed = null } = {}) {
    this.board = new Map(board); this.turn = turn; this.variant = variant;
    this.seed = seed === null ? null : (typeof seed === 'number' ? Number(seed) >>> 0 : String(seed));
    this.history = []; this.result = 'ongoing'; this.endReason = null; this.isCheck = false;
    this.keys = [positionKey(this.board, this.turn)]; this.counts = new Map([[this.keys[0], 1]]);
    this._refresh();
  }

  static jieqi(seed) { return new XiangqiGame({ board: createJieqiInitialBoard(seed), variant: VARIANT.JIEQI, seed }); }
  static jieqiSecure(seed) {
    return new XiangqiGame({ board: createSecureJieqiInitialBoard(seed), variant: VARIANT.JIEQI, seed });
  }
  get repetitionCount() { return this.counts.get(this.keys[this.keys.length - 1]) ?? 1; }
  get pliesSinceCapture() { let n = 0; for (let i = this.history.length - 1; i >= 0 && !this.history[i].captured; i--) n++; return n; }
  get isOver() { return this.result !== 'ongoing'; }
  static _index(pos) { return pos && Number.isInteger(pos.col) && Number.isInteger(pos.row) && inBoard(pos.col, pos.row) ? toIndex(pos.col, pos.row) : -1; }

  legalMovesFrom(from) {
    if (this.isOver) return [];
    const fi = XiangqiGame._index(from); const piece = this.board.get(fi);
    if (!piece || piece.side !== this.turn) return [];
    return legalMoves(this.board, fi).map(toPos);
  }

  allLegalMoves() {
    if (this.isOver) return [];
    const moves = [];
    for (const [i, p] of [...this.board]) if (p.side === this.turn) {
      for (const to of legalMoves(this.board, i)) moves.push({ from: toPos(i), to: toPos(to) });
    }
    return moves;
  }

  isLegal(from, to) {
    const ti = XiangqiGame._index(to);
    return ti >= 0 && this.legalMovesFrom(from).some((p) => toIndex(p.col, p.row) === ti);
  }

  play(from, to) {
    if (!this.isLegal(from, to)) return null;
    const fi = XiangqiGame._index(from); const ti = XiangqiGame._index(to);
    const piece = this.board.get(fi); const captured = this.board.get(ti) ?? null;
    const movedPiece = piece.faceDown ? { ...piece, faceDown: false } : piece;
    const revealed = piece.faceDown ? piece.type : null;
    this.board.delete(fi); this.board.set(ti, movedPiece); this.turn = opposite(this.turn); this._refresh();
    const record = {
      from: toPos(fi), to: toPos(ti), piece, captured,
      capturedWasFaceDown: captured?.faceDown ?? false, revealed, givesCheck: this.isCheck,
    };
    this.history.push(record);
    const key = positionKey(this.board, this.turn); this.keys.push(key);
    const irreversible = revealed !== null || captured !== null;
    const n = irreversible ? 1 : (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (!this.isOver && n >= 3) {
      const first = this.keys.indexOf(key);
      const verdict = judgeRepetition(this.history.slice(first).map((r) => ({ side: r.piece.side, givesCheck: r.givesCheck })));
      this.forceEnd(verdict.result, verdict.reason);
    }
    if (!this.isOver && this.pliesSinceCapture >= NO_CAPTURE_LIMIT_PLIES) this.forceEnd('draw', 'no_capture');
    return record;
  }

  undo() {
    const last = this.history.pop(); if (!last) return false;
    const key = this.keys.pop(); const left = (this.counts.get(key) ?? 1) - 1;
    if (left <= 0) this.counts.delete(key); else this.counts.set(key, left);
    const fi = toIndex(last.from.col, last.from.row); const ti = toIndex(last.to.col, last.to.row);
    this.board.delete(ti); this.board.set(fi, last.piece); if (last.captured) this.board.set(ti, last.captured);
    this.turn = opposite(this.turn); this._refresh(); return true;
  }

  forceEnd(result, reason) { this.result = result; this.endReason = reason; }
  _refresh() {
    this.isCheck = isInCheck(this.board, this.turn);
    if (hasAnyLegalMove(this.board, this.turn)) { this.result = 'ongoing'; this.endReason = null; }
    else { this.result = opposite(this.turn); this.endReason = this.isCheck ? 'checkmate' : 'stalemate'; }
  }
}

export const createJieqiGame = (seed) => XiangqiGame.jieqi(seed);
