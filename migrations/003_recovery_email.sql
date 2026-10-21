-- Email khôi phục mật khẩu. Tách khỏi users.email (email do Google/Facebook/Zalo trả về, chưa được xác minh ở đây).
-- Chỉ email ĐÃ XÁC MINH mới được dùng để quên mật khẩu, và mỗi email đã xác minh chỉ thuộc một tài khoản.
ALTER TABLE users
  ADD COLUMN recovery_email             text,
  ADD COLUMN recovery_email_verified_at timestamptz;

CREATE UNIQUE INDEX users_recovery_email_uidx
  ON users (lower(recovery_email)) WHERE recovery_email_verified_at IS NOT NULL;

-- Mã 6 số gửi qua email (xác minh email / đặt lại mật khẩu). Chỉ lưu BĂM của mã; mỗi (tài khoản, mục đích) chỉ có một mã
-- đang hiệu lực (gửi mã mới thì mã cũ mất). attempts đếm số lần nhập sai.
CREATE TABLE email_codes (
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text        NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  email      text        NOT NULL,
  code_hash  text        NOT NULL,
  attempts   integer     NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, purpose)
);
