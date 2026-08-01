-- 啟用外鍵功能
PRAGMA foreign_keys = ON;

-- 每次執行時先刪除舊表 (依據外鍵相依性反向順序刪除，避免衝突)
DROP INDEX IF EXISTS idx_appointments_user_id;
DROP INDEX IF EXISTS idx_appointments_date_time;
DROP INDEX IF EXISTS idx_appointments_status;
DROP INDEX IF EXISTS idx_holidays_date;
DROP INDEX IF EXISTS idx_holidays_type;
DROP INDEX IF EXISTS idx_users_courses_user;
DROP INDEX IF EXISTS idx_users_courses_course;
DROP INDEX IF EXISTS idx_questionnaires_user;
DROP INDEX IF EXISTS idx_cash_trans_date;
DROP INDEX IF EXISTS idx_cash_trans_user;
DROP INDEX IF EXISTS idx_revenue_date;
DROP INDEX IF EXISTS idx_revenue_user;
DROP INDEX IF EXISTS idx_inv_trans_product;

DROP TABLE IF EXISTS inventory_transactions;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS revenue_recognitions;
DROP TABLE IF EXISTS cash_transactions;
DROP TABLE IF EXISTS client_questionnaires;
DROP TABLE IF EXISTS users_courses;
DROP TABLE IF EXISTS courses;
DROP TABLE IF EXISTS Appointments;
DROP TABLE IF EXISTS ShopHolidays;
DROP TABLE IF EXISTS beauticians;
DROP TABLE IF EXISTS LineAutoReplies;
DROP TABLE IF EXISTS Users;


-- 1. 建立客戶資料表 (Users)
CREATE TABLE Users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    last_name TEXT NOT NULL,
    first_name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    date_of_birth TEXT NOT NULL,
    location TEXT,
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

-- 美容師列表
CREATE TABLE beauticians (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
);

-- 3. 課程資料表 (Courses)
CREATE TABLE courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,           -- 課程名稱 (例如: 精緻美學管理)
    description TEXT,             -- 課程描述
    price INTEGER NOT NULL        -- 價格
);

-- 4. 會員已購買課程表 (Users Courses)
CREATE TABLE users_courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    course_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,     -- 此次購買堂數
    remaining_count INTEGER,     -- 剩餘堂數
    purchase_date DATETIME DEFAULT CURRENT_TIMESTAMP, -- 購買時間

    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
);

CREATE TABLE appointment_courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_course_id INTEGER NOT NULL,            -- 關聯會員購買的特定課程包
    
    type TEXT NOT NULL CHECK(type IN ('usage', 'refund', 'expiry', 'adjustment')), 
    -- 🌟 異動類型：上課消耗(usage), 財務退款扣除(refund), 逾期失效(expiry), 管理員手動調整(adjustment)
    
    use_count INTEGER NOT NULL,                 -- 🌟 變動堂數 (消耗或退款填正數，代表異動了幾堂)
    balance_after INTEGER,                      -- 異動後的剩餘堂數快照 (對帳、Debug 救星)
    
    appointment_id INTEGER,                     -- 如果是上課消耗，關聯預約單 (選填，可為 NULL)
    cash_transaction_id INTEGER,                -- 🌟 如果是退款，直接關聯現金收支表 (選填，可為 NULL)
    
    description TEXT,                           -- 備註 (例如: "客人辦理退費，剩餘 5 堂清空")
    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),

    FOREIGN KEY (appointment_id) REFERENCES Appointments(id) ON DELETE SET NULL,
    FOREIGN KEY (user_course_id) REFERENCES users_courses(id) ON DELETE CASCADE,
    FOREIGN KEY (cash_transaction_id) REFERENCES cash_transactions(id) ON DELETE SET NULL
);

-- 5. 建立預約紀錄表 (Appointments)
CREATE TABLE Appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_course_id INTEGER,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    beautician_id INTEGER,
    appointment_code TEXT NOT NULL UNIQUE,
    notes TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'cancelled', 'complete')) DEFAULT 'pending',
    -- 🌟 改為台灣時間 (UTC+8)
    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
    
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE,
    FOREIGN KEY (user_course_id) REFERENCES users_courses(id) ON DELETE SET NULL,
    FOREIGN KEY (beautician_id) REFERENCES beauticians(id) ON DELETE SET NULL
);

-- 6. 初次到訪詢問表
CREATE TABLE client_questionnaires (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,               -- 關聯到 Users 會員表
    how_to_know TEXT CHECK(how_to_know IN ('instagram', 'friend', 'search', 'other')) DEFAULT 'other',                      -- 如何得知本店
    history_of_treatments TEXT,             -- 以往經驗
    allergies TEXT,                         -- 過敏原 / 藥物過敏
    medical_history TEXT,                   -- 特殊病史 / 近期醫美狀況
    skin_type TEXT,                         -- 肌膚類型
    concerns TEXT,                          -- 主要肌膚困擾
    Habit TEXT,                             -- 日常保養習慣
    notes TEXT,                             -- 其他補充備註
    agreed_to_terms INTEGER DEFAULT 0 CHECK(agreed_to_terms IN (0,1)),
    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
    
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
);

-- 7. 現金收支表 (管理實際的現金流：收入與支出)
CREATE TABLE cash_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('income', 'expense')), -- 類型：現金收入 (income) 或 現金支出 (expense)
    category TEXT NOT NULL,          -- 分類
    amount INTEGER NOT NULL,         -- 金額
    payment_method TEXT,             -- 支付方式
    user_id INTEGER,                 -- 關聯客戶 (選填)
    description TEXT,                -- 備註說明
    date TEXT NOT NULL,              -- 交易發生日期 (YYYY-MM-DD)
    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
    
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE SET NULL
);

-- 8. 實質營收認列表 (管理當日實際產生的營收)
CREATE TABLE revenue_recognitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL CHECK(source_type IN ('course_usage', 'product_sale')), -- 來源
    amount INTEGER NOT NULL,         -- 當日認列營收金額
    user_id INTEGER NOT NULL,        -- 關聯客戶
    appointment_id INTEGER,          -- 關聯預約單
    user_course_id INTEGER,          -- 關聯會員購買的課程項目
    description TEXT,                -- 備註
    date TEXT NOT NULL,              -- 營收認列日期 (YYYY-MM-DD)
    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),

    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE,
    FOREIGN KEY (appointment_id) REFERENCES Appointments(id) ON DELETE SET NULL,
    FOREIGN KEY (user_course_id) REFERENCES users_courses(id) ON DELETE SET NULL
);

-- 9. 產品資料表 (Products)
CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,              -- 產品名稱
    cost_price INTEGER NOT NULL,     -- 成本價
    selling_price INTEGER NOT NULL,  -- 售價
    stock_quantity INTEGER NOT NULL DEFAULT 0, -- 當前庫存數量
    created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
);

-- 10. 庫存異動與進銷存紀錄表 (Inventory Transactions)
CREATE TABLE inventory_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('purchase', 'sale', 'usage', 'adjustment')), 
    quantity INTEGER NOT NULL,       -- 變動數量
    unit_price INTEGER NOT NULL,     -- 當時的單價
    total_amount INTEGER NOT NULL,   -- 總金額
    user_id INTEGER,                 -- 關聯客戶
    description TEXT,                -- 備註說明
    date TEXT NOT NULL,              -- 發生日期 (YYYY-MM-DD)
    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),

    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE SET NULL
);

-- 11. 建立店家休假與時段設定表 (ShopHolidays)
CREATE TABLE ShopHolidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('full_day', 'time_range', 'weekly')),
    date TEXT,
    start_time TEXT,
    end_time TEXT,
    day_of_week INTEGER CHECK(day_of_week >= 0 AND day_of_week <= 6),
    reason TEXT,
    created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
);


-- ==========================================
-- 🌟 建立所有高效能索引 (Indexes)
-- ==========================================

-- 預約相關查詢優化
CREATE INDEX idx_appointments_user_id ON Appointments(user_id);
CREATE INDEX idx_appointments_date_time ON Appointments(date, start_time);
CREATE INDEX idx_appointments_status ON Appointments(status);
CREATE INDEX idx_appt_courses_appt ON appointment_courses(appointment_id);
CREATE INDEX idx_appt_courses_ucourse ON appointment_courses(user_course_id);
CREATE INDEX idx_appt_courses_type ON appointment_courses(type);

-- 店家休假查詢優化
CREATE INDEX idx_holidays_date ON ShopHolidays(date);
CREATE INDEX idx_holidays_type ON ShopHolidays(type);

-- 會員課程與問卷查詢優化
CREATE INDEX idx_users_courses_user ON users_courses(user_id);
CREATE INDEX idx_users_courses_course ON users_courses(course_id);
CREATE INDEX idx_questionnaires_user ON client_questionnaires(user_id);

-- 財務收支與營收報表查詢優化 (常需依據日期區間與客戶過濾)
CREATE INDEX idx_cash_trans_date ON cash_transactions(date);
CREATE INDEX idx_cash_trans_user ON cash_transactions(user_id);
CREATE INDEX idx_revenue_date ON revenue_recognitions(date);
CREATE INDEX idx_revenue_user ON revenue_recognitions(user_id);

-- 庫存異動查詢優化
CREATE INDEX idx_inv_trans_product ON inventory_transactions(product_id);
CREATE INDEX idx_inv_trans_date ON inventory_transactions(date);