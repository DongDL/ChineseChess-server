import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { MemoryStore } from '../src/stores/memory.js';

const moves = (variant) => variant === 'jieqi' ? [
  {
    from: { col: 0, row: 6 }, to: { col: 0, row: 3 },
    pieceId: 'jq-r-10', moverSide: 'red', capturedId: 'jq-b-10',
    capturedType: 'cannon', capturedWasFaceDown: true, revealedPiece: 'horse',
    givesCheck: false, elapsedMs: 100,
  },
  {
    from: { col: 2, row: 3 }, to: { col: 2, row: 6 },
    pieceId: 'jq-b-11', moverSide: 'black', capturedId: 'jq-r-11',
    capturedType: 'elephant', capturedWasFaceDown: true, revealedPiece: 'advisor',
    givesCheck: false, elapsedMs: 200,
  },
  {
    from: { col: 0, row: 3 }, to: { col: 2, row: 3 },
    pieceId: 'jq-r-10', moverSide: 'red', capturedId: 'jq-b-11',
    capturedType: 'advisor', capturedWasFaceDown: false, revealedPiece: null,
    givesCheck: false, elapsedMs: 300,
  },
] : Array.from({ length: 6 }, (_, i) => ({
  from: { col: i % 2, row: 7 }, to: { col: i % 2, row: 6 },
  pieceId: `red_soldier_${i}`,
  capturedId: null, capturedType: null, capturedWasFaceDown: false,
  revealedPiece: null, givesCheck: false, elapsedMs: i * 100,
}));

const game = (red, black, variant, result, endedAt) => ({
  id: randomUUID(), roomId: 'JQAPI1', variant,
  seed: variant === 'jieqi' ? 305419896 : null,
  seedHash: variant === 'jieqi' ? 'a'.repeat(64) : null,
  red: { userId: red.id, name: red.displayName, guest: false },
  black: { userId: black.id, name: black.displayName, guest: false },
  timeControl: null, result, endReason: 'resign', moves: moves(variant), clock: null,
  startedAt: endedAt - 1000, endedAt,
});

const has = (o, key) => Object.prototype.hasOwnProperty.call(o, key);

test('store/API tách Elo và replay Jieqi phân quyền từng nước ăn', async () => {
  const store = new MemoryStore({ ratedMinMoves: 3 });
  const auth = new AuthService({ store, scryptParams: { N: 1024, r: 8, p: 1 }, log: { error() {} } });
  const app = createApp({ store, authService: auth });
  await new Promise((resolve) => app.httpServer.listen(0, resolve));
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;
  try {
    const aSession = await auth.register({ username: 'jq_api_a', password: 'mat-khau-123', displayName: 'An' }, '127.0.0.1');
    const bSession = await auth.register({ username: 'jq_api_b', password: 'mat-khau-123', displayName: 'Bình' }, '127.0.0.1');
    const xSession = await auth.register({ username: 'jq_api_x', password: 'mat-khau-123', displayName: 'Ngoài' }, '127.0.0.1');
    const a = await store.findUserById(aSession.user.id); const b = await store.findUserById(bSession.user.id);
    const xiangqi = game(a, b, 'xiangqi', 'black', 1_700_000_001_000);
    const jieqi = game(a, b, 'jieqi', 'red', 1_700_000_002_000);
    await store.saveGame(xiangqi);
    await store.saveGame(jieqi);

    const internal = await store.getGame(jieqi.id);
    assert.equal(internal.seed, 305419896);
    assert.equal(internal.seedHash, 'a'.repeat(64));
    assert.equal(internal.moves[0].capturedType, 'cannon');

    assert.equal((await store.getRating(a.id)).rating, 1480);
    assert.equal((await store.getRating(a.id, 'jieqi')).rating, 1520);
    assert.equal((await store.listLeaderboard({ variant: 'xiangqi' }))[0].userId, b.id);
    assert.equal((await store.listLeaderboard({ variant: 'jieqi' }))[0].userId, a.id);
    assert.deepEqual((await store.listGamesOfUser(a.id)).map((g) => g.variant), ['xiangqi']);
    assert.deepEqual((await store.listGamesOfUser(a.id, { variant: 'jieqi' })).map((g) => g.variant), ['jieqi']);

    const get = async (path, token = aSession.token) => {
      const headers = token === null ? {} : { authorization: `Bearer ${token}` };
      const response = await fetch(base + path, { headers });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await get('/me/rating')).body.variant, 'xiangqi');
    assert.equal((await get('/me/rating?variant=jieqi')).body.rating.rating, 1520);
    assert.deepEqual((await get('/me/games?variant=jieqi')).body.games.map((g) => g.variant), ['jieqi']);
    assert.deepEqual((await get('/me/stats?variant=jieqi')).body.stats, { total: 1, wins: 1, losses: 0, draws: 0 });
    assert.equal((await get('/leaderboard?variant=jieqi')).body.players[0].displayName, 'An');
    assert.equal((await get('/leaderboard?variant=banqi')).status, 400);

    const replay = async (token) => (await get(`/games/${jieqi.id}`, token)).body.game;
    const publicGame = await replay(null);
    const invalidGame = await replay('invalid-token');
    const outsiderGame = await replay(xSession.token);
    const redGame = await replay(aSession.token);
    const blackGame = await replay(bSession.token);

    for (const detail of [publicGame, invalidGame, outsiderGame, redGame, blackGame]) {
      assert.equal(detail.variant, 'jieqi');
      assert.equal(has(detail, 'seed'), false);
      assert.equal(has(detail, 'seedHash'), false);
      assert.equal(has(detail.moves[0], 'moverSide'), false);
      assert.equal(detail.moves[2].capturedType, 'advisor', 'quân đã ngửa là công khai');
      assert.equal(JSON.stringify(detail).includes(a.id), false);
      assert.equal(JSON.stringify(detail).includes(b.id), false);
    }
    for (const detail of [publicGame, invalidGame, outsiderGame]) {
      assert.equal(has(detail.moves[0], 'capturedType'), false);
      assert.equal(has(detail.moves[1], 'capturedType'), false);
    }
    assert.equal(redGame.moves[0].capturedType, 'cannon');
    assert.equal(has(redGame.moves[1], 'capturedType'), false);
    assert.equal(has(blackGame.moves[0], 'capturedType'), false);
    assert.equal(blackGame.moves[1].capturedType, 'elephant');
    assert.equal(publicGame.moves[0].revealedPiece, 'horse');
  } finally {
    await app.close();
    await store.close();
  }
});
