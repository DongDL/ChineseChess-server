/**
 * Xác thực domain với Zalo Platform.
 *
 * Zalo yêu cầu chứng minh bạn sở hữu domain trước khi cho dùng đăng nhập Zalo: tải một file HTML
 * (Zalo cấp sẵn) lên website, đặt tại ĐÚNG đường dẫn Zalo chỉ định, rồi bấm "Xác thực". Zalo sẽ
 * gọi URL đó và kỳ vọng thấy NGUYÊN VĂN trang HTML đã tải xuống (bên trong có thẻ meta
 * `zalo-platform-site-verification`).
 *
 * Vì không chỉnh được DNS/subdomain, ta phục vụ file này trực tiếp từ server. Tất cả nằm trong
 * biến môi trường để KHÔNG hard-code và dễ đổi khi Zalo cấp lại, không phải sửa code:
 *
 *   ZALO_VERIFY_FILE : đường dẫn Zalo yêu cầu, KHỚP TỪNG KÝ TỰ, gồm cả path, ví dụ
 *                      /auth/oauth/zalo/callback/zalo_verifierPu-o28wjPmrbqkHNvEDLR3oHtJBGvmPgDJ8p.html
 *   ZALO_VERIFY_HTML : (ưu tiên) nội dung HTML y hệt file Zalo cấp, đặt trên một dòng.
 *   ZALO_VERIFY_CODE : (dự phòng) chỉ mã; khi không có ZALO_VERIFY_HTML, server tự dựng trang HTML
 *                      tối thiểu có thẻ meta mà Zalo kiểm tra.
 *
 * Trả về handler theo đúng giao ước các route khác: xử lý xong trả true, không phải route này trả false.
 */
export function createZaloVerifyRoute({ verifyFile = '', verifyHtml = '', verifyCode = '' } = {}) {
  // Chuẩn hoá: đảm bảo đường dẫn bắt đầu bằng '/'. Bỏ qua route nếu thiếu cấu hình đường dẫn.
  const path = verifyFile ? (verifyFile.startsWith('/') ? verifyFile : `/${verifyFile}`) : '';

  // Ưu tiên nội dung HTML nguyên văn; nếu chỉ có mã thì dựng trang HTML tối thiểu đúng chuẩn Zalo.
  const html = verifyHtml
    ? verifyHtml
    : verifyCode
      ? `<!DOCTYPE html><html lang="en"><head><meta property="zalo-platform-site-verification" content="${verifyCode}" /></head><body></body></html>`
      : '';

  return async function handle(req, res) {
    if (!path || !html) return false;
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return true;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : html);
    return true;
  };
}
