-- Seed Cờ Úp online chuyển sang khóa ngẫu nhiên 128-bit dạng hex.
-- Giữ tương thích các bản ghi uint32 cũ; server mới chỉ tạo dạng 32 ký tự hex.
ALTER TABLE games DROP CONSTRAINT games_jieqi_seed_check;

ALTER TABLE games
  ALTER COLUMN seed TYPE text USING seed::text;

ALTER TABLE games ADD CONSTRAINT games_jieqi_seed_check CHECK (
  (variant = 'xiangqi' AND seed IS NULL AND seed_hash IS NULL)
  OR
  (variant = 'jieqi'
    AND seed IS NOT NULL
    AND seed_hash IS NOT NULL
    AND seed ~ '^([0-9]{1,10}|[0-9a-f]{32})$'
    AND seed_hash ~ '^[0-9a-f]{64}$')
);
