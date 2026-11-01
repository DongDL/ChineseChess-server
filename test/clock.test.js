import test from 'node:test';
import assert from 'node:assert/strict';
import { GameClock, normalizeTimeControl, timeControlKey, DEFAULT_CLOCK_LIMITS } from '../src/clock.js';

/** Giờ giả: tự điều khiển thời gian trôi, test không phải chờ. */
function fakeTime() {
  let t = 1000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('chỉ đồng hồ của bên đến lượt chạy; bên kia đứng yên', () => {
  const time = fakeTime();
  const clock = new GameClock({ baseMs: 60_000, incrementMs: 0 }, time.now);
  clock.start('red');
  time.advance(5_000);
  const s = clock.snapshot();
  assert.equal(s.running, 'red');
  assert.equal(s.remainingMs.red, 55_000);
  assert.equal(s.remainingMs.black, 60_000);
});

test('đi xong một nước: được cộng thêm giờ và đồng hồ chuyển sang đối thủ', () => {
  const time = fakeTime();
  const clock = new GameClock({ baseMs: 60_000, incrementMs: 3_000 }, time.now);
  clock.start('red');
  time.advance(10_000);
  assert.equal(clock.press(), null);
  let s = clock.snapshot();
  assert.equal(s.running, 'black');
  assert.equal(s.remainingMs.red, 60_000 - 10_000 + 3_000);

  time.advance(4_000);
  assert.equal(clock.press(), null);
  s = clock.snapshot();
  assert.equal(s.running, 'red');
  assert.equal(s.remainingMs.black, 60_000 - 4_000 + 3_000);
});

test('snapshot không làm thay đổi đồng hồ', () => {
  const time = fakeTime();
  const clock = new GameClock({ baseMs: 60_000 }, time.now);
  clock.start('red');
  time.advance(7_000);
  clock.snapshot();
  clock.snapshot();
  time.advance(3_000);
  assert.equal(clock.snapshot().remainingMs.red, 50_000);
});

test('hết giờ: press() trả về bên hết giờ và không được cộng thêm giờ', () => {
  const time = fakeTime();
  const clock = new GameClock({ baseMs: 5_000, incrementMs: 2_000 }, time.now);
  clock.start('red');
  time.advance(5_001);
  assert.equal(clock.isExpired('red'), false); // chưa tick
  assert.equal(clock.press(), 'red');
  assert.equal(clock.isExpired('red'), true);
  assert.equal(clock.snapshot().remainingMs.red, 0); // không bao giờ âm
});

test('msUntilFlag: đếm ngược đến lúc hết giờ; dừng đồng hồ thì là vô hạn', () => {
  const time = fakeTime();
  const clock = new GameClock({ baseMs: 10_000 }, time.now);
  assert.equal(clock.msUntilFlag(), Infinity); // chưa start
  clock.start('black');
  time.advance(2_500);
  assert.equal(clock.msUntilFlag(), 7_500);
  clock.stop();
  time.advance(60_000);
  assert.equal(clock.msUntilFlag(), Infinity);
  assert.equal(clock.snapshot().running, null);
  assert.equal(clock.snapshot().remainingMs.black, 7_500); // dừng rồi thì không trôi nữa
});

test('normalizeTimeControl: chấp nhận cấu hình hợp lệ, từ chối cấu hình sai', () => {
  assert.equal(normalizeTimeControl(undefined), null);
  assert.equal(normalizeTimeControl(null), null);
  assert.deepEqual(normalizeTimeControl({ baseMs: 600_000, incrementMs: 5_000 }),
    { baseMs: 600_000, incrementMs: 5_000, perMoveMs: 0 });
  assert.deepEqual(normalizeTimeControl({ baseMs: 300_000 }), { baseMs: 300_000, incrementMs: 0, perMoveMs: 0 });
  // Giới hạn mỗi nước
  assert.deepEqual(normalizeTimeControl({ baseMs: 300_000, perMoveMs: 30_000 }),
    { baseMs: 300_000, incrementMs: 0, perMoveMs: 30_000 });

  const bad = [
    'abc', 5, {}, { baseMs: 'x' }, { baseMs: 1.5 }, { baseMs: 1_000 }, // dưới mức tối thiểu
    { baseMs: DEFAULT_CLOCK_LIMITS.maxBaseMs + 1 },
    { baseMs: 60_000, incrementMs: -1 },
    { baseMs: 60_000, incrementMs: DEFAULT_CLOCK_LIMITS.maxIncrementMs + 1 },
    { baseMs: 60_000, incrementMs: 0.5 },
    { baseMs: 60_000, perMoveMs: -1 },
    { baseMs: 60_000, perMoveMs: 1.5 },
    { baseMs: 60_000, perMoveMs: DEFAULT_CLOCK_LIMITS.maxPerMoveMs + 1 },
  ];
  for (const raw of bad) {
    assert.throws(() => normalizeTimeControl(raw), /bad_time_control/, JSON.stringify(raw));
  }
  // Giới hạn có thể ghi đè (dùng cho test với thời gian ngắn); thiếu maxPerMoveMs vẫn chấp nhận perMoveMs mặc định
  assert.deepEqual(normalizeTimeControl({ baseMs: 300 }, { ...DEFAULT_CLOCK_LIMITS, minBaseMs: 100 }),
    { baseMs: 300, incrementMs: 0, perMoveMs: 0 });
});

test('timeControlKey: ghép trận chỉ giữa những người cùng mức thời gian', () => {
  assert.equal(timeControlKey(null), 'none');
  assert.equal(timeControlKey({ baseMs: 600_000, incrementMs: 5_000, perMoveMs: 0 }), '600000+5000+0');
  assert.notEqual(timeControlKey({ baseMs: 600_000, incrementMs: 0 }), timeControlKey({ baseMs: 600_000, incrementMs: 5_000 }));
  // Khác giới hạn mỗi nước thì không ghép chung
  assert.notEqual(
    timeControlKey({ baseMs: 600_000, incrementMs: 0, perMoveMs: 30_000 }),
    timeControlKey({ baseMs: 600_000, incrementMs: 0, perMoveMs: 0 }),
  );
});

test('giới hạn mỗi nước: quá hạn nước đi thì bên đó bị xử thua dù còn tổng giờ', () => {
  const time = fakeTime();
  const clock = new GameClock({ baseMs: 600_000, incrementMs: 0, perMoveMs: 30_000 }, time.now);
  clock.start('red');
  // Mỗi nước giới hạn 30s, nhỏ hơn tổng giờ còn lại rất nhiều.
  assert.equal(clock.msUntilFlag(), 30_000);
  time.advance(30_001);
  clock.tick(); // như server làm trong onFlag trước khi kiểm tra
  assert.equal(clock.isExpired('red'), true); // hết giờ cho nước này
  const s = clock.snapshot();
  assert.ok(s.remainingMs.red > 500_000, 'tổng giờ vẫn còn nhiều');
  assert.equal(s.moveRemainingMs, 0);
});

test('giới hạn mỗi nước: đi trong hạn thì nước kế tiếp được đặt lại đồng hồ nước', () => {
  const time = fakeTime();
  const clock = new GameClock({ baseMs: 600_000, incrementMs: 0, perMoveMs: 30_000 }, time.now);
  clock.start('red');
  time.advance(10_000); // Đỏ dùng 10s
  assert.equal(clock.press(), null); // đi hợp lệ, chuyển sang Đen
  const s = clock.snapshot();
  assert.equal(s.running, 'black');
  assert.equal(s.moveRemainingMs, 30_000); // đồng hồ nước của Đen được đặt lại đầy đủ
});

test('snapshot: moveRemainingMs là null khi không giới hạn mỗi nước', () => {
  const time = fakeTime();
  const clock = new GameClock({ baseMs: 60_000, incrementMs: 0 }, time.now);
  clock.start('red');
  assert.equal(clock.snapshot().moveRemainingMs, null);
});
