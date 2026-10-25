import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/stores/memory.js';
import { XiangqiGame, boardFrom } from '../src/engine.js';
import { P, connectWith, emit, waitFor } from './helpers/sockets.js';

let app; let url; let seq = 0;
const clients = [];
const connect = () => connectWith(url, { playerId: `jieqi-player-${++seq}-xxxxxxxx`, name: `J${seq}` }, clients);

before(async () => {
  app = createApp({ store: new MemoryStore(), graceMs: 1000, gameServerOptions: { matchTickMs: 3_600_000 } });
  await new Promise((resolve) => app.httpServer.listen(0, resolve));
  url = `http://127.0.0.1:${app.httpServer.address().port}`;
});

after(async () => {
  clients.forEach((c) => c.close());
  await app.close();
});

const assertNoJieqiIndexes = (value) => {
  if (Array.isArray(value)) {
    value.forEach(assertNoJieqiIndexes);
    return;
  }
  if (!value || typeof value !== 'object') return;
  assert.equal('index' in value, false);
  Object.values(value).forEach(assertNoJieqiIndexes);
};

const assertRedactedBoard = (state) => {
  assert.equal(state.variant, 'jieqi');
  assert.equal('seed' in state, false);
  assert.equal('seedHash' in state, false);
  assertNoJieqiIndexes(state.board);
  assertNoJieqiIndexes(state.moves);
  const covered = state.board.filter((p) => p.faceDown);
  assert.equal(covered.length, 30);
  for (const p of covered) {
    assert.equal('type' in p, false);
    assert.match(p.id, /^jq-[br]-\d{2}$/);
  }
};

test('state/move/reconnect/spectator và game_over luôn giữ bí mật', async () => {
  const red = await connect(); const black = await connect(); const spectator = await connect();
  const created = await emit(red, 'jieqi:create_room', { side: 'red' });
  assert.equal(created.ok, true);
  assertRedactedBoard(created.state);
  const watched = await emit(spectator, 'jieqi:spectate', { roomId: created.roomId });
  assert.equal(watched.ok, true);
  assertRedactedBoard(watched.state);

  const redStart = waitFor(red, 'jieqi:state');
  const blackStart = waitFor(black, 'jieqi:state');
  const spectatorStart = waitFor(spectator, 'jieqi:state');
  const joined = await emit(black, 'jieqi:join_room', { roomId: created.roomId });
  assert.equal(joined.ok, true);
  const starts = await Promise.all([redStart, blackStart, spectatorStart]);
  starts.forEach(assertRedactedBoard);

  const outsider = await connect();
  assert.equal((await emit(black, 'jieqi:move', { from: P(0, 3), to: P(0, 4) })).error, 'not_your_turn');
  assert.equal((await emit(spectator, 'jieqi:move', { from: P(0, 6), to: P(0, 5) })).error, 'not_playing');
  assert.equal((await emit(outsider, 'jieqi:move', { from: P(0, 6), to: P(0, 5) })).error, 'not_playing');
  assert.equal((await emit(red, 'game:move', { from: P(0, 6), to: P(0, 5) })).error, 'wrong_variant');

  // Dùng thế fixture kiểm soát được để kiểm tra ăn quân đang úp cho đủ ba viewer.
  const room = app.gameServer.rooms.get(created.roomId);
  room.game = new XiangqiGame({ variant: 'jieqi', board: boardFrom([
    { at: [3, 9], id: 'jq-r-15', side: 'red', type: 'general', roleType: 'general', index: 0, faceDown: false },
    { at: [5, 0], id: 'jq-b-15', side: 'black', type: 'general', roleType: 'general', index: 0, faceDown: false },
    { at: [0, 5], id: 'jq-r-04', side: 'red', type: 'horse', roleType: 'chariot', index: 1, faceDown: true },
    { at: [0, 4], id: 'jq-b-10', side: 'black', type: 'cannon', roleType: 'soldier', index: 1, faceDown: true },
  ]) });

  const er = waitFor(red, 'jieqi:moved');
  const eb = waitFor(black, 'jieqi:moved');
  const es = waitFor(spectator, 'jieqi:moved');
  assert.equal((await emit(red, 'jieqi:move', { from: P(0, 5), to: P(0, 4) })).ok, true);
  const [mr, mb, ms] = await Promise.all([er, eb, es]);
  for (const m of [mr, mb, ms]) {
    assert.equal(m.revealed, 'horse');
    assert.equal(m.capturedWasFaceDown, true);
    assert.equal(m.captured.id, 'jq-b-10');
    assertNoJieqiIndexes(m);
  }
  assert.equal(mr.captured.type, 'cannon');
  assert.equal('type' in mb.captured, false);
  assert.equal('type' in ms.captured, false);

  const syncedRed = await emit(red, 'jieqi:sync', {});
  const syncedBlack = await emit(black, 'jieqi:sync', {});
  const syncedSpec = await emit(spectator, 'jieqi:sync', {});
  for (const synced of [syncedRed, syncedBlack, syncedSpec]) {
    assertNoJieqiIndexes(synced.state);
    const revealed = synced.state.board.find((p) => p.id === 'jq-r-04');
    assert.equal(revealed.faceDown, false);
    assert.equal(revealed.type, 'horse');
    assert.equal('seed' in synced.state, false);
  }
  assert.equal(syncedRed.state.moves[0].captured.type, 'cannon');
  assert.equal('type' in syncedBlack.state.moves[0].captured, false);
  assert.equal('type' in syncedSpec.state.moves[0].captured, false);

  red.disconnect();
  const red2 = await connectWith(url, { playerId: red.io.opts.auth.playerId, name: 'J reconnect red' }, clients);
  const resumedRed = await waitFor(red2, 'jieqi:state');
  assertNoJieqiIndexes(resumedRed);
  assert.equal(resumedRed.moves[0].captured.type, 'cannon');
  assert.equal(resumedRed.board.find((p) => p.id === 'jq-r-04').type, 'horse');

  black.disconnect();
  const black2 = await connectWith(url, { playerId: black.io.opts.auth.playerId, name: 'J reconnect black' }, clients);
  const resumedBlack = await waitFor(black2, 'jieqi:state');
  assertNoJieqiIndexes(resumedBlack);
  assert.equal(resumedBlack.moves.length, 1);
  assert.equal('type' in resumedBlack.moves[0].captured, false);
  assert.equal('seed' in resumedBlack, false);

  // Quân đã ngửa bị ăn: mọi viewer được thấy type nhưng không ai nhận index.
  room.game = new XiangqiGame({ variant: 'jieqi', board: boardFrom([
    { at: [3, 9], id: 'jq-r-15', side: 'red', type: 'general', roleType: 'general', index: 0, faceDown: false },
    { at: [5, 0], id: 'jq-b-15', side: 'black', type: 'general', roleType: 'general', index: 0, faceDown: false },
    { at: [0, 5], id: 'jq-r-06', side: 'red', type: 'chariot', roleType: 'chariot', index: 1, faceDown: false },
    { at: [0, 4], id: 'jq-b-06', side: 'black', type: 'chariot', roleType: 'chariot', index: 1, faceDown: false },
  ]) });
  const faceUpEvents = [waitFor(red2, 'jieqi:moved'), waitFor(black2, 'jieqi:moved'), waitFor(spectator, 'jieqi:moved')];
  assert.equal((await emit(red2, 'jieqi:move', { from: P(0, 5), to: P(0, 4) })).ok, true);
  for (const moved of await Promise.all(faceUpEvents)) {
    assert.equal(moved.captured.type, 'chariot');
    assert.equal(moved.capturedWasFaceDown, false);
    assertNoJieqiIndexes(moved);
  }

  const overRed = waitFor(red2, 'jieqi:game_over');
  const overBlack = waitFor(black2, 'jieqi:game_over');
  const overSpec = waitFor(spectator, 'jieqi:game_over');
  assert.equal((await emit(black2, 'jieqi:resign')).ok, true);
  for (const over of await Promise.all([overRed, overBlack, overSpec])) {
    assert.equal(over.variant, 'jieqi');
    assert.equal('seed' in over, false);
    assert.equal('seedHash' in over, false);
    assert.equal('board' in over, false);
  }
  await app.recorder.drain();
  const internal = await app.store.getGame(room.gameId);
  assert.match(internal.seed, /^[0-9a-f]{32}$/);
  assert.match(internal.seedHash, /^[0-9a-f]{64}$/);
  assert.equal(internal.moves[0].capturedType, 'chariot');
});

test('matchmaking cô lập Xiangqi và Jieqi', async () => {
  const x = await connect(); const j1 = await connect(); const j2 = await connect();
  assert.deepEqual(await emit(x, 'queue:join', {}), { ok: true, matched: false });
  assert.deepEqual(await emit(j1, 'jieqi:queue_join', {}), { ok: true, matched: false, variant: 'jieqi' });
  const found = waitFor(j1, 'jieqi:match_found');
  const state1 = waitFor(j1, 'jieqi:state');
  const state2 = waitFor(j2, 'jieqi:state');
  const matched = await emit(j2, 'jieqi:queue_join', {});
  assert.equal(matched.matched, true);
  assert.equal((await found).roomId, matched.roomId);
  const [a, b] = await Promise.all([state1, state2]);
  assert.equal(a.variant, 'jieqi');
  assert.equal(b.variant, 'jieqi');
  assert.equal(x.log.some((e) => e.ev === 'match:found'), false);
  await emit(x, 'queue:leave', {});
});

test('spectate cô lập namespace Xiangqi và Jieqi theo cả hai chiều', async () => {
  const jieqiHost = await connect();
  const xiangqiViewer = await connect();
  const jieqiRoom = await emit(jieqiHost, 'jieqi:create_room', { side: 'red' });
  assert.deepEqual(
    await emit(xiangqiViewer, 'room:spectate', { roomId: jieqiRoom.roomId }),
    { ok: false, error: 'wrong_variant' },
  );
  assert.equal(app.gameServer.rooms.get(jieqiRoom.roomId).spectators.size, 0);
  assert.equal((await emit(xiangqiViewer, 'jieqi:spectate', { roomId: jieqiRoom.roomId })).ok, true);

  const xiangqiHost = await connect();
  const jieqiViewer = await connect();
  const xiangqiRoom = await emit(xiangqiHost, 'room:create', { side: 'red' });
  assert.deepEqual(
    await emit(jieqiViewer, 'jieqi:spectate', { roomId: xiangqiRoom.roomId }),
    { ok: false, error: 'wrong_variant' },
  );
  assert.equal(app.gameServer.rooms.get(xiangqiRoom.roomId).spectators.size, 0);
  assert.equal((await emit(jieqiViewer, 'room:spectate', { roomId: xiangqiRoom.roomId })).ok, true);
});

test('resign và draw cô lập namespace Xiangqi/Jieqi theo cả hai chiều', async () => {
  const jr = await connect(); const jb = await connect();
  const jieqiCreated = await emit(jr, 'jieqi:create_room', { side: 'red' });
  await emit(jb, 'jieqi:join_room', { roomId: jieqiCreated.roomId });
  const jieqiRoom = app.gameServer.rooms.get(jieqiCreated.roomId);

  assert.equal((await emit(jr, 'game:resign')).error, 'wrong_variant');
  assert.equal(jieqiRoom.status, 'playing');
  assert.equal((await emit(jr, 'game:draw:offer')).error, 'wrong_variant');
  assert.equal(jieqiRoom.drawOfferFrom, null);
  assert.equal((await emit(jr, 'jieqi:draw_offer')).ok, true);
  assert.equal(jieqiRoom.drawOfferFrom, 'red');
  assert.equal((await emit(jb, 'game:draw:respond', { accept: true })).error, 'wrong_variant');
  assert.equal(jieqiRoom.status, 'playing');
  assert.equal(jieqiRoom.drawOfferFrom, 'red');
  assert.equal((await emit(jb, 'jieqi:draw_respond', { accept: false })).ok, true);
  assert.equal(jieqiRoom.drawOfferFrom, null);
  assert.equal((await emit(jb, 'jieqi:resign')).ok, true);
  assert.equal(jieqiRoom.status, 'over');

  const xr = await connect(); const xb = await connect();
  const xiangqiCreated = await emit(xr, 'room:create', { side: 'red' });
  await emit(xb, 'room:join', { roomId: xiangqiCreated.roomId });
  const xiangqiRoom = app.gameServer.rooms.get(xiangqiCreated.roomId);

  assert.equal((await emit(xr, 'jieqi:resign')).error, 'wrong_variant');
  assert.equal(xiangqiRoom.status, 'playing');
  assert.equal((await emit(xr, 'jieqi:draw_offer')).error, 'wrong_variant');
  assert.equal(xiangqiRoom.drawOfferFrom, null);
  assert.equal((await emit(xr, 'game:draw:offer')).ok, true);
  assert.equal(xiangqiRoom.drawOfferFrom, 'red');
  assert.equal((await emit(xb, 'jieqi:draw_respond', { accept: true })).error, 'wrong_variant');
  assert.equal(xiangqiRoom.status, 'playing');
  assert.equal(xiangqiRoom.drawOfferFrom, 'red');
  assert.equal((await emit(xb, 'game:draw:respond', { accept: false })).ok, true);
  assert.equal(xiangqiRoom.drawOfferFrom, null);
  assert.equal((await emit(xb, 'game:resign')).ok, true);
  assert.equal(xiangqiRoom.status, 'over');
});