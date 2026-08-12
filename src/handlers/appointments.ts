// ========================================================
// 預約管理 API (handlers/appointments.ts)
// ========================================================
import type { 
  HandlerContext, 
  AppointmentCreateBody, 
  AppointmentPatchBody, 
  CompleteAppointmentBody 
} from "../types";
import { AppointmentStatus, HolidayType } from "../types";
import { successResponse, errorResponse, calculateEndTime, calculateAge } from "../utils";
import { MAX_RETRY } from "../constants";
import { dispatchNotificationToAllAdmins } from "./adminNotifications";
import { syncAppointmentToGoogleCalendar, deleteGoogleCalendarEvent } from "../utils/googleCalendar";

export async function handleCreateAppointment(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as AppointmentCreateBody;
    const { user_id, date, start_time, beautician_id } = body;
    if (!user_id || !date || !start_time) return errorResponse("缺少必要的預約資訊", 400, headers);

    // 🌟 0. 讀取系統預約開放與限制設定
    try {
      const { results: settingsRows } = await env.reserve_db.prepare(
        "SELECT key, value FROM system_settings WHERE key IN ('booking_advance_days', 'booking_enabled')"
      ).all() as { results: Array<{ key: string; value: string }> };

      const settingsMap: Record<string, string> = {
        booking_advance_days: "60",
        booking_enabled: "1"
      };
      if (settingsRows) {
        for (const r of settingsRows) settingsMap[r.key] = r.value;
      }

      if (settingsMap.booking_enabled === "0" || settingsMap.booking_enabled === "false") {
        return errorResponse("店家目前暫時關閉線上預約功能，請直接聯繫門市。", 400, headers);
      }

      const advanceDays = Number(settingsMap.booking_advance_days || 60);
      const todayStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      const maxDateObj = new Date(Date.now() + 8 * 3600 * 1000 + advanceDays * 86400000);
      const maxAllowedDateStr = maxDateObj.toISOString().slice(0, 10);

      if (date < todayStr) {
        return errorResponse("預約日期不可為過去的時間", 400, headers);
      }
      if (date > maxAllowedDateStr) {
        return errorResponse(`預約日期超出開放期限（店家目前最高開放未來 ${advanceDays} 天內之預約）`, 400, headers);
      }
    } catch (e) {
      console.warn("驗證預約系統設定時警告:", e);
    }

    const end_time = calculateEndTime(start_time);
    const reqDate = new Date(date);
    const dayOfWeek = reqDate.getDay();

    const holiday = await env.reserve_db.prepare(
      `SELECT * FROM ShopHolidays 
       WHERE (type = ? AND date = ?) OR (type = ? AND day_of_week = ?) OR (type = ? AND date = ? AND (
               (start_time <= ? AND end_time > ?) OR (start_time < ? AND end_time >= ?) OR (start_time >= ? AND end_time <= ?)
             ))`
    ).bind(
      HolidayType.FULL_DAY, date, HolidayType.WEEKLY, dayOfWeek, HolidayType.TIME_RANGE, date,
      start_time, start_time, end_time, end_time, start_time, end_time
    ).first();
    if (holiday) return errorResponse("抱歉！您選擇的時間為店家公休日或休息時段，請重新選擇。", 409, headers);

    const conflict = await env.reserve_db.prepare(
      `SELECT id FROM Appointments WHERE date = ? AND status != ? AND (start_time < ? AND end_time > ?)`
    ).bind(date, AppointmentStatus.CANCELLED, end_time, start_time).first();
    if (conflict) return errorResponse("真不巧！這個時段已經被人預約走了，請選擇其他時間。", 409, headers);

    let appointment_code = '';
    let insertResult: { id: number } | null = null;
    const finalBeauticianId = (beautician_id && Number(beautician_id) > 0) ? Number(beautician_id) : null;

    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      const random = Math.random().toString(36).substring(2, 8).toUpperCase();
      appointment_code = `RV-${random}`;
      try {
        insertResult = await env.reserve_db.prepare(
          `INSERT INTO Appointments (user_id, date, start_time, end_time, beautician_id, appointment_code)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
        ).bind(user_id, date, start_time, end_time, finalBeauticianId, appointment_code).first() as { id: number } | null;
        break;
      } catch (err: unknown) {
        if ((err as { message?: string })?.message?.includes('UNIQUE') && attempt < MAX_RETRY - 1) continue;
        throw err;
      }
    }

    // 🌟 若建立預約時狀態即為已確認，自動寫入對應的 Google 日曆
    const currentStatus = (body as any).status || AppointmentStatus.PENDING;
    if ((currentStatus === AppointmentStatus.CONFIRMED || currentStatus === 'confirmed') && env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY) {
      try {
        const user = await env.reserve_db.prepare(
          `SELECT last_name, first_name FROM Users WHERE id = ?`
        ).bind(user_id).first() as { last_name?: string; first_name?: string } | null;

        const clientName = user ? `${user.last_name || ''}${user.first_name || ''}` : `客戶_${user_id}`;

        await syncAppointmentToGoogleCalendar(env, {
          clientName,
          date,
          startTime: start_time,
          endTime: end_time,
        });
      } catch (calendarErr) {
        console.error("Google 日曆寫入失敗：", calendarErr);
      }
    }

    return successResponse({
      appointment: { id: insertResult?.id, date, start_time, end_time, appointment_code }
    }, "預約成功！", 201, headers);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error("預約失敗：", error);
    return errorResponse("預約失敗：" + (err.message || "未知錯誤"), 500, headers);
  }
}

export async function handleGetAppointments(ctx: HandlerContext): Promise<Response> {
  const { env, headers } = ctx;
  try {
    const userId = ctx.url.searchParams.get('user_id');
    const date = ctx.url.searchParams.get('date');

    let query = `
      SELECT 
        Appointments.id, Appointments.date, Appointments.start_time, Appointments.end_time,
        Appointments.status, Appointments.notes AS notes, Appointments.appointment_code, Appointments.created_at,
        Appointments.beautician_id, beauticians.name AS beautician_name,
        Users.id AS user_id, Users.last_name || Users.first_name AS client_name,
        Users.phone AS client_phone, Users.email AS client_email, Users.gender AS client_gender,
        Users.date_of_birth AS client_date_of_birth, Users.location AS client_location,
        Users.notes AS user_notes,
        (SELECT COUNT(*) FROM Appointments A2 WHERE A2.user_id = Users.id AND A2.status = ?) AS visit_count
      FROM Appointments
      JOIN Users ON Appointments.user_id = Users.id
      LEFT JOIN beauticians ON Appointments.beautician_id = beauticians.id
    `;

    let results: any[];
    if (date) {
      query += " WHERE Appointments.date = ? AND Appointments.status != ? ORDER BY Appointments.start_time ASC";
      const res = await env.reserve_db.prepare(query).bind(AppointmentStatus.COMPLETE, date, AppointmentStatus.CANCELLED).all();
      results = res.results;
    } else if (userId) {
      query += " WHERE Appointments.user_id = ? ORDER BY Appointments.date DESC, Appointments.start_time DESC";
      const res = await env.reserve_db.prepare(query).bind(AppointmentStatus.COMPLETE, userId).all();
      results = res.results;
    } else {
      query += " ORDER BY Appointments.date ASC, Appointments.start_time ASC";
      const res = await env.reserve_db.prepare(query).bind(AppointmentStatus.COMPLETE).all();
      results = res.results;
    }

    results = results.map((item: any) => ({
      ...item,
      age: calculateAge(item.client_date_of_birth)
    }));

    return successResponse(results, undefined, 200, headers);
  } catch (error: unknown) {
    console.error("讀取預約失敗：", error);
    return errorResponse("讀取預約資料失敗", 500, headers);
  }
}

export async function handlePatchAppointment(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as AppointmentPatchBody;
    const { id, status, notes, user_id, user_notes, beautician_id, date, start_time } = body as any;
    if (!id) return errorResponse("缺少預約 ID", 400, headers);

    const batchStatements: any[] = [];

    // 🌟 1. 讀取預約變更前的原始資料與客戶名稱
    const oldAppt = await env.reserve_db.prepare(`
      SELECT A.id, A.date, A.start_time, A.end_time, A.status, A.user_id, U.last_name || U.first_name AS client_name 
      FROM Appointments A 
      JOIN Users U ON A.user_id = U.id 
      WHERE A.id = ?
    `).bind(id).first<{ id: number; date: string; start_time: string; end_time: string; status: string; user_id: number; client_name: string }>();

    if (!oldAppt) return errorResponse("找不到該筆預約紀錄", 404, headers);

    const isDateChanged = date !== undefined && date !== oldAppt.date;
    const isTimeChanged = start_time !== undefined && start_time !== oldAppt.start_time;

    let newDate = oldAppt.date;
    let newStartTime = oldAppt.start_time;
    let newEndTime = oldAppt.end_time;

    // 🌟 2. 若有修改預約日期或時間，執行狀態限制、衝突檢查、結束時間重新計算與 Google 日曆重同步
    if (isDateChanged || isTimeChanged) {
      // 限制：只有「待審核 (pending)」或「已確認 (confirmed)」的預約才能修改時間
      if (
        oldAppt.status !== AppointmentStatus.PENDING &&
        oldAppt.status !== 'pending' &&
        oldAppt.status !== AppointmentStatus.CONFIRMED &&
        oldAppt.status !== 'confirmed'
      ) {
        return errorResponse("修改失敗：只有「審核中」或「已確認」的預約才可以調整時間。", 400, headers);
      }

      newDate = date !== undefined ? date : oldAppt.date;
      newStartTime = start_time !== undefined ? start_time : oldAppt.start_time;
      newEndTime = calculateEndTime(newStartTime);

      // A. 公休日與休息時段衝突校驗
      const reqDate = new Date(newDate);
      const dayOfWeek = reqDate.getDay();
      const holiday = await env.reserve_db.prepare(
        `SELECT * FROM ShopHolidays 
         WHERE (type = ? AND date = ?) OR (type = ? AND day_of_week = ?) OR (type = ? AND date = ? AND (
                 (start_time <= ? AND end_time > ?) OR (start_time < ? AND end_time >= ?) OR (start_time >= ? AND end_time <= ?)
               ))`
      ).bind(
        HolidayType.FULL_DAY, newDate, HolidayType.WEEKLY, dayOfWeek, HolidayType.TIME_RANGE, newDate,
        newStartTime, newStartTime, newEndTime, newEndTime, newStartTime, newEndTime
      ).first();

      if (holiday) {
        return errorResponse("修改失敗：您選擇的新時間為店家公休日或休息時段，請選擇其他時間。", 409, headers);
      }

      // B. 與其他未取消預約的時間重疊衝突校驗
      const conflict = await env.reserve_db.prepare(
        `SELECT id FROM Appointments WHERE id != ? AND date = ? AND status != ? AND (start_time < ? AND end_time > ?)`
      ).bind(id, newDate, AppointmentStatus.CANCELLED, newEndTime, newStartTime).first();

      if (conflict) {
        return errorResponse("修改失敗：您選擇的新時段與其他預約時間重疊，請選擇其他時間。", 409, headers);
      }

      // C. 更新 Appointments 的 date, start_time, end_time
      batchStatements.push(
        env.reserve_db.prepare("UPDATE Appointments SET date = ?, start_time = ?, end_time = ? WHERE id = ?").bind(newDate, newStartTime, newEndTime, id)
      );

      // D. 若預約當前狀態已是「已確認 (confirmed)」，刪除舊時間 Google 日曆並寫入新時間 Google 日曆
      const isConfirmedAppt = String(oldAppt.status) === 'confirmed' || String(oldAppt.status) === AppointmentStatus.CONFIRMED;
      if (isConfirmedAppt && status === undefined) {
        if (env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY) {
          try {
            await deleteGoogleCalendarEvent(env, {
              clientName: oldAppt.client_name || `客戶_${id}`,
              date: oldAppt.date,
              startTime: oldAppt.start_time,
              endTime: oldAppt.end_time,
            });
            await syncAppointmentToGoogleCalendar(env, {
              clientName: oldAppt.client_name || `客戶_${id}`,
              date: newDate,
              startTime: newStartTime,
              endTime: newEndTime,
            });
          } catch (calendarErr) {
            console.error("時間變更同步 Google 日曆失敗：", calendarErr);
          }
        }
      }
    }

    if (status !== undefined) {
      const appt = await env.reserve_db.prepare("SELECT status FROM Appointments WHERE id = ?").bind(id).first() as { status: string } | null;
      
      // 當預約從「已完成」改回「未完成」或「取消」時，執行全面回滾
      if (appt && appt.status === AppointmentStatus.COMPLETE && status !== AppointmentStatus.COMPLETE) {
        
        // 1. 取得該預約的所有堂數流水帳紀錄
        const usedCourses = await env.reserve_db.prepare(
          "SELECT user_course_id, use_count FROM appointment_courses WHERE appointment_id = ?"
        ).bind(id).all();

        if (usedCourses.results && usedCourses.results.length > 0) {
          for (const uc of usedCourses.results as { user_course_id: number, use_count: number }[]) {
            
            const checkNewBuy = await env.reserve_db.prepare(
              "SELECT id FROM cash_transactions WHERE user_id = (SELECT user_id FROM users_courses WHERE id = ?) AND description LIKE ?"
            ).bind(uc.user_course_id, `%現場購買%`).first();

            if (checkNewBuy) {
              batchStatements.push(
                env.reserve_db.prepare("DELETE FROM users_courses WHERE id = ?").bind(uc.user_course_id)
              );
            } else {
              batchStatements.push(
                env.reserve_db.prepare("UPDATE users_courses SET remaining_count = remaining_count + ? WHERE id = ?").bind(uc.use_count, uc.user_course_id)
              );
            }
          }
        }

        batchStatements.push(
          env.reserve_db.prepare("DELETE FROM appointment_courses WHERE appointment_id = ?").bind(id)
        );

        batchStatements.push(
          env.reserve_db.prepare("DELETE FROM revenue_recognitions WHERE appointment_id = ?").bind(id)
        );

        batchStatements.push(
          env.reserve_db.prepare("DELETE FROM cash_transactions WHERE description LIKE ? AND user_id IN (SELECT user_id FROM Appointments WHERE id = ?)").bind(`%現場購買%`, id)
        );
      }
      
      batchStatements.push(
        env.reserve_db.prepare("UPDATE Appointments SET status = ? WHERE id = ?").bind(status, id)
      );
    }

    if (notes !== undefined) {
      batchStatements.push(env.reserve_db.prepare("UPDATE Appointments SET notes = ? WHERE id = ?").bind(notes, id));
    }
    if (beautician_id !== undefined) {
      batchStatements.push(env.reserve_db.prepare("UPDATE Appointments SET beautician_id = ? WHERE id = ?").bind(beautician_id, id));
    }
    if (user_notes !== undefined && user_id) {
      batchStatements.push(env.reserve_db.prepare("UPDATE Users SET notes = ? WHERE id = ?").bind(user_notes, user_id));
    }

    if (batchStatements.length > 0) {
      await env.reserve_db.batch(batchStatements);
    }

    if (status !== undefined) {
      // 🌟 即時性廣播通知派發給所有 Admin 帳號 (Instant Notification Dispatch)
      const apptDetail = await env.reserve_db.prepare(`
        SELECT A.id, A.date, A.start_time, A.end_time, A.beautician_id, A.appointment_code, U.last_name || U.first_name AS client_name 
        FROM Appointments A 
        JOIN Users U ON A.user_id = U.id 
        WHERE A.id = ?
      `).bind(id).first<{ id: number; date: string; start_time: string; end_time: string; beautician_id?: number | null; appointment_code: string; client_name: string }>();

      if (apptDetail) {
        if (status === AppointmentStatus.CONFIRMED || status === 'confirmed') {
          const notifId = `appt-confirmed-${id}`;
          const title = `【預約確認】${apptDetail.client_name || '客戶'} 的預約已確認`;
          const message = `預約時間：${apptDetail.date} ${apptDetail.start_time} | 預約單號：${apptDetail.appointment_code}`;
          await dispatchNotificationToAllAdmins(
            env,
            notifId,
            'appointment',
            title,
            message,
            '/Appointment',
            '預約已確認',
            'bg-emerald-100 text-emerald-800 border-emerald-200',
            'mdi:calendar-check',
            'bg-emerald-50 text-emerald-600 border border-emerald-200'
          );

          // 🌟 預約確認時自動寫入對應的 Google 日曆
          if (env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY) {
            try {
              await syncAppointmentToGoogleCalendar(env, {
                clientName: apptDetail.client_name || `客戶_${id}`,
                date: apptDetail.date,
                startTime: apptDetail.start_time,
                endTime: apptDetail.end_time,
              });
            } catch (calendarErr: any) {
              console.error("Google 日曆寫入失敗：", calendarErr?.message || calendarErr);
            }
          } else {
            console.warn("⚠️ 未設定 GOOGLE_SERVICE_ACCOUNT_EMAIL 或 GOOGLE_PRIVATE_KEY，跳過 Google 日曆同步。");
          }
        } else if (status === AppointmentStatus.CANCELLED || status === 'cancelled' || status === 'cancel') {
          const notifId = `appt-cancelled-${id}`;
          const title = `【預約取消】${apptDetail.client_name || '客戶'} 的預約已取消`;
          const message = `預約時間：${apptDetail.date} ${apptDetail.start_time} | 預約單號：${apptDetail.appointment_code}`;
          await dispatchNotificationToAllAdmins(
            env,
            notifId,
            'appointment',
            title,
            message,
            '/Appointment',
            '預約已取消',
            'bg-rose-100 text-rose-800 border-rose-200',
            'mdi:calendar-remove',
            'bg-rose-50 text-rose-600 border border-rose-200'
          );

          // 🌟 預約取消時自動刪除 Google 日曆事件
          if (env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY) {
            try {
              await deleteGoogleCalendarEvent(env, {
                clientName: apptDetail.client_name || `客戶_${id}`,
                date: apptDetail.date,
                startTime: apptDetail.start_time,
                endTime: apptDetail.end_time,
              });
            } catch (calendarErr) {
              console.error("Google 日曆刪除失敗：", calendarErr);
            }
          }
        }
      }
    }

    return successResponse({}, "預約資料更新成功", 200, headers);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error("更新失敗：", error);
    return errorResponse("更新失敗：" + (err.message || "未知錯誤"), 500, headers);
  }
}

export async function handleCompleteAppointment(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as CompleteAppointmentBody;
    const { appointment_id, courses_used, new_courses_bought, date } = body;

    if (!appointment_id) return errorResponse("缺少預約 ID", 400, headers);

    const appt = await env.reserve_db.prepare(
      "SELECT id, user_id, date FROM Appointments WHERE id = ?"
    ).bind(appointment_id).first() as { id: number; user_id: number; date: string } | null;

    if (!appt) return errorResponse("找不到該筆預約記錄", 404, headers);

    const batchStatements: any[] = [];
    const transactionDate = date || appt.date; 

    batchStatements.push(
      env.reserve_db.prepare(
        "UPDATE Appointments SET status = ? WHERE id = ?"
      ).bind(AppointmentStatus.COMPLETE, appointment_id)
    );

    if (courses_used && courses_used.length > 0) {
      for (const item of courses_used) {
        if (!item.user_course_id || !item.use_count || item.use_count <= 0) continue;

        const courseInfo = await env.reserve_db.prepare(`
          SELECT uc.id AS user_course_id, uc.amount AS total_amount, uc.remaining_count, c.price AS default_unit_price, c.name AS course_name,
                 (SELECT amount FROM cash_transactions WHERE user_id = appt.user_id AND category = '課程包套預收' AND description LIKE '%' || c.name || '%' ORDER BY id DESC LIMIT 1) AS actual_paid
          FROM users_courses uc
          JOIN courses c ON uc.course_id = c.id
          WHERE uc.id = ? AND uc.user_id = ?
        `).bind(item.user_course_id, appt.user_id).first() as { user_course_id: number; total_amount: number; remaining_count: number; default_unit_price: number; course_name: string; actual_paid?: number } | null;

        if (!courseInfo) return errorResponse(`找不到合約資料`, 400, headers);
        if (courseInfo.remaining_count < item.use_count) return errorResponse(`剩餘堂數不足`, 400, headers);

        const totalPackageAmount = courseInfo.total_amount || 1;
        const actualPaidTotal = (typeof courseInfo.actual_paid === 'number' && courseInfo.actual_paid > 0)
          ? courseInfo.actual_paid
          : (courseInfo.default_unit_price * totalPackageAmount);

        const newRemaining = courseInfo.remaining_count - item.use_count;
        let recognizedAmount = 0;

        if (newRemaining === 0) {
          // 最後一堂用罄：財務實務倒擠清算法 - 以「實際總成交金額 - 過去累積已認列金額」全數清算，解決小數點除不盡誤差
          const alreadyRecognizedRes = await env.reserve_db.prepare(`
            SELECT COALESCE(SUM(amount), 0) AS recognized_total FROM revenue_recognitions WHERE user_course_id = ?
          `).bind(item.user_course_id).first() as { recognized_total: number } | null;
          
          const alreadyRecognized = alreadyRecognizedRes?.recognized_total || 0;
          recognizedAmount = Math.max(0, actualPaidTotal - alreadyRecognized);
        } else {
          // 一般堂數：依 (實際總售價 / 總堂數 * 扣除堂數) 四捨五入取整數
          const unitPrice = actualPaidTotal / totalPackageAmount;
          recognizedAmount = Math.round(unitPrice * item.use_count);
        }

        batchStatements.push(env.reserve_db.prepare(
          `INSERT INTO appointment_courses (appointment_id, user_course_id, type, use_count, balance_after, description) 
           VALUES (?, ?, 'usage', ?, ?, ?)`
        ).bind(appointment_id, item.user_course_id, item.use_count, newRemaining, `到店履約扣堂：${courseInfo.course_name}`));
        
        batchStatements.push(env.reserve_db.prepare(`UPDATE users_courses SET remaining_count = ? WHERE id = ?`).bind(newRemaining, item.user_course_id));
        
        batchStatements.push(env.reserve_db.prepare(
          `INSERT INTO revenue_recognitions (source_type, appointment_id, user_id, user_course_id, amount, description, date) 
           VALUES ('course_usage', ?, ?, ?, ?, ?, ?)`
        ).bind(
          appointment_id, 
          appt.user_id, 
          item.user_course_id, 
          recognizedAmount, 
          `課程履約認列：${courseInfo.course_name} x ${item.use_count} 堂`, 
          transactionDate
        ));
      }
    }

    if (new_courses_bought && new_courses_bought.length > 0) {
      for (const item of new_courses_bought) {
        if (!item.course_id || !item.buy_amount || item.buy_amount <= 0) continue;

        const courseInfo = await env.reserve_db.prepare(`SELECT price, name FROM courses WHERE id = ?`).bind(item.course_id).first() as { price: number; name: string } | null;
        if (!courseInfo) return errorResponse(`找不到課程資料`, 400, headers);

        const defaultTotalPrice = courseInfo.price * item.buy_amount;
        const totalPrice = (typeof item.custom_total_price === 'number' && !isNaN(item.custom_total_price) && item.custom_total_price >= 0)
          ? item.custom_total_price
          : defaultTotalPrice;

        const useCount = (typeof item.use_count === 'number' && item.use_count > 0) ? item.use_count : 0;
        const finalRemaining = Math.max(0, item.buy_amount - useCount);

        const ucResult = await env.reserve_db.prepare(
          `INSERT INTO users_courses (user_id, course_id, amount, remaining_count) VALUES (?, ?, ?, ?) RETURNING id`
        ).bind(appt.user_id, item.course_id, item.buy_amount, finalRemaining).first() as { id: number } | null;

        batchStatements.push(env.reserve_db.prepare(
          `INSERT INTO cash_transactions (type, category, amount, payment_method, user_id, description, date) 
           VALUES ('income', '課程包套預收', ?, ?, ?, ?, ?)`
        ).bind(totalPrice, item.payment_method || 'Cash', appt.user_id, `現場購買「${courseInfo.name}」共 ${item.buy_amount} 堂 (${totalPrice !== defaultTotalPrice ? '優惠特價 $' + totalPrice : '定價 $' + defaultTotalPrice})`, transactionDate));

        if (ucResult && ucResult.id && useCount > 0) {
          batchStatements.push(env.reserve_db.prepare(
            `INSERT INTO appointment_courses (appointment_id, user_course_id, type, use_count, balance_after, description) 
             VALUES (?, ?, 'usage', ?, ?, ?)`
          ).bind(appointment_id, ucResult.id, useCount, finalRemaining, `現場加購並履約使用：${courseInfo.name}`));

          const recognizedAmount = Math.round((totalPrice / item.buy_amount) * useCount);

          batchStatements.push(env.reserve_db.prepare(
            `INSERT INTO revenue_recognitions (source_type, appointment_id, user_id, user_course_id, amount, description, date) 
             VALUES ('course_usage', ?, ?, ?, ?, ?, ?)`
          ).bind(
            appointment_id, 
            appt.user_id, 
            ucResult.id, 
            recognizedAmount, 
            `現場加購履約認列：${courseInfo.name} x ${useCount} 堂`, 
            transactionDate
          ));
        }
      }
    }

    if (batchStatements.length > 0) {
      await env.reserve_db.batch(batchStatements);
    }

    return successResponse({}, "結單履約成功！", 200, headers);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error("結單失敗：", error);
    return errorResponse("結單失敗：" + (err.message || "未知錯誤"), 500, headers);
  }
}