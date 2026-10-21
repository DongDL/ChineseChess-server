// Engine luật cờ tướng — JavaScript thuần, không phụ thuộc thư viện.
// Đây là bản port 1-1 của xiangqi_engine.dart (Flutter) để server làm trọng tài:
// cùng một bộ luật, cùng quy ước toạ độ và cùng ID quân cờ với client.
//
// Toạ độ: col 0..8 (trái -> phải), row 0..9 (trên -> dưới).
// Hàng 0 là phía quân Đen, hàng 9 là phía quân Đỏ. Đỏ đi trước.

export const SIDE = Object.freeze({ RED: 'red', BLACK: 'black' });

export const TYPE = Object.freeze({
  GENERAL: 'general',
  ADVISOR: 'advisor',
  ELEPHANT: 'elephant',
  HORSE: 'horse',
  CHARIOT: 'chariot',
  CANNON: 'cannon',
  SOLDIER: 'soldier',
});

const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

// Bàn cờ nội bộ: Map<số nguyên (row * 9 + col), quân cờ>
export const toIndex = (col, row) => row * 9 + col;
export const toPos = (i) => ({ col: i % 9, row: Math.floor(i / 9) });
export const opposite = (side) => (side === SIDE.RED ? SIDE.BLACK : SIDE.RED);
export const inBoard = (c, r) => c >= 0 && c <= 8 && r >= 0 && r <= 9;

/** Cung tướng: cột 3..5; Đỏ hàng 7..9, Đen hàng 0..2. */
const inPalace = (side, c, r) => {
  if (c < 3 || c > 5) return false;
  return side === SIDE.RED ? r >= 7 && r <= 9 : r >= 0 && r <= 2;
};

/** Nửa bàn cờ của mỗi bên (Tượng không được qua sông). */
const ownHalf = (side, r) => (side === SIDE.RED ? r >= 5 : r <= 4);

/** Tạo thế khai cuộc 32 quân. ID quân giống client: `${side}_${type}_${index}`. */
export function createInitialBoard() {
  const board = new Map();
  const back = [
    TYPE.CHARIOT, TYPE.HORSE, TYPE.ELEPHANT, TYPE.ADVISOR, TYPE.GENERAL,
    TYPE.ADVISOR, TYPE.ELEPHANT, TYPE.HORSE, TYPE.CHARIOT,
  ];
  for (const side of [SIDE.BLACK, SIDE.RED]) {
    const isBlack = side === SIDE.BLACK;
    const backRow = isBlack ? 0 : 9;
    const cannonRow = isBlack ? 2 : 7;
    const soldierRow = isBlack ? 3 : 6;
    const put = (col, row, type, index) =>
      board.set(toIndex(col, row), { id: `${side}_${type}_${index}`, side, type, index });

    const seen = {};
    back.forEach((type, col) => {
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

/** Dựng bàn cờ từ danh sách [col, row, side, type, index?] (dùng cho test). */
export function boardFrom(list) {
  const board = new Map();
  list.forEach(([col, row, side, type, index = 0]) => {
    board.set(toIndex(col, row), { id: `${side}_${type}_${index}`, side, type, index });
  });
  return board;
}

/** Chuyển bàn cờ sang JSON gửi cho client. */
export function serializeBoard(board) {
  return [...board.entries()].map(([i, p]) => ({
    id: p.id,
    type: p.type,
    side: p.side,
    index: p.index,
    ...toPos(i),
  }));
}

/** Nước đi "giả hợp lệ": đúng cách đi của quân, CHƯA xét việc bị chiếu. */
export function pseudoMoves(board, from) {
  const piece = board.get(from);
  if (!piece) return [];
  const { side, type } = piece;
  const fc = from % 9;
  const fr = Math.floor(from / 9);
  const out = [];

  // Thêm ô đích nếu trong bàn và không có quân mình.
  const tryAdd = (c, r) => {
    if (!inBoard(c, r)) return;
    const i = toIndex(c, r);
    const target = board.get(i);
    if (!target || target.side !== side) out.push(i);
  };

  switch (type) {
    case TYPE.GENERAL:
      // Tướng: 1 bước ngang/dọc, trong cung.
      for (const [dc, dr] of ORTH) {
        if (inPalace(side, fc + dc, fr + dr)) tryAdd(fc + dc, fr + dr);
      }
      break;

    case TYPE.ADVISOR:
      // Sĩ: 1 bước chéo, trong cung.
      for (const [dc, dr] of DIAG) {
        if (inPalace(side, fc + dc, fr + dr)) tryAdd(fc + dc, fr + dr);
      }
      break;

    case TYPE.ELEPHANT:
      // Tượng: 2 bước chéo, không qua sông, không bị cản mắt tượng.
      for (const [dc, dr] of DIAG) {
        const c = fc + 2 * dc;
        const r = fr + 2 * dr;
        if (!inBoard(c, r) || !ownHalf(side, r)) continue;
        if (board.has(toIndex(fc + dc, fr + dr))) continue;
        tryAdd(c, r);
      }
      break;

    case TYPE.HORSE:
      // Mã: đi chữ L, bị cản nếu có quân ở "chân mã".
      for (const [dc, dr] of ORTH) {
        const lc = fc + dc;
        const lr = fr + dr;
        if (!inBoard(lc, lr) || board.has(toIndex(lc, lr))) continue;
        if (dc !== 0) {
          tryAdd(fc + 2 * dc, fr + 1);
          tryAdd(fc + 2 * dc, fr - 1);
        } else {
          tryAdd(fc + 1, fr + 2 * dr);
          tryAdd(fc - 1, fr + 2 * dr);
        }
      }
      break;

    case TYPE.CHARIOT:
      // Xe: chạy thẳng, dừng ở quân đầu tiên (ăn nếu là quân địch).
      for (const [dc, dr] of ORTH) {
        let c = fc + dc;
        let r = fr + dr;
        while (inBoard(c, r)) {
          const i = toIndex(c, r);
          const t = board.get(i);
          if (!t) {
            out.push(i);
          } else {
            if (t.side !== side) out.push(i);
            break;
          }
          c += dc;
          r += dr;
        }
      }
      break;

    case TYPE.CANNON:
      // Pháo: đi như Xe khi không ăn; ăn phải nhảy qua đúng 1 quân (ngòi).
      for (const [dc, dr] of ORTH) {
        let c = fc + dc;
        let r = fr + dr;
        let hasScreen = false;
        while (inBoard(c, r)) {
          const i = toIndex(c, r);
          const t = board.get(i);
          if (!hasScreen) {
            if (!t) out.push(i);
            else hasScreen = true;
          } else if (t) {
            if (t.side !== side) out.push(i);
            break;
          }
          c += dc;
          r += dr;
        }
      }
      break;

    case TYPE.SOLDIER: {
      // Tốt: tiến 1 bước; qua sông thì được đi ngang. Không đi lùi.
      const forward = side === SIDE.RED ? -1 : 1;
      tryAdd(fc, fr + forward);
      const crossed = side === SIDE.RED ? fr <= 4 : fr >= 5;
      if (crossed) {
        tryAdd(fc - 1, fr);
        tryAdd(fc + 1, fr);
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/** Vị trí Tướng của [side], hoặc -1 nếu không còn. */
export function findGeneral(board, side) {
  for (const [i, p] of board) {
    if (p.type === TYPE.GENERAL && p.side === side) return i;
  }
  return -1;
}

/** Hai Tướng đối mặt nhau trên cùng một cột, không có quân nào ở giữa. */
export function generalsFacing(board) {
  const red = findGeneral(board, SIDE.RED);
  const black = findGeneral(board, SIDE.BLACK);
  if (red < 0 || black < 0) return false;
  const col = red % 9;
  if (col !== black % 9) return false;
  const rr = Math.floor(red / 9);
  const br = Math.floor(black / 9);
  for (let r = Math.min(rr, br) + 1; r < Math.max(rr, br); r++) {
    if (board.has(toIndex(col, r))) return false;
  }
  return true;
}

/** Bên [side] đang bị chiếu (hoặc hai Tướng đang đối mặt) không? */
export function isInCheck(board, side) {
  const general = findGeneral(board, side);
  if (general < 0) return true; // mất Tướng
  if (generalsFacing(board)) return true;
  for (const [i, p] of board) {
    if (p.side === side) continue;
    if (pseudoMoves(board, i).includes(general)) return true;
  }
  return false;
}

/** Nước đi HỢP LỆ từ [from]: không để Tướng mình bị chiếu (kể cả lộ mặt Tướng). */
export function legalMoves(board, from) {
  const piece = board.get(from);
  if (!piece) return [];
  const result = [];
  for (const to of pseudoMoves(board, from)) {
    const next = new Map(board);
    next.delete(from);
    next.set(to, piece);
    if (!isInCheck(next, piece.side)) result.push(to);
  }
  return result;
}

export function hasAnyLegalMove(board, side) {
  for (const [i, p] of [...board]) {
    if (p.side === side && legalMoves(board, i).length > 0) return true;
  }
  return false;
}

const KEY_CHAR = {
  [TYPE.GENERAL]: 'k', [TYPE.ADVISOR]: 'a', [TYPE.ELEPHANT]: 'b', [TYPE.HORSE]: 'n',
  [TYPE.CHARIOT]: 'r', [TYPE.CANNON]: 'c', [TYPE.SOLDIER]: 'p',
};

/**
 * Khoá nhận diện một thế cờ để phát hiện lặp nước: gồm vị trí các quân (chỉ loại quân + phe,
 * KHÔNG phân biệt quân giống nhau) và bên đến lượt. Quân Đỏ viết hoa, quân Đen viết thường.
 * Định dạng giống hệt hàm positionKey trong xiangqi_engine.dart.
 */
export function positionKey(board, turn) {
  const rows = [];
  for (let r = 0; r < 10; r++) {
    let row = '';
    for (let c = 0; c < 9; c++) {
      const p = board.get(toIndex(c, r));
      if (!p) {
        row += '.';
      } else {
        const ch = KEY_CHAR[p.type];
        row += p.side === SIDE.RED ? ch.toUpperCase() : ch;
      }
    }
    rows.push(row);
  }
  return `${rows.join('/')} ${turn === SIDE.RED ? 'r' : 'b'}`;
}

/**
 * Phán quyết khi một thế cờ lặp đến lần thứ 3.
 * [cycle]: các nước trong đoạn lặp, dạng [{ side, givesCheck }], từ lần xuất hiện đầu tiên
 * của thế cờ đó đến nước vừa đi.
 *  - Đúng một bên CHIẾU Ở MỌI NƯỚC của mình trong đoạn lặp: bên đó phạm luật chiếu liên tục -> THUA.
 *  - Cả hai bên cùng chiếu liên tục, hoặc không bên nào: HOÀ do lặp nước.
 * (Luật "đuổi quân liên tục" chưa được áp dụng.)
 */
export function judgeRepetition(cycle) {
  const seen = { red: false, black: false };
  const allCheck = { red: true, black: true };
  for (const m of cycle) {
    seen[m.side] = true;
    if (!m.givesCheck) allCheck[m.side] = false;
  }
  const redPerpetual = seen.red && allCheck.red;
  const blackPerpetual = seen.black && allCheck.black;
  if (redPerpetual && !blackPerpetual) return { result: SIDE.BLACK, reason: 'perpetual_check' };
  if (blackPerpetual && !redPerpetual) return { result: SIDE.RED, reason: 'perpetual_check' };
  return { result: 'draw', reason: 'repetition' };
}

/** Hoà nếu 60 nước mỗi bên (120 nước tính cả hai bên) liên tiếp không ai ăn quân. */
export const NO_CAPTURE_LIMIT_PLIES = 120;

/**
 * Một ván cờ: giữ bàn cờ, lượt đi, lịch sử và kết quả.
 * result: 'ongoing' | 'red' | 'black' | 'draw'  (red/black = bên THẮNG)
 * endReason: null | 'checkmate' | 'stalemate' | 'repetition' | 'perpetual_check' | 'no_capture'
 *            | 'resign' | 'disconnect' | 'agreement' | 'timeout'
 * Bên hết nước đi hợp lệ là bên THUA (dù có đang bị chiếu hay không).
 */
export class XiangqiGame {
  constructor({ board = createInitialBoard(), turn = SIDE.RED } = {}) {
    this.board = new Map(board);
    this.turn = turn;
    this.history = [];
    this.result = 'ongoing';
    this.endReason = null;
    this.isCheck = false;
    // Theo dõi các thế cờ đã qua để phát hiện lặp nước (keys[k] = thế cờ sau k nước).
    this.keys = [positionKey(this.board, this.turn)];
    this.counts = new Map([[this.keys[0], 1]]);
    this._refresh();
  }

  /** Số lần thế cờ hiện tại đã xuất hiện (1 = lần đầu). Đến lần 3 ván kết thúc. */
  get repetitionCount() {
    return this.counts.get(this.keys[this.keys.length - 1]) ?? 1;
  }

  /** Số nước (tính cả hai bên) liên tiếp gần nhất không có quân nào bị ăn. */
  get pliesSinceCapture() {
    let n = 0;
    for (let i = this.history.length - 1; i >= 0 && !this.history[i].captured; i--) n++;
    return n;
  }

  get isOver() {
    return this.result !== 'ongoing';
  }

  static _index(pos) {
    if (!pos || !Number.isInteger(pos.col) || !Number.isInteger(pos.row)) return -1;
    return inBoard(pos.col, pos.row) ? toIndex(pos.col, pos.row) : -1;
  }

  /** Các ô đến hợp lệ của quân tại [from] (rỗng nếu không phải quân đến lượt). */
  legalMovesFrom(from) {
    if (this.isOver) return [];
    const fi = XiangqiGame._index(from);
    const piece = this.board.get(fi);
    if (!piece || piece.side !== this.turn) return [];
    return legalMoves(this.board, fi).map(toPos);
  }

  /** Toàn bộ nước đi hợp lệ của bên đang đến lượt. */
  allLegalMoves() {
    if (this.isOver) return [];
    const moves = [];
    for (const [i, p] of [...this.board]) {
      if (p.side !== this.turn) continue;
      for (const to of legalMoves(this.board, i)) {
        moves.push({ from: toPos(i), to: toPos(to) });
      }
    }
    return moves;
  }

  isLegal(from, to) {
    const ti = XiangqiGame._index(to);
    if (ti < 0) return false;
    return this.legalMovesFrom(from).some((p) => toIndex(p.col, p.row) === ti);
  }

  /** Đi một nước. Trả về bản ghi nước đi, hoặc null nếu không hợp lệ. */
  play(from, to) {
    if (!this.isLegal(from, to)) return null;
    const fi = XiangqiGame._index(from);
    const ti = XiangqiGame._index(to);
    const piece = this.board.get(fi);
    const captured = this.board.get(ti) ?? null;
    this.board.delete(fi);
    this.board.set(ti, piece);
    this.turn = opposite(this.turn);
    this._refresh();
    const record = { from: toPos(fi), to: toPos(ti), piece, captured, givesCheck: this.isCheck };
    this.history.push(record);

    // Lặp nước / chiếu liên tục (chỉ xét khi ván chưa kết thúc bằng chiếu bí/hết nước đi).
    const key = positionKey(this.board, this.turn);
    this.keys.push(key);
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (!this.isOver && n >= 3) {
      const first = this.keys.indexOf(key); // lần xuất hiện đầu tiên
      const cycle = this.history
        .slice(first)
        .map((r) => ({ side: r.piece.side, givesCheck: r.givesCheck }));
      const verdict = judgeRepetition(cycle);
      this.forceEnd(verdict.result, verdict.reason);
    }
    if (!this.isOver && this.pliesSinceCapture >= NO_CAPTURE_LIMIT_PLIES) {
      this.forceEnd('draw', 'no_capture');
    }
    return record;
  }

  /** Hoàn tác nước đi gần nhất. Trả về false nếu chưa có nước nào. */
  undo() {
    const last = this.history.pop();
    if (!last) return false;
    const key = this.keys.pop();
    const left = (this.counts.get(key) ?? 1) - 1;
    if (left <= 0) this.counts.delete(key);
    else this.counts.set(key, left);
    const fi = toIndex(last.from.col, last.from.row);
    const ti = toIndex(last.to.col, last.to.row);
    this.board.delete(ti);
    this.board.set(fi, last.piece);
    if (last.captured) this.board.set(ti, last.captured);
    this.turn = opposite(this.turn);
    this._refresh();
    return true;
  }

  /** Kết thúc ván bằng lý do ngoài bàn cờ (đầu hàng, mất kết nối, hoà...). */
  forceEnd(result, reason) {
    this.result = result;
    this.endReason = reason;
  }

  _refresh() {
    this.isCheck = isInCheck(this.board, this.turn);
    if (hasAnyLegalMove(this.board, this.turn)) {
      this.result = 'ongoing';
      this.endReason = null;
    } else {
      this.result = opposite(this.turn);
      this.endReason = this.isCheck ? 'checkmate' : 'stalemate';
    }
  }
}
