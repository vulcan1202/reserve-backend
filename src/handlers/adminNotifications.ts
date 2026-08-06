// ========================================================
// 管理員個人化通知與物理刪除處理器 (handlers/adminNotifications.ts)
// 支援多管理員獨立通知、跨裝置同步與資料庫實體刪除防肥大
// ========================================================
import type { HandlerContext } from "../types";
import { successResponse, errorResponse, buildCorsHeaders } from "../utils";
import { authenticateAdmin } from "./adminAuth";

interface NotificationDBRecord {
  id: number;
  admin_id: number;
  notification_id: string;
  type: string;
  title: string;
  message: string;
  link: string;
  badge_text: string;
  badge_class: string;
  icon: string;
  icon_bg: string;
  is_read: number;
  created_at: string;
}

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
  
  const dateStr = `${year}-${month}-${day}`;
  const taiwanDate = new Date(`${dateStr}T00:00:00+08:00`);
  const dayOfWeek = taiwanDate.getDay();

  const lastDayNum = new Date(Number(year), Number(month), 0).getDate();
  const isLastDayOfMonth = (parseInt(day, 10) === lastDayNum);

  return { year, month, day, hour, dayOfWeek, isLastDayOfMonth, dateStr };
}

/**
 * 1. 取得與自動動態派發個人化通知 (GET /api/admin/notifications)
 */
export async function handleGetAdminNotifications(ctx: HandlerContext): Promise<Response> {
  const admin = await authenticateAdmin(ctx);
  const adminId = admin ? admin.id : 1; // 預設或驗證身份

  const { env } = ctx;

  try {
    const taiwanTime = getTaiwanDateTimeDetails();

    // 🌟 自動為該管理員嘗試補發最新的系統通知 (使用 INSERT OR IGNORE 確保獨特且不重複)
    // 1. 最新預約
    const appts = await env.reserve_db.prepare(`
      SELECT id, client_name, date, start_time, appointment_code, status, created_at 
      FROM appointments 
      WHERE status IN ('confirmed', 'pending') 
      ORDER BY id DESC LIMIT 5
    `).all<any>();

    if (appts.results) {
      for (const a of appts.results) {
        const notifId = `appt-${a.id}`;
        const title = `【預約通知】新增預約 - ${a.client_name}`;
        const message = `預約時間：${a.date} ${a.start_time} | 預約單號：${a.appointment_code}`;
        const badgeText = a.status === 'confirmed' ? '預約已確認' : '待服務';
        const badgeClass = 'bg-emerald-100 text-emerald-800 border-emerald-200';
        const icon = 'mdi:calendar-check';
        const iconBg = 'bg-emerald-50 text-emerald-600 border border-emerald-200';
        const link = '/Appointment';

        await env.reserve_db.prepare(`
          INSERT OR IGNORE INTO admin_notifications 
          (admin_id, notification_id, type, title, message, link, badge_text, badge_class, icon, icon_bg, is_read)
          VALUES (?, ?, 'appointment', ?, ?, ?, ?, ?, ?, ?, 0)
        `).bind(adminId, notifId, title, message, link, badgeText, badgeClass, icon, iconBg).run();
      }
    }

    // 2. 週財報推播 (禮拜日 22:00 以後)
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
        (admin_id, notification_id, type, title, message, link, badge_text, badge_class, icon, icon_bg, is_read)
        VALUES (?, ?, 'financial_weekly', ?, ?, ?, ?, ?, ?, ?, 0)
      `).bind(adminId, notifId, title, message, link, badgeText, badgeClass, icon, iconBg).run();
    }

    // 3. 月財報推播 (月底 22:00 以後)
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
        (admin_id, notification_id, type, title, message, link, badge_text, badge_class, icon, icon_bg, is_read)
        VALUES (?, ?, 'financial_monthly', ?, ?, ?, ?, ?, ?, ?, 0)
      `).bind(adminId, notifId, title, message, link, badgeText, badgeClass, icon, iconBg).run();
    }

    // 從 D1 撈取該管理員未被物理刪除的所有通知列表
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

    const notifications = (res.results || []).map(item => ({
      ...item,
      read: Boolean(item.is_read)
    }));

    return successResponse(notifications, "取得通知成功", ctx.request);
  } catch (err: any) {
    console.error("Get admin notifications error:", err);
    return errorResponse(err.message || "讀取通知失敗", 500, ctx.request);
  }
}

/**
 * 2. 標示通知為已讀 (POST /api/admin/notifications/mark-read)
 */
export async function handleMarkAdminNotificationRead(ctx: HandlerContext): Promise<Response> {
  const admin = await authenticateAdmin(ctx);
  const adminId = admin ? admin.id : 1;
  const { request, env } = ctx;

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

    return successResponse(null, "已更新已讀狀態", request);
  } catch (err: any) {
    return errorResponse(err.message || "更新已讀狀態失敗", 500, request);
  }
}

/**
 * 3. 實體物理刪除通知 (DELETE /api/admin/notifications)
 * 支援刪除單筆或全部清空，從 D1 資料庫徹底物理刪除，防止 DB 肥大
 */
export async function handleDeleteAdminNotification(ctx: HandlerContext): Promise<Response> {
  const admin = await authenticateAdmin(ctx);
  const adminId = admin ? admin.id : 1;
  const { request, env } = ctx;

  try {
    const url = new URL(request.url);
    const notificationId = url.searchParams.get("notification_id");
    const clearAll = url.searchParams.get("clear_all") === "true";

    if (clearAll) {
      // 🌟 全部清空：一鍵物理刪除該 Admin 的全部通知紀錄
      await env.reserve_db.prepare(`
        DELETE FROM admin_notifications 
        WHERE admin_id = ?
      `).bind(adminId).run();
    } else if (notificationId) {
      // 🌟 單筆刪除：物理刪除特定通知
      await env.reserve_db.prepare(`
        DELETE FROM admin_notifications 
        WHERE admin_id = ? AND notification_id = ?
      `).bind(adminId, notificationId).run();
    } else {
      return errorResponse("缺少 notification_id 或 clear_all 參數", 400, request);
    }

    return successResponse(null, "通知已從資料庫物理刪除", request);
  } catch (err: any) {
    return errorResponse(err.message || "刪除通知失敗", 500, request);
  }
}
