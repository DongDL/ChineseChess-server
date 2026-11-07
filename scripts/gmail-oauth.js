// =============================================================================
// Lấy GMAIL_REFRESH_TOKEN (chạy MỘT LẦN trên máy cục bộ)
//
// Vì sao: Render free chặn cổng SMTP ra ngoài, nên server gửi thư qua Gmail API (HTTPS). Gmail API
// cần một "refresh token" OAuth2 (sống lâu) với quyền gửi thư. Script này mở trình duyệt để bạn
// đăng nhập Google và đồng ý, rồi in ra refresh token để dán vào .env (GMAIL_REFRESH_TOKEN).
//
// CHUẨN BỊ (Google Cloud Console — https://console.cloud.google.com/apis/credentials):
//   1) Tạo OAuth client ID RIÊNG cho việc gửi mail (GMAIL_CLIENT_ID), loại "Web application".
//      KHÔNG dùng chung client đăng nhập Google (GOOGLE_CLIENT_ID) — gửi mail có cấu hình riêng.
//   2) Thêm vào "Authorized redirect URIs":  http://localhost:4571/oauth2callback
//      (phải trùng TUYỆT ĐỐI với REDIRECT bên dưới; cổng có thể đổi bằng biến PORT).
//   3) Bật "Gmail API" cho project:  APIs & Services -> Library -> Gmail API -> Enable.
//   4) Nếu màn hình đồng ý (OAuth consent screen) ở chế độ "Testing", thêm email Gmail dùng để
//      gửi thư vào danh sách "Test users" (nếu không sẽ bị chặn khi đồng ý).
//
// CHẠY (trong thư mục ChineseChess-server) — luôn dùng GMAIL_CLIENT_ID/SECRET, KHÔNG dùng GOOGLE_*:
//   # Nếu .env đã có GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET:
//   node --env-file=.env scripts/gmail-oauth.js
//   # Hoặc truyền trực tiếp (PowerShell):
//   $env:GMAIL_CLIENT_ID="..."; $env:GMAIL_CLIENT_SECRET="..."; node scripts/gmail-oauth.js
//
// Sau khi đồng ý, script in ra refresh token. Dán vào .env:
//   GMAIL_REFRESH_TOKEN=<token vừa in>
//   GMAIL_SENDER=<email Gmail vừa đồng ý>   # thường trùng SMTP_USER
// =============================================================================

import http from 'node:http';
import { randomBytes } from 'node:crypto';

const env = process.env;
const CLIENT_ID = env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = env.GMAIL_CLIENT_SECRET;
const PORT = Number(env.OAUTH_HELPER_PORT || 4571);
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Thiếu GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET (client RIÊNG cho gửi mail, không phải GOOGLE_*).');
  console.error('Chạy:  node --env-file=.env scripts/gmail-oauth.js');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline', // bắt buộc để nhận refresh_token
  prompt: 'consent', // buộc hiện màn hình đồng ý để chắc chắn có refresh_token mới
  state,
}).toString()}`;

async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Đổi code lỗi (${res.status}): ${data.error_description || data.error || 'không rõ'}`);
  }
  return data;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404).end('not found');
    return;
  }
  const reply = (msg) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<p>${msg}</p>`); };

  if (url.searchParams.get('state') !== state) {
    reply('Sai state — thử lại.');
    return;
  }
  const err = url.searchParams.get('error');
  if (err) {
    reply(`Bị từ chối: ${err}. Có thể quay lại terminal, Ctrl+C và thử lại.`);
    console.error(`\nNgười dùng từ chối hoặc lỗi: ${err}`);
    server.close();
    return;
  }
  const code = url.searchParams.get('code');
  try {
    const token = await exchangeCode(code);
    if (!token.refresh_token) {
      reply('KHÔNG nhận được refresh_token. Hãy xoá quyền cũ tại https://myaccount.google.com/permissions rồi chạy lại.');
      console.error('\nKhông có refresh_token trong phản hồi. Nguyên nhân thường gặp: tài khoản đã cấp quyền trước đó.');
      console.error('Xoá quyền của app tại https://myaccount.google.com/permissions rồi chạy lại script.');
    } else {
      reply('Xong! Quay lại terminal để lấy refresh token.');
      console.log('\n==================== THÀNH CÔNG ====================');
      console.log('Dán các dòng sau vào .env (ChineseChess-server):\n');
      console.log(`GMAIL_REFRESH_TOKEN=${token.refresh_token}`);
      console.log('GMAIL_SENDER=<email Gmail bạn vừa đồng ý>   # thường trùng SMTP_USER');
      console.log('\n(Không cần đặt GMAIL_CLIENT_ID/SECRET nếu đã có GOOGLE_CLIENT_ID/SECRET.)');
      console.log('====================================================\n');
    }
  } catch (e) {
    reply(`Lỗi đổi code: ${e.message}`);
    console.error(`\n${e.message}`);
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log('Mở đường dẫn sau trong trình duyệt để cấp quyền gửi thư Gmail:\n');
  console.log(`  ${authUrl}\n`);
  console.log(`(Đang chờ chuyển hướng về ${REDIRECT} ...)`);
});
