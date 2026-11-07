import { hostname } from 'node:os';
import pino from 'pino';

/**
 * Logger tập trung dựa trên Pino.
 *
 * Mục tiêu: log ra JSON một dòng (NDJSON) dễ nuốt bởi ELK, Grafana Loki, Datadog,
 * AWS CloudWatch Logs... mà KHÔNG cần parser riêng. Vì vậy ta chuẩn hoá tên trường
 * theo quy ước phổ biến nhất:
 *
 *   - `@timestamp`  : mốc thời gian ISO-8601 (Elastic Common Schema + Datadog hiểu ngay).
 *   - `log.level`   : mức log dạng chữ ("info"/"error"...) — ECS/Datadog `status`.
 *   - `message`     : nội dung log — ECS/Datadog `message` (không dùng `msg` mặc định của Pino).
 *   - `service.name`, `service.version`, `service.environment` : nhận diện dịch vụ (ECS).
 *   - `error.type`, `error.message`, `error.stack_trace` : lỗi theo ECS (serializer bên dưới).
 *
 * Dev (NODE_ENV != 'production') có thể bật in màu dễ đọc bằng pino-pretty khi đặt
 * LOG_PRETTY=1. Production luôn in JSON thuần để log collector thu thập.
 */

const DEFAULT_SERVICE_NAME = 'xiangqi-server';

/** Chuyển Error -> hình dạng ECS (error.type / error.message / error.stack_trace). */
function ecsErrorSerializer(err) {
  if (!err || typeof err !== 'object') return err;
  const out = {
    type: err.name ?? err.constructor?.name ?? 'Error',
    message: err.message ?? String(err),
    stack_trace: err.stack,
  };
  // Giữ lại các trường nghiệp vụ hữu ích (vd AuthError.code / .status) nhưng không đè field chuẩn.
  if (err.code !== undefined) out.code = err.code;
  if (err.status !== undefined) out.status = err.status;
  return out;
}

/**
 * Tạo một logger Pino đã cấu hình.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {object} [overrides] ghi đè tuỳ chọn Pino (chủ yếu cho test, vd truyền `destination`).
 * @returns {import('pino').Logger}
 */
export function createLogger(env = process.env, overrides = {}) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProd = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';
  // Mặc định im lặng khi chạy test (trừ khi LOG_LEVEL được đặt rõ) để không làm nhiễu output.
  const defaultLevel = isTest ? 'silent' : isProd ? 'info' : 'debug';
  const level = env.LOG_LEVEL ?? defaultLevel;
  // Dev được in đẹp khi LOG_PRETTY=1 (mặc định TẮT để không phụ thuộc pino-pretty lúc chạy thật).
  const pretty = env.LOG_PRETTY === '1' && !isProd;

  const options = {
    level,
    // "message" thay cho "msg" để khớp ECS/Datadog/Loki mà không cần cấu hình thêm.
    messageKey: 'message',
    // "log.level" dạng chuỗi + "@timestamp" ISO-8601 (thay cho "level":30 và "time":epoch).
    formatters: {
      level: (label) => ({ 'log.level': label }),
      // `bindings` nhận cả `base` bên dưới + pid/hostname. Phải GIỮ LẠI mọi trường (nhất là
      // `service`) rồi mới đổi tên pid/hostname sang chuẩn ECS, nếu không `service` sẽ bị mất.
      bindings: ({ pid, hostname, ...rest }) => ({
        ...rest,
        'process.pid': pid,
        'host.name': hostname,
      }),
    },
    timestamp: () => `,"@timestamp":"${new Date().toISOString()}"`,
    // Gắn vào MỌI dòng log (đi qua formatter `bindings` ở trên để đổi tên pid/hostname theo ECS).
    base: {
      pid: process.pid,
      hostname: hostname(),
      service: {
        name: env.SERVICE_NAME ?? DEFAULT_SERVICE_NAME,
        version: env.SERVICE_VERSION ?? env.npm_package_version ?? undefined,
        environment: nodeEnv,
      },
    },
    serializers: {
      err: ecsErrorSerializer,
      error: ecsErrorSerializer,
    },
    // Không bao giờ in bí mật ra log, dù lỡ truyền nhầm vào object log.
    redact: {
      paths: [
        'password',
        'newPassword',
        'currentPassword',
        'token',
        'accessToken',
        'refreshToken',
        'auth.token',
        'authorization',
        'req.headers.authorization',
        'headers.authorization',
        '*.password',
        '*.token',
      ],
      censor: '[REDACTED]',
    },
    ...overrides,
  };

  if (pretty) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        messageKey: 'message',
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,service,process.pid,host.name',
      },
    };
  }

  return pino(options, overrides.destination);
}

/**
 * Bộ chuyển tiếp để truyền vào những API cũ chỉ nhận `log(message)` dạng hàm
 * (vd scripts/migrate.js). Mỗi lời gọi được ghi ở mức `info`.
 */
export function logFn(logger) {
  return (message, ...rest) => logger.info(rest.length ? { details: rest } : {}, String(message));
}
