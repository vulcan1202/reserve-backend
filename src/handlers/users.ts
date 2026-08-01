// ========================================================
// 會員註冊 / 登入 / 資料管理 API
// ========================================================
import type {
  HandlerContext, RegisterBody, LiffLoginBody, UpdateUserBody,
  LoginBody, LineLoginBody, LineTokenResponse, LineProfileResponse
} from "../types";
import { successResponse, errorResponse, hashPassword, calculateAge } from "../utils";
import { getUserByLineId, getUserByPhone } from "../db";

export async function handleRegister(ctx: HandlerContext): Promise<Response> {
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

export async function handleLiffLogin(ctx: HandlerContext): Promise<Response> {
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

export async function handleUpdateUser(ctx: HandlerContext): Promise<Response> {
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

export async function handleGetUsers(ctx: HandlerContext): Promise<Response> {
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

export async function handleLogin(ctx: HandlerContext): Promise<Response> {
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

export async function handleLineLogin(ctx: HandlerContext): Promise<Response> {
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
        client_id: env.LINE_LOGIN_CHANNEL_ID,      // 改用 LOGIN_CHANNEL_ID
        client_secret: env.LINE_LOGIN_CHANNEL_SECRET // 改用 LOGIN_CHANNEL_SECRET
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
