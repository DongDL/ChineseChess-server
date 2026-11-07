import fs from 'node:fs';
import path from 'node:path';

/**
 * Đọc chứng chỉ TLS để bật HTTPS.
 *
 * HTTPS là TUỲ CHỌN: thiếu hoặc sai đường dẫn chứng chỉ thì server vẫn chạy bình thường bằng HTTP
 * (trên Railway/Render/Fly thì TLS do chính nền tảng lo, server chỉ cần nói HTTP). Chỉ khi chạy máy
 * cục bộ hoặc tự dựng máy chủ mới cần cấu hình ở đây.
 *
 * Biến môi trường:
 *   TLS_KEY_FILE  — khoá riêng (PEM). Mặc định: .ssl/localhost-key.pem
 *   TLS_CERT_FILE — chứng chỉ (PEM). Mặc định: .ssl/localhost.pem
 *   TLS_CA_FILE   — chuỗi chứng chỉ trung gian (PEM), tuỳ chọn
 *   TLS_PASSPHRASE— mật khẩu của khoá riêng, nếu khoá được mã hoá
 *
 * Đường dẫn tương đối được tính từ thư mục gốc của project (nơi chạy `npm start`).
 *
 * Trả về object tuỳ chọn cho https.createServer, hoặc null nếu không bật được HTTPS.
 */
export function tlsOptionsFromEnv(env = process.env, { log = console, cwd = process.cwd() } = {}) {
  const resolve = (p) => (p ? path.resolve(cwd, p) : null);
  const keyFile = resolve(env.TLS_KEY_FILE ?? env.TLS_KEY_PATH ?? '.ssl/localhost-key.pem');
  const certFile = resolve(env.TLS_CERT_FILE ?? env.TLS_CERT_PATH ?? '.ssl/localhost.pem');
  const caFile = resolve(env.TLS_CA_FILE ?? env.TLS_CA_PATH ?? '');

  // Người dùng đặt biến môi trường = CHỦ Ý bật HTTPS, nên thiếu file phải báo lỗi rõ chứ không im lặng bỏ qua.
  const explicit = Boolean(env.TLS_KEY_FILE || env.TLS_KEY_PATH || env.TLS_CERT_FILE || env.TLS_CERT_PATH);

  const missing = [keyFile, certFile].filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    const how = 'Tạo chứng chỉ cho máy cục bộ: `mkcert -key-file .ssl/localhost-key.pem -cert-file .ssl/localhost.pem localhost 127.0.0.1 10.0.2.2`';
    if (explicit) {
      log.warn?.(`CẢNH BÁO: HTTPS bị tắt vì không tìm thấy chứng chỉ:\n  ${missing.join('\n  ')}\n${how}`);
    } else {
      // Tương thích cả console (log.log) lẫn logger Pino (log.info).
      const info = typeof log.info === 'function' ? log.info.bind(log) : log.log?.bind(log);
      info?.(`HTTPS: chưa bật (không có ${path.relative(cwd, certFile)}). ${how}`);
    }
    return null;
  }

  try {
    return {
      key: fs.readFileSync(keyFile),
      cert: fs.readFileSync(certFile),
      ...(caFile && fs.existsSync(caFile) ? { ca: fs.readFileSync(caFile) } : {}),
      ...(env.TLS_PASSPHRASE ? { passphrase: env.TLS_PASSPHRASE } : {}),
      // Chặn các phiên bản TLS đã lỗi thời (SSLv3/TLS 1.0/1.1).
      minVersion: 'TLSv1.2',
    };
  } catch (err) {
    log.warn?.(`CẢNH BÁO: HTTPS bị tắt vì không đọc được chứng chỉ: ${err.message}`);
    return null;
  }
}
