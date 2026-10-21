import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { createApp } from '../src/app.js';
import { AuthService, validateEmail } from '../src/auth.js';
import { createSmtpMailer } from '../src/mailer.js';
import { MemoryStore } from '../src/stores/memory.js';
import { PgStore } from '../src/stores/pg.js';
import { sleep } from './helpers/sockets.js';

const PG_URL = process.env.TEST_DATABASE_URL;
const FAST = { N: 1024, r: 8, p: 1 };
const BIG = { max: 1e6, windowMs: 3_600_000 };
const impls = [
  ['MemoryStore', () => new MemoryStore(), null],
  ['PostgreSQL thật', async () => {
    const s = new PgStore({ connectionString: PG_URL });
    await s.migrate();
    await s._truncateAllForTests();
    return s;
  }, PG_URL ? null : 'bỏ qua: chưa đặt TEST_DATABASE_URL'],
];

/** Máy chủ SMTP thật chạy cục bộ: nhận thư qua giao thức SMTP và giữ lại để test đọc. */
function startSmtp({ requirePassword = null } = {}) {
  const inbox = [];
  const server = new SMTPServer({
    authOptional: requirePassword === null,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    onAuth(auth, _s, cb) {
      if (requirePassword !== null && auth.username === 'gui@example.com' && auth.password === requirePassword) {
        return cb(null, { user: auth.username });
      }
      return cb(new Error('Sai tài khoản SMTP'));
    },
    onData(stream, _s, cb) {
      simpleParser(stream).then((m) => { inbox.push(m); cb(); }, cb);
    },
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    inbox, port: server.server.address().port, close: () => new Promise((r) => server.close(r)),
  })));
}
const codeOf = (mail) => /(\d{6})/.exec(mail.text)[1];

describe('validateEmail', () => {
  test('chuẩn hoá và từ chối dạng sai', () => {
    assert.equal(validateEmail('  Lam.Dong@Gmail.COM '), 'lam.dong@gmail.com');
    for (const bad of ['', 'abc', 'a@b', 'a b@c.d', 'a@b.c\r\nBcc: x@y.z', 5, null, `${'a'.repeat(250)}@b.cd`]) {
      assert.throws(() => validateEmail(bad), { code: 'invalid_email' });
    }
  });
});

describe('SMTP thật (cục bộ)', () => {
  test('gửi thư qua SMTP có đăng nhập; sai mật khẩu SMTP thì báo lỗi', async () => {
    const smtp = await startSmtp({ requirePassword: 'mat-khau-ung-dung' });
    try {
      const opts = { host: '127.0.0.1', port: smtp.port, secure: false, requireTLS: false, ignoreTLS: true, from: 'Cờ tướng <gui@example.com>' };
      const good = createSmtpMailer({ ...opts, user: 'gui@example.com', pass: 'mat-khau-ung-dung' });
      await good.send({ to: 'nhan@example.com', subject: 'Chủ đề tiếng Việt', text: 'Nội dung 123456' });
      assert.equal(smtp.inbox.length, 1);
      assert.equal(smtp.inbox[0].subject, 'Chủ đề tiếng Việt');
      assert.equal(smtp.inbox[0].to.value[0].address, 'nhan@example.com');
      assert.match(smtp.inbox[0].text, /Nội dung 123456/);
      const bad = createSmtpMailer({ ...opts, user: 'gui@example.com', pass: 'sai' });
      await assert.rejects(bad.send({ to: 'nhan@example.com', subject: 'x', text: 'y' }));
      assert.equal(smtp.inbox.length, 1);
    } finally { await smtp.close(); }
  });
});

for (const [name, make, skip] of impls) {
  describe(`Email khôi phục và quên mật khẩu: ${name}`, { skip: skip ?? false }, () => {
    let store; let smtp; let app; let base; let auth; let failing = false;
    before(async () => {
      store = await make();
      smtp = await startSmtp();
      const real = createSmtpMailer({ host: '127.0.0.1', port: smtp.port, secure: false, requireTLS: false, ignoreTLS: true, from: 'cotuong@example.com' });
      const mailer = { send: (m) => (failing ? Promise.reject(new Error('SMTP down')) : real.send(m)) };
      auth = new AuthService({
        store, scryptParams: FAST, log: { error() {} }, mailer,
        limits: { registerPerIp: BIG, loginPerIp: BIG, resetPerIp: BIG, forgotPerIp: BIG, forgotPerEmail: BIG, emailPerUser: BIG },
      });
      app = createApp({ store, authService: auth });
      await new Promise((r) => app.httpServer.listen(0, r));
      base = `http://127.0.0.1:${app.httpServer.address().port}`;
    });
    after(async () => { await app.close(); await smtp.close(); await store.close(); });

    const call = async (method, path, body, token) => {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    };
    const signup = (u) => auth.register({ username: u, password: 'mat-khau-cu-1', displayName: u }, '5.5.5.5');
    const lastMail = async (to, afterCount) => {
      for (let i = 0; i < 100; i++) {
        const m = smtp.inbox.filter((x) => x.to.value[0].address === to);
        if (m.length > afterCount) return m.at(-1);
        await sleep(20);
      }
      throw new Error(`không nhận được thư tới ${to}`);
    };
    const count = (to) => smtp.inbox.filter((x) => x.to.value[0].address === to).length;
    /** Tạo tài khoản có email đã xác minh. */
    async function verifiedAccount(user, email) {
      const s = await signup(user);
      assert.equal((await call('POST', '/auth/email', { email, password: 'mat-khau-cu-1' }, s.token)).status, 200);
      const code = codeOf(await lastMail(email, 0));
      assert.equal((await call('POST', '/auth/email/verify', { code }, s.token)).status, 200);
      return s;
    }

    test('thêm email: cần mật khẩu; chưa xác minh thì chưa dùng được; nhập đúng mã thì xác minh', async () => {
      const s = await signup('them_email');
      assert.equal((await call('POST', '/auth/email', { email: 'a@b.cd', password: 'sai-sai-sai' }, s.token)).status, 401);
      assert.equal((await call('POST', '/auth/email', { email: 'khong-hop-le', password: 'mat-khau-cu-1' }, s.token)).body.error, 'invalid_email');
      assert.equal((await call('POST', '/auth/email', { email: 'x@y.zz' })).status, 401);

      const r = await call('POST', '/auth/email', { email: 'Them.Email@Example.com', password: 'mat-khau-cu-1' }, s.token);
      assert.deepEqual(r.body, { ok: true, email: 'them.email@example.com', verified: false });
      const mail = await lastMail('them.email@example.com', 0);
      assert.match(mail.subject, /xác minh/);
      assert.match(mail.text, /^[\s\S]*\b\d{6}\b/);

      const me = await call('GET', '/auth/me', null, s.token);
      assert.equal(me.body.user.recoveryEmail, 'them.email@example.com');
      assert.equal(me.body.user.recoveryEmailVerified, false);

      // chưa xác minh: quên mật khẩu không gửi gì
      const before = smtp.inbox.length;
      assert.equal((await call('POST', '/auth/forgot', { email: 'them.email@example.com' })).status, 200);
      await sleep(150);
      assert.equal(smtp.inbox.length, before);

      const code = codeOf(mail);
      const wrong = code === '000000' ? '111111' : '000000';
      assert.equal((await call('POST', '/auth/email/verify', { code: wrong }, s.token)).body.error, 'invalid_email_code');
      const ok = await call('POST', '/auth/email/verify', { code }, s.token);
      assert.deepEqual(ok.body, { ok: true, email: 'them.email@example.com', verified: true });
      assert.equal((await call('GET', '/auth/me', null, s.token)).body.user.recoveryEmailVerified, true);
      assert.equal((await call('POST', '/auth/email/verify', { code }, s.token)).body.error, 'invalid_email_code'); // dùng một lần
    });

    test('mã xác minh sai 5 lần thì bị huỷ, kể cả nhập đúng sau đó', async () => {
      const s = await signup('sai_nam_lan');
      await call('POST', '/auth/email', { email: 'nam.lan@example.com', password: 'mat-khau-cu-1' }, s.token);
      const code = codeOf(await lastMail('nam.lan@example.com', 0));
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/auth/email/verify', { code: wrong }, s.token)).body.error, 'invalid_email_code');
      assert.equal((await call('POST', '/auth/email/verify', { code }, s.token)).body.error, 'invalid_email_code');
    });

    test('một email đã xác minh chỉ thuộc một tài khoản', async () => {
      await verifiedAccount('chu_email', 'chung@example.com');
      const other = await signup('tranh_email');
      const r = await call('POST', '/auth/email', { email: 'CHUNG@example.com', password: 'mat-khau-cu-1' }, other.token);
      assert.equal(r.body.error, 'email_taken');
      assert.equal(r.status, 409);
    });

    test('quên mật khẩu: nhận mã, đặt lại, đăng nhập bằng mật khẩu mới, mọi phiên cũ bị thu hồi, mã dùng một lần', async () => {
      const s = await verifiedAccount('quen_mk', 'quen.mk@example.com');
      const n = count('quen.mk@example.com');
      assert.equal((await call('POST', '/auth/forgot', { email: 'Quen.MK@example.com' })).status, 200);
      const mail = await lastMail('quen.mk@example.com', n);
      assert.match(mail.subject, /đặt lại mật khẩu/);
      const code = codeOf(mail);

      assert.equal((await call('POST', '/auth/reset', { email: 'quen.mk@example.com', code, newPassword: 'ngan' })).body.error, 'invalid_password');
      const done = await call('POST', '/auth/reset', { email: 'quen.mk@example.com', code, newPassword: 'mat-khau-moi-9' });
      assert.deepEqual(done.body, { ok: true });
      assert.equal((await call('GET', '/auth/me', null, s.token)).status, 401, 'phiên cũ phải bị thu hồi');
      assert.equal((await call('POST', '/auth/login', { username: 'quen_mk', password: 'mat-khau-cu-1' })).status, 401);
      assert.equal((await call('POST', '/auth/login', { username: 'quen_mk', password: 'mat-khau-moi-9' })).status, 200);
      assert.equal((await call('POST', '/auth/reset', { email: 'quen.mk@example.com', code, newPassword: 'mat-khau-khac-1' })).body.error, 'invalid_email_code');
    });

    test('không lộ email nào có tài khoản: email lạ / chưa xác minh cho cùng phản hồi và không gửi thư', async () => {
      await verifiedAccount('co_that', 'co.that@example.com');
      const n = smtp.inbox.length;
      const known = await call('POST', '/auth/forgot', { email: 'co.that@example.com' });
      const unknown = await call('POST', '/auth/forgot', { email: 'khong.ton.tai@example.com' });
      assert.deepEqual(known, unknown);
      await lastMail('co.that@example.com', 0).then(() => {});
      await sleep(150);
      assert.equal(smtp.inbox.length, n + 1);
      assert.equal(count('khong.ton.tai@example.com'), 0);
      assert.equal((await call('POST', '/auth/forgot', { email: 'sai-dinh-dang' })).body.error, 'invalid_email');
      // đặt lại bằng email lạ báo cùng một lỗi như mã sai
      assert.equal((await call('POST', '/auth/reset', { email: 'khong.ton.tai@example.com', code: '123456', newPassword: 'mat-khau-moi-9' })).body.error, 'invalid_email_code');
    });

    test('đặt lại: sai mã 5 lần thì mã bị huỷ; mã mới thay mã cũ', async () => {
      await verifiedAccount('doan_ma', 'doan.ma@example.com');
      let n = count('doan.ma@example.com');
      await call('POST', '/auth/forgot', { email: 'doan.ma@example.com' });
      const first = codeOf(await lastMail('doan.ma@example.com', n));
      const wrong = first === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        assert.equal((await call('POST', '/auth/reset', { email: 'doan.ma@example.com', code: wrong, newPassword: 'mat-khau-moi-9' })).body.error, 'invalid_email_code');
      }
      assert.equal((await call('POST', '/auth/reset', { email: 'doan.ma@example.com', code: first, newPassword: 'mat-khau-moi-9' })).body.error, 'invalid_email_code');

      n = count('doan.ma@example.com');
      await call('POST', '/auth/forgot', { email: 'doan.ma@example.com' });
      const second = codeOf(await lastMail('doan.ma@example.com', n));
      await call('POST', '/auth/forgot', { email: 'doan.ma@example.com' });
      const third = codeOf(await lastMail('doan.ma@example.com', n + 1));
      if (second !== third) {
        assert.equal((await call('POST', '/auth/reset', { email: 'doan.ma@example.com', code: second, newPassword: 'mat-khau-moi-9' })).body.error, 'invalid_email_code');
      }
      assert.equal((await call('POST', '/auth/reset', { email: 'doan.ma@example.com', code: third, newPassword: 'mat-khau-moi-9' })).status, 200);
    });

    test('mã hết hạn thì không dùng được', async () => {
      const store2 = store;
      const s = await verifiedAccount('het_han', 'het.han@example.com');
      const n = count('het.han@example.com');
      await call('POST', '/auth/forgot', { email: 'het.han@example.com' });
      const code = codeOf(await lastMail('het.han@example.com', n));
      const rec = await store2.getEmailCode(s.user.id, 'reset_password');
      assert.ok(rec.expiresAt > Date.now());
      await store2.putEmailCode({ userId: s.user.id, purpose: 'reset_password', email: rec.email, codeHash: rec.codeHash, expiresAt: Date.now() - 1000 });
      assert.equal((await call('POST', '/auth/reset', { email: 'het.han@example.com', code, newPassword: 'mat-khau-moi-9' })).body.error, 'invalid_email_code');
    });

    test('chỉ lưu BĂM của mã, không lưu mã gốc', async () => {
      const s = await signup('luu_bam');
      await call('POST', '/auth/email', { email: 'luu.bam@example.com', password: 'mat-khau-cu-1' }, s.token);
      const code = codeOf(await lastMail('luu.bam@example.com', 0));
      const rec = await store.getEmailCode(s.user.id, 'verify_email');
      assert.equal(JSON.stringify(rec).includes(code), false);
      assert.match(rec.codeHash, /^[0-9a-f]{64}$/);
    });

    test('gửi thư xác minh lỗi: báo email_send_failed và không để lại mã', async () => {
      const s = await signup('thu_loi');
      failing = true;
      try {
        const r = await call('POST', '/auth/email', { email: 'thu.loi@example.com', password: 'mat-khau-cu-1' }, s.token);
        assert.equal(r.status, 502);
        assert.equal(r.body.error, 'email_send_failed');
        assert.equal(await store.getEmailCode(s.user.id, 'verify_email'), null);
      } finally { failing = false; }
    });

    test('đổi email khôi phục thì mã xác minh cũ vô hiệu; xoá tài khoản xoá luôn email và mã', async () => {
      const s = await signup('doi_email');
      await call('POST', '/auth/email', { email: 'cu@example.com', password: 'mat-khau-cu-1' }, s.token);
      const oldCode = codeOf(await lastMail('cu@example.com', 0));
      await call('POST', '/auth/email', { email: 'moi@example.com', password: 'mat-khau-cu-1' }, s.token);
      assert.equal((await call('POST', '/auth/email/verify', { code: oldCode }, s.token)).body.error, 'invalid_email_code');
      const newCode = codeOf(await lastMail('moi@example.com', 0));
      assert.equal((await call('POST', '/auth/email/verify', { code: newCode }, s.token)).status, 200);
      await call('POST', '/auth/account/delete', { password: 'mat-khau-cu-1' }, s.token);
      assert.equal(await store.findUserByVerifiedEmail('moi@example.com'), null);
      assert.equal(await store.getEmailCode(s.user.id, 'verify_email'), null);
    });
  });
}

describe('Không có mailer', () => {
  test('các chức năng email báo email_unavailable (503) thay vì lỗi lạ', async () => {
    const store = new MemoryStore();
    const auth = new AuthService({ store, scryptParams: FAST, log: { error() {} } });
    const app = createApp({ store, authService: auth });
    await new Promise((r) => app.httpServer.listen(0, r));
    const base = `http://127.0.0.1:${app.httpServer.address().port}`;
    try {
      const res = await fetch(`${base}/auth/forgot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.cd' }) });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'email_unavailable');
    } finally { await app.close(); }
  });
});
