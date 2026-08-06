// ========================================================
// 管理員個人化通知與物理刪除處理器 (handlers/adminNotifications.ts)
// 支援多管理員獨立通知、即時派發、跨裝置同步與資料庫實體刪除防肥大
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
  
  const dateStr = `${year}-${month}-${day}`;
  const taiwanDate = new Date(`${dateStr}T00:00:00+08:00`);
  const dayOfWeek = taiwanDate.getDay();

  const lastDayNum = new Date(Number(year), Number(month), 0).getDate();
  const isLastDayOfMonth = (parseInt(day, 10) === lastDayNum);

  return { year, month, day, hour, dayOfWeek, isLastDayOfMonth, dateStr };
}

/**
 * 🌟 廣播即時派發通知給資料庫中的所有 Admin 帳號 (Instant Dispatch to All Admins)
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

    for (const adminId of adminIds) {
      await env.reserve_db.prepare(`
        INSERT OR IGNORE INTO admin_notifications 
        (admin_id, notification_id, type, title, message, link, badge_text, badge_class, icon, icon_bg, is_read)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).bind(adminId, notifId, type, title, message, link, badgeText, badgeClass, icon, iconBg).run();
    }
  } catch (e) {
    console.error("dispatchNotificationToAllAdmins error:", e);
  }
}

/**
 * 1. 取得與自動動態派發個人化通知 (GET /api/admin/notifications)
 */
export async function handleGetAdminNotifications(ctx: HandlerContext): Promise<Response> {
  const admin = await authenticateAdmin(ctx);
  const adminId = admin ? admin.id : 1;

  const { env, headers } = ctx;

  try {
    const taiwanTime = getTaiwanDateTimeDetails();

    // 🌟 1. 最新預約 (過濾掉 pending，只通知 confirmed 與 cancelled/cancel)
    try {
      const appts = await env.reserve_db.prepare(`
        SELECT 
          Appointments.id, Appointments.date, Appointments.start_time, Appointments.appointment_code, Appointments.status, Appointments.created_at,
          Users.last_name || Users.first_name AS client_name
        FROM Appointments 
        JOIN Users ON Appointments.user_id = Users.id
        WHERE Appointments.status IN ('confirmed', 'cancelled', 'cancel') 
        ORDER BY Appointments.id DESC LIMIT 5
      `).all<any>();

      if (appts.results) {
        for (const a of appts.results) {
          const isCancelled = (a.status === 'cancelled' || a.status === 'cancel');
          const notifId = `appt-${isCancelled ? 'cancelled' : 'confirmed'}-${a.id}`;
          const title = isCancelled 
            ? `【預約取消】${a.client_name || '客戶'} 的預約已取消`
            : `【預約確認】${a.client_name || '客戶'} 的預約已確認`;
          const message = `預約時間：${a.date} ${a.start_time} | 預約單號：${a.appointment_code}`;
          const badgeText = isCancelled ? '預約已取消' : '預約已確認';
          const badgeClass = isCancelled ? 'bg-rose-100 text-rose-800 border-rose-200' : 'bg-emerald-100 text-emerald-800 border-emerald-200';
          const icon = isCancelled ? 'mdi:calendar-remove' : 'mdi:calendar-check';
          const iconBg = isCancelled ? 'bg-rose-50 text-rose-600 border border-rose-200' : 'bg-emerald-50 text-emerald-600 border border-emerald-200';
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
    } catch (dbErr) {
      console.warn("admin_notifications table might not exist yet:", dbErr);
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
        read: Boolean(item.is_read)
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
 * 支援刪除單筆或全部清空，從 D1 資料庫徹底物理刪除，防止 DB 肥大
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
