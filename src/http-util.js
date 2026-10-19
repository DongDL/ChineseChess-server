import { AuthError } from './auth.js';

const MAX_BODY_BYTES = 4096;

/** Đọc thân yêu cầu dạng JSON (tối đa 4 KB). Thân rỗng được coi là {}. */
export function readJson(req) {
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

export function bearerToken(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

/** Hàm gửi phản hồi JSON kèm tiêu đề CORS (cho app web) và chặn cache. */
export function makeJsonSender(corsOrigin) {
  return (res, status, body, extraHeaders = {}) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': corsOrigin,
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '600',
      ...extraHeaders,
    });
    res.end(JSON.stringify(body));
  };
}

/** Ngữ cảnh yêu cầu để ghi lịch sử đăng nhập. [trustProxy]: tin X-Forwarded-For (chỉ khi có proxy đáng tin). */
export function requestContext(req, trustProxy = false) {
  let ip = req.socket.remoteAddress ?? 'unknown';
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim() !== '') ip = fwd.split(',')[0].trim();
  }
  const ua = req.headers['user-agent'];
  return { ip, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null };
}

/** Báo lỗi nghiệp vụ (AuthError) hoặc lỗi nội bộ dưới dạng JSON. */
export function sendError(send, res, err) {
  if (err instanceof AuthError) {
    send(res, err.status, { ok: false, error: err.code });
  } else {
    console.error('[http]', err);
    send(res, 500, { ok: false, error: 'internal_error' });
  }
}
