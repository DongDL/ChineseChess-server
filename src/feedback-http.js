import { AuthError } from './auth.js';
import { bearerToken, makeJsonSender, sendError } from './http-util.js';

// Giới hạn tổng dung lượng tệp đính kèm người dùng gửi lên: 10 MB (tính theo byte thật, sau giải mã base64).
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// Thân yêu cầu gửi lên là JSON có base64 nên phình ~4/3; thêm chỗ cho chủ đề/nội dung và vài tệp.
// Cho tối đa ~14 MB JSON để 10 MB tệp (đã base64 ≈ 13,4 MB) vẫn lọt.
const MAX_BODY_BYTES = 14 * 1024 * 1024;
const MAX_SUBJECT_LEN = 200;
const MAX_BODY_LEN = 20_000;
const MAX_FILES = 10;
const MAX_FILENAME_LEN = 200;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Đọc thân yêu cầu JSON lớn (cho thư góp ý có tệp đính kèm). Vượt [MAX_BODY_BYTES] -> 413. */
function readLargeJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AuthError('payload_too_large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return resolve(body && typeof body === 'object' ? body : {});
      } catch {
        return reject(new AuthError('bad_json', 400));
      }
    });
    req.on('error', () => reject(new AuthError('bad_request', 400)));
  });
}

const cleanLine = (raw) => String(raw ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();

/** Chuẩn hoá và kiểm tra một tệp đính kèm { name, dataBase64 } -> { filename, content: Buffer, size }. */
function parseAttachment(raw) {
  if (!raw || typeof raw !== 'object') throw new AuthError('invalid_attachment', 400);
  const filename = cleanLine(raw.name).slice(0, MAX_FILENAME_LEN) || 'tệp-đính-kèm';
  const b64 = typeof raw.dataBase64 === 'string' ? raw.dataBase64 : '';
  // Base64 phải hợp lệ; chuỗi rỗng là tệp 0 byte, vẫn chấp nhận.
  let content;
  try {
    content = Buffer.from(b64, 'base64');
  } catch {
    throw new AuthError('invalid_attachment', 400);
  }
  return { filename, content, size: content.length, contentType: cleanLine(raw.type) || undefined };
}

/**
 * Đường dẫn gửi thư góp ý:
 *
 *   POST /feedback  { subject, body, attachments?: [{ name, dataBase64, type? }] }  -> { ok: true }
 *
 * - Không bắt buộc đăng nhập; nếu có Bearer hợp lệ thì đính kèm thông tin người gửi vào thư.
 * - Tổng dung lượng tệp (sau giải mã) không vượt 10 MB; vượt -> 413 attachment_too_large.
 * - Thiếu [mailer] (server chưa cấu hình SMTP) -> 503 email_unavailable.
 * - Địa chỉ nhận: [feedbackTo] (mặc định lấy SMTP_USER / SMTP_FROM lúc dựng app).
 */
export function createFeedbackRoute(mailer, {
  corsOrigin = '*', feedbackTo, appName = 'Cờ tướng online', auth = null, log = console,
} = {}) {
  const send = makeJsonSender(corsOrigin);

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/feedback') return false;

    if (req.method === 'OPTIONS') {
      send(res, 204, {});
      return true;
    }

    try {
      if (req.method !== 'POST') throw new AuthError('not_found', 404);
      if (!mailer || !feedbackTo) throw new AuthError('email_unavailable', 503);

      const payload = await readLargeJson(req);
      const subject = cleanLine(payload.subject).slice(0, MAX_SUBJECT_LEN);
      const bodyText = String(payload.body ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
      if (!subject) throw new AuthError('subject_required', 400);
      if (!bodyText) throw new AuthError('body_required', 400);
      if (bodyText.length > MAX_BODY_LEN) throw new AuthError('body_too_long', 400);

      const rawFiles = Array.isArray(payload.attachments) ? payload.attachments : [];
      if (rawFiles.length > MAX_FILES) throw new AuthError('too_many_files', 400);
      const attachments = rawFiles.map(parseAttachment);
      const totalBytes = attachments.reduce((n, a) => n + a.size, 0);
      if (totalBytes > MAX_ATTACHMENT_BYTES) throw new AuthError('attachment_too_large', 413);

      // Người gửi (nếu đã đăng nhập) để tiện liên hệ lại; không bắt buộc.
      let sender = null;
      if (auth) {
        const user = await auth.authenticate(bearerToken(req)).catch(() => null);
        if (user) sender = { id: user.id, name: user.displayName ?? null };
      }

      const header = [
        `Thư góp ý từ ứng dụng ${appName}`,
        sender ? `Người gửi: ${sender.name ?? '(không tên)'} (id ${sender.id})` : 'Người gửi: khách (chưa đăng nhập)',
        `Thời điểm: ${new Date().toISOString()}`,
        '',
        '----------------------------------------',
        '',
      ].join('\n');

      // Lỗi gửi thư là lỗi hạ tầng (SMTP từ chối, mất mạng...), không phải lỗi nhập liệu của người dùng:
      // trả email_send_failed (502) và LOG chi tiết để chẩn đoán, thay vì 500 internal_error mơ hồ.
      try {
        await mailer.send({
          to: feedbackTo,
          subject: `[Góp ý] ${subject}`,
          text: header + bodyText,
          attachments: attachments.map(({ filename, content, contentType }) => ({ filename, content, contentType })),
        });
      } catch (err) {
        log.error?.({ err }, 'Gửi thư góp ý thất bại');
        throw new AuthError('email_send_failed', 502);
      }

      send(res, 200, { ok: true });
    } catch (err) {
      sendError(send, res, err, log);
    }
    return true;
  };
}
