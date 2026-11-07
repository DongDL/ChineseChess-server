/**
 * Đặc tả OpenAPI 3.1 cho REST API của server cờ tướng.
 *
 * File này CHỈ mô tả các đường dẫn HTTP (REST). Luồng chơi cờ thời gian thực
 * (đi quân, đầu hàng, chat...) chạy qua Socket.IO nên không nằm trong đặc tả này.
 *
 * Tài liệu được build thuần bằng JS (không annotation, không quét mã) để khớp
 * đúng với bộ định tuyến HTTP tự viết trong app.js. Khi thêm/sửa endpoint ở
 * auth-http.js / api-http.js / feedback-http.js thì cập nhật tương ứng tại đây.
 *
 * [appVersion]: phiên bản server, hiển thị trên trang Swagger UI.
 * [servers]: danh sách server để người xem chọn (vd. http://localhost:3000).
 */
export function buildOpenApiSpec({ appVersion = '1.0.0', servers = [] } = {}) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'API Server Cờ Tướng Online',
      version: appVersion,
      description: [
        'REST API cho hệ thống cờ tướng / cờ úp online.',
        '',
        'Server làm **trọng tài**: mọi nước đi và kết quả ván đều do server kiểm tra.',
        'Phần chơi cờ thời gian thực chạy qua **Socket.IO** (đường dẫn `/socket.io/`) và',
        'KHÔNG được mô tả ở đây — tài liệu này chỉ gồm các đường dẫn HTTP (xác thực,',
        'lịch sử ván, bảng xếp hạng, thư góp ý).',
        '',
        'Các endpoint cần đăng nhập dùng **Bearer token** (lấy từ `/auth/login` hoặc',
        '`/auth/register`). Bấm nút **Authorize** để dán access token.',
      ].join('\n'),
    },
    servers: servers.length ? servers : [{ url: '/', description: 'Server hiện tại' }],
    tags: [
      { name: 'Hệ thống', description: 'Trạng thái và phiên bản server' },
      { name: 'Xác thực', description: 'Đăng ký, đăng nhập, phiên, email khôi phục, mạng xã hội' },
      { name: 'Người dùng', description: 'Dữ liệu của chính người đang đăng nhập (ván, thống kê, điểm, lịch sử đăng nhập)' },
      { name: 'Ván đấu', description: 'Bảng xếp hạng và replay ván đã kết thúc' },
      { name: 'Góp ý', description: 'Gửi thư góp ý tới quản trị viên' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Dán access token nhận được từ /auth/login hoặc /auth/register.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: false },
            error: {
              type: 'string',
              description: 'Mã lỗi nghiệp vụ (vd. invalid_token, bad_json, not_found).',
              example: 'invalid_token',
            },
          },
          required: ['ok', 'error'],
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            username: { type: 'string', nullable: true },
            displayName: { type: 'string' },
            avatarUrl: { type: 'string', nullable: true },
            providers: {
              type: 'array',
              items: { type: 'string', example: 'google' },
              description: 'Các nhà cung cấp mạng xã hội đã liên kết (chỉ có ở /auth/me).',
            },
            hasPassword: { type: 'boolean', description: 'Tài khoản có đặt mật khẩu không (chỉ có ở /auth/me).' },
          },
        },
        AuthSession: {
          type: 'object',
          description: 'Kết quả chung cho đăng ký / đăng nhập / làm mới token.',
          properties: {
            ok: { type: 'boolean', example: true },
            token: { type: 'string', description: 'Giống accessToken (giữ tên cũ cho client bản trước).' },
            accessToken: { type: 'string' },
            refreshToken: { type: 'string' },
            tokenType: { type: 'string', example: 'Bearer' },
            expiresIn: { type: 'integer', description: 'Thời gian sống của access token (giây).' },
            user: { $ref: '#/components/schemas/User' },
          },
        },
        GameSummary: {
          type: 'object',
          description: 'Tóm tắt một ván theo góc nhìn người đang đăng nhập.',
          properties: {
            id: { type: 'string', format: 'uuid' },
            variant: { type: 'string', enum: ['xiangqi', 'jieqi'] },
            mySide: { type: 'string', enum: ['red', 'black'] },
            rated: { type: 'boolean' },
            ratingChange: {
              type: 'object',
              nullable: true,
              properties: {
                before: { type: 'integer' },
                after: { type: 'integer' },
                delta: { type: 'integer' },
              },
            },
            outcome: { type: 'string', enum: ['win', 'loss', 'draw'] },
            result: { type: 'string', enum: ['red', 'black', 'draw'] },
            endReason: { type: 'string' },
            opponentName: { type: 'string' },
            opponentGuest: { type: 'boolean' },
            moveCount: { type: 'integer' },
            baseMs: { type: 'integer' },
            incrementMs: { type: 'integer' },
            startedAt: { type: 'integer', description: 'Thời điểm bắt đầu (epoch ms).' },
            endedAt: { type: 'integer', description: 'Thời điểm kết thúc (epoch ms).' },
          },
        },
        GameDetail: {
          type: 'object',
          description: 'Chi tiết replay công khai (đã che bí mật quân úp ngoài quyền xem).',
          properties: {
            id: { type: 'string', format: 'uuid' },
            variant: { type: 'string', enum: ['xiangqi', 'jieqi'] },
            redName: { type: 'string' },
            blackName: { type: 'string' },
            redGuest: { type: 'boolean' },
            blackGuest: { type: 'boolean' },
            baseMs: { type: 'integer' },
            incrementMs: { type: 'integer' },
            result: { type: 'string', enum: ['red', 'black', 'draw'] },
            endReason: { type: 'string' },
            moveCount: { type: 'integer' },
            moves: { type: 'array', items: { type: 'object' } },
            rated: { type: 'boolean' },
            ratings: {
              type: 'object',
              nullable: true,
              properties: {
                red: { type: 'object', properties: { before: { type: 'integer' }, after: { type: 'integer' } } },
                black: { type: 'object', properties: { before: { type: 'integer' }, after: { type: 'integer' } } },
              },
            },
            redRemainingMs: { type: 'integer' },
            blackRemainingMs: { type: 'integer' },
            startedAt: { type: 'integer' },
            endedAt: { type: 'integer' },
          },
        },
        Rating: {
          type: 'object',
          properties: {
            rating: { type: 'integer', example: 1500 },
            ratedGames: { type: 'integer' },
            rank: { type: 'integer', nullable: true },
            provisional: { type: 'boolean', description: 'true khi còn ít hơn 30 ván tính điểm.' },
          },
        },
        LeaderboardPlayer: {
          type: 'object',
          properties: {
            rank: { type: 'integer' },
            displayName: { type: 'string' },
            avatarUrl: { type: 'string', nullable: true },
            rating: { type: 'integer' },
            ratedGames: { type: 'integer' },
            provisional: { type: 'boolean' },
            isMe: { type: 'boolean' },
          },
        },
        LoginEvent: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Loại sự kiện (vd. login, logout, register).' },
            at: { type: 'integer', description: 'Thời điểm (epoch ms).' },
            ip: { type: 'string', nullable: true },
            userAgent: { type: 'string', nullable: true },
          },
        },
      },
      parameters: {
        variant: {
          name: 'variant',
          in: 'query',
          description: 'Biến thể cờ cho thang điểm / thống kê.',
          required: false,
          schema: { type: 'string', enum: ['xiangqi', 'jieqi'], default: 'xiangqi' },
        },
      },
      responses: {
        Unauthorized: {
          description: 'Thiếu hoặc sai token.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        NotFound: {
          description: 'Không tìm thấy tài nguyên.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        BadRequest: {
          description: 'Dữ liệu gửi lên không hợp lệ.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
    paths: {
      '/health': {
        get: {
          tags: ['Hệ thống'],
          summary: 'Kiểm tra sức khoẻ + thống kê nhanh',
          responses: {
            200: {
              description: 'Server đang chạy, kèm thống kê phòng/ván.',
              content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean', example: true } } } } },
            },
          },
        },
      },
      '/version': {
        get: {
          tags: ['Hệ thống'],
          summary: 'Phiên bản server (công khai)',
          responses: {
            200: {
              description: 'Phiên bản hiện tại.',
              content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, version: { type: 'string' } } } } },
            },
          },
        },
      },
      '/auth/providers': {
        get: {
          tags: ['Xác thực'],
          summary: 'Danh sách nhà cung cấp đăng nhập mạng xã hội đã bật',
          responses: {
            200: {
              description: 'Danh sách provider.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { ok: { type: 'boolean' }, providers: { type: 'array', items: { type: 'string' }, example: ['google', 'facebook'] } },
                  },
                },
              },
            },
          },
        },
      },
      '/auth/register': {
        post: {
          tags: ['Xác thực'],
          summary: 'Đăng ký tài khoản mật khẩu',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['username', 'password'],
                  properties: {
                    username: { type: 'string' },
                    password: { type: 'string', format: 'password' },
                    displayName: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Đăng ký thành công.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthSession' } } } },
            400: { $ref: '#/components/responses/BadRequest' },
          },
        },
      },
      '/auth/login': {
        post: {
          tags: ['Xác thực'],
          summary: 'Đăng nhập bằng mật khẩu',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['username', 'password'],
                  properties: {
                    username: { type: 'string' },
                    password: { type: 'string', format: 'password' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Đăng nhập thành công.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthSession' } } } },
            400: { $ref: '#/components/responses/BadRequest' },
          },
        },
      },
      '/auth/refresh': {
        post: {
          tags: ['Xác thực'],
          summary: 'Làm mới token bằng refresh token',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', required: ['refreshToken'], properties: { refreshToken: { type: 'string' } } },
              },
            },
          },
          responses: {
            200: { description: 'Cấp token mới.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthSession' } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/auth/me': {
        get: {
          tags: ['Xác thực'],
          summary: 'Hồ sơ người đang đăng nhập',
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'Hồ sơ đầy đủ (kèm providers, hasPassword).',
              content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, user: { $ref: '#/components/schemas/User' } } } } },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/auth/logout': {
        post: {
          tags: ['Xác thực'],
          summary: 'Đăng xuất phiên hiện tại',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'Đã đăng xuất.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/auth/password': {
        post: {
          tags: ['Xác thực'],
          summary: 'Đổi mật khẩu (thu hồi các phiên khác)',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['currentPassword', 'newPassword'],
                  properties: { currentPassword: { type: 'string', format: 'password' }, newPassword: { type: 'string', format: 'password' } },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Đổi thành công.',
              content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, revoked: { type: 'integer', description: 'Số phiên khác bị thu hồi.' } } } } },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/auth/email': {
        post: {
          tags: ['Xác thực'],
          summary: 'Đặt email khôi phục (gửi mã xác minh 6 số)',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', format: 'password' } } },
              },
            },
          },
          responses: {
            200: {
              description: 'Đã gửi mã xác minh.',
              content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, email: { type: 'string' }, verified: { type: 'boolean' } } } } },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/auth/email/verify': {
        post: {
          tags: ['Xác thực'],
          summary: 'Xác minh email bằng mã 6 số',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', example: '123456' } } } },
            },
          },
          responses: {
            200: {
              description: 'Xác minh thành công.',
              content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, email: { type: 'string' }, verified: { type: 'boolean' } } } } },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/auth/forgot': {
        post: {
          tags: ['Xác thực'],
          summary: 'Quên mật khẩu (gửi mã về email nếu đã xác minh)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } },
          },
          responses: {
            200: { description: 'Luôn trả ok nếu email hợp lệ (không tiết lộ tài khoản có tồn tại hay không).', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
          },
        },
      },
      '/auth/reset': {
        post: {
          tags: ['Xác thực'],
          summary: 'Đặt lại mật khẩu bằng mã (thu hồi mọi phiên)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', required: ['email', 'code', 'newPassword'], properties: { email: { type: 'string', format: 'email' }, code: { type: 'string' }, newPassword: { type: 'string', format: 'password' } } },
              },
            },
          },
          responses: {
            200: { description: 'Đặt lại thành công.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
            400: { $ref: '#/components/responses/BadRequest' },
          },
        },
      },
      '/auth/account/delete': {
        post: {
          tags: ['Xác thực'],
          summary: 'Xoá tài khoản vĩnh viễn',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  description: "Gửi password (nếu có mật khẩu) hoặc confirm = 'DELETE'.",
                  properties: { password: { type: 'string', format: 'password' }, confirm: { type: 'string', example: 'DELETE' } },
                },
              },
            },
          },
          responses: {
            200: { description: 'Đã xoá.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/auth/oauth/exchange': {
        post: {
          tags: ['Xác thực'],
          summary: 'Đổi mã OAuth tạm lấy token',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } } },
          },
          responses: {
            200: { description: 'Đăng nhập mạng xã hội thành công.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthSession' } } } },
            400: { $ref: '#/components/responses/BadRequest' },
          },
        },
      },
      '/auth/oauth/{provider}/start': {
        post: {
          tags: ['Xác thực'],
          summary: 'Bắt đầu luồng đăng nhập mạng xã hội',
          parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string', example: 'google' } }],
          security: [{ bearerAuth: [] }, {}],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    appRedirect: { type: 'string', description: 'URL quay về app sau khi xong.' },
                    link: { type: 'boolean', description: 'true để liên kết vào tài khoản hiện tại (cần Bearer).' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Trả URL trang uỷ quyền của provider.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, url: { type: 'string' } } } } } },
          },
        },
      },
      '/auth/oauth/{provider}/callback': {
        get: {
          tags: ['Xác thực'],
          summary: 'Callback từ provider (trình duyệt tự gọi)',
          parameters: [
            { name: 'provider', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'code', in: 'query', schema: { type: 'string' } },
            { name: 'state', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            302: { description: 'Chuyển hướng về app kèm ?code=... hoặc ?error=...' },
            400: { description: 'Phiên OAuth hết hạn hoặc không hợp lệ (trả HTML).' },
          },
        },
      },
      '/auth/oauth/{provider}': {
        delete: {
          tags: ['Xác thực'],
          summary: 'Gỡ liên kết mạng xã hội',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Đã gỡ liên kết.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/me/games': {
        get: {
          tags: ['Người dùng'],
          summary: 'Lịch sử ván của tôi (phân trang)',
          security: [{ bearerAuth: [] }],
          parameters: [
            { $ref: '#/components/parameters/variant' },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
            { name: 'before', in: 'query', description: 'Lấy ván kết thúc trước mốc này (epoch ms) để tải trang tiếp.', schema: { type: 'integer' } },
          ],
          responses: {
            200: {
              description: 'Danh sách ván.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      games: { type: 'array', items: { $ref: '#/components/schemas/GameSummary' } },
                      nextBefore: { type: 'integer', nullable: true },
                    },
                  },
                },
              },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/me/stats': {
        get: {
          tags: ['Người dùng'],
          summary: 'Thống kê thắng/thua/hoà của tôi',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/variant' }],
          responses: {
            200: {
              description: 'Thống kê.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      variant: { type: 'string' },
                      stats: { type: 'object', properties: { total: { type: 'integer' }, wins: { type: 'integer' }, losses: { type: 'integer' }, draws: { type: 'integer' } } },
                    },
                  },
                },
              },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/me/rating': {
        get: {
          tags: ['Người dùng'],
          summary: 'Điểm Elo của tôi',
          security: [{ bearerAuth: [] }],
          parameters: [{ $ref: '#/components/parameters/variant' }],
          responses: {
            200: {
              description: 'Điểm và hạng.',
              content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, variant: { type: 'string' }, rating: { $ref: '#/components/schemas/Rating' } } } } },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
            404: { $ref: '#/components/responses/NotFound' },
          },
        },
      },
      '/me/logins': {
        get: {
          tags: ['Người dùng'],
          summary: 'Lịch sử đăng nhập của tôi',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }],
          responses: {
            200: {
              description: 'Danh sách sự kiện đăng nhập.',
              content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, events: { type: 'array', items: { $ref: '#/components/schemas/LoginEvent' } } } } } },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/leaderboard': {
        get: {
          tags: ['Ván đấu'],
          summary: 'Bảng xếp hạng',
          description: 'Bearer là tuỳ chọn; nếu có sẽ đánh dấu isMe cho người đang xem.',
          security: [{ bearerAuth: [] }, {}],
          parameters: [
            { $ref: '#/components/parameters/variant' },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
          ],
          responses: {
            200: {
              description: 'Danh sách người chơi theo hạng.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      variant: { type: 'string' },
                      players: { type: 'array', items: { $ref: '#/components/schemas/LeaderboardPlayer' } },
                      nextOffset: { type: 'integer', nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/games/{id}': {
        get: {
          tags: ['Ván đấu'],
          summary: 'Chi tiết replay một ván đã kết thúc',
          description: 'Công khai nhưng đã che bí mật quân úp; nếu là người trong ván (Bearer) sẽ thấy đầy đủ góc nhìn của mình.',
          security: [{ bearerAuth: [] }, {}],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'Chi tiết ván.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, game: { $ref: '#/components/schemas/GameDetail' } } } } } },
            404: { $ref: '#/components/responses/NotFound' },
          },
        },
      },
      '/feedback': {
        post: {
          tags: ['Góp ý'],
          summary: 'Gửi thư góp ý tới quản trị viên',
          description: 'Không bắt buộc đăng nhập; có Bearer thì đính kèm thông tin người gửi. Tổng tệp đính kèm tối đa 10 MB.',
          security: [{ bearerAuth: [] }, {}],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['subject', 'body'],
                  properties: {
                    subject: { type: 'string', maxLength: 200 },
                    body: { type: 'string', maxLength: 20000 },
                    attachments: {
                      type: 'array',
                      maxItems: 10,
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          dataBase64: { type: 'string', description: 'Nội dung tệp mã hoá base64.' },
                          type: { type: 'string', description: 'MIME type (tuỳ chọn).' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Đã gửi.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
            400: { $ref: '#/components/responses/BadRequest' },
            413: { description: 'Tệp đính kèm quá lớn.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            503: { description: 'Server chưa cấu hình SMTP nên tính năng tắt.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
    },
  };
}
