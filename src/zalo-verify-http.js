/**
 * Xác thực domain với Zalo Platform.
 *
 * Zalo yêu cầu chứng minh bạn sở hữu domain trước khi cho dùng đăng nhập Zalo: tải một file
 * (Zalo cấp sẵn) lên website, đặt tại ĐÚNG đường dẫn Zalo chỉ định, rồi bấm "Xác thực". Zalo sẽ
 * gọi URL đó và kỳ vọng thấy NGUYÊN VĂN nội dung đã tải xuống (chứa chuỗi/thẻ meta
 * `zalo-platform-site-verification`).
 *
 * Vì không chỉnh được DNS/subdomain, ta phục vụ nội dung này trực tiếp từ server. Cấu hình nằm trong
 * biến môi trường để KHÔNG hard-code và dễ đổi khi Zalo cấp lại, không phải sửa code:
 *
 *   file    : đường dẫn cần phục vụ (gồm cả path con), KHỚP TỪNG KÝ TỰ với URL Zalo đưa.
 *   content : (ưu tiên) nội dung trả về y hệt Zalo cấp (text thuần hoặc cả trang HTML).
 *   code    : (dự phòng) chỉ mã; khi thiếu content, server tự dựng trang HTML tối thiểu có thẻ meta.
 *   type    : (tuỳ chọn) content-type, mặc định 'text/html'. Chấp nhận MIME đầy đủ ('text/html',
 *             'text/plain') hoặc viết tắt ('html', 'plain', 'txt').
 *
 * Trả về handler theo đúng giao ước các route khác: xử lý xong trả true, không phải route này trả false.
 */
export function createZaloVerifyRoute({ file = '', content = '', code = '', type = '' } = {}) {
  // Chuẩn hoá đường dẫn: đảm bảo bắt đầu bằng '/'. Bỏ qua route nếu thiếu cấu hình.
  const path = file ? (file.startsWith('/') ? file : `/${file}`) : '';

  const minimalHtml = (c) => `<!DOCTYPE html><html lang="en"><head>`
    + `<meta property="zalo-platform-site-verification" content="${c}" />`
    + `</head><body></body></html>`;
  const body = content ? content : code ? minimalHtml(code) : '';

  // Chuẩn hoá content-type: chấp nhận viết tắt phổ biến để tránh nhầm (vd đặt "html" thay vì "text/html"
  // sẽ sinh ra header sai khiến trình duyệt hiển thị HTML dưới dạng text thuần). Giá trị đã có dấu "/"
  // được coi là MIME đầy đủ và giữ nguyên; rỗng -> mặc định text/html.
  const mimeOf = (t) => {
    const s = String(t ?? '').trim().toLowerCase();
    if (!s) return 'text/html';
    if (s.includes('/')) return s;
    const alias = { html: 'text/html', htm: 'text/html', text: 'text/plain', plain: 'text/plain', txt: 'text/plain' };
    return alias[s] ?? 'text/html';
  };
  const contentType = `${mimeOf(type)}; charset=utf-8`;

  return async function handle(req, res) {
    if (!path || !body) return false;
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return true;
    }
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
