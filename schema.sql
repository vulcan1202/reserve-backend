-- 啟用外鍵功能
PRAGMA foreign_keys = ON;

-- 每次執行時先刪除舊表
DROP TABLE IF EXISTS Appointments;
DROP TABLE IF EXISTS Users;

-- 1. 建立客戶資料表 (Users)
CREATE TABLE Users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    last_name TEXT NOT NULL,       -- 姓
    first_name TEXT NOT NULL,      -- 名
    phone TEXT NOT NULL UNIQUE,    -- 電話 (登入帳號，必須唯一)
    password_hash TEXT NOT NULL,   -- 256位元雜湊後的密碼
    line_id TEXT NOT NULL UNIQUE,  -- Line ID (必須唯一)
    gender TEXT NOT NULL,          -- 性別
    email TEXT,                    -- 信箱 (選填，拿掉 NOT NULL)
    notes TEXT,                    -- 備註 (給店家看)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. 建立預約紀錄表 (Appointments) - 已移除預約項目
CREATE TABLE Appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,           -- 關聯到客戶的 ID
    date TEXT NOT NULL,                 -- 預約日期 (格式: YYYY-MM-DD)
    start_time TEXT NOT NULL,           -- 開始時間 (格式: HH:MM，例如 14:30)
    end_time TEXT NOT NULL,             -- 結束時間 (格式: HH:MM，例如 17:00，自動加 2.5 小時)
    status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'cancelled')) DEFAULT 'pending', -- 狀態
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
);

-- 建立索引
CREATE INDEX idx_appointments_user_id ON Appointments(user_id);
-- 🌟 將原本的 appointment_time 改成針對 date 與 start_time 建立索引
CREATE INDEX idx_appointments_date_time ON Appointments(date, start_time);