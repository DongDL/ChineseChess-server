-- 1. Xóa schema public cũ và toàn bộ bảng, hàm bên trong nó
DROP SCHEMA public CASCADE;

-- 2. Tạo lại schema public mới trống hoàn toàn
CREATE SCHEMA public;

-- 3. Khôi phục lại quyền mặc định (Cần thiết để các user có thể tương tác bình thường)
GRANT ALL ON SCHEMA public TO postgres;
GRANT ALL ON SCHEMA public TO public;