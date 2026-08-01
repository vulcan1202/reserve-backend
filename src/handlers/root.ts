// ========================================================
// 根路由（API 歡迎頁 / 健康檢查）
// ========================================================
import type { HandlerContext } from "../types";
import { successResponse } from "../utils";

export async function handleRoot(ctx: HandlerContext): Promise<Response> {
  return successResponse({
    endpoints: [
      "/api/users", "/api/login", "/api/liff-login", "/api/line-login",
      "/api/appointments", "/api/beauticians", "/api/holidays", "/api/line-webhook"
    ]
  }, "歡迎來到預約系統 API 伺服器！", 200, ctx.headers);
}
