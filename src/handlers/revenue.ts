// ========================================================
// 📈 實質營收認列 API (Revenue Recognitions)
// ========================================================
import type { HandlerContext, RevenueRecognitionBody } from "../types";
import { successResponse, errorResponse } from "../utils";

/** 取得實質營收認列紀錄 */
export async function handleGetRevenueRecognitions(ctx: HandlerContext): Promise<Response> {
  const { env, headers, url } = ctx;
  try {
    const startDate = url.searchParams.get('start_date');
    const endDate = url.searchParams.get('end_date');
    const sourceType = url.searchParams.get('source_type');

    let query = `
      SELECT rr.*, Users.last_name || Users.first_name AS client_name,
             Appointments.appointment_code, courses.name AS course_name
      FROM revenue_recognitions rr
      JOIN Users ON rr.user_id = Users.id
      LEFT JOIN Appointments ON rr.appointment_id = Appointments.id
      LEFT JOIN users_courses ON rr.user_course_id = users_courses.id
      LEFT JOIN courses ON users_courses.course_id = courses.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (startDate) { query += " AND rr.date >= ?"; params.push(startDate); }
    if (endDate) { query += " AND rr.date <= ?"; params.push(endDate); }
    if (sourceType) { query += " AND rr.source_type = ?"; params.push(sourceType); }

    query += " ORDER BY rr.date DESC, rr.created_at DESC";

    const { results } = params.length > 0 
      ? await env.reserve_db.prepare(query).bind(...params).all()
      : await env.reserve_db.prepare(query).all();

    return successResponse(results, undefined, 200, headers);
  } catch (error: unknown) {
    console.error("讀取營收認列失敗：", error);
    return errorResponse("讀取營收認列失敗", 500, headers);
  }
}

/** 新增實質營收認列 (例如：完成課程履約時扣堂認列營收、產品現場銷售) */
export async function handleCreateRevenueRecognition(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as RevenueRecognitionBody;
    const { source_type, amount, user_id, appointment_id, user_course_id, description, date } = body;

    if (!source_type || !['course_usage', 'product_sale'].includes(source_type)) {
      return errorResponse("來源類型必須是 course_usage 或 product_sale", 400, headers);
    }
    if (!user_id) return errorResponse("缺少關聯客戶 user_id", 400, headers);
    if (typeof amount !== 'number' || amount <= 0) return errorResponse("認列金額必須大於 0", 400, headers);
    if (!date) return errorResponse("請指定營收認列日期", 400, headers);

    const result = await env.reserve_db.prepare(
      `INSERT INTO revenue_recognitions (source_type, amount, user_id, appointment_id, user_course_id, description, date)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ).bind(
      source_type, amount, user_id, 
      appointment_id || null, user_course_id || null, description || null, date
    ).first();

    return successResponse(result, "營收認列成功", 201, headers);
  } catch (error: unknown) {
    console.error("新增營收認列失敗：", error);
    return errorResponse("新增營收認列失敗", 500, headers);
  }
}
