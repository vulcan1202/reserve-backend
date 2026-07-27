-- 啟用外鍵功能
PRAGMA foreign_keys = ON;

-- 每次執行時先刪除舊表
DROP TABLE IF EXISTS Appointments;
DROP TABLE IF EXISTS Users;

-- 1. 建立客戶資料表 (Users)
CREATE TABLE Users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    last_name TEXT NOT NULL,
    first_name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    line_id TEXT NOT NULL UNIQUE,
    gender TEXT NOT NULL,
    email TEXT,
    notes TEXT,
    -- 🌟 改為台灣時間 (UTC+8)
    created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
);

-- 2. 建立預約紀錄表 (Appointments)
CREATE TABLE Appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    -- 🌟 新增預約編號欄位
    appointment_code TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'cancelled')) DEFAULT 'pending',
    -- 🌟 改為台灣時間 (UTC+8)
    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
    
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
);

-- 建立索引
CREATE INDEX idx_appointments_user_id ON Appointments(user_id);
CREATE INDEX idx_appointments_date_time ON Appointments(date, start_time);