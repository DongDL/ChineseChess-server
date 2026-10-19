// Chạy thử server: 2 bot kết nối qua Socket.IO và đánh với nhau bằng nước đi ngẫu nhiên.
// Dùng:  npm start   (cửa sổ 1)
//        npm run demo -- http://localhost:3000 200 100   (cửa sổ 2; tham số: URL, số nước tối đa, độ trễ mỗi nước ms)
import { randomBytes } from 'node:crypto';
import { io } from 'socket.io-client';
import { XiangqiGame } from '../src/engine.js';

const url = process.argv[2] ?? 'http://localhost:3000';
const maxPlies = Number(process.argv[3] ?? 200);
// Bot đi chậm lại một chút như người thật (server giới hạn 60 sự kiện / 5 giây mỗi kết nối).
const delayMs = Number(process.argv[4] ?? 100);

function createBot(label) {
  const socket = io(url, {
    auth: { playerId: `bot-${label}-${randomBytes(4).toString('hex')}`, name: `Bot ${label}` },
    transports: ['websocket'],
    reconnection: false,
  });
  // Bot giữ một bản sao ván cờ (chỉ để chọn nước đi), cập nhật theo sự kiện từ server.
  return { label, socket, mirror: new XiangqiGame(), side: null, sentAtPly: -1 };
}

const emit = (s, ev, payload) => new Promise((resolve) => s.emit(ev, payload, resolve));

function playIfMyTurn(bot) {
  setTimeout(() => playNow(bot), delayMs);
}

function playNow(bot) {
  const { mirror, socket } = bot;
  if (mirror.isOver || mirror.turn !== bot.side) return;
  // Mỗi thế cờ chỉ gửi 1 nước (timer có thể dồn lại khi event loop bận).
  if (bot.sentAtPly === mirror.history.length) return;
  bot.sentAtPly = mirror.history.length;
  const moves = mirror.allLegalMoves();
  const pick = moves[Math.floor(Math.random() * moves.length)];
  if (mirror.history.length >= maxPlies) {
    socket.emit('game:resign');
    return;
  }
  socket.emit('game:move', pick, (res) => {
    if (!res.ok) console.error(`[${bot.label}] server từ chối nước đi (đã đi ${mirror.history.length} nước, lượt mirror=${mirror.turn}, phe bot=${bot.side}):`, res.error, pick);
  });
}

const A = createBot('A');
const B = createBot('B');
const started = Date.now();
let finished = 0;

for (const bot of [A, B]) {
  bot.socket.on('connect_error', (e) => {
    console.error(`Không kết nối được tới ${url}:`, e.message);
    process.exit(1);
  });
  bot.socket.on('game:start', (state) => {
    bot.side = state.you;
    console.log(`[${bot.label}] vào ván ${state.roomId} — cầm quân ${state.you}`);
    playIfMyTurn(bot);
  });
  bot.socket.on('game:move', (m) => {
    // Đồng bộ bản sao: nước đi đã được server xác nhận nên chắc chắn hợp lệ.
    bot.mirror.play(m.from, m.to);
    if (bot.label === 'A' && m.moveNumber % 20 === 0) {
      console.log(`  ... nước thứ ${m.moveNumber}`);
    }
    playIfMyTurn(bot);
  });
  bot.socket.on('game:over', (o) => {
    if (bot.label === 'A') {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`Kết thúc sau ${A.mirror.history.length} nước (${secs}s): kết quả=${o.result}, lý do=${o.reason}`);
    }
    if (++finished === 2) {
      A.socket.close();
      B.socket.close();
    }
  });
}

await new Promise((r) => A.socket.once('connect', r));
await new Promise((r) => B.socket.once('connect', r));

const created = await emit(A.socket, 'room:create', { side: 'red' });
console.log(`[A] tạo phòng ${created.roomId}`);
const joined = await emit(B.socket, 'room:join', { roomId: created.roomId });
if (!joined.ok) {
  console.error('[B] không vào được phòng:', joined.error);
  process.exit(1);
}
