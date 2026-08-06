-- ========================================================
-- Admin Authentication & Notifications Schema (adminUser.SQL)
-- 基於 Argon2id 與 Cookie Session 的管理員驗證機制與個人化通知持久化
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

-- 3. 管理員獨立通知表 (admin_notifications) - 支援獨立已讀與實體物理刪除防肥大
CREATE TABLE IF NOT EXISTS admin_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,               -- 接收通知的管理員帳號 ID
    notification_id VARCHAR(100) NOT NULL,    -- 通知唯一識別碼 (如 "appt-105", "fin-weekly-2026-08-02")
    type VARCHAR(50) NOT NULL,                -- 通知類型 ('appointment', 'financial_weekly', 'financial_monthly')
    title VARCHAR(255) NOT NULL,              -- 通知標題
    message TEXT,                             -- 通知詳細內容
    link VARCHAR(255),                        -- 點擊跳轉連結
    badge_text VARCHAR(50),                   -- 標籤文字
    badge_class VARCHAR(100),                 -- 標籤樣式
    icon VARCHAR(50),                         -- 圖示名稱
    icon_bg VARCHAR(100),                     -- 圖示背景
    is_read INTEGER DEFAULT 0,               -- 0: 未讀, 1: 已讀
    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
    UNIQUE(admin_id, notification_id)         -- 確保同一管理員對同一事件不重複派發
);

-- 4. 索引優化
CREATE INDEX IF NOT EXISTS idx_admin_users_username ON AdminUsers(username);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_id ON AdminSessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON AdminSessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_notif_lookup ON admin_notifications(admin_id, is_read, created_at);
