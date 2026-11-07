import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { buildMimeMessage, createGmailApiMailer } from '../src/mailer.js';

// Giải mã base64url (đảo của base64url trong mailer) -> Buffer, để kiểm tra phần "raw" gửi lên Gmail.
function fromBase64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

/**
 * fetch giả: ghi lại mọi lần gọi; trả token rồi trả kết quả gửi thư thành công.
 * [sendStatus]/[sendBody]: cho phép mô phỏng lỗi phía Gmail API.
 */
function makeFakeFetch({ accessToken = 'tok-1', expiresIn = 3600, sendStatus = 200, sendBody = { id: 'm1' } } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('oauth2.googleapis.com/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: accessToken, expires_in: expiresIn }),
      };
    }
    // Gmail send
    return {
      ok: sendStatus >= 200 && sendStatus < 300,
      status: sendStatus,
      json: async () => sendBody,
    };
  };
  return { fetchImpl, calls };
}

const baseCfg = {
  clientId: 'cid', clientSecret: 'secret', refreshToken: 'refresh', sender: 'cotuong@example.com',
};

describe('buildMimeMessage', () => {
  test('thư không đính kèm: parse ra đúng tiêu đề và nội dung (UTF-8)', async () => {
    const mime = buildMimeMessage({
      from: 'A <a@example.com>', to: 'b@example.com', subject: 'Chào bạn', text: 'Nội dung tiếng Việt: cờ tướng.',
    });
    const parsed = await simpleParser(mime);
    assert.equal(parsed.subject, 'Chào bạn');
    assert.equal(parsed.to.value[0].address, 'b@example.com');
    assert.match(parsed.text, /Nội dung tiếng Việt: cờ tướng\./);
  });

  test('có Reply-To và tệp đính kèm: multipart giữ đúng tệp', async () => {
    const mime = buildMimeMessage({
      from: 'A <a@example.com>',
      to: 'b@example.com',
      subject: 'Kèm tệp',
      text: 'xem tệp',
      replyTo: 'nguoi-gui@example.com',
      attachments: [{ filename: 'log.txt', content: Buffer.from('nội dung log', 'utf8'), contentType: 'text/plain' }],
    });
    const parsed = await simpleParser(mime);
    assert.equal(parsed.replyTo.value[0].address, 'nguoi-gui@example.com');
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0].filename, 'log.txt');
    assert.equal(parsed.attachments[0].content.toString('utf8'), 'nội dung log');
  });
});

describe('createGmailApiMailer', () => {
  test('thiếu cấu hình bắt buộc thì ném lỗi ngay', () => {
    assert.throws(() => createGmailApiMailer({ clientId: 'x' }), /thiếu/);
  });

  test('gửi thành công: lấy token rồi POST tới Gmail API với raw base64url hợp lệ', async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    const mailer = createGmailApiMailer({ ...baseCfg, fetchImpl });
    await mailer.send({ to: 'b@example.com', subject: 'Tiêu đề', text: 'Xin chào' });

    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /oauth2\.googleapis\.com\/token/);
    assert.match(calls[1].url, /gmail\.googleapis\.com.*messages\/send/);
    assert.equal(calls[1].opts.headers.authorization, 'Bearer tok-1');

    // "raw" phải giải mã base64url ra một thư MIME đọc được.
    const { raw } = JSON.parse(calls[1].opts.body);
    const parsed = await simpleParser(fromBase64url(raw));
    assert.equal(parsed.subject, 'Tiêu đề');
    assert.equal(parsed.from.value[0].address, 'cotuong@example.com');
    assert.match(parsed.text, /Xin chào/);
  });

  test('access token được cache: gửi 2 lần chỉ lấy token 1 lần', async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    const mailer = createGmailApiMailer({ ...baseCfg, fetchImpl });
    await mailer.send({ to: 'b@example.com', subject: 's1', text: 't1' });
    await mailer.send({ to: 'b@example.com', subject: 's2', text: 't2' });
    const tokenCalls = calls.filter((c) => c.url.includes('oauth2.googleapis.com/token'));
    assert.equal(tokenCalls.length, 1);
  });

  test('Gmail API trả lỗi thì ném lỗi có thông điệp của Google', async () => {
    const { fetchImpl } = makeFakeFetch({ sendStatus: 403, sendBody: { error: { message: 'Insufficient Permission' } } });
    const mailer = createGmailApiMailer({ ...baseCfg, fetchImpl });
    await assert.rejects(
      () => mailer.send({ to: 'b@example.com', subject: 's', text: 't' }),
      /Insufficient Permission/,
    );
  });

  test('đổi refresh token lỗi thì ném lỗi OAuth', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) };
      }
      throw new Error('không nên gọi tới đây');
    };
    const mailer = createGmailApiMailer({ ...baseCfg, fetchImpl });
    await assert.rejects(() => mailer.send({ to: 'b@example.com', subject: 's', text: 't' }), /expired or revoked/);
  });
});
