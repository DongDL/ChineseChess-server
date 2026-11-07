import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';

/**
 * Gửi email. Mọi mailer có cùng giao diện: `await mailer.send({ to, subject, text })`.
 *
 * Cấu hình SMTP qua biến môi trường (xem .env): SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM.
 * Gmail: dùng "Mật khẩu ứng dụng" (App password, cần bật xác minh 2 bước), KHÔNG dùng mật khẩu đăng nhập Google;
 * smtp.gmail.com cổng 465 (SMTP_SECURE=1) hoặc 587.
 *
 * [rejectUnauthorized]: mặc định true = xác minh chuỗi chứng chỉ TLS của máy chủ SMTP (AN TOÀN, nên giữ).
 *   Đặt false CHỈ khi mạng dev có proxy/antivirus chen chứng chỉ tự ký vào giữa gây lỗi
 *   "self-signed certificate in certificate chain" — khi đó tốt hơn là trỏ [ca] tới file CA của proxy.
 * [ca]: nội dung PEM của CA tin cậy bổ sung (ví dụ CA của proxy công ty), để vẫn xác minh chặt.
 */
export function createSmtpMailer({
  host, port = 587, secure = port === 465, user, pass, from,
  requireTLS = !secure, ignoreTLS = false, rejectUnauthorized = true, ca = null,
}) {
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS, // cổng 587: bắt buộc nâng cấp TLS, không chịu gửi mật khẩu/mã ở dạng thường
    ignoreTLS,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
    tls: {
      rejectUnauthorized,
      ...(ca ? { ca } : {}),
    },
  });
  const sender = from || user;
  return {
    kind: 'smtp',
    // [attachments]: tuỳ chọn — mảng { filename, content (Buffer|base64 string), contentType }.
    // [replyTo]: đặt địa chỉ "Trả lời tới" (hữu ích cho thư góp ý: trả lời là tới người gửi góp ý).
    async send({ to, subject, text, attachments, replyTo }) {
      await transport.sendMail({ from: sender, to, subject, text, attachments, replyTo });
    },
    close: () => transport.close(),
  };
}

// ============================ Gmail API (HTTPS) ============================
//
// Vì sao cần: nhiều nền tảng (Render free, một số PaaS) CHẶN lưu lượng ra ngoài tới cổng SMTP
// 25/465/587 để chống spam, khiến SMTP trực tiếp bị "Connection timeout". Gmail API gửi thư qua
// HTTPS (cổng 443) nên KHÔNG bị chặn.
//
// Cách hoạt động: dùng OAuth2 "refresh token" (lấy MỘT LẦN, sống lâu) để đổi lấy "access token"
// ngắn hạn qua https://oauth2.googleapis.com/token, rồi POST thư (dạng MIME, mã base64url) tới
// https://gmail.googleapis.com/gmail/v1/users/me/messages/send. Toàn bộ qua HTTPS.
//
// Cần có: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET (OAuth client RIÊNG cho việc gửi mail — KHÔNG dùng
// chung GOOGLE_CLIENT_ID/SECRET vốn dành cho đăng nhập Google), GMAIL_REFRESH_TOKEN với scope
// "https://www.googleapis.com/auth/gmail.send", và GMAIL_SENDER (địa chỉ Gmail gửi đi).
//
// Lấy refresh token: chạy `node scripts/gmail-oauth.js` (hướng dẫn in ngay khi chạy).

const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/** Mã hoá base64url (RFC 4648 §5): + -> -, / -> _, bỏ '='. Gmail API yêu cầu định dạng này. */
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mã hoá tiêu đề/tên tệp có ký tự ngoài ASCII theo RFC 2047 ("encoded word" UTF-8/Base64). */
function encodeHeaderWord(value) {
  const s = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(s)) return s; // thuần ASCII: giữ nguyên cho dễ đọc
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/**
 * Dựng một thông điệp MIME (RFC 2822) dạng Buffer.
 * - Không đính kèm: thư text/plain đơn giản (UTF-8, base64).
 * - Có đính kèm: multipart/mixed, phần đầu là text, các phần sau là tệp (base64).
 */
export function buildMimeMessage({
  from, to, subject, text, replyTo, attachments = [],
}) {
  const CRLF = '\r\n';
  // base64 chuẩn cho thân thư MIME: xuống dòng mỗi 76 ký tự (RFC 2045).
  const bodyB64 = (buf) => Buffer.from(buf).toString('base64').replace(/(.{76})/g, `$1${CRLF}`);
  const headersBase = [
    `From: ${from}`,
    `To: ${to}`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `Subject: ${encodeHeaderWord(subject)}`,
    'MIME-Version: 1.0',
  ];

  if (!attachments || attachments.length === 0) {
    const lines = [
      ...headersBase,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      bodyB64(Buffer.from(String(text ?? ''), 'utf8')),
    ];
    return Buffer.from(lines.join(CRLF), 'utf8');
  }

  const boundary = `=_cotuong_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const parts = [
    ...headersBase,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    bodyB64(Buffer.from(String(text ?? ''), 'utf8')),
  ];
  for (const a of attachments) {
    const filename = a.filename ?? 'tệp-đính-kèm';
    const contentType = a.contentType || 'application/octet-stream';
    const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content ?? '', 'base64');
    parts.push(
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${encodeHeaderWord(filename)}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${encodeHeaderWord(filename)}"`,
      '',
      bodyB64(content),
    );
  }
  parts.push(`--${boundary}--`, '');
  return Buffer.from(parts.join(CRLF), 'utf8');
}

/**
 * Mailer dùng Gmail API qua HTTPS. Cùng giao diện `send({ to, subject, text, attachments, replyTo })`.
 *
 * [fetchImpl]: chỉ để test (tiêm fetch giả). Mặc định dùng fetch toàn cục của Node >= 18.
 * Access token được cache trong bộ nhớ và tự làm mới khi sắp hết hạn (đệm 60s).
 */
export function createGmailApiMailer({
  clientId, clientSecret, refreshToken, sender, from, fetchImpl = globalThis.fetch,
}) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Gmail API mailer: thiếu clientId/clientSecret/refreshToken');
  }
  const fromAddr = from || sender;
  let cachedToken = null;
  let tokenExpiresAt = 0;

  async function accessToken() {
    const now = Date.now();
    if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await fetchImpl(GMAIL_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const detail = data.error_description || data.error || 'không lấy được access token';
      throw new Error(`Gmail OAuth lỗi (${res.status}): ${detail}`);
    }
    cachedToken = data.access_token;
    tokenExpiresAt = now + (Number(data.expires_in) || 3600) * 1000;
    return cachedToken;
  }

  return {
    kind: 'gmail-api',
    async send({ to, subject, text, attachments, replyTo }) {
      const token = await accessToken();
      const mime = buildMimeMessage({ from: fromAddr, to, subject, text, replyTo, attachments });
      const res = await fetchImpl(GMAIL_SEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw: base64url(mime) }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const detail = data?.error?.message || data?.error || `HTTP ${res.status}`;
        throw new Error(`Gmail API gửi thư lỗi: ${detail}`);
      }
    },
    close() {},
  };
}

/** Chỉ để phát triển: in email (kèm mã) ra console/log. KHÔNG dùng khi chạy thật. */
export function createConsoleMailer(log = console) {
  // Tương thích cả console (log.log) lẫn logger Pino (log.info).
  const info = typeof log.info === 'function' ? (m) => log.info(m) : (m) => log.log(m);
  return {
    kind: 'console',
    async send({ to, subject, text, attachments }) {
      const files = Array.isArray(attachments) && attachments.length
        ? `\n[đính kèm] ${attachments.map((a) => a.filename ?? '(không tên)').join(', ')}`
        : '';
      info(`[mail:dev] tới ${to} | ${subject}\n${text}${files}`);
    },
  };
}

/**
 * Tạo mailer từ biến môi trường. Thứ tự ưu tiên:
 *   1) Gmail API (GMAIL_REFRESH_TOKEN) — gửi qua HTTPS, KHÔNG bị chặn cổng SMTP (dùng cho Render/PaaS).
 *   2) SMTP (SMTP_HOST) — gửi trực tiếp, chỉ chạy ở nơi cổng 465/587 không bị chặn (máy cục bộ, VPS).
 *   3) Không cấu hình gì: console khi phát triển, null (tắt email) khi production.
 */
export function mailerFromEnv(env = process.env, log = console) {
  // --- 1) Gmail API (ưu tiên vì vượt qua được chặn cổng SMTP của Render free) ---
  // Dùng OAuth client RIÊNG cho gửi mail (GMAIL_CLIENT_ID/SECRET), tách khỏi GOOGLE_CLIENT_ID/SECRET
  // vốn chỉ dùng cho đăng nhập Google.
  if (env.GMAIL_REFRESH_TOKEN) {
    const clientId = env.GMAIL_CLIENT_ID;
    const clientSecret = env.GMAIL_CLIENT_SECRET;
    const sender = env.GMAIL_SENDER || env.SMTP_USER;
    if (!clientId || !clientSecret) {
      log.warn?.('[mail] có GMAIL_REFRESH_TOKEN nhưng thiếu GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET: bỏ qua Gmail API.');
    } else {
      log.info?.('[mail] dùng Gmail API (HTTPS) để gửi thư — không bị chặn cổng SMTP.');
      return createGmailApiMailer({
        clientId,
        clientSecret,
        refreshToken: env.GMAIL_REFRESH_TOKEN,
        sender,
        from: env.SMTP_FROM || sender,
      });
    }
  }

  // --- 2) SMTP trực tiếp ---
  if (env.SMTP_HOST) {
    const port = Number(env.SMTP_PORT) || 587;
    // Mặc định xác minh chặt TLS; chỉ tắt khi SMTP_TLS_REJECT_UNAUTHORIZED=0 (mạng dev có proxy chen chứng chỉ).
    const rejectUnauthorized = env.SMTP_TLS_REJECT_UNAUTHORIZED !== '0';
    let ca = null;
    if (env.SMTP_TLS_CA_FILE) {
      try {
        ca = readFileSync(env.SMTP_TLS_CA_FILE, 'utf8');
      } catch (err) {
        log.warn?.(`[mail] không đọc được SMTP_TLS_CA_FILE (${env.SMTP_TLS_CA_FILE}): ${err.message}`);
      }
    }
    if (!rejectUnauthorized) {
      log.warn?.('[mail] SMTP_TLS_REJECT_UNAUTHORIZED=0: KHÔNG xác minh chứng chỉ TLS của máy chủ SMTP (chỉ nên dùng khi dev).');
    }
    return createSmtpMailer({
      host: env.SMTP_HOST,
      port,
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === '1' : port === 465,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.SMTP_FROM,
      rejectUnauthorized,
      ca,
    });
  }
  if (env.NODE_ENV === 'production') {
    log.warn?.('[mail] SMTP_HOST chưa được cấu hình: email khôi phục mật khẩu bị TẮT.');
    return null;
  }
  log.warn?.('[mail] SMTP_HOST chưa được cấu hình: dùng mailer console (mã sẽ in ra màn hình, chỉ để phát triển).');
  return createConsoleMailer(log);
}
