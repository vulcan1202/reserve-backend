-- 1. 建立全新預約課程明細表 (中間表)
CREATE TABLE IF NOT EXISTS appointment_courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id INTEGER NOT NULL,
    user_course_id INTEGER NOT NULL,
    use_count INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),

    FOREIGN KEY (appointment_id) REFERENCES Appointments(id) ON DELETE CASCADE,
    FOREIGN KEY (user_course_id) REFERENCES users_courses(id) ON DELETE CASCADE
);

-- 2.【資料無縫轉移】將舊 Appointments 表內既存的 user_course_id 自動轉入新中間表
INSERT INTO appointment_courses (appointment_id, user_course_id, use_count)
SELECT id, user_course_id, 1 
FROM Appointments 
WHERE user_course_id IS NOT NULL;

-- 3. 建立移除 user_course_id 欄位後的新 Appointments 表
CREATE TABLE Appointments_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    beautician_id INTEGER,
    appointment_code TEXT NOT NULL UNIQUE,
    notes TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'cancelled', 'complete')) DEFAULT 'pending',
    created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
    
    FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE,
    FOREIGN KEY (beautician_id) REFERENCES beauticians(id) ON DELETE SET NULL
);

-- 4. 將所有歷史預約資料完整複製至新表
INSERT INTO Appointments_new (id, user_id, date, start_time, end_time, beautician_id, appointment_code, notes, status, created_at)
SELECT id, user_id, date, start_time, end_time, beautician_id, appointment_code, notes, status, created_at 
FROM Appointments;

-- 5. 刪除舊的 Appointments 表並將新表更名
DROP TABLE Appointments;
ALTER TABLE Appointments_new RENAME TO Appointments;

-- 6. 重建原本屬性與新表的索引 (Indexes)
CREATE INDEX idx_appointments_user_id ON Appointments(user_id);
CREATE INDEX idx_appointments_date_time ON Appointments(date, start_time);
CREATE INDEX idx_appointments_status ON Appointments(status);
CREATE INDEX idx_appt_courses_appt ON appointment_courses(appointment_id);
CREATE INDEX idx_appt_courses_ucourse ON appointment_courses(user_course_id);