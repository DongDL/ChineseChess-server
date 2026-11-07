import { readFile } from 'node:fs/promises';
import path from 'node:path';
import swaggerUiDist from 'swagger-ui-dist';
import { buildOpenApiSpec } from './openapi.js';

// Thư mục chứa toàn bộ asset tĩnh của Swagger UI (bản cài qua npm, không phụ thuộc gì thêm).
const UI_DIR = swaggerUiDist.getAbsoluteFSPath();

// Chỉ phục vụ các tệp tĩnh cần cho trang Swagger UI; tránh lộ tệp khác trong thư mục module.
const STATIC_FILES = new Set([
  'swagger-ui.css',
  'swagger-ui-bundle.js',
  'swagger-ui-standalone-preset.js',
  'index.css',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'oauth2-redirect.html',
]);

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const mimeOf = (name) => MIME[path.extname(name)] ?? 'application/octet-stream';

/**
 * Trang HTML tự khởi tạo Swagger UI, trỏ tới /docs/openapi.json.
 * Nạp JS/CSS từ chính route này (đường dẫn tương đối) nên không cần CDN.
 */
const indexHtml = (basePath) => `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API Cờ Tướng Online</title>
  <link rel="stylesheet" href="${basePath}/swagger-ui.css" />
  <link rel="icon" type="image/png" href="${basePath}/favicon-32x32.png" sizes="32x32" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${basePath}/swagger-ui-bundle.js"></script>
  <script src="${basePath}/swagger-ui-standalone-preset.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '${basePath}/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'StandaloneLayout',
      persistAuthorization: true,
    });
  </script>
</body>
</html>`;

/**
 * Route tài liệu API (Swagger UI), phục vụ dưới tiền tố /docs:
 *
 *   GET /docs            -> trang Swagger UI
 *   GET /docs/openapi.json -> đặc tả OpenAPI 3.1 (JSON)
 *   GET /docs/<asset>    -> tệp tĩnh của Swagger UI
 *
 * Chỉ bật khi [enabled] = true (mặc định bật; có thể tắt ở môi trường production
 * bằng biến môi trường DOCS_ENABLED=0).
 *
 * [appVersion]: hiện trên tiêu đề tài liệu.
 * [publicUrl]: nếu có, thêm vào danh sách server để "Try it out" gọi đúng địa chỉ.
 */
export function createDocsRoute({ appVersion = '1.0.0', publicUrl = '', enabled = true } = {}) {
  const basePath = '/docs';

  // Dựng đặc tả một lần (tĩnh theo vòng đời tiến trình). servers giúp nút "Try it out"
  // gọi đúng host: ưu tiên PUBLIC_URL nếu có, luôn kèm "/" để chạy ngay trên host đang mở.
  const servers = [];
  if (publicUrl) servers.push({ url: publicUrl, description: 'Public URL' });
  servers.push({ url: '/', description: 'Host hiện tại (dùng ngay trên trang này)' });
  const spec = buildOpenApiSpec({ appVersion, servers });
  const specJson = JSON.stringify(spec);

  return async function handle(req, res) {
    if (!enabled) return false;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return false;

    // Chỉ cho GET/HEAD; các method khác trên /docs coi như không tồn tại.
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    // Chuẩn hoá /docs -> /docs/ để đường dẫn tương đối của asset hoạt động đúng.
    if (pathname === basePath) {
      res.writeHead(302, { location: `${basePath}/` });
      res.end();
      return true;
    }

    // Phần sau tiền tố: '' (trang chủ), 'openapi.json', hoặc tên tệp tĩnh.
    const rest = pathname.slice(basePath.length + 1);

    if (rest === '' || rest === 'index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(indexHtml(basePath));
      return true;
    }

    if (rest === 'openapi.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(specJson);
      return true;
    }

    if (STATIC_FILES.has(rest)) {
      try {
        const data = await readFile(path.join(UI_DIR, rest));
        res.writeHead(200, { 'content-type': mimeOf(rest), 'cache-control': 'public, max-age=3600' });
        res.end(data);
      } catch {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      }
      return true;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    return true;
  };
}
