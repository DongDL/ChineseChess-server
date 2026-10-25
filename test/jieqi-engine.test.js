import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  HmacRandom, Mulberry32, XiangqiGame, boardFrom, createJieqiInitialBoard,
  createSecureJieqiInitialBoard, jieqiStartingSlots,
  pseudoMoves, toIndex, toPos,
} from '../src/engine.js';

const fixtureUrl = new URL('./fixtures/jieqi_engine_vectors.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const canonicalHash = createHash('sha256').update(JSON.stringify(fixture)).digest('hex');

test('fixture Jieqi server có đúng contract/hash dùng chung', () => {
  assert.equal(canonicalHash, 'f56dd968a57d4af0c7c81b25cf7f58a183d4d1dfc826fbe29c9a454054ff88d3');
  assert.equal(fixture.variant, 'jieqi');
});

test('Mulberry32 khớp mọi vector Dart', () => {
  for (const vector of fixture.prngVectors) {
    const random = new Mulberry32(vector.seed);
    assert.deepEqual(vector.uint32.map(() => random.nextUint32()), vector.uint32, `seed ${vector.seed}`);
  }
});

test('shuffle online dùng seed HMAC 128-bit, tất định nhưng không thu về uint32', () => {
  const a = '00112233445566778899aabbccddeeff';
  const b = '00112233445566778899aabbccddee00';
  const signature = (board) => [...board.values()].map((p) => `${p.id}:${p.type}`);
  assert.deepEqual(signature(createSecureJieqiInitialBoard(a)), signature(createSecureJieqiInitialBoard(a)));
  assert.notDeepEqual(signature(createSecureJieqiInitialBoard(a)), signature(createSecureJieqiInitialBoard(b)));
  assert.equal(new HmacRandom(a).nextUint32(), new HmacRandom(a).nextUint32());
  assert.throws(() => createSecureJieqiInitialBoard('123'), RangeError);
});

test('khởi tạo Cờ Úp khớp permutation, vai và opaque ID Dart', () => {
  for (const vector of fixture.initialPositionVectors) {
    const board = createJieqiInitialBoard(vector.seed);
    assert.equal(board.size, 32);
    for (const [side, expected, prefix] of [['black', vector.blackTypesBySlot, 'b'], ['red', vector.redTypesBySlot, 'r']]) {
      const slots = jieqiStartingSlots(side);
      assert.deepEqual(slots.map((p) => board.get(toIndex(p.col, p.row)).type), expected);
      slots.forEach((p, i) => {
        const piece = board.get(toIndex(p.col, p.row));
        assert.equal(piece.id, `jq-${prefix}-${String(i).padStart(2, '0')}`);
        assert.equal(piece.faceDown, true);
        assert.equal(piece.id.includes(piece.type), false);
      });
      const general = board.get(toIndex(4, side === 'black' ? 0 : 9));
      assert.deepEqual([general.id, general.type, general.faceDown], [`jq-${prefix}-15`, 'general', false]);
    }
  }
});

test('sinh nước dùng role khi úp và type thật sau lật', () => {
  for (const vector of fixture.ruleVectors) {
    const entries = [{ at: vector.from, ...vector.piece }, ...vector.occupied];
    const board = boardFrom(entries);
    const actual = pseudoMoves(board, toIndex(...vector.from)).map((i) => {
      const p = toPos(i); return [p.col, p.row];
    });
    if (vector.expectedPseudo) assert.deepEqual(actual, vector.expectedPseudo, vector.name);
    for (const excluded of vector.expectedExcluded ?? []) assert.equal(actual.some((p) => p[0] === excluded[0] && p[1] === excluded[1]), false);
  }
});

test('reveal/capture/check/undo khớp game vectors Dart', () => {
  for (const vector of fixture.gameVectors) {
    const game = new XiangqiGame({ board: boardFrom(vector.board), turn: vector.turn, variant: 'jieqi' });
    const [from, to] = vector.move.map(([col, row]) => ({ col, row }));
    assert.equal(game.isLegal(from, to), vector.expected.legal, vector.name);
    if (!vector.expected.legal) continue;
    const record = game.play(from, to);
    assert.equal(record.revealed, vector.expected.revealed);
    assert.equal(record.givesCheck, vector.expected.givesCheck ?? record.givesCheck);
    assert.equal(game.isCheck, vector.expected.isCheck ?? game.isCheck);
    assert.equal(game.board.get(toIndex(to.col, to.row)).faceDown, vector.expected.faceDownAtTo);
    assert.equal(game.repetitionCount, vector.expected.repetition);
    if (vector.expected.capturedType) assert.equal(record.captured.type, vector.expected.capturedType);
    if ('capturedWasFaceDown' in vector.expected) assert.equal(record.capturedWasFaceDown, vector.expected.capturedWasFaceDown);
    assert.equal(game.undo(), vector.expected.undo);
    assert.equal(game.board.get(toIndex(from.col, from.row)).faceDown, vector.expected.faceDownAtFromAfterUndo);
    if (vector.expected.capturedRestoredFaceDown) assert.equal(game.board.get(toIndex(to.col, to.row)).faceDown, true);
  }
});

test('chuỗi Xiangqi trong fixture không hồi quy', () => {
  const vector = fixture.sequenceVectors[0];
  const game = new XiangqiGame();
  for (const [from, to] of vector.moves) game.play({ col: from[0], row: from[1] }, { col: to[0], row: to[1] });
  assert.equal(game.result, vector.expected.result);
  assert.equal(game.endReason, vector.expected.endReason);
  assert.equal(game.repetitionCount, vector.expected.repetition);
});
