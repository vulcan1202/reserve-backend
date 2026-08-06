// ========================================================
// 管理員身份驗證與登入處理器 (handlers/adminAuth.ts)
// ========================================================
import type { HandlerContext } from "../types";
import { successResponse, errorResponse } from "../utils";
import { hashPassword, verifyPassword, parseCookies } from "../utils/authUtils";

export interface AdminUserRecord {
  id: number;
  username: string;
  role: string;
  session_id?: string;
}

/**
 * 身分驗證中間件 (Auth Middleware)
 * 驗證 Request Cookie 中的 Session ID 是否有效且未過期
 */
export async function authenticateAdmin(ctx: HandlerContext): Promise<AdminUserRecord | null> {
  const { request, env } = ctx;
  const cookieHeader = request.headers.get("Cookie");
  const cookies = parseCookies(cookieHeader);
  const sessionId = cookies["admin_session"];

  if (!sessionId) {
    return null;
  }

  try {
    const sessionRecord = await env.reserve_db.prepare(`
      SELECT 
        AdminSessions.id AS session_id,
        AdminSessions.expires_at,
        AdminUsers.id AS admin_id,
        AdminUsers.username,
        AdminUsers.role
      FROM AdminSessions
      JOIN AdminUsers ON AdminSessions.admin_id = AdminUsers.id
      WHERE AdminSessions.id = ?
    `).bind(sessionId).first<{
      session_id: string;
      expires_at: string;
      admin_id: number;
      username: string;
      role: string;
    }>();

    if (!sessionRecord) {
      return null;
    }

    // 檢查 Session 是否已過期
    const expiresAt = new Date(sessionRecord.expires_at).getTime();
    if (expiresAt <= Date.now()) {
      // 自動清理過期 Session
      ctx.ctx.waitUntil(
        env.reserve_db.prepare("DELETE FROM AdminSessions WHERE id = ?").bind(sessionId).run()
      );
      return null;
    }

    return {
      id: sessionRecord.admin_id,
      username: sessionRecord.username,
      role: sessionRecord.role,
      session_id: sessionRecord.session_id
    };
  } catch (error) {
    console.error("authenticateAdmin 驗證失敗:", error);
    return null;
  }
}

/**
 * 管理員登入 API (POST /api/admin/login)
 */
export async function handleAdminLogin(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = await request.json() as { username?: string; password?: string };
    const { username, password } = body;

    if (!username || !password) {
      return errorResponse("請輸入帳號與密碼", 400, headers);
    }

    // 查詢管理員帳號
    const admin = await env.reserve_db.prepare(`
      SELECT id, username, password_hash, role FROM AdminUsers WHERE username = ?
    `).bind(username.trim()).first<{
      id: number;
      username: string;
      password_hash: string;
      role: string;
    }>();

    // 驗證帳號存在性與 Argon2id 密碼比對
    // 統一回傳「帳號或密碼錯誤」以防帳號枚舉攻擊 (Username Enumeration)
    if (!admin) {
      return errorResponse("帳號或密碼錯誤", 401, headers);
    }

    const isPasswordValid = await verifyPassword(password, admin.password_hash);
    if (!isPasswordValid) {
      return errorResponse("帳號或密碼錯誤", 401, headers);
    }

    // 生成隨機 32-byte / UUID Session Token
    const sessionToken = crypto.randomUUID();
    
    // 設定 8 小時過期時間 (28,800 秒)
    const maxAgeSeconds = 28800;
    const expiresAtISO = new Date(Date.now() + maxAgeSeconds * 1000).toISOString();

    // 寫入 AdminSessions 資料庫
    await env.reserve_db.prepare(`
      INSERT INTO AdminSessions (id, admin_id, expires_at)
      VALUES (?, ?, ?)
    `).bind(sessionToken, admin.id, expiresAtISO).run();

    // 設定安全 HttpOnly + Secure + SameSite=Lax Cookie Header
    const responseHeaders = {
      ...headers,
      "Set-Cookie": `admin_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
    };

    return successResponse({
      admin: {
        id: admin.id,
        username: admin.username,
        role: admin.role
      }
    }, "登入成功！", 200, responseHeaders);

  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error("管理員登入失敗:", error);
    return errorResponse("登入失敗：" + (err.message || "未知錯誤"), 500, headers);
  }
}

/**
 * 管理員登出 API (POST /api/admin/logout)
 */
export async function handleAdminLogout(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const cookies = parseCookies(request.headers.get("Cookie"));
    const sessionId = cookies["admin_session"];

    if (sessionId) {
      // 刪除 Session 紀錄
      await env.reserve_db.prepare("DELETE FROM AdminSessions WHERE id = ?").bind(sessionId).run();
    }

    // 將 Cookie 設定為過期 (Max-Age=0)
    const responseHeaders = {
      ...headers,
      "Set-Cookie": "admin_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
    };

    return successResponse({}, "已成功登出！", 200, responseHeaders);
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error("管理員登出失敗:", error);
    return errorResponse("登出失敗：" + (err.message || "未知錯誤"), 500, headers);
  }
}

/**
 * 取得當前管理員身分 API (GET /api/admin/me)
 */
export async function handleAdminMe(ctx: HandlerContext): Promise<Response> {
  const { headers } = ctx;
  const admin = await authenticateAdmin(ctx);
  if (!admin) {
    return errorResponse("未登入或 Session 已失效，請重新登入", 401, headers);
  }

  return successResponse({ admin }, undefined, 200, headers);
}

/**
 * 建立管理員帳號 API (POST /api/admin/register)
 * 供初始化或新增管理員使用
 */
export async function handleAdminRegister(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = await request.json() as { username?: string; password?: string; role?: string };
    const { username, password, role = "admin" } = body;

    if (!username || !password) {
      return errorResponse("請輸入欲建立的管理員帳號與密碼", 400, headers);
    }

    // 檢查帳號是否已存在
    const existing = await env.reserve_db.prepare(`
      SELECT id FROM AdminUsers WHERE username = ?
    `).bind(username.trim()).first();
    if (existing) {
      return errorResponse("該管理員帳號已存在！", 409, headers);
    }

    // 使用 Argon2id 加鹽雜湊密碼
    const passwordHash = await hashPassword(password);

    // 插入資料庫
    const result = await env.reserve_db.prepare(`
      INSERT INTO AdminUsers (username, password_hash, role)
      VALUES (?, ?, ?) RETURNING id, username, role, created_at
    `).bind(username.trim(), passwordHash, role).first<{
      id: number;
      username: string;
      role: string;
      created_at: string;
    }>();

    return successResponse({ admin: result }, "管理員帳號建立成功！", 201, headers);

  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error("建立管理員帳號失敗:", error);
    return errorResponse("建立失敗：" + (err.message || "未知錯誤"), 500, headers);
  }
}
