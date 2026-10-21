-- Xếp hạng Elo. Ván cũ (trước migration này) giữ nguyên là "không tính điểm";
-- muốn tính lại từ lịch sử: npm run ratings:rebuild
ALTER TABLE users
  ADD COLUMN rating      integer NOT NULL DEFAULT 1500,
  ADD COLUMN rated_games integer NOT NULL DEFAULT 0;

ALTER TABLE games
  ADD COLUMN rated             boolean NOT NULL DEFAULT false,
  ADD COLUMN red_rating_before integer,
  ADD COLUMN red_rating_after  integer,
  ADD COLUMN black_rating_before integer,
  ADD COLUMN black_rating_after  integer;

-- Bảng xếp hạng chỉ gồm người đã có ít nhất một ván tính điểm.
CREATE INDEX users_rating_idx ON users (rating DESC, rated_games DESC) WHERE rated_games > 0;
