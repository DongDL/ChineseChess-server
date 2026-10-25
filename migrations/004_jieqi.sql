-- Cờ Úp (Jieqi): metadata ván và Elo tách riêng theo biến thể.
-- Chuỗi nước vẫn nằm trong games.moves JSONB; revealedPiece được lưu trong từng phần tử,
-- vì schema hiện tại không có bảng moves riêng.

ALTER TABLE games
  ADD COLUMN variant text NOT NULL DEFAULT 'xiangqi'
    CHECK (variant IN ('xiangqi', 'jieqi')),
  ADD COLUMN seed bigint,
  ADD COLUMN seed_hash text;

ALTER TABLE games ADD CONSTRAINT games_jieqi_seed_check CHECK (
  (variant = 'xiangqi' AND seed IS NULL AND seed_hash IS NULL)
  OR
  (variant = 'jieqi' AND seed BETWEEN 0 AND 4294967295 AND seed_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX games_variant_ended_idx ON games (variant, ended_at DESC);

CREATE TABLE ratings (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  variant      text NOT NULL CHECK (variant IN ('xiangqi', 'jieqi')),
  elo          integer NOT NULL DEFAULT 1500,
  games_played integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, variant)
);

-- Giữ nguyên điểm Xiangqi đã có từ migration 002.
INSERT INTO ratings (user_id, variant, elo, games_played)
SELECT id, 'xiangqi', rating, rated_games FROM users;

CREATE INDEX ratings_leaderboard_idx
  ON ratings (variant, elo DESC, games_played DESC, user_id)
  WHERE games_played > 0;
