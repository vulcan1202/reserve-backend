// ========================================================
// 管理員個人化通知與物理刪除處理器 (handlers/adminNotifications.ts)
// 支援多管理員獨立通知、即時派發、跨裝置同步與資料庫實體刪除防肥大
// 並且包含 Cloudflare caches.default 15 秒邊緣防護探針與台灣時間格式化
// ========================================================
import type { HandlerContext } from "../types";
import { successResponse, errorResponse } from "../utils";
import { authenticateAdmin } from "./adminAuth";

const getTaiwanDateTimeDetails = (dateObj: Date = new Date()) => {
  const formatter = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(dateObj);
  const year = parts.find(p => p.type === 'year')?.value || '';
  const month = parts.find(p => p.type === 'month')?.value || '';
  const day = parts.find(p => p.type === 'day')?.value || '';
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const minute = parts.find(p => p.type === 'minute')?.value || '00';
  
  const dateStr = `${year}-${month}-${day}`;
  const fullStr = `${year}-${month}-${day} ${String(hour).padStart(2, '0')}:${minute}`;
  const taiwanDate = new Date(`${dateStr}T00:00:00+08:00`);
  const dayOfWeek = taiwanDate.getDay();

  const lastDayNum = new Date(Number(year), Number(month), 0).getDate();
  const isLastDayOfMonth = (parseInt(day, 10) === lastDayNum);

  return { year, month, day, hour, minute, dayOfWeek, isLastDayOfMonth, dateStr, fullStr };
};

/** 統一台灣時間格式化工具 */
const formatTaiwanTimeStr = (timeStr?: string): string => {
  if (!timeStr) return getTaiwanDateTimeDetails().fullStr;
  
  if (timeStr.includes('T') || timeStr.endsWith('Z')) {
    const dt = new Date(timeStr);
    if (!isNaN(dt.getTime())) {
      return getTaiwanDateTimeDetails(dt).fullStr;
    }
  }
  return timeStr.substring(0, 16);
};

/**
 * 🌟 廣播即時派發通知給資料庫中的所有 Admin 帳號 (Instant Dispatch to All Admins)
 * 當預約被點擊為「已確認」或「已取消」時發動寫入
 */
export async function dispatchNotificationToAllAdmins(
  env: any,
  notifId: string,
  type: string,
  title: string,
  message: string,
  link: string,
  badgeText: string,
  badgeClass: string,
  icon: string,
  iconBg: string
) {
  try {
    const admins = await env.reserve_db.prepare(`SELECT id FROM AdminUsers`).all();
    const adminIds = (admins.results || []).map((a: any) => a.id);
    if (adminIds.length === 0) adminIds.push(1);

    const nowTaiwan = getTaiwanDateTimeDetails().fullStr;

    for (const adminId of adminIds) {
      await env.reserve_db.prepare(`
        INSERT OR IGNORE INTO admin_notifications 
        (admin_id, notification_id, type, title, message, link, badge_text, badge_class, icon, icon_bg, is_read, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).bind(adminId, notifId, type, title, message, link, badgeText, badgeClass, icon, iconBg, nowTaiwan).run();
    }
  } catch (e) {
    console.error("dispatchNotificationToAllAdmins error:", e);
  }
}

/**
 * 1. 取得個人化通知 (GET /api/admin/notifications)
 * 🌟 已移除自動重掃重寫迴圈，確保使用者刪除通知後絕不復活！
 */
export async function handleGetAdminNotifications(ctx: HandlerContext): Promise<Response> {
  const admin = await authenticateAdmin(ctx);
  const adminId = admin ? admin.id : 1;

  const { env, headers } = ctx;

  try {
    const taiwanTime = getTaiwanDateTimeDetails();

    try {
      // 🧹 1. 清理舊版誤把 pending / 待確認 寫入通知的舊資料
      await env.reserve_db.prepare(`
        DELETE FROM admin_notifications 
        WHERE admin_id = ? AND (notification_id LIKE 'appt-pending%' OR badge_text = '待服務' OR title LIKE '%待處理%' OR title LIKE '%待確認%')
      `).bind(adminId).run();

      // 2. 週財報定時推播 (禮拜日 22:00 以後)
      if (taiwanTime.dayOfWeek === 0 && taiwanTime.hour >= 22) {
        const notifId = `fin-weekly-${taiwanTime.dateStr}`;
        const title = `【週財報推播】本週門市營收實質履約統計`;
        const message = `禮拜日 22:00 定時推播：當週門市營運報告已完成計算。`;
        const badgeText = '週日 22:00 推播';
        const badgeClass = 'bg-purple-100 text-purple-800 border-purple-200';
        const icon = 'mdi:chart-timeline-variant-shimmer';
        const iconBg = 'bg-purple-50 text-purple-600 border border-purple-200';
        const link = '/analytics';

        await env.reserve_db.prepare(`
          INSERT OR IGNORE INTO admin_notifications 
          (admin_id, notification_id, type, title, message, link, badge_text, badge_class, icon, icon_bg, is_read, created_at)
          VALUES (?, ?, 'financial_weekly', ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `).bind(adminId, notifId, title, message, link, badgeText, badgeClass, icon, iconBg, taiwanTime.fullStr).run();
      }

      // 3. 月財報定時推播 (月底 22:00 以後)
      if (taiwanTime.isLastDayOfMonth && taiwanTime.hour >= 22) {
        const notifId = `fin-monthly-${taiwanTime.year}-${taiwanTime.month}`;
        const title = `【月財報推播】${taiwanTime.year}-${taiwanTime.month} 月份門市營運綜合結算`;
        const message = `月底 22:00 定時推播：當月綜合財務與營收結算已更新。`;
        const badgeText = '月底 22:00 推播';
        const badgeClass = 'bg-amber-100 text-amber-800 border-amber-200';
        const icon = 'mdi:finance';
        const iconBg = 'bg-amber-50 text-amber-600 border border-amber-200';
        const link = '/finance';

        await env.reserve_db.prepare(`
          INSERT OR IGNORE INTO admin_notifications 
          (admin_id, notification_id, type, title, message, link, badge_text, badge_class, icon, icon_bg, is_read, created_at)
          VALUES (?, ?, 'financial_monthly', ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `).bind(adminId, notifId, title, message, link, badgeText, badgeClass, icon, iconBg, taiwanTime.fullStr).run();
      }
    } catch (dbErr) {
      console.warn("admin_notifications table error:", dbErr);
    }

    // 從 D1 撈取該管理員未被物理刪除的所有通知列表
    let notifications: any[] = [];
    try {
      const res = await env.reserve_db.prepare(`
        SELECT 
          notification_id AS id,
          type,
          title,
          message,
          link,
          badge_text AS badgeText,
          badge_class AS badgeClass,
          icon,
          icon_bg AS iconBg,
          is_read,
          created_at AS time
        FROM admin_notifications
        WHERE admin_id = ?
        ORDER BY id DESC
      `).bind(adminId).all<any>();

      notifications = (res.results || []).map(item => ({
        ...item,
        read: Boolean(item.is_read),
        time: formatTaiwanTimeStr(item.time)
      }));
    } catch (e) {
      notifications = [];
    }

    return successResponse(notifications, "取得通知成功", 200, headers);
  } catch (err: any) {
    console.error("Get admin notifications error:", err);
    return errorResponse(err.message || "讀取通知失敗", 500, headers);
  }
}

/**
 * 2. 標示通知為已讀 (POST /api/admin/notifications/mark-read)
 */
export async function handleMarkAdminNotificationRead(ctx: HandlerContext): Promise<Response> {
  const admin = await authenticateAdmin(ctx);
  const adminId = admin ? admin.id : 1;
  const { request, env, headers } = ctx;

  try {
    const body = await request.json().catch(() => ({})) as { notification_id?: string; mark_all?: boolean };

    if (body.mark_all) {
      await env.reserve_db.prepare(`
        UPDATE admin_notifications 
        SET is_read = 1 
        WHERE admin_id = ?
      `).bind(adminId).run();
    } else if (body.notification_id) {
      await env.reserve_db.prepare(`
        UPDATE admin_notifications 
        SET is_read = 1 
        WHERE admin_id = ? AND notification_id = ?
      `).bind(adminId, body.notification_id).run();
    }

    return successResponse(null, "已更新已讀狀態", 200, headers);
  } catch (err: any) {
    return errorResponse(err.message || "更新已讀狀態失敗", 500, headers);
  }
}

/**
 * 3. 實體物理刪除通知 (DELETE /api/admin/notifications)
 * 從 D1 資料庫徹底物理刪除，防止 DB 肥大
 */
export async function handleDeleteAdminNotification(ctx: HandlerContext): Promise<Response> {
  const admin = await authenticateAdmin(ctx);
  const adminId = admin ? admin.id : 1;
  const { request, env, headers } = ctx;

  try {
    const url = new URL(request.url);
    const notificationId = url.searchParams.get("notification_id");
    const clearAll = url.searchParams.get("clear_all") === "true";

    if (clearAll) {
      await env.reserve_db.prepare(`
        DELETE FROM admin_notifications 
        WHERE admin_id = ?
      `).bind(adminId).run();
    } else if (notificationId) {
      await env.reserve_db.prepare(`
        DELETE FROM admin_notifications 
        WHERE admin_id = ? AND notification_id = ?
      `).bind(adminId, notificationId).run();
    } else {
      return errorResponse("缺少 notification_id 或 clear_all 參數", 400, headers);
    }

    return successResponse(null, "通知已從資料庫物理刪除", 200, headers);
  } catch (err: any) {
    return errorResponse(err.message || "刪除通知失敗", 500, headers);
  }
}

/**
 * 4. 探針快取檢查 (GET /api/admin/notifications/check-probe)
 * 使用 Cloudflare caches.default API 提供 15 秒邊緣層防護快取 (0 D1 讀取開銷)
 * 精準監聽 admin_notifications 資料庫變動狀態
 */
export async function handleNotificationProbe(ctx: HandlerContext): Promise<Response> {
  const admin = await authenticateAdmin(ctx);
  const adminId = admin ? admin.id : 1;
  const { request, env, headers } = ctx;

  try {
    const cache = caches.default;
    const cacheUrl = new URL(request.url);
    // 依據 admin_id 進行獨立 ETag 快取隔離
    cacheUrl.searchParams.set('admin_id', String(adminId));
    const cacheKey = new Request(cacheUrl.toString(), { method: 'GET', headers: request.headers });

    // 1. 嘗試從 Cloudflare 邊緣層快取讀取
    let cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      return cachedResponse;
    }

    // 2. 邊緣快取未命中 (Cache Miss)：從 D1 資料庫讀取該管理員通知的極速特徵 (MAX ID、總數、已讀數)
    let maxNotifId = 0;
    let totalCount = 0;
    let readCount = 0;

    try {
      const row = await env.reserve_db.prepare(`
        SELECT MAX(id) AS max_id, COUNT(*) AS total, SUM(is_read) AS total_read 
        FROM admin_notifications 
        WHERE admin_id = ?
      `).bind(adminId).first<{ max_id: number; total: number; total_read: number }>();

      maxNotifId = row?.max_id || 0;
      totalCount = row?.total || 0;
      readCount = row?.total_read || 0;
    } catch (e) {
      maxNotifId = 0;
      totalCount = 0;
      readCount = 0;
    }

    const currentETag = `W/"notif-${adminId}-${maxNotifId}-${totalCount}-${readCount}"`;
    const clientETag = request.headers.get("If-None-Match");

    let response: Response;
    const responseHeaders = {
      ...headers,
      "ETag": currentETag,
      "Cache-Control": "public, max-age=15, s-maxage=15",
    };

    if (clientETag === currentETag) {
      response = new Response(null, {
        status: 304,
        headers: responseHeaders,
      });
    } else {
      response = new Response(JSON.stringify({ success: true, has_new: true, etag: currentETag }), {
        status: 200,
        headers: {
          ...responseHeaders,
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    }

    ctx.ctx.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  } catch (err: any) {
    return errorResponse(err.message || "探針檢查失敗", 500, headers);
  }
}
