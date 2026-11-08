/**
 * Xác thực domain với Zalo Platform.
 *
 * Zalo yêu cầu chứng minh bạn sở hữu domain trước khi cho dùng đăng nhập Zalo: tải một file HTML
 * (Zalo cấp sẵn) lên website, đặt tại ĐÚNG đường dẫn Zalo chỉ định, rồi bấm "Xác thực". Zalo sẽ
 * gọi URL đó và kỳ vọng thấy NGUYÊN VĂN trang HTML đã tải xuống (bên trong có thẻ meta
 * `zalo-platform-site-verification`).
 *
 * Zalo có thể yêu cầu NHIỀU đường dẫn cùng lúc (ví dụ cả ở gốc domain lẫn dưới đường dẫn callback),
 * nên route này nhận một DANH SÁCH mục, mỗi mục gồm:
 *   - file : đường dẫn cần phục vụ (gồm cả path con), KHỚP TỪNG KÝ TỰ với URL Zalo đưa.
 *   - html : (ưu tiên) nội dung trả về y hệt Zalo cấp (có thể là cả trang HTML, hoặc chuỗi text thuần).
 *   - code : (dự phòng) chỉ mã; khi thiếu html, server tự dựng trang HTML tối thiểu có thẻ meta.
 *   - type : (tuỳ chọn) content-type, mặc định 'text/html'. Chấp nhận MIME đầy đủ ('text/html',
 *            'text/plain') hoặc viết tắt ('html', 'plain', 'txt'). Dùng kiểu text cho đường dẫn mà Zalo
 *            chỉ cần chuỗi "zalo-platform-site-verification=<mã>".
 *
 * Vì không chỉnh được DNS/subdomain, ta phục vụ các file này trực tiếp từ server. Tất cả nằm trong
 * biến môi trường để KHÔNG hard-code và dễ đổi khi Zalo cấp lại, không phải sửa code.
 *
 * Trả về handler theo đúng giao ước các route khác: xử lý xong trả true, không phải route này trả false.
 */
export function createZaloVerifyRoute(config = {}) {
  // Chấp nhận cả dạng cũ (một mục { verifyFile, verifyHtml, verifyCode }) lẫn dạng mới ({ entries: [...] }).
  const rawEntries = Array.isArray(config.entries)
    ? config.entries
    : [{ file: config.verifyFile, html: config.verifyHtml, code: config.verifyCode }];

  const minimalHtml = (code) => `<!DOCTYPE html><html lang="en"><head>`
    + `<meta property="zalo-platform-site-verification" content="${code}" />`
    + `</head><body></body></html>`;

  // Chuẩn hoá content-type: chấp nhận viết tắt phổ biến để tránh nhầm (vd đặt "html" thay vì "text/html"
  // sẽ sinh ra header sai khiến trình duyệt hiển thị HTML dưới dạng text thuần). Giá trị đã có dấu "/"
  // được coi là MIME đầy đủ và giữ nguyên; rỗng -> mặc định text/html.
  const mimeOf = (type) => {
    const t = String(type ?? '').trim().toLowerCase();
    if (!t) return 'text/html';
    if (t.includes('/')) return t; // đã là MIME đầy đủ, vd text/html, text/plain
    const alias = { html: 'text/html', htm: 'text/html', text: 'text/plain', plain: 'text/plain', txt: 'text/plain' };
    return alias[t] ?? 'text/html';
  };

  // path -> { body, type }. Bỏ qua mục thiếu đường dẫn hoặc thiếu cả html/code.
  // Zalo yêu cầu KHÁC nhau tuỳ đường dẫn: có nơi cần cả trang HTML, có nơi chỉ cần chuỗi text thuần
  // "zalo-platform-site-verification=<mã>". `type` cho phép đặt content-type phù hợp (mặc định text/html).
  const byPath = new Map();
  for (const e of rawEntries) {
    const file = e?.file ?? '';
    if (!file) continue;
    const path = file.startsWith('/') ? file : `/${file}`;
    const body = e.html ? e.html : e.code ? minimalHtml(e.code) : '';
    if (!body) continue;
    byPath.set(path, { body, type: mimeOf(e.type) });
  }

  return async function handle(req, res) {
    if (byPath.size === 0) return false;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const entry = byPath.get(url.pathname);
    if (entry === undefined) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return true;
    }
    res.writeHead(200, {
      'content-type': `${entry.type}; charset=utf-8`,
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : entry.body);
    return true;
  };
}
