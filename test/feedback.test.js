import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { createApp } from '../src/app.js';
import { AuthService } from '../src/auth.js';
import { createSmtpMailer } from '../src/mailer.js';
import { MemoryStore } from '../src/stores/memory.js';
import { sleep } from './helpers/sockets.js';

const FAST = { N: 1024, r: 8, p: 1 };
const BIG = { max: 1e6, windowMs: 3_600_000 };
const FEEDBACK_TO = 'gop-y@example.com';

/** Máy chủ SMTP cục bộ: nhận thư và giữ lại để test đọc (kèm tệp đính kèm). */
function startSmtp() {
  const inbox = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    size: 20 * 1024 * 1024, // cho phép thư lớn (có tệp đính kèm)
    onData(stream, _s, cb) {
      simpleParser(stream).then((m) => { inbox.push(m); cb(); }, cb);
    },
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    inbox, port: server.server.address().port, close: () => new Promise((r) => server.close(r)),
  })));
}

const lastTo = async (inbox, to, afterCount) => {
  for (let i = 0; i < 100; i++) {
    const m = inbox.filter((x) => x.to.value[0].address === to);
    if (m.length > afterCount) return m.at(-1);
    await sleep(20);
  }
  throw new Error(`không nhận được thư tới ${to}`);
};

describe('Thư góp ý (POST /feedback)', () => {
  let smtp; let app; let base; let store; let auth;

  before(async () => {
    smtp = await startSmtp();
    store = new MemoryStore();
    auth = new AuthService({
      store, scryptParams: FAST, log: { error() {} },
      limits: { registerPerIp: BIG, loginPerIp: BIG },
    });
    const mailer = createSmtpMailer({
      host: '127.0.0.1', port: smtp.port, secure: false, requireTLS: false, ignoreTLS: true, from: 'cotuong@example.com',
    });
    app = createApp({ store, authService: auth, mailer, feedbackTo: FEEDBACK_TO, appName: 'Cờ tướng' });
    await new Promise((r) => app.httpServer.listen(0, r));
    base = `http://127.0.0.1:${app.httpServer.address().port}`;
  });
  after(async () => { await app.close(); await smtp.close(); await store.close(); });

  const post = async (body, token) => {
    const res = await fetch(`${base}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* không có thân */ }
    return { status: res.status, body: json };
  };

  test('khách gửi được góp ý; thư tới đúng hộp nhận, có tiền tố [Góp ý]', async () => {
    const n = smtp.inbox.filter((x) => x.to.value[0].address === FEEDBACK_TO).length;
    const r = await post({ subject: 'Đề xuất tính năng', body: 'Thêm chế độ đấu giải nhé.' });
    assert.deepEqual(r.body, { ok: true });
    const mail = await lastTo(smtp.inbox, FEEDBACK_TO, n);
    assert.equal(mail.subject, '[Góp ý] Đề xuất tính năng');
    assert.match(mail.text, /Thêm chế độ đấu giải nhé\./);
    assert.match(mail.text, /khách \(chưa đăng nhập\)/);
  });

  test('người đã đăng nhập: thư ghi kèm tên và id người gửi', async () => {
    const s = await auth.register({ username: 'nguoi_gop_y', password: 'mat-khau-cu-1', displayName: 'Người Góp Ý' }, '1.1.1.1');
    const n = smtp.inbox.filter((x) => x.to.value[0].address === FEEDBACK_TO).length;
    const r = await post({ subject: 'Lỗi hiển thị', body: 'Quân xe bị lệch ô.' }, s.token);
    assert.equal(r.status, 200);
    const mail = await lastTo(smtp.inbox, FEEDBACK_TO, n);
    assert.match(mail.text, /Người Góp Ý/);
    assert.match(mail.text, new RegExp(`id ${s.user.id}`));
  });

  test('tệp đính kèm đi kèm thư', async () => {
    const n = smtp.inbox.filter((x) => x.to.value[0].address === FEEDBACK_TO).length;
    const data = Buffer.from('nội dung tệp log 123', 'utf8').toString('base64');
    const r = await post({
      subject: 'Kèm log',
      body: 'Gửi kèm tệp.',
      attachments: [{ name: 'log.txt', dataBase64: data, type: 'text/plain' }],
    });
    assert.equal(r.status, 200);
    const mail = await lastTo(smtp.inbox, FEEDBACK_TO, n);
    assert.equal(mail.attachments.length, 1);
    assert.equal(mail.attachments[0].filename, 'log.txt');
    assert.equal(mail.attachments[0].content.toString('utf8'), 'nội dung tệp log 123');
  });

  test('thiếu chủ đề hoặc nội dung thì bị từ chối', async () => {
    assert.equal((await post({ subject: '', body: 'x' })).body.error, 'subject_required');
    assert.equal((await post({ subject: 'x', body: '   ' })).body.error, 'body_required');
  });

  test('tổng tệp vượt 10 MB thì báo attachment_too_large (413)', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1024, 65).toString('base64');
    const r = await post({ subject: 'Tệp lớn', body: 'quá cỡ', attachments: [{ name: 'big.bin', dataBase64: big }] });
    assert.equal(r.status, 413);
    assert.equal(r.body.error, 'attachment_too_large');
  });

  test('quá 10 tệp thì báo too_many_files', async () => {
    const one = { name: 'a.txt', dataBase64: Buffer.from('a').toString('base64') };
    const r = await post({ subject: 'Nhiều tệp', body: 'x', attachments: Array.from({ length: 11 }, () => one) });
    assert.equal(r.body.error, 'too_many_files');
  });
});

describe('Thư góp ý khi chưa cấu hình SMTP', () => {
  test('báo email_unavailable (503)', async () => {
    const store = new MemoryStore();
    const auth = new AuthService({ store, scryptParams: FAST, log: { error() {} } });
    const app = createApp({ store, authService: auth }); // không truyền mailer / feedbackTo
    await new Promise((r) => app.httpServer.listen(0, r));
    const base = `http://127.0.0.1:${app.httpServer.address().port}`;
    try {
      const res = await fetch(`${base}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject: 'x', body: 'y' }),
      });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'email_unavailable');
    } finally { await app.close(); await store.close(); }
  });
});
