// ========================================================
// 📚 課程方案管理 API (Courses)
//
// 對應 schema.sql 的 courses 資料表：
//   id, name, description, price
// ========================================================
import type { HandlerContext, CourseBody } from "../types";
import { successResponse, errorResponse } from "../utils";

/** 取得課程方案清單或單一課程方案 */
export async function handleGetCourses(ctx: HandlerContext): Promise<Response> {
  const { env, headers, url } = ctx;
  try {
    const id = url.searchParams.get('id');
    if (id) {
      const course = await env.reserve_db.prepare("SELECT * FROM courses WHERE id = ?").bind(id).first();
      if (!course) return errorResponse("找不到該課程方案", 404, headers);
      return successResponse(course, undefined, 200, headers);
    }

    const { results } = await env.reserve_db.prepare("SELECT * FROM courses ORDER BY id ASC").all();
    return successResponse(results, undefined, 200, headers);
  } catch (error: unknown) {
    console.error("讀取課程方案失敗：", error);
    return errorResponse("讀取課程方案清單失敗", 500, headers);
  }
}

/** 新增課程方案 */
export async function handleCreateCourse(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as any;
    const { name, description, price, cost } = body;

    if (!name || !name.trim()) return errorResponse("課程名稱為必填", 400, headers);
    if (typeof price !== 'number' || price < 0) return errorResponse("價格格式不正確", 400, headers);

    const result = await env.reserve_db.prepare(
      `INSERT INTO courses (name, description, price, cost)
       VALUES (?, ?, ?, ?) RETURNING *`
    ).bind(name.trim(), description || null, price, cost || 0).first();

    return successResponse(result, "課程方案建立成功", 201, headers);
  } catch (error: unknown) {
    return errorResponse("新增課程方案失敗", 500, headers);
  }
}

export async function handleUpdateCourse(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as any;
    const { id, name, description, price, cost } = body;

    if (!id) return errorResponse("缺少課程方案 ID", 400, headers);

    await env.reserve_db.prepare(
      `UPDATE courses SET name = ?, description = ?, price = ?, cost = ? WHERE id = ?`
    ).bind(name.trim(), description || null, price, cost || 0, id).run();

    return successResponse({}, "課程方案更新成功", 200, headers);
  } catch (error: unknown) {
    return errorResponse("更新課程方案失敗", 500, headers);
  }
}

/** 刪除課程方案 */
export async function handleDeleteCourse(ctx: HandlerContext): Promise<Response> {
  const { env, headers, url } = ctx;
  try {
    const id = url.searchParams.get('id');
    if (!id) return errorResponse("缺少課程方案 ID", 400, headers);

    await env.reserve_db.prepare("DELETE FROM courses WHERE id = ?").bind(id).run();
    return successResponse({}, "課程方案已刪除", 200, headers);
  } catch (error: unknown) {
    console.error("刪除課程方案失敗：", error);
    return errorResponse("刪除課程方案失敗", 500, headers);
  }
}