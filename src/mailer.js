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

/** Chỉ để phát triển: in email (kèm mã) ra console. KHÔNG dùng khi chạy thật. */
export function createConsoleMailer(log = console) {
  return {
    kind: 'console',
    async send({ to, subject, text, attachments }) {
      const files = Array.isArray(attachments) && attachments.length
        ? `\n[đính kèm] ${attachments.map((a) => a.filename ?? '(không tên)').join(', ')}`
        : '';
      log.log(`[mail:dev] tới ${to} | ${subject}\n${text}${files}`);
    },
  };
}

/** Tạo mailer từ biến môi trường. Không cấu hình SMTP: console khi phát triển, null (tắt tính năng email) khi production. */
export function mailerFromEnv(env = process.env, log = console) {
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
