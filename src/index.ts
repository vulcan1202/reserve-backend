import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";

export interface Env {
  reserve_db: D1Database;
}
//SHA-256 雜湊密碼的函式
async function hashPassword(password: string) {
  const msgBuffer = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 🌟 1. 取得這次請求的來源網址 (Origin)
    const requestOrigin = request.headers.get("Origin") || "";

    // 🌟 2. 設定你的白名單 (包含正式上線網址與本地開發網址)
    const allowedOrigins = [
      "https://hervive-pages.pages.dev",
      "http://127.0.0.1:3000",   // 如果你的前端本地端是用這個 port
      "http://localhost:3000",   // 通常也把 localhost 加進去比較保險
      "http://localhost:5173"    // 如果你用 Vite 開發，通常是 5173
    ];

    // 🌟 3. 判斷來源是否在白名單內。如果有，就回傳該來源；沒有的話就給一個預設值（或是拒絕）
    const validOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
// 🌟 加上這行！將網址中多餘的雙斜線替換掉，並存進 safePath 變數
    const safePath = url.pathname.replace(/\/+/g, '/');
    // 🌟 4. 動態產生 CORS 標頭
    const corsHeaders = {
      "Access-Control-Allow-Origin": validOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // ==========================================
    // 處理 CORS 預檢請求 (Preflight)
    // ==========================================
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // ==========================================
        // 路由 1：會員註冊 API (POST /api/users)
        // ==========================================
        if (request.method === 'POST' && safePath === '/api/users') {
          try {
            const body = await request.json() as any;
            // 接收新欄位
            const { last_name, first_name, phone, password, gender, email, notes, line_id } = body;

            // 1. 必填欄位檢查
            if (!last_name || !first_name || !phone || !password || !gender) {
              return new Response(JSON.stringify({ error: "姓、名、電話、密碼與性別皆為必填！" }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }

            // 2. 密碼強度檢查 (正規表達式：至少包含一個英文字母與一個數字)
            const passwordRegex = /^(?=.*[a-zA-Z])(?=.*\d).+$/;
            if (!passwordRegex.test(password)) {
              return new Response(JSON.stringify({ error: "密碼必須包含至少一個英文字母與數字！" }), {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }

            // 3. 檢查手機號碼是否已經註冊過
            const existingUser = await env.reserve_db.prepare(
              "SELECT id FROM Users WHERE phone = ?"
            ).bind(phone).first();

            if (existingUser) {
              return new Response(JSON.stringify({ error: "此手機號碼已經註冊過會員了，請直接登入！" }), {
                status: 409,
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }

            // 4. 將密碼進行 256 位元 (SHA-256) 雜湊
            const hashedPassword = await hashPassword(password);

            // 5. 寫入資料庫
            const result = await env.reserve_db.prepare(
              "INSERT INTO Users (last_name, first_name, phone, password_hash, gender, email, notes, line_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
            )
            .bind(
              last_name, 
              first_name, 
              phone, 
              hashedPassword, 
              gender, 
              email || null, 
              notes || null, 
              line_id // 帶入前端傳過來的 LINE ID
            )
            .first();

            return new Response(JSON.stringify({ 
              success: true, 
              message: "會員註冊成功！",
              userId: result?.id 
            }), {
              status: 201,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });

          } catch (error: any) {
            console.error("❌ 會員註冊失敗：", error);
            return new Response(JSON.stringify({ error: "伺服器發生錯誤" }), {
              status: 500,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }
        }
    // ==========================================
    // 路由：修改會員資料 API (PUT /api/users)
    // ==========================================
    if (request.method === 'PUT' && safePath === '/api/users') {
      try {
        const body = await request.json() as any;
        const { id, last_name, first_name, gender, email } = body;

        if (!id) {
          return new Response(JSON.stringify({ error: "缺少會員 ID" }), { status: 400, headers: corsHeaders });
        }

        await env.reserve_db.prepare(
          "UPDATE Users SET last_name = ?, first_name = ?, gender = ?, email = ? WHERE id = ?"
        )
        .bind(last_name, first_name, gender, email || null, id)
        .run();

        return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: "更新失敗" }), { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
        // 路由 2：取得所有客戶名單 (GET /api/users)
        // ==========================================
        if (request.method === 'GET' && safePath === '/api/users') {
          try {
            // ⚠️ 資安防護：明確指定欄位，絕對不撈出 password_hash！
            const { results } = await env.reserve_db.prepare(`
              SELECT 
                id,
                last_name,
                first_name,
                phone,
                gender,
                email,
                notes,
                created_at
              FROM Users
              ORDER BY created_at DESC
            `).all();

            return new Response(JSON.stringify(results), {
              status: 200,
              headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
            });
          } catch (error: any) {
            console.error("讀取失敗：", error);
            return new Response(JSON.stringify({ error: "讀取客戶資料失敗" }), {
              status: 500,
              headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
            });
          }
        }

    // ==========================================
        // 路由 3：新增預約 (POST /api/appointments)
        // ==========================================
        if (request.method === 'POST' && safePath === '/api/appointments') {
          try {
            const body = await request.json() as any;
            const { user_id, appointment_time } = body;

            if (!user_id || !appointment_time) {
              return new Response(JSON.stringify({ error: "客戶 ID 和預約時間為必填！" }), {
                status: 400,
                headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
              });
            }

            // 🌟 1. 檢查該時段是否已經被預約過了
            const existingAppt = await env.reserve_db.prepare(
              "SELECT * FROM Appointments WHERE appointment_time = ?"
            )
            .bind(appointment_time)
            .first();

            if (existingAppt) {
              return new Response(JSON.stringify({ error: "這個時段已經被人預約滿囉！請選擇其他時間。" }), {
                status: 409, // 409 Conflict 代表衝突
                headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
              });
            }

            // 🌟 2. 如果沒有人預約，才執行寫入
            const result = await env.reserve_db.prepare(
              "INSERT INTO Appointments (user_id, appointment_time) VALUES (?, ?)"
            )
            .bind(user_id, appointment_time)
            .run();

            return new Response(JSON.stringify({ success: true, message: "預約建立成功！" }), {
              status: 201,
              headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
            });

          } catch (error: any) {
            console.error("預約寫入失敗：", error);
            return new Response(JSON.stringify({ error: "預約失敗，請確認該客戶是否存在。" }), {
              status: 500,
              headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
            });
          }
        }

    // ==========================================
    // 路由 4：取得預約紀錄 (GET /api/appointments)
    // ==========================================
    if (request.method === 'GET' && safePath === '/api/appointments') {
      try {
        // 抓取網址後面的 ?user_id=xxx
        const userId = url.searchParams.get('user_id');

        let query = `
          SELECT 
            Appointments.id AS appointment_id,
            Appointments.appointment_time,
            Appointments.status,
            Users.last_name || Users.first_name AS client_name,
            Users.phone AS client_phone,
            Users.notes AS client_notes
          FROM Appointments
          JOIN Users ON Appointments.user_id = Users.id
        `;

        // 如果前端有傳 user_id，就只撈那個人的；沒傳就撈全部 (店家後台用)
        let results;
        if (userId) {
          query += " WHERE Appointments.user_id = ? ORDER BY Appointments.appointment_time DESC";
          const res = await env.reserve_db.prepare(query).bind(userId).all();
          results = res.results;
        } else {
          query += " ORDER BY Appointments.appointment_time ASC";
          const res = await env.reserve_db.prepare(query).all();
          results = res.results;
        }

        return new Response(JSON.stringify(results), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
        });
      } catch (error: any) {
        console.error("讀取預約失敗：", error);
        return new Response(JSON.stringify({ error: "讀取預約資料失敗" }), { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // 路由 5：會員登入 API (POST /api/login)
    // ==========================================
    if (request.method === 'POST' && safePath === '/api/login') {
      try {
        const body = await request.json() as any;
        const { phone, password } = body;

        // 1. 檢查必填欄位
        if (!phone || !password) {
          return new Response(JSON.stringify({ error: "手機號碼與密碼為必填！" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        // 2. 根據手機號碼尋找使用者 (順便把名字拿出來，登入後前端可以顯示歡迎詞)
        const user = await env.reserve_db.prepare(
          "SELECT id, last_name, first_name, gender, email, password_hash FROM Users WHERE phone = ?"
        )
        .bind(phone)
        .first();

        // 3. 資安防護：找不到使用者時，回傳模糊錯誤
        if (!user) {
          return new Response(JSON.stringify({ error: "手機號碼或密碼錯誤！" }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        // 4. 將前端傳來的密碼進行相同的 SHA-256 雜湊
        const hashedPassword = await hashPassword(password);

        // 5. 比對密碼是否一致
        if (hashedPassword !== user.password_hash) {
          return new Response(JSON.stringify({ error: "手機號碼或密碼錯誤！" }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        // 6. 登入成功！回傳使用者的 ID 與姓名給前端
        return new Response(JSON.stringify({ 
          success: true, 
          message: "登入成功！",
          user: {
            id: user.id,
            lastName: user.last_name,
            firstName: user.first_name,
            gender: user.gender, 
            email: user.email 
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });

      } catch (error: any) {
        console.error("❌ 登入發生錯誤：", error);
        return new Response(JSON.stringify({ error: "伺服器發生錯誤" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }
    // ==========================================
    // 路由 6：LINE 登入與驗證 (POST /api/line-login)
    // ==========================================
    if (request.method === 'POST' && safePath === '/api/line-login') {
      try {
        const body = await request.json() as any;
        const { code, redirectUri } = body;

        if (!code) {
          return new Response(JSON.stringify({ error: "缺少授權碼" }), { status: 400, headers: corsHeaders });
        }

        // ⚠️ 請填入你在 LINE Developers 取得的 Channel ID 與 Secret
        const LINE_CHANNEL_ID = '2010853479'; 
        const LINE_CHANNEL_SECRET = 'da0a863c30ae277dc6670a2a83e0e82a';

        // 1. 向 LINE 伺服器換取 Access Token
        const tokenResponse = await fetch('https://api.line.me/oauth2/v2.1/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: redirectUri, // 必須與授權時的網址完全一致
            client_id: LINE_CHANNEL_ID,
            client_secret: LINE_CHANNEL_SECRET
          }).toString()
        });

        const tokenData = await tokenResponse.json() as any;
        if (!tokenData.access_token) throw new Error("無法取得 LINE Token");

        // 2. 拿 Access Token 取得使用者 Profile (取得 lineId)
        const profileResponse = await fetch('https://api.line.me/v2/profile', {
          headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
        });
        const profileData = await profileResponse.json() as any;
        const lineId = profileData.userId;

        if (!lineId) throw new Error("無法取得 LINE 帳號資訊");

        // 3. 命運分岔點：去資料庫尋找這個 line_id
        const existingUser = await env.reserve_db.prepare(
          "SELECT id, last_name, first_name, gender, email FROM Users WHERE line_id = ?"
        ).bind(lineId).first();

        if (existingUser) {
          // 👉 情境 A (老客)：直接回傳登入成功
          return new Response(JSON.stringify({ 
            success: true, 
            action: "login", 
            user: {
              id: existingUser.id,
              lastName: existingUser.last_name,
              firstName: existingUser.first_name,
              gender: existingUser.gender,
              email: existingUser.email
            }
          }), { status: 200, headers: corsHeaders });
        } else {
          // 👉 情境 B (新客)：回傳 line_id 給前端，要求繼續填寫註冊表單
          return new Response(JSON.stringify({ 
            success: true, 
            action: "require_register", 
            line_id: lineId 
          }), { status: 200, headers: corsHeaders });
        }

      } catch (error: any) {
        console.error("LINE 登入錯誤：", error);
        return new Response(JSON.stringify({ error: "LINE 驗證失敗，請重試。" }), { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // 預設路由：首頁
    // ==========================================
    return new Response("歡迎來到預約系統 API 伺服器！", {
      headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders }
    });
  },
};