// ========================================================
// 休假設定
// ========================================================
import type { HandlerContext, HolidayCreateBody } from "../types";
import { HolidayType } from "../types";
import { successResponse, errorResponse } from "../utils";

export async function handleHolidays(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const method = request.method;
    if (method === 'GET') {
      const { results } = await env.reserve_db.prepare(
        `SELECT * FROM ShopHolidays 
         WHERE type = ? OR (type IN (?, ?) AND date >= date('now', '+8 hours'))
         ORDER BY type DESC, date ASC, day_of_week ASC`
      ).bind(HolidayType.WEEKLY, HolidayType.FULL_DAY, HolidayType.TIME_RANGE).all();
      return successResponse(results, undefined, 200, headers);
    }
    if (method === 'POST') {
      const body = (await request.json()) as HolidayCreateBody;
      const { type, date, start_time, end_time, day_of_week, reason } = body;
      if (!type || ![HolidayType.FULL_DAY, HolidayType.TIME_RANGE, HolidayType.WEEKLY].includes(type as HolidayType)) {
        return errorResponse("無效的休假類型", 400, headers);
      }
      if (type === HolidayType.FULL_DAY && !date) return errorResponse("全天公休必須指定日期", 400, headers);
      if (type === HolidayType.TIME_RANGE && (!date || !start_time || !end_time)) {
        return errorResponse("時段休息必須指定日期、開始與結束時間", 400, headers);
      }
      if (type === HolidayType.WEEKLY && day_of_week === undefined) {
        return errorResponse("固定公休必須指定星期幾", 400, headers);
      }
      const finalDayOfWeek = type === HolidayType.WEEKLY ? day_of_week : null;
      await env.reserve_db.prepare(
        `INSERT INTO ShopHolidays (type, date, start_time, end_time, day_of_week, reason) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(type, date || null, start_time || null, end_time || null, finalDayOfWeek, reason || null).run();
      return successResponse({}, "休假設定已新增", 201, headers);
    }
    if (method === 'DELETE') {
      const id = ctx.url.searchParams.get('id');
      if (!id) return errorResponse("缺少要刪除的休假 ID", 400, headers);
      await env.reserve_db.prepare("DELETE FROM ShopHolidays WHERE id = ?").bind(id).run();
      return successResponse({}, "已刪除該休假設定", 200, headers);
    }
    return errorResponse("不支援的方法", 405, headers);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error("休假設定處理失敗：", error);
    return errorResponse(err.message || "伺服器錯誤", 500, headers);
  }
}
