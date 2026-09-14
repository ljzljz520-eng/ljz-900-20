-- 为已有数据库补建独立「老板」账号（可重复执行）
-- 执行: docker compose exec -T db mysql -uroot -proot hygiene_audit < backend/database/migrate_add_boss.sql
-- 账号: boss / boss123（首次登录后改为哈希密码），角色 role=boss，仅可访问汇总看板
SET NAMES utf8mb4;
USE hygiene_audit;

INSERT INTO `users` (`name`, `username`, `password_hash`, `token`, `role`, `is_active`)
SELECT '老板', 'boss', NULL, 'boss-token-001', 'boss', 1
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM `users` WHERE `username` = 'boss' OR `role` = 'boss'
);
