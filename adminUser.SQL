-- ========================================================
-- Admin Authentication Schema (adminUser.SQL)
-- 基於 Argon2id 與 Cookie Session 的管理員驗證機制
-- ========================================================

-- 1. 管理員帳號表 (AdminUsers)
CREATE TABLE IF NOT EXISTS AdminUsers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,           -- Argon2id PHC 格式化字串 ($argon2id$v=19$m=65536,t=3,p=1$...)
    role TEXT DEFAULT 'admin',             -- 權限角色 (預設 'admin')
    created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
);

-- 2. 管理員 Session 表 (AdminSessions)
CREATE TABLE IF NOT EXISTS AdminSessions (
    id TEXT PRIMARY KEY,                   -- 隨機 Session Token / UUID
    admin_id INTEGER NOT NULL,             -- 關聯 AdminUsers.id
    expires_at DATETIME NOT NULL,          -- Session 到期時間 (UTC+8 或 ISO 格式)
    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
    FOREIGN KEY (admin_id) REFERENCES AdminUsers(id) ON DELETE CASCADE
);

-- 3. 索引優化
CREATE INDEX IF NOT EXISTS idx_admin_users_username ON AdminUsers(username);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_id ON AdminSessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON AdminSessions(expires_at);
