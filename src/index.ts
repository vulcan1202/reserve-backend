// ========================================================
// Worker 入口與定時任務
// ========================================================
import type { ExecutionContext } from "@cloudflare/workers-types";
import type { Env } from "./types";
import { AppointmentStatus, HolidayType } from "./types";
import { buildCorsHeaders, successResponse, errorResponse } from "./utils";
import { routeHandlers } from "./routes";
import {
  CLEANUP_PENDING_MINUTES,
  COMPLETE_AFTER_DAYS,
  HOLIDAY_RETENTION_DAYS,
} from "./constants";

// 保留原本從 index.ts 對外匯出的型別/Env，避免其他檔案（如遷移腳本）import 路徑失效
export type { Env } from "./types";
export { AppointmentStatus, HolidayType } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const safePath = url.pathname.replace(/\/+/g, '/');
    const method = request.method;

    const corsHeaders = buildCorsHeaders(request.headers.get("Origin") || "");
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const routeKey = `${method}:${safePath}`;
    const handler = routeHandlers[routeKey];

    if (handler) {
      try {
        return await handler({ request, env, ctx, url, headers: corsHeaders });
      } catch (error: unknown) {
        console.error("路由处理器错误：", error);
        return errorResponse("伺服器發生錯誤", 500, corsHeaders);
      }
    }

    return successResponse({}, "API 路由不存在", 404, corsHeaders);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    try {
      await env.reserve_db.prepare(
        `DELETE FROM Appointments WHERE status IN (?, ?) AND created_at <= datetime('now', '+8 hours', ?)`
      ).bind(AppointmentStatus.PENDING, AppointmentStatus.CANCELLED, `-${CLEANUP_PENDING_MINUTES} minutes`).run();

      await env.reserve_db.prepare(
        `DELETE FROM Appointments WHERE status = ? AND date <= date('now', '+8 hours', ?)`
      ).bind(AppointmentStatus.COMPLETE, `-${COMPLETE_AFTER_DAYS} years`).run();

      await env.reserve_db.prepare(
        `DELETE FROM ShopHolidays WHERE type IN (?, ?) AND date <= date('now', '+8 hours', ?)`
      ).bind(HolidayType.FULL_DAY, HolidayType.TIME_RANGE, `-${HOLIDAY_RETENTION_DAYS} days`).run();

      console.log('✅ scheduled 任務執行完畢');
    } catch (error) {
      console.error('❌ scheduled 任務失敗：', error);
    }
  }
};
