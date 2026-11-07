import { randomUUID } from 'node:crypto';
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

/**
 * Báo lỗi nghiệp vụ (AuthError) hoặc lỗi nội bộ dưới dạng JSON.
 * [log] (tuỳ chọn): logger để ghi lỗi nội bộ; mặc định dùng console cho tương thích ngược.
 * Lỗi nghiệp vụ (AuthError) KHÔNG ghi log (đó là hành vi mong đợi, vd sai mật khẩu).
 */
export function sendError(send, res, err, log = console) {
  if (err instanceof AuthError) {
    send(res, err.status, { ok: false, error: err.code });
  } else {
    if (typeof log.error === 'function') log.error({ err }, 'Lỗi nội bộ khi xử lý HTTP');
    else console.error('[http]', err);
    send(res, 500, { ok: false, error: 'internal_error' });
  }
}

/**
 * Ghi log một vòng đời yêu cầu HTTP (truy cập log) vào logger Pino.
 *
 * Gắn `res.on('finish')` để log sau khi phản hồi xong, kèm:
 *   http.request.method, url.path, http.response.status_code, event.duration (ms),
 *   client.ip, user_agent.original, trace.id (request id, cũng trả về cho client qua header x-request-id).
 *
 * Trả về `requestId` để nơi gọi gắn vào `req` nếu muốn.
 */
export function logHttpRequest(logger, req, res, { trustProxy = false } = {}) {
  if (!logger || typeof logger.info !== 'function') return null;
  const start = process.hrtime.bigint();
  const requestId = (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'])
    || randomUUID();
  const { ip, userAgent } = requestContext(req, trustProxy);

  // Để client/đối tác lần được dòng log tương ứng.
  res.setHeader('x-request-id', requestId);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const status = res.statusCode;
    const fields = {
      'trace.id': requestId,
      http: {
        request: { method: req.method },
        response: { status_code: status },
      },
      url: { path: (req.url ?? '/').split('?')[0] },
      client: { ip },
      user_agent: { original: userAgent },
      'event.duration_ms': Math.round(durationMs * 1000) / 1000,
    };
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    logger[level](fields, `${req.method} ${fields.url.path} ${status}`);
  });

  return requestId;
}
