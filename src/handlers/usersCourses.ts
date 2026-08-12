// ========================================================
// 🎫 會員已購買課程管理 API (Users Courses)
// ========================================================
import type { HandlerContext, UserCourseCreateBody, UserCourseUpdateBody } from "../types";
import { successResponse, errorResponse } from "../utils";

const BASE_SELECT = `
  SELECT uc.*, courses.name AS course_name, courses.price AS course_price,
         Users.last_name || Users.first_name AS client_name, Users.phone AS client_phone
  FROM users_courses uc
  JOIN courses ON uc.course_id = courses.id
  JOIN Users ON uc.user_id = Users.id
`;

export async function handleGetUsersCourses(ctx: HandlerContext): Promise<Response> {
  const { env, headers, url } = ctx;
  try {
    const id = url.searchParams.get('id');
    const hasRemaining = url.searchParams.get('has_remaining');

    if (id) {
      const result = await env.reserve_db.prepare(`${BASE_SELECT} WHERE uc.id = ?`).bind(id).first();
      if (!result) return errorResponse("找不到該筆會員課程紀錄", 404, headers);
      return successResponse(result, undefined, 200, headers);
    }

    const userId = url.searchParams.get('user_id');
    const courseId = url.searchParams.get('course_id');

    let query = `${BASE_SELECT} WHERE 1=1`;
    const params: any[] = [];
    if (userId) { query += " AND uc.user_id = ?"; params.push(userId); }
    if (courseId) { query += " AND uc.course_id = ?"; params.push(courseId); }
    if (hasRemaining === 'true') { query += " AND uc.remaining_count > 0"; }
    query += " ORDER BY uc.purchase_date DESC";

    const { results } = params.length > 0
      ? await env.reserve_db.prepare(query).bind(...params).all()
      : await env.reserve_db.prepare(query).all();

    return successResponse(results, undefined, 200, headers);
  } catch (error: unknown) {
    console.error("讀取會員課程紀錄失敗：", error);
    return errorResponse("讀取會員課程紀錄失敗", 500, headers);
  }
}

export async function handleCreateUserCourse(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as UserCourseCreateBody;
    const { user_id, course_id, amount, remaining_count } = body;

    if (!user_id) return errorResponse("缺少會員 user_id", 400, headers);
    if (!course_id) return errorResponse("缺少課程 course_id", 400, headers);
    if (typeof amount !== 'number' || amount <= 0) return errorResponse("購買堂數必須是大於 0 的數字", 400, headers);

    const result = await env.reserve_db.prepare(
      `INSERT INTO users_courses (user_id, course_id, amount, remaining_count)
       VALUES (?, ?, ?, ?) RETURNING *`
    ).bind(
      user_id, course_id, amount,
      remaining_count !== undefined ? remaining_count : amount
    ).first();

    return successResponse(result, "會員課程購買紀錄建立成功", 201, headers);
  } catch (error: unknown) {
    console.error("新增會員課程紀錄失敗：", error);
    return errorResponse("新增會員課程紀錄失敗", 500, headers);
  }
}

export async function handleUpdateUserCourse(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as any;
    const { id, course_id, amount, custom_total_price, purchase_date, date } = body;
    const newDate = purchase_date || date;

    if (!id) return errorResponse("缺少會員課程紀錄 ID", 400, headers);
    if (typeof amount !== 'number' || amount <= 0) return errorResponse("購買總堂數必須大於 0", 400, headers);

    const oldPkg = await env.reserve_db.prepare(`
      SELECT uc.*, c.id AS old_course_id, c.name AS old_course_name, c.price AS old_price 
      FROM users_courses uc 
      JOIN courses c ON uc.course_id = c.id 
      WHERE uc.id = ?
    `).bind(id).first() as any;

    if (!oldPkg) return errorResponse("找不到該筆包套紀錄", 404, headers);

    const newCourse = await env.reserve_db.prepare("SELECT id, name, price FROM courses WHERE id = ?").bind(course_id).first() as any;
    if (!newCourse) return errorResponse("找不到對應的新課程方案", 404, headers);

    const diffAmount = amount - oldPkg.amount;
    const newRemaining = oldPkg.remaining_count + diffAmount;
    if (newRemaining < 0) {
      return errorResponse("修改失敗：剩餘堂數不可小於 0（已有部分堂數被預約消耗）", 400, headers);
    }

    const defaultTotalPrice = newCourse.price * amount;
    const newTotalPrice = (typeof custom_total_price === 'number' && !isNaN(custom_total_price) && custom_total_price >= 0)
      ? custom_total_price
      : defaultTotalPrice;

    const batchStatements: any[] = [];

    batchStatements.push(
      env.reserve_db.prepare(
        `UPDATE users_courses 
         SET course_id = ?, amount = ?, remaining_count = ?, purchase_date = COALESCE(?, purchase_date) 
         WHERE id = ?`
      ).bind(course_id, amount, newRemaining, newDate || null, id)
    );

    const cashTrans = await env.reserve_db.prepare(`
      SELECT id FROM cash_transactions 
      WHERE user_id = ? AND category = '課程包套預收' AND type = 'income' 
        AND (description LIKE ? OR description LIKE ?)
      ORDER BY id DESC LIMIT 1
    `).bind(
      oldPkg.user_id, 
      `%${oldPkg.old_course_name}%`, 
      `%${newCourse.name}%`
    ).first() as any;

    const updatedDescription = `購買「${newCourse.name}」共 ${amount} 堂 (${newTotalPrice !== defaultTotalPrice ? '優惠特價 $' + newTotalPrice : '定價 $' + defaultTotalPrice})`;

    if (cashTrans) {
      batchStatements.push(
        env.reserve_db.prepare(
          `UPDATE cash_transactions SET amount = ?, description = ?, date = COALESCE(?, date) WHERE id = ?`
        ).bind(
          newTotalPrice,
          updatedDescription,
          newDate || null,
          cashTrans.id
        )
      );
    } else {
      batchStatements.push(
        env.reserve_db.prepare(
          `INSERT INTO cash_transactions (type, category, amount, payment_method, user_id, description, date)
           VALUES ('income', '課程包套預收', ?, 'Cash', ?, ?, COALESCE(?, date('now', '+8 hours')))`
        ).bind(
          newTotalPrice,
          oldPkg.user_id,
          updatedDescription,
          newDate || null
        )
      );
    }

    await env.reserve_db.batch(batchStatements);
    return successResponse({}, "會員包套修改成功，原始現金收入已同步更新", 200, headers);
  } catch (error: unknown) {
    console.error("更新會員課程紀錄失敗：", error);
    return errorResponse("更新會員課程紀錄失敗", 500, headers);
  }
}

// 🌟 補上並明確匯出退款處理函式
export async function handleRefundUserCourse(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = await request.json() as any;
    const { user_course_id, refund_count, refund_amount, payment_method, description } = body;

    if (!user_course_id) return errorResponse("缺少會員包套 ID", 400, headers);
    if (!refund_count || refund_count <= 0) return errorResponse("退款堂數必須大於 0", 400, headers);
    if (refund_amount === undefined || refund_amount < 0) return errorResponse("退款金額不合法", 400, headers);

    const pkg = await env.reserve_db.prepare(`
      SELECT uc.*, c.name AS course_name, c.price 
      FROM users_courses uc 
      JOIN courses c ON uc.course_id = c.id 
      WHERE uc.id = ?
    `).bind(user_course_id).first() as any;

    if (!pkg) return errorResponse("找不到該筆會員包套紀錄", 404, headers);
    if (pkg.remaining_count < refund_count) {
      return errorResponse(`退款失敗：欲退還 ${refund_count} 堂，但目前剩餘堂數僅剩 ${pkg.remaining_count} 堂`, 400, headers);
    }

    const newRemaining = pkg.remaining_count - refund_count;
    const batchStatements: any[] = [];

    const cashRes = await env.reserve_db.prepare(
      `INSERT INTO cash_transactions (type, category, amount, payment_method, user_id, description, date)
       VALUES ('expense', '課程退款', ?, ?, ?, ?, date('now', '+8 hours')) RETURNING id`
    ).bind(
      refund_amount, 
      payment_method || 'Cash', 
      pkg.user_id, 
      description || `辦理「${pkg.course_name}」課程退款 ${refund_count} 堂`
    ).first() as any;

    const cashTransactionId = cashRes?.id;

    batchStatements.push(
      env.reserve_db.prepare(
        `INSERT INTO appointment_courses (user_course_id, type, use_count, balance_after, cash_transaction_id, description)
         VALUES (?, 'refund', ?, ?, ?, ?)`
      ).bind(
        user_course_id, 
        refund_count, 
        newRemaining, 
        cashTransactionId || null, 
        description || `辦理課程退款扣除 ${refund_count} 堂`
      )
    );

    batchStatements.push(
      env.reserve_db.prepare(
        `UPDATE users_courses SET remaining_count = ? WHERE id = ?`
      ).bind(newRemaining, user_course_id)
    );

    await env.reserve_db.batch(batchStatements);

    return successResponse({}, "課程退款手續已完成，現金流與流水帳已同步更新", 200, headers);
  } catch (error: unknown) {
    console.error("課程退款失敗：", error);
    return errorResponse("課程退款處理失敗", 500, headers);
  }
}

export async function handleDeleteUserCourse(ctx: HandlerContext): Promise<Response> {
  const { env, headers, url } = ctx;
  try {
    const id = url.searchParams.get('id');
    if (!id) return errorResponse("缺少會員課程紀錄 ID", 400, headers);

    const pkg = await env.reserve_db.prepare(`
      SELECT uc.*, c.price FROM users_courses uc
      JOIN courses c ON uc.course_id = c.id
      WHERE uc.id = ?
    `).bind(id).first() as any;

    if (!pkg) return errorResponse("找不到該筆會員課程紀錄", 404, headers);

    if (pkg.amount !== pkg.remaining_count) {
      return errorResponse("無法刪除：此包套已有部分堂數被預約消耗使用過，僅能保留。", 400, headers);
    }

    const totalPaid = pkg.price * pkg.amount;
    const batchStatements: any[] = [];

    batchStatements.push(env.reserve_db.prepare("DELETE FROM users_courses WHERE id = ?").bind(id));

    batchStatements.push(
      env.reserve_db.prepare(
        `DELETE FROM cash_transactions WHERE user_id = ? AND amount = ? AND type = 'income' AND category = '課程包套預收' AND date >= date(?, '-1 day')`
      ).bind(pkg.user_id, totalPaid, pkg.purchase_date)
    );

    await env.reserve_db.batch(batchStatements);
    return successResponse({}, "會員課程紀錄已刪除，現金流已同步回滾", 200, headers);
  } catch (error: unknown) {
    console.error("刪除會員課程紀錄失敗：", error);
    return errorResponse("刪除會員課程紀錄失敗", 500, headers);
  }
}