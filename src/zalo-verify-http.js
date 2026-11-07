/**
 * Xác thực domain với Zalo Platform.
 *
 * Zalo yêu cầu chứng minh bạn sở hữu domain trước khi cho dùng đăng nhập Zalo. Cách phổ biến
 * là phục vụ một file HTML tĩnh ở gốc domain, có tên và nội dung do Zalo cấp:
 *
 *   GET /zalo_verifierXXXX.html  ->  zalo-platform-site-verification=XXXX
 *
 * Vì không chỉnh được DNS/subdomain, ta phục vụ file này trực tiếp từ server.
 * Tên file và chuỗi mã nằm trong biến môi trường để KHÔNG hard-code và dễ đổi khi Zalo cấp lại:
 *
 *   ZALO_VERIFY_FILE  : tên file Zalo yêu cầu, ví dụ zalo_verifierPu-o28wjPmrbqkHNvEDLR3oHtJBGvmPgDJ8p.html
 *   ZALO_VERIFY_CODE  : chuỗi mã, ví dụ Pu-o28wjPmrbqkHNvEDLR3oHtJBGvmPgDJ8p
 *                       (nội dung trả về luôn có tiền tố zalo-platform-site-verification=)
 *
 * Trả về handler theo đúng giao ước của các route khác: xử lý xong trả true, không phải route này trả false.
 */
export function createZaloVerifyRoute({ verifyFile = '', verifyCode = '' } = {}) {
  // Chuẩn hoá: đảm bảo đường dẫn bắt đầu bằng '/'. Bỏ qua nếu thiếu cấu hình.
  const path = verifyFile ? (verifyFile.startsWith('/') ? verifyFile : `/${verifyFile}`) : '';
  const body = verifyCode ? `zalo-platform-site-verification=${verifyCode}` : '';

  return async function handle(req, res) {
    if (!path || !body) return false;
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
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
