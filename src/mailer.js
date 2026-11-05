import nodemailer from 'nodemailer';

/**
 * Gửi email. Mọi mailer có cùng giao diện: `await mailer.send({ to, subject, text })`.
 *
 * Cấu hình SMTP qua biến môi trường (xem .env): SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM.
 * Gmail: dùng "Mật khẩu ứng dụng" (App password, cần bật xác minh 2 bước), KHÔNG dùng mật khẩu đăng nhập Google;
 * smtp.gmail.com cổng 465 (SMTP_SECURE=1) hoặc 587.
 */
export function createSmtpMailer({
  host, port = 587, secure = port === 465, user, pass, from, requireTLS = !secure, ignoreTLS = false,
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
  });
  const sender = from || user;
  return {
    kind: 'smtp',
    async send({ to, subject, text }) {
      await transport.sendMail({ from: sender, to, subject, text });
    },
    close: () => transport.close(),
  };
}

/** Chỉ để phát triển: in email (kèm mã) ra console. KHÔNG dùng khi chạy thật. */
export function createConsoleMailer(log = console) {
  return {
    kind: 'console',
    async send({ to, subject, text }) {
      log.log(`[mail:dev] tới ${to} | ${subject}\n${text}`);
    },
  };
}

/** Tạo mailer từ biến môi trường. Không cấu hình SMTP: console khi phát triển, null (tắt tính năng email) khi production. */
export function mailerFromEnv(env = process.env, log = console) {
  if (env.SMTP_HOST) {
    const port = Number(env.SMTP_PORT) || 587;
    return createSmtpMailer({
      host: env.SMTP_HOST,
      port,
      secure: env.SMTP_SECURE ? env.SMTP_SECURE === '1' : port === 465,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.SMTP_FROM,
    });
  }
  if (env.NODE_ENV === 'production') {
    log.warn?.('[mail] SMTP_HOST chưa được cấu hình: email khôi phục mật khẩu bị TẮT.');
    return null;
  }
  log.warn?.('[mail] SMTP_HOST chưa được cấu hình: dùng mailer console (mã sẽ in ra màn hình, chỉ để phát triển).');
  return createConsoleMailer(log);
}
