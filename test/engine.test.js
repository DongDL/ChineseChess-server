import test from 'node:test';
import assert from 'node:assert/strict';
import {
  XiangqiGame, boardFrom, pseudoMoves, toIndex, toPos, SIDE, TYPE,
  positionKey, judgeRepetition,
} from '../src/engine.js';

const { RED, BLACK } = SIDE;

/** Đếm số nước đi hợp lệ ở độ sâu [depth] (perft) — kiểm tra tổng thể bộ luật. */
function perft(game, depth) {
  const moves = game.allLegalMoves();
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) {
    game.play(m.from, m.to);
    n += perft(game, depth - 1);
    game.undo();
  }
  return n;
}

test('khai cuộc có đủ 32 quân, Đỏ đi trước, chưa bị chiếu', () => {
  const g = new XiangqiGame();
  assert.equal(g.board.size, 32);
  assert.equal(g.turn, RED);
  assert.equal(g.isCheck, false);
  assert.equal(g.result, 'ongoing');
});

test('ID quân khớp quy ước client (side_type_index)', () => {
  const g = new XiangqiGame();
  const ids = new Set([...g.board.values()].map((p) => p.id));
  assert.equal(ids.size, 32);
  for (const id of ['red_general_0', 'black_chariot_1', 'red_soldier_4', 'black_cannon_1']) {
    assert.ok(ids.has(id), id);
  }
});

test('perft từ thế khai cuộc khớp số chuẩn: 44 / 1920 / 79666', () => {
  const g = new XiangqiGame();
  assert.equal(perft(g, 1), 44);
  assert.equal(perft(g, 2), 1920);
  assert.equal(perft(g, 3), 79666);
  assert.equal(g.history.length, 0); // undo trả bàn cờ về nguyên trạng
});

test('hai Tướng không được đối mặt: Xe ở giữa chỉ đi dọc cột', () => {
  const g = new XiangqiGame({
    board: boardFrom([
      [4, 9, RED, TYPE.GENERAL],
      [4, 0, BLACK, TYPE.GENERAL],
      [4, 5, RED, TYPE.CHARIOT],
    ]),
  });
  const moves = g.legalMovesFrom({ col: 4, row: 5 });
  assert.ok(moves.length > 0);
  assert.ok(moves.every((m) => m.col === 4));
});

test('chiếu bí bằng 2 Xe', () => {
  const g = new XiangqiGame({
    board: boardFrom([
      [3, 9, RED, TYPE.GENERAL],
      [4, 0, BLACK, TYPE.GENERAL],
      [0, 1, RED, TYPE.CHARIOT, 0],
      [8, 0, RED, TYPE.CHARIOT, 1],
    ]),
    turn: BLACK,
  });
  assert.equal(g.isCheck, true);
  assert.equal(g.result, RED);
  assert.equal(g.endReason, 'checkmate');
});

test('hết nước đi (không bị chiếu) vẫn thua', () => {
  const g = new XiangqiGame({
    board: boardFrom([
      [5, 9, RED, TYPE.GENERAL],
      [3, 0, BLACK, TYPE.GENERAL],
      [4, 9, RED, TYPE.CHARIOT, 0],
      [8, 1, RED, TYPE.CHARIOT, 1],
    ]),
    turn: BLACK,
  });
  assert.equal(g.isCheck, false);
  assert.equal(g.result, RED);
  assert.equal(g.endReason, 'stalemate');
});

test('Mã bị cản chân, Tượng không qua sông, Tốt chưa qua sông không đi ngang', () => {
  const horse = boardFrom([
    [4, 9, RED, TYPE.GENERAL],
    [3, 0, BLACK, TYPE.GENERAL],
    [4, 5, RED, TYPE.HORSE],
    [4, 4, BLACK, TYPE.SOLDIER],
  ]);
  const hm = pseudoMoves(horse, toIndex(4, 5)).map(toPos);
  assert.ok(!hm.some((p) => p.col === 3 && p.row === 3));
  assert.ok(!hm.some((p) => p.col === 5 && p.row === 3));

  const elephant = boardFrom([[2, 5, RED, TYPE.ELEPHANT]]);
  assert.ok(pseudoMoves(elephant, toIndex(2, 5)).map(toPos).every((p) => p.row >= 5));

  const soldier = boardFrom([[4, 6, RED, TYPE.SOLDIER]]);
  assert.deepEqual(pseudoMoves(soldier, toIndex(4, 6)).map(toPos), [{ col: 4, row: 5 }]);
});

test('Pháo cần đúng 1 ngòi để ăn quân', () => {
  const board = boardFrom([
    [4, 9, RED, TYPE.GENERAL],
    [3, 0, BLACK, TYPE.GENERAL],
    [1, 7, RED, TYPE.CANNON],
    [1, 5, BLACK, TYPE.SOLDIER, 0], // ngòi
    [1, 2, BLACK, TYPE.HORSE],      // quân bị ăn
  ]);
  const m = pseudoMoves(board, toIndex(1, 7)).map(toPos);
  assert.ok(m.some((p) => p.col === 1 && p.row === 2), 'ăn được Mã qua ngòi');
  assert.ok(!m.some((p) => p.col === 1 && p.row === 3), 'không đi vào ô trống sau ngòi');
});

test('nước đi sai bị từ chối, undo hoàn tác đúng', () => {
  const g = new XiangqiGame();
  // Xe đỏ (0,9) không thể nhảy qua Tốt của mình
  assert.equal(g.play({ col: 0, row: 9 }, { col: 0, row: 3 }), null);
  // Pháo đỏ (1,7) -> (4,7) hợp lệ
  assert.ok(g.play({ col: 1, row: 7 }, { col: 4, row: 7 }));
  assert.equal(g.turn, BLACK);
  assert.equal(g.undo(), true);
  assert.equal(g.turn, RED);
  assert.equal(g.board.size, 32);
});

test('dữ liệu toạ độ rác không làm engine văng lỗi', () => {
  const g = new XiangqiGame();
  for (const bad of [null, undefined, {}, { col: 'a', row: 1 }, { col: 99, row: 0 }, { col: 1.5, row: 2 }]) {
    assert.equal(g.play(bad, { col: 0, row: 0 }), null);
    assert.equal(g.play({ col: 0, row: 9 }, bad), null);
    assert.deepEqual(g.legalMovesFrom(bad), []);
  }
});

// ------------------------------------------------- lặp nước / chiếu liên tục

const P = (col, row) => ({ col, row });
const move = (g, [fc, fr], [tc, tr]) => {
  const rec = g.play(P(fc, fr), P(tc, tr));
  assert.ok(rec, `nước đi phải hợp lệ: ${fc},${fr} -> ${tc},${tr}`);
  return rec;
};

// Các chuỗi này cũng được kiểm tra y hệt trong test Dart (xiangqi_engine_test.dart)
const KEY_START =
  'rnbakabnr/........./.c.....c./p.p.p.p.p/........./........./P.P.P.P.P/.C.....C./........./RNBAKABNR r';
const KEY_AFTER_HORSE =
  'rnbakabnr/........./.c.....c./p.p.p.p.p/........./........./P.P.P.P.P/.CN....C./........./R.BAKABNR b';

// Hai bên cùng đưa Mã đi ra rồi về: sau 4 nước thế cờ quay lại như cũ
const HORSE_CYCLE = [
  [[1, 9], [2, 7]],
  [[1, 0], [2, 2]],
  [[2, 7], [1, 9]],
  [[2, 2], [1, 0]],
];

// Xe Đỏ chiếu Tướng Đen liên tục: Xe (8,1)<->(8,0), Tướng Đen (4,0)<->(4,1)
const PERPETUAL_CYCLE = [
  [[8, 1], [8, 0]],
  [[4, 0], [4, 1]],
  [[8, 0], [8, 1]],
  [[4, 1], [4, 0]],
];

const perpetualBoard = () =>
  boardFrom([
    [3, 9, RED, TYPE.GENERAL],
    [4, 0, BLACK, TYPE.GENERAL],
    [8, 1, RED, TYPE.CHARIOT],
  ]);

test('khoá thế cờ (positionKey) có định dạng cố định, gồm cả bên đến lượt', () => {
  const g = new XiangqiGame();
  assert.equal(positionKey(g.board, g.turn), KEY_START);
  move(g, [1, 9], [2, 7]);
  assert.equal(positionKey(g.board, g.turn), KEY_AFTER_HORSE);
});

test('thế cờ lặp lần 3 thì hoà (lặp nước), chưa đến lần 3 thì chưa kết thúc', () => {
  const g = new XiangqiGame();
  for (let i = 0; i < 7; i++) {
    move(g, ...HORSE_CYCLE[i % 4]);
    assert.equal(g.isOver, false, `chưa được kết thúc ở nước ${i + 1}`);
  }
  assert.equal(g.repetitionCount, 2);
  move(g, ...HORSE_CYCLE[3]);
  assert.equal(g.repetitionCount, 3);
  assert.equal(g.result, 'draw');
  assert.equal(g.endReason, 'repetition');
  // Ván đã kết thúc: không đi tiếp được
  assert.equal(g.play(P(0, 9), P(0, 8)), null);
});

test('chiếu liên tục: bên chiếu ở mọi nước bị xử THUA', () => {
  const g = new XiangqiGame({ board: perpetualBoard() });
  const checks = [];
  for (let i = 0; i < 8; i++) checks.push(move(g, ...PERPETUAL_CYCLE[i % 4]).givesCheck);
  // Đỏ (nước lẻ) nào cũng chiếu, Đen (nước chẵn) thì không
  assert.deepEqual(checks, [true, false, true, false, true, false, true, false]);
  assert.equal(g.result, BLACK);
  assert.equal(g.endReason, 'perpetual_check');
});

test('undo sau khi ván kết thúc do lặp nước: ván tiếp tục và bộ đếm lặp được hoàn lại', () => {
  const g = new XiangqiGame();
  for (let i = 0; i < 8; i++) move(g, ...HORSE_CYCLE[i % 4]);
  assert.equal(g.isOver, true);
  assert.equal(g.undo(), true);
  assert.equal(g.isOver, false);
  assert.equal(g.repetitionCount, 2);
  assert.equal(g.keys.length, g.history.length + 1);
  // Đi lại nước đó thì lại hoà như cũ
  move(g, ...HORSE_CYCLE[3]);
  assert.equal(g.endReason, 'repetition');
});

test('cùng vị trí nhưng khác bên đến lượt thì KHÔNG tính là lặp', () => {
  const board = boardFrom([
    [3, 9, RED, TYPE.GENERAL],
    [4, 0, BLACK, TYPE.GENERAL],
    [0, 5, RED, TYPE.CHARIOT],
  ]);
  assert.notEqual(positionKey(board, RED), positionKey(board, BLACK));
});

test('judgeRepetition: phán quyết theo từng trường hợp', () => {
  const c = (side, givesCheck) => ({ side, givesCheck });
  // Chỉ Đỏ chiếu liên tục -> Đen thắng
  assert.deepEqual(judgeRepetition([c('red', true), c('black', false), c('red', true), c('black', false)]),
    { result: 'black', reason: 'perpetual_check' });
  // Chỉ Đen chiếu liên tục -> Đỏ thắng
  assert.deepEqual(judgeRepetition([c('red', false), c('black', true)]),
    { result: 'red', reason: 'perpetual_check' });
  // Cả hai cùng chiếu liên tục -> hoà
  assert.deepEqual(judgeRepetition([c('red', true), c('black', true)]),
    { result: 'draw', reason: 'repetition' });
  // Không bên nào chiếu liên tục -> hoà
  assert.deepEqual(judgeRepetition([c('red', false), c('black', false)]),
    { result: 'draw', reason: 'repetition' });
  // Đỏ xen 1 nước không chiếu giữa chừng -> không phải chiếu liên tục -> hoà
  assert.deepEqual(judgeRepetition([c('red', true), c('black', false), c('red', false), c('black', false)]),
    { result: 'draw', reason: 'repetition' });
});
