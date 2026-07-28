-- 啟用外鍵功能
PRAGMA foreign_keys = ON;

-- 每次執行時先刪除舊表
DROP TABLE IF EXISTS Appointments;
DROP TABLE IF EXISTS Users;
DROP TABLE IF EXISTS LineAutoReplies;

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

-- 2. 建立 LINE 自動回覆記錄表 (獨立追蹤，不綁定 Users)[cite: 1]
CREATE TABLE LineAutoReplies (
    line_id TEXT UNIQUE PRIMARY KEY,
    last_auto_reply_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
);

-- 3. 建立預約紀錄表 (Appointments)
CREATE TABLE Appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    beautician_id INTEGER,
    appointment_code TEXT NOT NULL UNIQUE,
    notes TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'cancelled', 'complete')) DEFAULT 'pending',
    -- 🌟 改為台灣時間 (UTC+8)
    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
    
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
    FOREIGN KEY (beautician_id) REFERENCES beauticians(id) ON DELETE SET NULL
);

--美容師列表
CREATE TABLE beauticians (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
);

-- 4. 建立店家休假與時段設定表 (ShopHolidays)
CREATE TABLE ShopHolidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- 類型：'full_day' (全天公休), 'time_range' (特定日期時段休息), 'weekly' (每週固定公休)
    type TEXT NOT NULL CHECK(type IN ('full_day', 'time_range', 'weekly')),
    
    -- 適用於 'full_day' 與 'time_range' (格式：YYYY-MM-DD)
    date TEXT,
    
    -- 適用於 'time_range' (格式：HH:MM)
    start_time TEXT,
    end_time TEXT,
    
    -- 適用於 'weekly' (0=週日, 1=週一, 2=週二...6=週六)
    day_of_week INTEGER CHECK(day_of_week >= 0 AND day_of_week <= 6),
    
    -- 休息原因或備註 (例如：員工旅遊、設備維護)，供老闆自己看
    reason TEXT,
    
    -- 建立時間 (台灣時間)
    created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
);

-- 建立索引以加快前端查詢特定日期的速度
CREATE INDEX idx_holidays_date ON ShopHolidays(date);
CREATE INDEX idx_holidays_type ON ShopHolidays(type);

-- 建立索引
CREATE INDEX idx_appointments_user_id ON Appointments(user_id);
CREATE INDEX idx_appointments_date_time ON Appointments(date, start_time);