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

export async function handleCreateAppointment(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as AppointmentCreateBody;
    const { user_id, date, start_time, beautician_id } = body;
    if (!user_id || !date || !start_time) return errorResponse("缺少必要的預約資訊", 400, headers);

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
        Appointments.status, Appointments.notes AS notes, Appointments.appointment_code,
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
    const { id, status, notes, user_id, user_notes, beautician_id } = body;
    if (!id) return errorResponse("缺少預約 ID", 400, headers);

    const batchStatements: any[] = [];

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
            
            // 檢查是否為當初「現場新購買」建立的包套
            const checkNewBuy = await env.reserve_db.prepare(
              "SELECT id FROM cash_transactions WHERE user_id = (SELECT user_id FROM users_courses WHERE id = ?) AND description LIKE ?"
            ).bind(uc.user_course_id, `%現場購買%`).first();

            if (checkNewBuy) {
              // 若是現場新買的合約，直接整筆刪除
              batchStatements.push(
                env.reserve_db.prepare("DELETE FROM users_courses WHERE id = ?").bind(uc.user_course_id)
              );
            } else {
              // 若是既有包套，將堂數加回來
              batchStatements.push(
                env.reserve_db.prepare("UPDATE users_courses SET remaining_count = remaining_count + ? WHERE id = ?").bind(uc.use_count, uc.user_course_id)
              );
            }
          }
        }

        // 2. 刪除該預約的堂數流水帳紀錄
        batchStatements.push(
          env.reserve_db.prepare("DELETE FROM appointment_courses WHERE appointment_id = ?").bind(id)
        );

        // 3. 刪除實質營收認列
        batchStatements.push(
          env.reserve_db.prepare("DELETE FROM revenue_recognitions WHERE appointment_id = ?").bind(id)
        );

        // 4. 刪除現場加購產生的現金收入流
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

    return successResponse({}, "狀態與資料回滾更新成功", 200, headers);
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

    // 處理 【既有包套】 扣堂與流水帳紀錄
    if (courses_used && courses_used.length > 0) {
      for (const item of courses_used) {
        if (!item.user_course_id || !item.use_count || item.use_count <= 0) continue;

        const courseInfo = await env.reserve_db.prepare(`
          SELECT uc.id AS user_course_id, uc.remaining_count, c.price, c.name AS course_name
          FROM users_courses uc
          JOIN courses c ON uc.course_id = c.id
          WHERE uc.id = ? AND uc.user_id = ?
        `).bind(item.user_course_id, appt.user_id).first() as { user_course_id: number; remaining_count: number; price: number; course_name: string } | null;

        if (!courseInfo) return errorResponse(`找不到合約資料`, 400, headers);
        if (courseInfo.remaining_count < item.use_count) return errorResponse(`剩餘堂數不足`, 400, headers);

        const newRemaining = courseInfo.remaining_count - item.use_count;

        // 寫入升級版流水帳 (type = 'usage') 並記錄 balance_after 快照
        batchStatements.push(env.reserve_db.prepare(
          `INSERT INTO appointment_courses (appointment_id, user_course_id, type, use_count, balance_after, description) 
           VALUES (?, ?, 'usage', ?, ?, ?)`
        ).bind(appointment_id, item.user_course_id, item.use_count, newRemaining, `到店履約扣堂：${courseInfo.course_name}`));
        
        batchStatements.push(env.reserve_db.prepare(`UPDATE users_courses SET remaining_count = ? WHERE id = ?`).bind(newRemaining, item.user_course_id));
        
        const recognizedAmount = courseInfo.price * item.use_count;
        batchStatements.push(
          env.reserve_db.prepare(
            `INSERT INTO revenue_recognitions (source_type, amount, user_id, appointment_id, user_course_id, description, date)
             VALUES ('course_usage', ?, ?, ?, ?, ?, ?)`
          ).bind(recognizedAmount, appt.user_id, appointment_id, item.user_course_id, `到店履約扣堂：${courseInfo.course_name} (${item.use_count}堂)`, transactionDate)
        );
      }
    }

    // 處理 【現場當下購買即使用】
    if (new_courses_bought && new_courses_bought.length > 0) {
      for (const newCourse of new_courses_bought) {
        const { course_id, buy_amount, use_count, payment_method } = newCourse;
        if (!course_id || !buy_amount || buy_amount <= 0 || !use_count || use_count <= 0) continue;

        const course = await env.reserve_db.prepare("SELECT id, name, price FROM courses WHERE id = ?").bind(course_id).first() as { id: number; name: string; price: number } | null;
        if (!course) return errorResponse(`找不到課程資料`, 400, headers);

        const initialRemaining = buy_amount - use_count; 
        const totalPurchaseAmount = course.price * buy_amount; 

        const newUserCourse = await env.reserve_db.prepare(
          `INSERT INTO users_courses (user_id, course_id, amount, remaining_count) VALUES (?, ?, ?, ?) RETURNING id`
        ).bind(appt.user_id, course_id, buy_amount, initialRemaining).first() as { id: number } | null;

        if (!newUserCourse?.id) throw new Error("建立會員包套失敗");
        const newUserCourseId = newUserCourse.id;

        batchStatements.push(
          env.reserve_db.prepare(
            `INSERT INTO cash_transactions (type, category, amount, payment_method, user_id, description, date) VALUES ('income', '當下購買課程', ?, ?, ?, ?, ?)`
          ).bind(totalPurchaseAmount, payment_method || 'Cash', appt.user_id, `現場購買「${course.name}」共 ${buy_amount} 堂 (當下使用 ${use_count} 堂)`, transactionDate)
        );

        // 寫入現場即時履約的流水帳
        batchStatements.push(env.reserve_db.prepare(
          `INSERT INTO appointment_courses (appointment_id, user_course_id, type, use_count, balance_after, description) 
           VALUES (?, ?, 'usage', ?, ?, ?)`
        ).bind(appointment_id, newUserCourseId, use_count, initialRemaining, `現場購買並即時履約：${course.name}`));

        const recognizedAmount = course.price * use_count;
        batchStatements.push(
          env.reserve_db.prepare(
            `INSERT INTO revenue_recognitions (source_type, amount, user_id, appointment_id, user_course_id, description, date) VALUES ('course_usage', ?, ?, ?, ?, ?, ?)`
          ).bind(recognizedAmount, appt.user_id, appointment_id, newUserCourseId, `現場購買並即時履約：${course.name} (${use_count}堂)`, transactionDate)
        );
      }
    }

    await env.reserve_db.batch(batchStatements);

    return successResponse({}, "預約已完成點收！", 200, headers);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error("點收處理失敗：", error);
    return errorResponse("點收處理失敗：" + (err.message || "未知錯誤"), 500, headers);
  }
}