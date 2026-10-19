-- Schema ban đầu: tài khoản, đăng nhập mạng xã hội, phiên, lịch sử đăng nhập, ván đấu.
-- UUID do ứng dụng sinh (không cần extension). Thời gian dùng timestamptz.

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  -- username/password_hash để NULL với tài khoản chỉ đăng nhập bằng Google/Facebook/Zalo
  username      text UNIQUE CHECK (username IS NULL OR username = lower(username)),
  display_name  text NOT NULL,
  password_hash text,
  email         text,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- Danh tính từ nhà cung cấp bên ngoài. Mỗi (provider, provider_user_id) thuộc đúng một tài khoản,
-- và mỗi tài khoản chỉ liên kết một danh tính cho mỗi nhà cung cấp.
CREATE TABLE oauth_identities (
  provider         text NOT NULL,
  provider_user_id text NOT NULL,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email            text,
  display_name     text,
  avatar_url       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_login_at    timestamptz,
  PRIMARY KEY (provider, provider_user_id),
  UNIQUE (user_id, provider)
);

-- Phiên đăng nhập. Chỉ lưu BĂM của token.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  method     text NOT NULL,
  ip         text,
  user_agent text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Trạng thái đang dở của luồng OAuth (chống CSRF + PKCE), dùng một lần, sống ngắn.
CREATE TABLE oauth_states (
  state_hash    text PRIMARY KEY,
  provider      text NOT NULL,
  app_redirect  text NOT NULL,
  code_verifier text NOT NULL,
  link_user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL
);

-- Mã dùng một lần để app đổi lấy token sau khi đăng nhập mạng xã hội xong.
CREATE TABLE oauth_codes (
  code_hash  text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method     text NOT NULL,
  expires_at timestamptz NOT NULL
);

-- Lịch sử đăng nhập (kể cả thất bại): đăng ký, đăng nhập, đăng xuất, liên kết...
CREATE TABLE auth_events (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  event      text NOT NULL,
  method     text NOT NULL,
  success    boolean NOT NULL,
  ip         text,
  user_agent text,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_events_user_idx ON auth_events (user_id, created_at DESC);
CREATE INDEX auth_events_created_idx ON auth_events (created_at);

-- Ván đấu đã kết thúc. Khách không có tài khoản thì user_id để NULL nhưng vẫn lưu tên.
-- KHÔNG lưu playerId của khách (đó là "chìa khoá" bí mật của họ).
CREATE TABLE games (
  id               uuid PRIMARY KEY,
  room_id          text NOT NULL,
  red_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  black_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  red_name         text NOT NULL,
  black_name       text NOT NULL,
  red_guest        boolean NOT NULL,
  black_guest      boolean NOT NULL,
  base_ms          integer,
  increment_ms     integer,
  result           text NOT NULL CHECK (result IN ('red', 'black', 'draw')),
  end_reason       text NOT NULL,
  move_count       integer NOT NULL,
  moves            jsonb NOT NULL,
  red_remaining_ms integer,
  black_remaining_ms integer,
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz NOT NULL
);
CREATE INDEX games_red_idx ON games (red_user_id, ended_at DESC) WHERE red_user_id IS NOT NULL;
CREATE INDEX games_black_idx ON games (black_user_id, ended_at DESC) WHERE black_user_id IS NOT NULL;
