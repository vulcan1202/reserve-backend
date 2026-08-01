// ========================================================
// 美容師 CRUD
// ========================================================
import type { HandlerContext, BeauticianCreateBody, BeauticianUpdateBody } from "../types";
import { successResponse, errorResponse } from "../utils";

export async function handleBeauticians(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const method = request.method;
    if (method === 'GET') {
      const { results } = await env.reserve_db.prepare("SELECT id, name FROM beauticians ORDER BY id ASC").all();
      return successResponse(results, undefined, 200, headers);
    }
    if (method === 'POST') {
      const { name } = (await request.json()) as BeauticianCreateBody;
      if (!name?.trim()) return errorResponse("美容師姓名為必填！", 400, headers);
      const result = await env.reserve_db.prepare("INSERT INTO beauticians (name) VALUES (?) RETURNING id, name").bind(name.trim()).first();
      return successResponse({ beautician: result }, "新增成功", 201, headers);
    }
    if (method === 'PUT') {
      const { id, name } = (await request.json()) as BeauticianUpdateBody;
      if (!id || !name?.trim()) return errorResponse("缺少美容師 ID 或姓名", 400, headers);
      await env.reserve_db.prepare("UPDATE beauticians SET name = ? WHERE id = ?").bind(name.trim(), id).run();
      return successResponse({}, "更新成功", 200, headers);
    }
    if (method === 'DELETE') {
      const id = ctx.url.searchParams.get('id');
      if (!id) return errorResponse("缺少美容師 ID", 400, headers);
      await env.reserve_db.prepare("DELETE FROM beauticians WHERE id = ?").bind(id).run();
      return successResponse({}, "刪除成功", 200, headers);
    }
    return errorResponse("不支援的方法", 405, headers);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error("美容師 API 處理失敗：", error);
    return errorResponse(err.message || "伺服器錯誤", 500, headers);
  }
}
