// ========================================================
// 1. 导入与类型定义
// ========================================================
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";

export interface Env {
  reserve_db: D1Database;
  LINE_ACCESS_TOKEN: string;
  LINE_CHANNEL_ID: string;
  LINE_CHANNEL_SECRET: string;
  ENABLE_SIGNATURE_VERIFY?: string; // 可選，預設 true
}

// ---------- 常量定義 ----------
const APPOINTMENT_DURATION = 150;
const AUTO_REPLY_INTERVAL = 30;
const BUSINESS_HOUR_START = 10;
const BUSINESS_HOUR_END = 20;
const MAX_RETRY = 5;
const CLEANUP_PENDING_MINUTES = 30;
const COMPLETE_AFTER_DAYS = 5;
const HOLIDAY_RETENTION_DAYS = 2;

// ---------- 枚舉定義 ----------
export enum AppointmentStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  CANCELLED = 'cancelled',
  COMPLETE = 'complete',
}

export enum HolidayType {
  FULL_DAY = 'full_day',
  TIME_RANGE = 'time_range',
  WEEKLY = 'weekly',
}

// ---------- 請求體型別 ----------
interface RegisterBody {
  last_name: string;
  first_name: string;
  phone: string;
  password: string;
  date_of_birth: string;
  gender: string;
  location?: string;
  email?: string;
  notes?: string;
  line_id: string;
}

interface LiffLoginBody { line_id: string; }
interface UpdateUserBody { id: number; last_name: string; first_name: string; gender: string; date_of_birth: string; location?: string; email?: string; password?: string; }
interface AppointmentCreateBody { user_id: number; date: string; start_time: string; beautician_id?: number; }
interface AppointmentPatchBody { id: number; status?: AppointmentStatus | string; notes?: string; user_id?: number; user_notes?: string; beautician_id?: number | null; }
interface LoginBody { phone: string; password: string; }
interface LineLoginBody { code: string; redirectUri: string; }
interface BeauticianCreateBody { name: string; }
interface BeauticianUpdateBody { id: number; name: string; }
interface HolidayCreateBody { type: HolidayType | string; date?: string; start_time?: string; end_time?: string; day_of_week?: number; reason?: string; }

// ---------- LINE API 回應型別 ----------
interface LineTokenResponse { access_token: string; }
interface LineProfileResponse { userId: string; }
interface LineWebhookBody { events: LineWebhookEvent[]; }
interface LineWebhookEvent { type: string; replyToken: string; source: { userId: string; type: string }; message?: { type: string; text: string }; }

// ---------- 資料庫行型別 ----------
interface UserRow { id: number; last_name: string; first_name: string; gender: string; date_of_birth: string; location: string | null; email: string | null; password_hash: string; }
interface AppointmentRow { id: number; user_id: number; status: string; }

// ---------- 統一 Handler Context ----------
interface HandlerContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  headers: Record<string, string>;
}

// ========================================================
// 2. 工具函式
// ========================================================

/** SHA-256 雜湊 */
async function hashPassword(password: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/** CORS 標頭 */
function buildCorsHeaders(requestOrigin: string): Record<string, string> {
  const allowedOrigins = [
    "https://hervive-pages.pages.dev",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://localhost:5173"
  ];
  const validOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": validOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/** 統一成功回應（強制格式：{ success: true, data, message? }） */
function successResponse<T>(data: T, message?: string, status = 200, headers: Record<string, string> = {}) {
  const payload: any = { success: true, data };
  if (message) payload.message = message;
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

/** 統一錯誤回應（保留 error 欄位以向後相容，新增 success: false） */
function errorResponse(message: string, status = 400, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

/** 判斷營業時間 */
function isBusinessHour(): boolean {
  const now = new Date();
  const taipeiHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Taipei",
      hour: "numeric",
      hour12: false
    }).format(now)
  );
  return taipeiHour >= BUSINESS_HOUR_START && taipeiHour < BUSINESS_HOUR_END;
}

/** 計算預約結束時間 */
function calculateEndTime(startTime: string): string {
  const [h, m] = startTime.split(':').map(Number);
  const endTotal = h * 60 + m + APPOINTMENT_DURATION;
  const endH = Math.floor(endTotal / 60);
  const endM = endTotal % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

/** 驗證 LINE Webhook Signature（使用 Web Crypto API） */
async function verifyLineSignature(rawBody: string, signatureHeader: string | null, secret: string): Promise<boolean> {
  if (!signatureHeader) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const sigHex = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  return sigHex === signatureHeader;
}

// ---------- 資料庫輔助查詢 ----------
async function getUserByLineId(env: Env, lineId: string): Promise<UserRow | null> {
  return env.reserve_db.prepare(
    `SELECT id, last_name, first_name, gender, date_of_birth, location, email, password_hash
     FROM Users WHERE line_id = ?`
  ).bind(lineId).first() as Promise<UserRow | null>;
}

async function getUserByPhone(env: Env, phone: string): Promise<UserRow | null> {
  return env.reserve_db.prepare(
    `SELECT id, last_name, first_name, gender, date_of_birth, location, email, password_hash
     FROM Users WHERE phone = ?`
  ).bind(phone).first() as Promise<UserRow | null>;
}

/** 計算年齡（基於台灣時區） */
function calculateAge(dateOfBirth: string | null): number | null {
  if (!dateOfBirth) return null;
  const birth = new Date(dateOfBirth);
  if (isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

// ========================================================
// 3. LINE Webhook 專屬 Helper Functions（拆分責任）
// ========================================================

/** 發送 LINE 訊息 */
async function sendLineReply(replyToken: string, text: string, accessToken: string): Promise<void> {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }]
    })
  });
}

/** 處理預約碼驗證邏輯 */
async function handleAppointmentVerification(
  env: Env,
  userLineId: string,
  code: string,
  replyToken: string,
  accessToken: string
): Promise<void> {
  let replyText = "";
  const currentUser = await getUserByLineId(env, userLineId);

  if (!currentUser) {
    replyText = `❌ 驗證失敗：您的 LINE 尚未綁定網站會員帳號。\n請先至網站註冊或登入後進行 LINE 綁定，才能驗證預約！`;
  } else {
    const appt = await env.reserve_db.prepare(
      "SELECT id, user_id, status FROM Appointments WHERE appointment_code = ?"
    ).bind(code).first() as AppointmentRow | null;

    if (!appt) {
      replyText = `❌ 找不到此預約編號，或該預約已超過 30 分鐘自動失效。\n請重新至網站預約。`;
    } else if (appt.user_id !== currentUser.id) {
      replyText = `❌ 驗證失敗：此預約編號不屬於您的帳號。\n您只能驗證您自己透過網站所建立的預約！`;
    } else if (appt.status === AppointmentStatus.CONFIRMED) {
      replyText = `⚠️ 您的預約編號 ${code} 已經是確認狀態囉，請勿重複驗證！`;
    } else if (appt.status === AppointmentStatus.PENDING) {
      await env.reserve_db.prepare(
        "UPDATE Appointments SET status = ? WHERE id = ?"
      ).bind(AppointmentStatus.CONFIRMED, appt.id).run();
      replyText = `✅ 預約驗證成功！\n\n您的預約編號 ${code} 已確認。\n期待您的光臨！`;
    } else {
      replyText = `❌ 此預約已被取消或狀態異常。`;
    }
  }

  await sendLineReply(replyToken, replyText, accessToken);
}

/** 處理自動回覆邏輯（含間隔控制） */
async function handleAutoReply(
  env: Env,
  userLineId: string,
  replyToken: string,
  accessToken: string
): Promise<void> {
  const autoRecord = await env.reserve_db.prepare(
    "SELECT last_auto_reply_at FROM LineAutoReplies WHERE line_id = ?"
  ).bind(userLineId).first() as { last_auto_reply_at: string } | null;

  let shouldReply = true;
  if (autoRecord?.last_auto_reply_at) {
    const lastTime = new Date(autoRecord.last_auto_reply_at.replace(' ', 'T') + '+08:00').getTime();
    const diffMinutes = (Date.now() - lastTime) / (1000 * 60);
    if (diffMinutes < AUTO_REPLY_INTERVAL) shouldReply = false;
  }

  if (!shouldReply) return;

  const businessHour = isBusinessHour();
  const replyText = businessHour
    ? `感謝您的訊息！\n我們會儘快回覆您\n請耐心稍等噢☺️`
    : `我們已收到您的訊息！\n目前非上班時間\n我們會在上班後盡快回覆!\n請耐心等候❤️`;

  await sendLineReply(replyToken, replyText, accessToken);

  await env.reserve_db.prepare(
    `INSERT INTO LineAutoReplies (line_id, last_auto_reply_at)
     VALUES (?, datetime('now', '+8 hours'))
     ON CONFLICT(line_id) DO UPDATE SET last_auto_reply_at = datetime('now', '+8 hours')`
  ).bind(userLineId).run();
}

// ========================================================
// 4. 路由處理器
// ========================================================

async function handleRoot(ctx: HandlerContext): Promise<Response> {
  return successResponse({
    endpoints: [
      "/api/users", "/api/login", "/api/liff-login", "/api/line-login",
      "/api/appointments", "/api/beauticians", "/api/holidays", "/api/line-webhook"
    ]
  }, "歡迎來到預約系統 API 伺服器！", 200, ctx.headers);
}

async function handleRegister(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as RegisterBody;
    const { last_name, first_name, phone, password, date_of_birth, gender, location, email, notes, line_id } = body;

    if (!last_name || !first_name || !phone || !password || !gender || !date_of_birth || !line_id) {
      return errorResponse("姓、名、電話、密碼、生日、性別與 LINE 綁定皆為必填！", 400, headers);
    }
    if (!/^(?=.*[a-zA-Z])(?=.*\d).+$/.test(password)) {
      return errorResponse("密碼必須包含至少一個英文字母與數字！", 400, headers);
    }

    const existingLine = await getUserByLineId(env, line_id);
    if (existingLine) {
      return errorResponse("您的 LINE 帳號已經是會員囉，請直接使用 LINE 登入！", 409, headers);
    }
    const existingPhone = await getUserByPhone(env, phone);
    if (existingPhone) {
      return errorResponse("此手機號碼已經註冊過會員了，請直接登入！", 409, headers);
    }

    const hashed = await hashPassword(password);
    const result = await env.reserve_db.prepare(
      `INSERT INTO Users 
       (last_name, first_name, phone, date_of_birth, gender, location, password_hash, email, notes, line_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(
      last_name, first_name, phone, date_of_birth, gender,
      location || null, hashed, email || null, notes || null, line_id
    ).first() as { id: number } | null;

    return successResponse({ userId: result?.id }, "會員註冊成功！", 201, headers);
  } catch (error: unknown) {
    console.error("❌ 會員註冊失敗：", error);
    return errorResponse("伺服器發生錯誤", 500, headers);
  }
}

async function handleLiffLogin(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const { line_id } = (await request.json()) as LiffLoginBody;
    if (!line_id) return errorResponse("缺少 LINE ID", 400, headers);

    const user = await getUserByLineId(env, line_id);
    if (user) {
      return successResponse({
        action: "login",
        user: {
          id: user.id,
          lastName: user.last_name,
          firstName: user.first_name,
          gender: user.gender,
          dateOfBirth: user.date_of_birth,
          location: user.location,
          email: user.email,
          age: calculateAge(user.date_of_birth)  // ✅ 新增
        }
      }, undefined, 200, headers);
    } else {
      return successResponse({ action: "require_register", line_id }, undefined, 200, headers);
    }
  } catch (error: unknown) {
    console.error("LIFF 登入錯誤：", error);
    return errorResponse("LIFF 驗證失敗", 500, headers);
  }
}

async function handleUpdateUser(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as UpdateUserBody;
    const { id, last_name, first_name, gender, date_of_birth, location, email, password } = body;
    if (!id) return errorResponse("缺少會員 ID", 400, headers);

    if (password) {
      const hashed = await hashPassword(password);
      await env.reserve_db.prepare(
        `UPDATE Users SET last_name=?, first_name=?, gender=?, date_of_birth=?, location=?, email=?, password_hash=? WHERE id=?`
      ).bind(last_name, first_name, gender, date_of_birth, location || null, email || null, hashed, id).run();
    } else {
      await env.reserve_db.prepare(
        `UPDATE Users SET last_name=?, first_name=?, gender=?, date_of_birth=?, location=?, email=? WHERE id=?`
      ).bind(last_name, first_name, gender, date_of_birth, location || null, email || null, id).run();
    }
    return successResponse({}, "更新成功", 200, headers);
  } catch (error: unknown) {
    console.error("更新會員資料失敗：", error);
    return errorResponse("更新失敗", 500, headers);
  }
}

async function handleGetUsers(ctx: HandlerContext): Promise<Response> {
  const { env, headers, url } = ctx;
  try {
    const id = url.searchParams.get('id');

    // 🌟 若有傳入 id，只查詢該單一會員
    if (id) {
      const user = await env.reserve_db.prepare(
        `SELECT id, last_name, first_name, phone, date_of_birth, gender, location, email, notes, created_at
         FROM Users WHERE id = ?`
      ).bind(id).first();

      if (!user) return errorResponse("找不到該會員", 404, headers);

      // 附加計算後的年齡
      const result = {
        ...user,
        age: calculateAge(user.date_of_birth as string)
      };

      return successResponse(result, undefined, 200, headers);
    }

    // 🌟 若無傳入 id，則維護原本後台管理需要的全表查詢
    const { results } = await env.reserve_db.prepare(
      `SELECT id, last_name, first_name, phone, date_of_birth, gender, location, email, notes, created_at
       FROM Users ORDER BY created_at DESC`
    ).all();

    return successResponse(results, undefined, 200, headers);
  } catch (error: unknown) {
    console.error("讀取客戶失敗：", error);
    return errorResponse("讀取客戶資料失敗", 500, headers);
  }
}

async function handleLogin(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const { phone, password } = (await request.json()) as LoginBody;
    if (!phone || !password) return errorResponse("手機號碼與密碼為必填！", 400, headers);

    const user = await getUserByPhone(env, phone);
    if (!user) return errorResponse("手機號碼或密碼錯誤！", 401, headers);

    const hashed = await hashPassword(password);
    if (hashed !== user.password_hash) return errorResponse("手機號碼或密碼錯誤！", 401, headers);

    return successResponse({
      user: {
        id: user.id,
        lastName: user.last_name,
        firstName: user.first_name,
        gender: user.gender,
        dateOfBirth: user.date_of_birth,
        location: user.location,
        email: user.email,
        age: calculateAge(user.date_of_birth)  // ✅ 新增
      }
    }, "登入成功！", 200, headers);
  } catch (error: unknown) {
    console.error("❌ 登入發生錯誤：", error);
    return errorResponse("伺服器發生錯誤", 500, headers);
  }
}

async function handleLineLogin(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const { code, redirectUri } = (await request.json()) as LineLoginBody;
    if (!code) return errorResponse("缺少授權碼", 400, headers);

    const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: env.LINE_CHANNEL_ID,
        client_secret: env.LINE_CHANNEL_SECRET
      }).toString()
    });
    const tokenData = (await tokenRes.json()) as LineTokenResponse;
    if (!tokenData.access_token) throw new Error("無法取得 LINE Token");

    const profileRes = await fetch('https://api.line.me/v2/profile', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });
    const profile = (await profileRes.json()) as LineProfileResponse;
    const lineId = profile.userId;
    if (!lineId) throw new Error("無法取得 LINE 帳號資訊");

    const user = await getUserByLineId(env, lineId);
    if (user) {
      return successResponse({
        action: "login",
        user: {
          id: user.id,
          lastName: user.last_name,
          firstName: user.first_name,
          gender: user.gender,
          dateOfBirth: user.date_of_birth,
          location: user.location,
          email: user.email,
          age: calculateAge(user.date_of_birth)  // ✅ 新增
        }
      }, undefined, 200, headers);
    } else {
      return successResponse({ action: "require_register", line_id: lineId }, undefined, 200, headers);
    }
  } catch (error: unknown) {
    console.error("LINE 登入錯誤：", error);
    return errorResponse("LINE 驗證失敗，請重試。", 500, headers);
  }
}

async function handleCreateAppointment(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as AppointmentCreateBody;
    const { user_id, date, start_time, beautician_id } = body;
    if (!user_id || !date || !start_time) return errorResponse("缺少必要的預約資訊", 400, headers);

    const end_time = calculateEndTime(start_time);
    const reqDate = new Date(date);
    const dayOfWeek = reqDate.getDay();

    const holiday = await env.reserve_db.prepare(
      `SELECT * FROM ShopHolidays 
       WHERE (type = ? AND date = ?) OR (type = ? AND day_of_week = ?) OR (type = ? AND date = ? AND (
               (start_time <= ? AND end_time > ?) OR (start_time < ? AND end_time >= ?) OR (start_time >= ? AND end_time <= ?)
             ))`
    ).bind(
      HolidayType.FULL_DAY, date, HolidayType.WEEKLY, dayOfWeek, HolidayType.TIME_RANGE, date,
      start_time, start_time, end_time, end_time, start_time, end_time
    ).first();
    if (holiday) return errorResponse("抱歉！您選擇的時間為店家公休日或休息時段，請重新選擇。", 409, headers);

    const conflict = await env.reserve_db.prepare(
      `SELECT id FROM Appointments WHERE date = ? AND status != ? AND (start_time < ? AND end_time > ?)`
    ).bind(date, AppointmentStatus.CANCELLED, end_time, start_time).first();
    if (conflict) return errorResponse("真不巧！這個時段已經被人預約走了，請選擇其他時間。", 409, headers);

    let appointment_code = '';
    let insertResult: { id: number } | null = null;
    const finalBeauticianId = beautician_id ? Number(beautician_id) : null;

    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      const random = Math.random().toString(36).substring(2, 8).toUpperCase();
      appointment_code = `RV-${random}`;
      try {
        insertResult = await env.reserve_db.prepare(
          `INSERT INTO Appointments (user_id, date, start_time, end_time, beautician_id, appointment_code)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
        ).bind(user_id, date, start_time, end_time, finalBeauticianId, appointment_code).first() as { id: number } | null;
        break;
      } catch (err: unknown) {
        if ((err as { message?: string })?.message?.includes('UNIQUE') && attempt < MAX_RETRY - 1) continue;
        throw err;
      }
    }

    return successResponse({
      appointment: { id: insertResult?.id, date, start_time, end_time, appointment_code }
    }, "預約成功！", 201, headers);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error("預約失敗：", error);
    return errorResponse("預約失敗：" + (err.message || "未知錯誤"), 500, headers);
  }
}

async function handleGetAppointments(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const userId = ctx.url.searchParams.get('user_id');
    const date = ctx.url.searchParams.get('date');

    let query = `
      SELECT 
        Appointments.id, Appointments.date, Appointments.start_time, Appointments.end_time,
        Appointments.status, Appointments.notes AS notes, Appointments.appointment_code,
        Appointments.beautician_id, beauticians.name AS beautician_name,
        Users.id AS user_id, Users.last_name || Users.first_name AS client_name,
        Users.phone AS client_phone, Users.email AS client_email, Users.gender AS client_gender,
        Users.date_of_birth AS client_date_of_birth, Users.location AS client_location,
        Users.notes AS user_notes,
        (SELECT COUNT(*) FROM Appointments A2 WHERE A2.user_id = Users.id AND A2.status = ?) AS visit_count
      FROM Appointments
      JOIN Users ON Appointments.user_id = Users.id
      LEFT JOIN beauticians ON Appointments.beautician_id = beauticians.id
    `;

    let results: any[];
    if (date) {
      query += " WHERE Appointments.date = ? AND Appointments.status != ? ORDER BY Appointments.start_time ASC";
      const res = await env.reserve_db.prepare(query).bind(AppointmentStatus.COMPLETE, date, AppointmentStatus.CANCELLED).all();
      results = res.results;
    } else if (userId) {
      query += " WHERE Appointments.user_id = ? ORDER BY Appointments.date DESC, Appointments.start_time DESC";
      const res = await env.reserve_db.prepare(query).bind(AppointmentStatus.COMPLETE, userId).all();
      results = res.results;
    } else {
      query += " ORDER BY Appointments.date ASC, Appointments.start_time ASC";
      const res = await env.reserve_db.prepare(query).bind(AppointmentStatus.COMPLETE).all();
      results = res.results;
    }

    // ✅ 使用 calculateAge 統一計算年齡，刪除重複邏輯
    results = results.map((item: any) => ({
      ...item,
      age: calculateAge(item.client_date_of_birth)
    }));

    return successResponse(results, undefined, 200, headers);
  } catch (error: unknown) {
    console.error("讀取預約失敗：", error);
    return errorResponse("讀取預約資料失敗", 500, headers);
  }
}

async function handlePatchAppointment(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as AppointmentPatchBody;
    const { id, status, notes, user_id, user_notes, beautician_id } = body;
    if (!id) return errorResponse("缺少預約 ID", 400, headers);

    if (status !== undefined) await env.reserve_db.prepare("UPDATE Appointments SET status = ? WHERE id = ?").bind(status, id).run();
    if (notes !== undefined) await env.reserve_db.prepare("UPDATE Appointments SET notes = ? WHERE id = ?").bind(notes, id).run();
    if (beautician_id !== undefined) await env.reserve_db.prepare("UPDATE Appointments SET beautician_id = ? WHERE id = ?").bind(beautician_id, id).run();
    if (user_notes !== undefined && user_id) await env.reserve_db.prepare("UPDATE Users SET notes = ? WHERE id = ?").bind(user_notes, user_id).run();

    return successResponse({}, "更新成功", 200, headers);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error("更新失敗：", error);
    return errorResponse("更新失敗：" + (err.message || "未知錯誤"), 500, headers);
  }
}

// ---------- LINE Webhook（主流程，已拆分責任） ----------
async function handleLineWebhook(ctx: HandlerContext): Promise<Response> {
  const { request, env } = ctx;

  // 1. Signature 驗證（可開關）
  const enableVerify = env.ENABLE_SIGNATURE_VERIFY !== 'false'; // 預設啟用
  if (enableVerify) {
    const signature = request.headers.get('X-Line-Signature');
    if (!signature) return new Response('Unauthorized', { status: 401 });
    const rawBody = await request.text();
    const isValid = await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET);
    if (!isValid) return new Response('Invalid Signature', { status: 401 });
    // 重新解析已讀取的 body
    const body = JSON.parse(rawBody) as LineWebhookBody;
    return processWebhookEvents(body, env);
  } else {
    // 未啟用驗證，直接解析
    const body = (await request.json()) as LineWebhookBody;
    return processWebhookEvents(body, env);
  }
}

/** 實際處理 Webhook 事件（抽離以利閱讀） */
async function processWebhookEvents(body: LineWebhookBody, env: Env): Promise<Response> {
  if (!body.events || body.events.length === 0) return new Response("OK", { status: 200 });

  const accessToken = env.LINE_ACCESS_TOKEN;

  for (const event of body.events) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue;

    const replyToken = event.replyToken;
    const userLineId = event.source.userId;
    const text = event.message.text.trim().toUpperCase();

    if (['價目表'].includes(text)) continue;

    const codeMatch = text.match(/^RV-[A-Z0-9]{6}$/);

    if (codeMatch) {
      await handleAppointmentVerification(env, userLineId, codeMatch[0], replyToken, accessToken);
    } else {
      await handleAutoReply(env, userLineId, replyToken, accessToken);
    }
  }

  return new Response("OK", { status: 200 });
}

// ---------- 美容師 CRUD ----------
async function handleBeauticians(ctx: HandlerContext): Promise<Response> {
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

// ---------- 休假设定 ----------
async function handleHolidays(ctx: HandlerContext): Promise<Response> {
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

// ========================================================
// 5. 路由表
// ========================================================
type RouteHandler = (ctx: HandlerContext) => Promise<Response>;

const routeHandlers: Record<string, RouteHandler> = {
  'GET:/': handleRoot,
  'POST:/api/users': handleRegister,
  'PUT:/api/users': handleUpdateUser,
  'GET:/api/users': handleGetUsers,
  'POST:/api/login': handleLogin,
  'POST:/api/liff-login': handleLiffLogin,
  'POST:/api/line-login': handleLineLogin,
  'POST:/api/appointments': handleCreateAppointment,
  'GET:/api/appointments': handleGetAppointments,
  'PATCH:/api/appointments': handlePatchAppointment,
  'GET:/api/beauticians': handleBeauticians,
  'POST:/api/beauticians': handleBeauticians,
  'PUT:/api/beauticians': handleBeauticians,
  'DELETE:/api/beauticians': handleBeauticians,
  'GET:/api/holidays': handleHolidays,
  'POST:/api/holidays': handleHolidays,
  'DELETE:/api/holidays': handleHolidays,
  'POST:/api/line-webhook': handleLineWebhook,
};

// ========================================================
// 6. Worker 入口與定時任務
// ========================================================
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
        `UPDATE Appointments SET status = ? WHERE status = ? AND date < date('now', '+8 hours')`
      ).bind(AppointmentStatus.COMPLETE, AppointmentStatus.CONFIRMED).run();

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