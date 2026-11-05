# Xiangqi Server (Node.js + Socket.IO + PostgreSQL)

Server cờ tướng online. **Server là trọng tài**: client chỉ gửi *ý định* đi quân, server kiểm tra bằng engine luật
rồi mới phát nước đi cho cả hai bên. Có đồng hồ, luật lặp nước / chiếu liên tục, đăng nhập (mật khẩu, Google,
Facebook, Zalo, hoặc chơi với tư cách khách), và lưu ván đấu + lịch sử đăng nhập vào PostgreSQL.

## Chạy

```bash
npm install
docker compose up -d                       # PostgreSQL (hoặc dùng PostgreSQL có sẵn của bạn)
#   cấu hình nằm trong .env (file duy nhất, đã gitignore) — chỉnh trực tiếp, hoặc đặt biến môi trường
DATABASE_URL=postgres://xiangqi:xiangqi@localhost:5432/xiangqi npm start     # http://localhost:3000  (GET /health)
#   có TLS_KEY_FILE + TLS_CERT_FILE thì thêm cả https://localhost:3443 — xem mục "HTTPS"
npm run migrate                            # tạo/nâng cấp bảng thủ công (server tự làm khi AUTO_MIGRATE != 0)
npm run demo -- http://localhost:3000 200 100   # 2 bot đánh nhau (URL, số nước tối đa, ms/nước)
```

Không đặt `DATABASE_URL` thì server vẫn chạy nhưng **mọi dữ liệu chỉ nằm trong bộ nhớ và mất khi tắt** (có cảnh báo khi khởi động).
Yêu cầu Node.js >= 18. Toàn bộ biến môi trường và chú thích nằm trong **`.env`** — project dùng một file
cấu hình duy nhất (không có `.env.example`). File này nằm trong `.gitignore` vì chứa bí mật thật, nên khi dựng
máy mới hoặc deploy phải copy file này sang rồi **thay mọi bí mật** (`JWT_SECRET`, `DATABASE_URL`, `SMTP_PASS`,
khoá OAuth). Node nạp file bằng cờ sẵn có `--env-file=.env`, không cần thư viện `dotenv`.

### Kiểm thử

```bash
npm test                                   # engine, đồng hồ, đăng nhập, kho lưu trữ (bộ nhớ), end-to-end
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/xiangqi_test npm test   # thêm cả PostgreSQL thật
```

> **Cảnh báo:** khi có `TEST_DATABASE_URL`, bộ test **xoá sạch mọi bảng** trong CSDL đó. Chỉ trỏ vào CSDL dành riêng cho test.

Bộ test dùng một **máy chủ giả** của Google/Facebook/Zalo kiểm tra nghiêm ngặt quy ước từng bên (PKCE, khoá bí mật, GET/POST...).
**Luồng đăng nhập chưa được thử với máy chủ thật của ba nhà cung cấp** (cần khoá ứng dụng của bạn); xem mục "Cấu hình Google / Facebook / Zalo".

## Cấu trúc

| File | Vai trò |
|---|---|
| `src/engine.js` | Engine luật (port 1-1 của `xiangqi_engine.dart`): nước đi, chiếu, chiếu bí, lặp nước, chiếu liên tục |
| `src/clock.js` | Đồng hồ cờ kiểu Fischer (server tính giờ) |
| `src/game-server.js`, `src/room.js` | Logic Socket.IO: phòng, ghép trận, nước đi, đầu hàng, hoà, nối lại |
| `src/auth.js` | `AuthService`: đăng ký/đăng nhập mật khẩu (scrypt), cấp cặp JWT, phiên, chống dò mật khẩu, ghi lịch sử đăng nhập |
| `src/jwt.js` | Ký/kiểm JWT HS256 bằng `node:crypto` (không thêm phụ thuộc); chỉ nhận `alg: HS256` |
| `src/tls.js` | Đọc chứng chỉ TLS từ biến môi trường để bật HTTPS (thiếu chứng chỉ thì chỉ chạy HTTP) |
| `src/app.js` | Dựng HTTP (+ HTTPS) dùng chung bộ định tuyến và chung engine Socket.IO |
| `src/oauth.js`, `src/providers.js` | Đăng nhập Google / Facebook / Zalo (OAuth 2.0 + PKCE), liên kết, gỡ liên kết |
| `src/stores/pg.js`, `src/stores/memory.js` | Lưu trữ PostgreSQL / bộ nhớ, **cùng một giao diện** và cùng bộ test hợp đồng |
| `src/migrate.js`, `migrations/*.sql` | Tạo và nâng cấp schema. Thay đổi schema = thêm file `002_...sql`, **không sửa file cũ** |
| `src/elo.js` | Công thức Elo, hệ số K, quy tắc ván tính điểm (hàm thuần) |
| `src/recorder.js` | Ghi ván đã kết thúc vào CSDL ở nền, tự thử lại khi CSDL lỗi |
| `src/auth-http.js`, `src/api-http.js`, `src/http-util.js` | Các đường dẫn HTTP `/auth/*`, `/me/*`, `/games/*` |
| `test/` | `engine`, `clock`, `auth`, `store` (hợp đồng), `integration` (OAuth + ghi ván + API), `server` (Socket.IO) |

## Danh tính: hai chế độ cùng tồn tại

Mỗi kết nối Socket.IO chọn **một** trong hai cách qua `auth`:

**1. Khách (không cần tài khoản).** Client tự sinh `playerId` (8-64 ký tự `A-Za-z0-9_-`, nên là hex/UUID ngẫu nhiên),
**lưu trên máy** và gửi kèm tên (tuỳ chọn). Để trống tên thì server tự đặt `Khách-XXXX`, ổn định theo `playerId`.

```js
io(url, { auth: { playerId: '3f2c9a1e8b7d4c5aa1b2c3d4e5f60718', name: 'Lâm' } });
```

**2. Tài khoản.** Đăng nhập qua HTTP (mật khẩu hoặc Google/Facebook/Zalo) để nhận `token`, rồi gửi token khi kết nối.

```js
io(url, { auth: { token } });
```

- Cùng `playerId` (khách) hoặc cùng tài khoản kết nối lại: vào lại đúng ván; kết nối cũ nhận `session:replaced`.
- Có `token` mà sai/hết hạn thì bị từ chối (`connect_error`: `invalid_token`), **không** âm thầm chuyển thành khách.
- `playerId` của khách không được chứa `:`, còn danh tính tài khoản nội bộ là `u:<id>`, nên khách không thể mạo danh tài khoản.
- Thông tin người chơi gửi cho đối thủ là `{ name, connected, guest }`; `playerId` và id tài khoản không bao giờ bị lộ.
- Khách chưa có mật khẩu: ai biết `playerId` là vào được ván đó. Tên khách không duy nhất và không được xác thực, hãy dựa vào cờ `guest`.

## Đăng nhập mật khẩu (JWT)

| Lệnh | Gửi | Trả về |
|---|---|---|
| `POST /auth/register` | `{ username, password, displayName? }` | cặp token + `user` |
| `POST /auth/login` | `{ username, password }` | cặp token + `user` |
| `POST /auth/refresh` | `{ refreshToken }` | cặp token mới + `user` |
| `GET /auth/me` | `Authorization: Bearer <accessToken>` | `{ ok, user }` kèm `providers`, `hasPassword` |
| `POST /auth/logout` | `Authorization: Bearer <accessToken>` | `{ ok }` (thu hồi cả phiên ngay) |

"Cặp token" là:

```json
{ "ok": true, "token": "<accessToken>", "accessToken": "eyJ...", "refreshToken": "eyJ...",
  "tokenType": "Bearer", "expiresIn": 3600, "user": { "...": "..." } }
```

- **access token** — gửi kèm mọi yêu cầu ở `Authorization: Bearer ...`. Sống ngắn (`JWT_ACCESS_TTL_MS`,
  mặc định 1 giờ) để nếu bị lộ thì thiệt hại có hạn. Khoá `token` là tên cũ, giá trị y hệt `accessToken`.
- **refresh token** — chỉ dùng cho `POST /auth/refresh`. Sống bằng tuổi phiên (`SESSION_TTL_MS`, mặc định 30 ngày).
  Server **xoay token**: mỗi refresh token dùng được một lần, dùng lại lần hai bị từ chối (phát hiện token bị trộm).

Ký bằng HS256 với `JWT_SECRET` (`src/jwt.js`, chỉ dùng `node:crypto`, không thêm phụ thuộc).
Chỉ chấp nhận `alg: HS256`, nên không bị lỗ hổng `alg: none` hay lẫn lộn thuật toán.

**Vẫn thu hồi được ngay.** Đây không phải JWT "không trạng thái" thuần: mỗi token mang `sid` trỏ tới một bản ghi
phiên trong CSDL, nên đăng xuất / đổi mật khẩu có hiệu lực tức thì (JWT thuần thì phải chờ hết hạn). CSDL chỉ lưu
**băm** của `sid`, và băm theo miền riêng (`sha256("sid|" + sid)`) nên `sid` đọc được từ payload cũng không dùng
thay token được. Token "đục" kiểu cũ vẫn được chấp nhận để client bản trước không bị đăng xuất khi nâng cấp server.

> Đặt `JWT_SECRET` cố định khi chạy thật. Bỏ trống thì server tự sinh khoá ngẫu nhiên mỗi lần khởi động (có cảnh báo):
> khởi động lại là mọi người phải đăng nhập lại, và chạy nhiều tiến trình sẽ không hiểu token của nhau.

`user` = `{ id, username, displayName, avatarUrl }` (`username` là `null` với tài khoản chỉ đăng nhập mạng xã hội).
Tên đăng nhập 3-20 ký tự `a-z 0-9 _` (không phân biệt hoa thường), mật khẩu 8-128 ký tự, tên hiển thị 2-24 ký tự.

Socket.IO cũng dùng access token: `auth: { token: '<accessToken>' }` lúc bắt tay.

## HTTPS: chạy song song HTTP và HTTPS

Có đủ `TLS_KEY_FILE` + `TLS_CERT_FILE` thì server lắng nghe **đồng thời** HTTP (`PORT`) và HTTPS (`HTTPS_PORT`).
Thiếu chứng chỉ thì chỉ chạy HTTP — đúng cho Render/Railway/Fly, nơi nền tảng tự lo TLS.

Hai server dùng **chung một bộ định tuyến và chung một engine Socket.IO**, nên người vào bằng HTTP và người vào
bằng HTTPS vẫn gặp nhau trong cùng một ván. (Không dùng được `io.attach()` lần hai vì hàm đó ghi đè engine cũ;
`src/app.js` chuyển thẳng request/upgrade vào `io.engine`.)

Tạo chứng chỉ cho máy cục bộ — **khuyến nghị `mkcert`** vì hệ điều hành sẽ tin chứng chỉ đó, nên cả HTTP lẫn
WebSocket đều chạy mà không phải sửa code client:

```bash
choco install mkcert ; mkcert -install
mkdir .ssl ; mkcert -key-file .ssl/localhost-key.pem -cert-file .ssl/localhost.pem localhost 127.0.0.1 10.0.2.2
```

Chứng chỉ tự ký bằng `openssl` cũng chạy được, nhưng trình duyệt sẽ cảnh báo và app Flutter chỉ chấp nhận ở
**bản debug** với host cục bộ/LAN (xem `lib/net/dev_tls_io.dart` ở client). Thư mục `.ssl/` nằm trong `.gitignore`:
**không bao giờ commit khoá riêng**.

## Đăng nhập Google / Facebook / Zalo

Luồng OAuth 2.0 "authorization code" do **server điều khiển** (khoá bí mật nằm ở server, không nằm trong app):

```
App ── POST /auth/oauth/google/start {appRedirect} ──────────▶ Server   (trả về { url })
App mở trình duyệt hệ thống tới url ─▶ Google ─▶ người dùng đăng nhập
Google ─▶ trình duyệt ─▶ GET /auth/oauth/google/callback?code&state ─▶ Server
Server đổi code lấy access token, đọc hồ sơ, tìm/tạo tài khoản, rồi chuyển trình duyệt về
        cotuong://auth?code=<MÃ DÙNG MỘT LẦN>
App ── POST /auth/oauth/exchange {code} ─▶ Server  (trả về { token, user })
```

| Lệnh | Mô tả |
|---|---|
| `GET /auth/providers` | Danh sách nhà cung cấp **đã cấu hình** (app chỉ hiện nút dùng được) |
| `POST /auth/oauth/:provider/start` | `{ appRedirect, link? }`. `link: true` + `Authorization: Bearer` để liên kết vào tài khoản đang đăng nhập |
| `GET /auth/oauth/:provider/callback` | Nhà cung cấp gọi vào; chuyển hướng về `appRedirect` kèm `?code=` / `?linked=` / `?error=` |
| `POST /auth/oauth/exchange` | `{ code }` -> `{ token, user }`; mã dùng một lần, sống 60 giây |
| `DELETE /auth/oauth/:provider` | Gỡ liên kết (không cho gỡ nếu đó là cách đăng nhập duy nhất) |

**Quyết định bảo mật:**
- `state` ngẫu nhiên, chỉ lưu băm, dùng một lần, sống 10 phút (chống CSRF); thêm PKCE với Google và Zalo.
- `appRedirect` phải khớp **chính xác** một địa chỉ trong `OAUTH_APP_REDIRECTS` (chống chuyển hướng mở).
- Token phiên **không bao giờ** nằm trong địa chỉ chuyển hướng, chỉ có mã dùng một lần sống 60 giây.
- **Không tự gộp tài khoản theo email.** Email Facebook chưa chắc đã xác minh, gộp tự động là lỗ hổng chiếm tài khoản kinh điển.
  Mỗi danh tính mạng xã hội là một tài khoản riêng; muốn gộp phải đăng nhập rồi chủ động "liên kết".
- Một danh tính mạng xã hội chỉ thuộc một tài khoản; một tài khoản chỉ liên kết một danh tính cho mỗi nhà cung cấp.

Lỗi trả về trong `?error=`: `access_denied` (người dùng từ chối), `provider_error`, `identity_taken`, `provider_already_linked`.

### Cấu hình Google / Facebook / Zalo

Đặt `PUBLIC_URL` là địa chỉ công khai (HTTPS) của server, rồi đăng ký ứng dụng ở từng bên với **redirect URI**
`<PUBLIC_URL>/auth/oauth/<google|facebook|zalo>/callback`:

- **Google:** Google Cloud Console, tạo *OAuth client ID* loại **Web application**. Điền `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
  Cần cấu hình màn hình đồng ý (consent screen).
- **Facebook:** developers.facebook.com, tạo app, thêm sản phẩm *Facebook Login*, điền *Valid OAuth Redirect URIs*.
  Điền `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`. App phải ở chế độ **Live** thì người dùng ngoài nhóm phát triển mới đăng nhập được.
  Phiên bản Graph API mặc định `v24.0`: Facebook ngừng các phiên bản cũ sau khoảng 2 năm (ví dụ v19.0 hết hạn tháng 5/2026), hãy kiểm tra
  phiên bản còn hiệu lực và đặt `FACEBOOK_API_VERSION` nếu cần.
- **Zalo:** developers.zalo.me, tạo app, bật *Zalo Login*, điền callback URL. Điền `ZALO_APP_ID`, `ZALO_APP_SECRET`.
  Zalo dùng tên miền công khai (không dùng được `localhost`) và bắt buộc PKCE (server đã làm). Zalo không trả về email.

Các bên đều yêu cầu bạn khai báo chính sách quyền riêng tư và có thể yêu cầu duyệt ứng dụng. Giao diện và quy trình của họ thay đổi theo thời gian,
hãy đối chiếu với tài liệu hiện hành của từng bên.

## Lịch sử ván đấu và lịch sử đăng nhập

Mọi ván kết thúc (kể cả hết giờ, đầu hàng, mất kết nối) được ghi vào bảng `games` ở nền, tự thử lại nếu CSDL tạm lỗi.
Ván của **khách cũng được lưu** (chỉ lưu tên và cờ `guest`, **không bao giờ lưu `playerId`** vì đó là chìa khoá bí mật của họ).
Sự kiện `game:over` và `state` có thêm `gameId` để xem lại.

| Lệnh | Mô tả |
|---|---|
| `GET /me/games?limit=20&before=<ms>` | (Bearer) Ván của tôi, mới nhất trước: `{ games: [{ id, mySide, outcome, result, endReason, opponentName, opponentGuest, moveCount, baseMs, incrementMs, startedAt, endedAt }], nextBefore }` |
| `GET /me/stats` | (Bearer) `{ stats: { total, wins, losses, draws } }` |
| `GET /me/logins?limit=30` | (Bearer) Lịch sử đăng nhập của tôi: `{ events: [{ id, event, method, success, ip, userAgent, detail, createdAt }] }` |
| `GET /games/:id` | Xem lại ván: tên, kết quả, lý do, và toàn bộ nước đi `{ from, to, pieceId, capturedId, givesCheck, elapsedMs }`. Ai có id cũng xem được (UUID khó đoán); không lộ id tài khoản hay mã phòng |

Lịch sử đăng nhập ghi: `register`, `login`, `login_failed`, `logout`, `link`, `link_failed`, `unlink`, kèm phương thức (`password`, `google`, `facebook`, `zalo`, `token`).
Đăng nhập thất bại với tên không tồn tại được ghi nhưng không gắn với tài khoản nào và **không lưu tên đã gõ** (tránh lưu nhầm mật khẩu).

## Xếp hạng Elo và bảng xếp hạng

Mỗi tài khoản bắt đầu ở **1500** điểm. Điểm đổi sau mỗi **ván tính điểm**, trong **cùng transaction** với việc lưu ván (không bao giờ có ván đã lưu mà điểm chưa đổi), và lưu lại điểm trước/sau của từng ván.

**Ván tính điểm** khi: cả hai bên đều là tài khoản (khách không có điểm), là hai tài khoản khác nhau, và ván có ít nhất `RATED_MIN_MOVES` = 6 nước (chặn "đầu hàng ngay" để cày điểm). Hết giờ, đầu hàng, mất kết nối tính là thua bình thường.
**Hệ số K:** 40 cho 30 ván tính điểm đầu (điểm "tạm", API trả `provisional: true`), sau đó 20, từ 2400 trở lên 10. Điểm tối thiểu 100. Các hằng số nằm ở `src/elo.js`.

| Lệnh | Mô tả |
|---|---|
| `GET /me/rating` | (Bearer) `{ rating: { rating, ratedGames, rank, provisional } }`; `rank` là `null` nếu chưa có ván tính điểm |
| `GET /leaderboard?limit=50&offset=0` | Công khai. `{ players: [{ rank, displayName, avatarUrl, rating, ratedGames, provisional, isMe }], nextOffset }`. Có Bearer hợp lệ thì dòng của mình có `isMe: true`. **Không lộ id tài khoản.** Cùng điểm cùng hạng (1, 2, 2, 4) |
| `/me/games`, `/games/:id` | Thêm `rated`, và `ratingChange { before, after, delta }` (góc nhìn của bạn) / `ratings { red, black }` |

Sự kiện Socket.IO `game:rating` `{ roomId, gameId, rated, red: {before, after, delta}|null, black: ... }` được phát cho cả phòng **sau khi ván đã ghi vào CSDL**
(ván không tính điểm vẫn gửi với `rated: false` để app thôi chờ). Nếu CSDL lỗi quá 3 lần thì không có sự kiện này; điểm vẫn xem được qua API khi ván được ghi lại.

Ván chơi **trước** migration `002` không tính điểm. Muốn tính lại từ lịch sử (hoặc vá nếu nghi dữ liệu điểm lệch): `npm run ratings:rebuild`
(chạy lại bao nhiêu lần cũng cho cùng kết quả; chặn ghi vào `users`/`games` trong vài giây).
**Chưa chống:** hai người thông đồng thắng thua qua lại giữa hai tài khoản để "đẩy" điểm; cần thêm giới hạn theo cặp đối thủ nếu thành vấn đề thật.

## Ghép trận theo Elo

`queue:join` chỉ ghép những người chọn **cùng mức thời gian**, và chọn đối thủ có Elo **gần nhất**. Cửa sổ ban đầu là ±100 điểm, nới thêm
10 điểm mỗi giây chờ (chờ 30 giây là ±400), nên không ai chờ mãi; server thử ghép lại mỗi 2 giây. Khách (không có Elo) ghép với khách;
khách và tài khoản chỉ ghép với nhau khi một bên đã chờ quá 30 giây (ván đó không tính điểm). Tuỳ chỉnh qua tuỳ chọn `matchmaking` của `GameServer`.

## Khán giả và chat

| Sự kiện (client gửi) | Mô tả |
|---|---|
| `room:spectate { roomId }` | Xem phòng bằng mã. Ack: `{ roomId, state (you = null), chat, spectators }`. Nhận mọi sự kiện của phòng (nước đi, kết quả, chat) nhưng không đi quân được. Tối đa 50 khán giả/phòng (`too_many_spectators`). Người đang trong ván của mình không xem được (`already_in_room`); tự tạo/vào phòng thì thôi xem |
| `room:leave` | Khán giả rời phòng xem |
| `chat:send { text }` | Người chơi (kể cả khách) hoặc **khán giả có tài khoản** gửi tin; khán giả khách nhận `login_required` |

Sự kiện server gửi: `chat:message { id, roomId, from: { name, role: red|black|spectator, guest }, text, at }`, `chat:history { roomId, messages }`
(khi người chơi nối lại), `room:spectators { roomId, count }`, `spectate:state` (ván bắt đầu sau khi vào xem phòng chờ), `spectate:closed` (phòng bị xoá).

Tin tối đa 200 ký tự (đếm theo ký tự), tối đa 5 tin / 10 giây / người; ký tự điều khiển và ký tự đảo chiều chữ bị loại. Giữ 50 tin gần nhất **chỉ trong bộ nhớ**
(không lưu CSDL, mất khi phòng bị xoá). Server **không escape HTML**: client web phải tự escape. Chưa có lọc từ ngữ hay chặn người dùng.
Khán giả mất kết nối là rời phòng xem (khác người chơi được giữ ván); app phải `room:spectate` lại. Mã phòng là thứ duy nhất kiểm soát ai được xem.

## Email khôi phục và quên mật khẩu

Tài khoản mật khẩu chưa có email nên cần thêm và **xác minh** email trước khi dùng được "quên mật khẩu". Email lưu ở `users.recovery_email`
(tách khỏi `users.email` do Google/Facebook/Zalo trả về); chỉ email đã xác minh mới nhận mã, và mỗi email đã xác minh chỉ thuộc một tài khoản.

| Lệnh | Mô tả |
|---|---|
| `POST /auth/email` | (Bearer) `{ email, password }` -> gửi mã xác minh 6 số. Cần mật khẩu hiện tại. Tối đa 5 lần gửi/giờ/tài khoản |
| `POST /auth/email/verify` | (Bearer) `{ code }` -> xác minh |
| `POST /auth/forgot` | `{ email }` -> luôn `{ ok }` nếu email hợp lệ (không lộ email nào có tài khoản; thư gửi nền). Tối đa 3 mã/giờ/email, 10 yêu cầu/giờ/IP |
| `POST /auth/reset` | `{ email, code, newPassword }` -> đặt mật khẩu mới và **thu hồi mọi phiên**. Mọi lý do sai trả cùng lỗi `invalid_email_code` |

Mã 6 số, hiệu lực 15 phút, dùng một lần, **sai 5 lần là huỷ**, chỉ lưu băm. Mã mới thay mã cũ.

**Cấu hình gửi thư** (biến môi trường, xem `.env`): `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`.
Gmail: `smtp.gmail.com` cổng 465 (`SMTP_SECURE=1`) hoặc 587, và `SMTP_PASS` phải là **Mật khẩu ứng dụng** (bật xác minh 2 bước rồi tạo ở tài khoản Google), không phải mật khẩu đăng nhập.
Không đặt `SMTP_HOST`: khi phát triển mã được in ra console; khi `NODE_ENV=production` tính năng email bị tắt (API trả `email_unavailable`, 503).
Cổng 587 bắt buộc nâng cấp TLS. **Không bao giờ commit `.env`.**

## Quản lý tài khoản

| Lệnh | Mô tả |
|---|---|
| `POST /auth/password` | (Bearer) `{ currentPassword, newPassword }` -> `{ ok, revoked }`. Thu hồi **mọi phiên khác** (kẻ giữ token cũ bị đá ra); đoán sai mật khẩu cũ bị khoá tạm như đăng nhập. Tài khoản chỉ đăng nhập mạng xã hội: `no_password` |
| `POST /auth/account/delete` | (Bearer) `{ password }` (hoặc `{ confirm: "DELETE" }` với tài khoản chỉ đăng nhập mạng xã hội; chỉ chặn bấm nhầm, không phải xác thực). Xoá vĩnh viễn tài khoản, phiên, danh tính mạng xã hội và **lịch sử đăng nhập (có IP)**. Các ván đã chơi được giữ (mất liên kết tài khoản, vẫn còn tên hiển thị lúc chơi) để đối thủ còn lịch sử |

## Cơ sở dữ liệu PostgreSQL

Bảng (xem `migrations/*.sql`): `users`, `oauth_identities`, `sessions`, `oauth_states`, `oauth_codes`, `auth_events`, `games`, `schema_migrations`.

- UUID do ứng dụng sinh (không cần extension). Mọi truy vấn dùng tham số nên không có nguy cơ SQL injection.
- Mật khẩu chỉ lưu **băm scrypt**; token phiên, `state` OAuth và mã đổi token chỉ lưu **băm**. Lộ CSDL không lộ token đang dùng.
- Migration chạy trong transaction, có khoá tư vấn nên nhiều server khởi động cùng lúc không chạy chồng nhau.
- Dọn định kỳ mỗi giờ: phiên/state/mã hết hạn, và lịch sử đăng nhập quá `AUTH_EVENT_RETENTION_DAYS` ngày.
- Xoá tài khoản (nếu bạn tự làm): các ván được giữ lại (cột user thành NULL, vẫn còn tên), phiên và danh tính bị xoá theo.

**Quyền riêng tư:** `auth_events` và `sessions` lưu địa chỉ IP và trình duyệt, kèm email/tên từ nhà cung cấp là dữ liệu cá nhân. Hãy có chính sách quyền riêng tư,
chỉ giữ trong thời hạn cần thiết, và tham khảo quy định hiện hành về bảo vệ dữ liệu cá nhân (ở Việt Nam có Nghị định 13/2023/NĐ-CP). Đây không phải tư vấn pháp lý.

**Bảo mật khi đưa ra Internet:** chạy sau HTTPS (Nginx/Caddy), nếu không mật khẩu và token đi dưới dạng chữ rõ. Khi đó đặt `TRUST_PROXY=1`,
`CORS_ORIGIN` là domain cụ thể, và đặt `DATABASE_URL` với tài khoản CSDL chỉ có quyền cần thiết.

## Quy ước dữ liệu (khớp app Flutter)

- Toạ độ: `col` 0..8 (trái → phải), `row` 0..9 (trên → dưới). Hàng 0 là phía Đen, hàng 9 là phía Đỏ. Đỏ đi trước.
- `side`: `"red"` | `"black"`. `type`: `general, advisor, elephant, horse, chariot, cannon, soldier`.
- ID quân: `"{side}_{type}_{index}"`, ví dụ `red_soldier_3`, giống `XiangqiPiece.id` bên Dart.

## Sự kiện client → server

Mọi sự kiện đều có thể gửi kèm callback (ack) nhận `{ ok: true, ... }` hoặc `{ ok: false, error }`.

| Sự kiện | Payload | Ack khi thành công |
|---|---|---|
| `room:create` | `{ side?: 'red'\|'black', timeControl?: { baseMs, incrementMs } }` | `{ roomId, side, state }` |
| `room:join` | `{ roomId }` | `{ roomId, side, state }` |
| `room:leave` | — | `{}` (đang chơi thì tính là đầu hàng) |
| `queue:join` | `{ timeControl? }` (chỉ ghép với người chọn **cùng** mức thời gian) | `{ matched, roomId?, side? }` |
| `queue:leave` | — | `{}` |
| `game:move` | `{ from: {col,row}, to: {col,row} }` | `{}` |
| `game:resign` | — | `{}` |
| `game:draw:offer` | — | `{}` |
| `game:draw:respond` | `{ accept: boolean }` | `{}` |
| `game:sync` | — | `{ state }` |

Mã lỗi: `already_in_room`, `room_not_found`, `room_full`, `not_in_room`, `not_playing`, `not_your_turn`, `bad_payload`, `illegal_move`,
`already_offered`, `no_draw_offer`, `bad_time_control`, `time_expired`, `rate_limited`, `internal_error`.
Lỗi lúc kết nối (`connect_error`): `invalid_player_id`, `invalid_token`, `auth_error`.

## Sự kiện server → client

| Sự kiện | Dữ liệu | Khi nào |
|---|---|---|
| `game:start` | `state` | Đủ 2 người, ván bắt đầu |
| `match:found` | `{ roomId, side }` | Ghép trận nhanh thành công |
| `game:move` | `{ moveNumber, from, to, pieceId, capturedId, givesCheck, turn, isCheck, repetitions, clock }` | Có nước đi hợp lệ |
| `game:over` | `{ roomId, gameId, result, reason, clock }` | Ván kết thúc |
| `game:draw:offered` / `game:draw:declined` | `{ from }` / `{ by }` | Xin hoà / từ chối |
| `opponent:status` | `{ connected, graceMs? }` | Đối thủ mất kết nối / nối lại |
| `session:resume` | `state` | Vừa kết nối lại và đang có phòng |
| `session:replaced` | — | Bị kết nối khác cùng danh tính thay thế |

`result`: `"red"` / `"black"` (phe **thắng**) hoặc `"draw"`. `reason`: `checkmate`, `stalemate` (hết nước đi, bên đó thua), `repetition`
(lặp nước, hoà), `perpetual_check` (chiếu liên tục, bên chiếu thua), `no_capture` (60 nước mỗi bên không ăn quân, hoà), `timeout`, `resign`, `disconnect`, `agreement`.

`state`: `roomId, gameId, status ('waiting'|'playing'|'over'), you, players {red, black} (name, connected, guest), turn, isCheck,
repetitions, clock, board [{id,type,side,index,col,row}], moves [{from,to,pieceId,capturedId,givesCheck}], result, endReason, drawOfferFrom`.

`clock` là `null` nếu không giới hạn thời gian, ngược lại `{ baseMs, incrementMs, remainingMs: { red, black }, running }`.

## Đồng hồ cờ

Kiểu Fischer: mỗi bên có `baseMs`, đi xong được cộng `incrementMs`. Giới hạn mặc định: `baseMs` 30 giây đến 3 giờ, `incrementMs` 0 đến 60 giây.
**Server tính giờ**: đồng hồ Đỏ chạy ngay khi đủ 2 người, chỉ bên đến lượt bị trừ giờ; hết giờ server xử thua (`timeout`) và từ chối nước đi muộn (`time_expired`).
Mất kết nối không làm đồng hồ dừng. Client chỉ đếm ngược để hiển thị.

## Lặp nước và chiếu liên tục

Thế cờ được nhận diện bằng vị trí quân (loại + phe) **và bên đến lượt**. Khi một thế cờ xuất hiện **lần thứ 3**: đúng một bên chiếu ở **mọi** nước của
mình trong đoạn lặp thì bên đó **thua** (`perpetual_check`); cả hai cùng chiếu liên tục hoặc không bên nào thì **hoà** (`repetition`).
Ngoài ra **120 nước liên tiếp (60 mỗi bên) không có quân nào bị ăn** thì hoà (`no_capture`). Luật **đuổi quân liên tục** chưa được áp dụng.

## Quy tắc vận hành

- Mất kết nối khi đang chơi: đối thủ nhận `opponent:status`; sau `RECONNECT_GRACE_MS` (mặc định 60 giây) không nối lại thì bị xử thua (`disconnect`).
- Mỗi kết nối tối đa 60 sự kiện / 5 giây. Chống dò mật khẩu: sai quá 10 lần / 10 phút cho một tên đăng nhập thì khoá tạm; giới hạn theo IP cho đăng ký (10/giờ) và đăng nhập (30/10 phút).
- Phòng chờ quá 30 phút, hoặc ván đã xong quá 1 giờ, bị dọn khỏi bộ nhớ (ván vẫn nằm trong CSDL).

## Chưa có

- Đăng nhập Apple; xem danh sách ván đang diễn ra (hiện phải biết mã phòng); lọc từ ngữ / chặn người dùng trong chat.
- Chạy nhiều server với Redis (hiện phòng, hàng đợi và bộ đếm giới hạn tần suất nằm trong bộ nhớ MỘT tiến trình); chống thông đồng đẩy điểm.
- Luật đuổi quân liên tục; thời gian kiểu byo-yomi.
- Chạy nhiều server: trạng thái phòng đang nằm trong bộ nhớ một tiến trình. Muốn mở rộng cần Redis adapter cho Socket.IO và lưu phòng ra ngoài
  (tài khoản, phiên và ván đã nằm sẵn trong PostgreSQL nên dùng chung được).
