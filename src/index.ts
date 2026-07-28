import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";

export interface Env {
  reserve_db: D1Database;
  LINE_ACCESS_TOKEN: string;  
  LINE_CHANNEL_ID: string;  
  LINE_CHANNEL_SECRET: string;  
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
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
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
        // 🌟 接收 password 欄位
        const { id, last_name, first_name, gender, email, password } = body;

        if (!id) {
          return new Response(JSON.stringify({ error: "缺少會員 ID" }), { status: 400, headers: corsHeaders });
        }

        // 🌟 判斷使用者是否有填寫新密碼
        if (password) {
          // 有填寫密碼，先雜湊後，連同密碼一起更新
          const hashedPassword = await hashPassword(password);
          await env.reserve_db.prepare(
            "UPDATE Users SET last_name = ?, first_name = ?, gender = ?, email = ?, password_hash = ? WHERE id = ?"
          )
          .bind(last_name, first_name, gender, email || null, hashedPassword, id)
          .run();
        } else {
          // 沒有填寫密碼，只更新基本資料
          await env.reserve_db.prepare(
            "UPDATE Users SET last_name = ?, first_name = ?, gender = ?, email = ? WHERE id = ?"
          )
          .bind(last_name, first_name, gender, email || null, id)
          .run();
        }

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
        // 🌟 移除 service_name，只接收 user_id, date, start_time
        const { user_id, date, start_time } = body;

        if (!user_id || !date || !start_time) {
          return new Response(JSON.stringify({ error: "缺少必要的預約資訊" }), { 
            status: 400, 
            headers: { "Content-Type": "application/json", ...corsHeaders } 
          });
        }

        // 1. 計算結束時間 (固定預設 2.5 小時 = 150 分鐘)
        const [hours, minutes] = start_time.split(':').map(Number);
        const startTotalMinutes = hours * 60 + minutes;
        const endTotalMinutes = startTotalMinutes + 150; // 2.5 小時
        
        const endHours = Math.floor(endTotalMinutes / 60);
        const endMinutes = endTotalMinutes % 60;
        const end_time = `${String(endHours).padStart(2, '0')}:${String(endMinutes).padStart(2, '0')}`;

        const reqDateObj = new Date(date);
        const dayOfWeek = reqDateObj.getDay();

        const holidayCheck = await env.reserve_db.prepare(`
          SELECT * FROM ShopHolidays 
          WHERE 
            -- 條件 A：遇到單日全天休假
            (type = 'full_day' AND date = ?)
            OR 
            -- 條件 B：遇到每週固定公休
            (type = 'weekly' AND day_of_week = ?)
            OR
            -- 條件 C：遇到特定時段休息 (檢查時段是否有重疊)
            (type = 'time_range' AND date = ? AND (
               (start_time <= ? AND end_time > ?) OR
               (start_time < ? AND end_time >= ?) OR
               (start_time >= ? AND end_time <= ?)
            ))
        `).bind(
          date, 
          dayOfWeek, 
          date, start_time, start_time, end_time, end_time, start_time, end_time
        ).first();

        if (holidayCheck) {
          return new Response(JSON.stringify({ 
            error: "抱歉！您選擇的時間為店家公休日或休息時段，請重新選擇。" 
          }), { 
            status: 409, 
            headers: { "Content-Type": "application/json", ...corsHeaders } 
          });
        }
        
        // 2. 防撞期檢查
        const conflict = await env.reserve_db.prepare(`
          SELECT id FROM Appointments 
          WHERE date = ? 
            AND status != 'cancelled'
            AND (start_time < ? AND end_time > ?)
        `).bind(date, end_time, start_time).first();

        if (conflict) {
          return new Response(JSON.stringify({ error: "真不巧！這個時段已經被人預約走了，請選擇其他時間。" }), { 
            status: 409, 
            headers: { "Content-Type": "application/json", ...corsHeaders } 
          });
        }

        // 🌟 3. 產生 6 碼隨機預約編號 (例如：RV-A8X9K2)
        const randomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        const appointment_code = `RV-${randomCode}`;

        // 🌟 4. 寫入資料庫 (新增 appointment_code 欄位)
        const result = await env.reserve_db.prepare(
          "INSERT INTO Appointments (user_id, date, start_time, end_time, appointment_code) VALUES (?, ?, ?, ?, ?) RETURNING id"
        ).bind(user_id, date, start_time, end_time, appointment_code).first();

        // 🌟 5. 將預約編號回傳給前端
        return new Response(JSON.stringify({ 
          success: true, 
          message: "預約成功！",
          appointment: { 
            id: result?.id, 
            date, 
            start_time, 
            end_time,
            appointment_code // 回傳給前端顯示
          }
        }), { 
          status: 201, 
          headers: { "Content-Type": "application/json", ...corsHeaders } 
        });

      } catch (error: any) {
        return new Response(JSON.stringify({ error: "預約失敗：" + error.message }), { 
          status: 500, 
          headers: { "Content-Type": "application/json", ...corsHeaders } 
        });
      }
    }

    // ==========================================
    // 路由 4：取得預約紀錄 (GET /api/appointments)
    // ==========================================
    if (request.method === 'GET' && safePath === '/api/appointments') {
      try {
        const userId = url.searchParams.get('user_id');
        const date = url.searchParams.get('date'); // 🌟 補上：抓取網址的 date 參數

        let query = `
          SELECT 
            Appointments.id,
            Appointments.date,
            Appointments.start_time,
            Appointments.end_time,
            Appointments.status,
            Users.id AS user_id,
            Users.last_name || Users.first_name AS client_name,
            Users.phone AS client_phone,
            Users.notes AS client_notes
          FROM Appointments
          JOIN Users ON Appointments.user_id = Users.id
        `;

        let results;
        if (date) {
          query += " WHERE Appointments.date = ? AND Appointments.status != 'cancelled' ORDER BY Appointments.start_time ASC";
          const res = await env.reserve_db.prepare(query).bind(date).all();
          results = res.results;
        } else if (userId) {
          query += " WHERE Appointments.user_id = ? ORDER BY Appointments.date DESC, Appointments.start_time DESC";
          const res = await env.reserve_db.prepare(query).bind(userId).all();
          results = res.results;
        } else {
          query += " ORDER BY Appointments.date ASC, Appointments.start_time ASC";
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
        const LINE_CHANNEL_ID = env.LINE_CHANNEL_ID; 
        const LINE_CHANNEL_SECRET = env.LINE_CHANNEL_SECRET;

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

    if (request.method === 'PATCH' && safePath === '/api/appointments') {
      try {
        const body = await request.json() as { id: number; status?: string; notes?: string; user_id?: number };
        const { id, status, notes, user_id } = body;
        
        // 1. 如果有傳入 status，更新預約狀態
        if (status !== undefined) {
          await env.reserve_db.prepare(
            "UPDATE Appointments SET status = ? WHERE id = ?"
          ).bind(status, id).run();
        }

        // 2. 如果有傳入 notes 且有 user_id，更新對應使用者的備註
        if (notes !== undefined && user_id) {
          await env.reserve_db.prepare(
            "UPDATE Users SET notes = ? WHERE id = ?"
          ).bind(notes, user_id).run();
        }

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
        });
      } catch (error: any) {
        console.error("更新失敗：", error);
        return new Response(JSON.stringify({ error: "更新失敗" }), { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // 路由 7：LINE Webhook 接收預約驗證碼 (POST /api/line-webhook)
    // ==========================================
    if (request.method === 'POST' && safePath === '/api/line-webhook') {
      try {
        const body = await request.json() as any;
        
        // LINE 驗證 Webhook 網址時會傳送空的 events
        if (!body.events || body.events.length === 0) {
          return new Response("OK", { status: 200 });
        }

        // ⚠️ 請填入你剛剛在 LINE Developers 取得的 Channel Access Token
        const LINE_ACCESS_TOKEN = env.LINE_ACCESS_TOKEN;

        for (const event of body.events) {
          // 只處理「文字訊息」
          if (event.type === 'message' && event.message.type === 'text') {
            const replyToken = event.replyToken;
            const userLineId = event.source.userId; // 抓出客人的真實 LINE ID
            const text = event.message.text.trim().toUpperCase(); // 轉大寫去空白

            // 檢查訊息是否符合預約編號格式 (例如：RV-A8X9K2)
            const codeMatch = text.match(/^RV-[A-Z0-9]{6}$/);

            if (codeMatch) {
              const code = codeMatch[0];

              // 去資料庫找這個預約
              const appt = await env.reserve_db.prepare(
                "SELECT id, user_id, status FROM Appointments WHERE appointment_code = ?"
              ).bind(code).first();

              let replyText = "";

              if (appt && appt.status === 'pending') {
                // 🌟 1. 找到預約，更新狀態為 confirmed
                await env.reserve_db.prepare(
                  "UPDATE Appointments SET status = 'confirmed' WHERE id = ?"
                ).bind(appt.id).run();

                // 🌟 2. 順手牽羊：把這個真實的 LINE ID 綁定到該會員身上，以後老闆就知道他是誰了！
                try {
                  await env.reserve_db.prepare(
                    "UPDATE Users SET line_id = ? WHERE id = ?"
                  ).bind(userLineId, appt.user_id).run();
                } catch (e) {
                  // 若因為 UNIQUE 限制報錯（例如客人換帳號），就略過，不影響預約確認
                }

                replyText = `✅ 預約驗證成功！\n\n您的預約編號 ${code} 已確認。\n期待您的光臨！`;

              } else if (appt && appt.status === 'confirmed') {
                replyText = `⚠️ 您的預約編號 ${code} 已經是確認狀態囉，請勿重複驗證！`;
              } else {
                replyText = `❌ 找不到此預約編號，或該預約已超過 30 分鐘自動失效。\n請重新至網站預約。`;
              }

              // 透過 Reply API 回傳結果給客人 (這個免費不扣額度)
              await fetch('https://api.line.me/v2/bot/message/reply', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
                },
                body: JSON.stringify({
                  replyToken: replyToken,
                  messages: [{ type: 'text', text: replyText }]
                })
              });
            }
          }
        }

        return new Response("OK", { status: 200 });

      } catch (error) {
        console.error("Webhook 錯誤：", error);
        return new Response("Error", { status: 500 });
      }
    }

    // ==========================================
    // 路由 8：新增休假設定 (POST /api/holidays)
    // ==========================================
    if (request.method === 'POST' && safePath === '/api/holidays') {
      try {
        const body = await request.json() as any;
        const { type, date, start_time, end_time, day_of_week, reason } = body;

        // 1. 基本檢查
        if (!type || !['full_day', 'time_range', 'weekly'].includes(type)) {
          return new Response(JSON.stringify({ error: "無效的休假類型" }), { status: 400, headers: corsHeaders });
        }

        if (type === 'full_day' && !date) {
          return new Response(JSON.stringify({ error: "全天公休必須指定日期" }), { status: 400, headers: corsHeaders });
        }
        if (type === 'time_range' && (!date || !start_time || !end_time)) {
          return new Response(JSON.stringify({ error: "時段休息必須指定日期、開始與結束時間" }), { status: 400, headers: corsHeaders });
        }
        if (type === 'weekly' && day_of_week === undefined) {
          return new Response(JSON.stringify({ error: "固定公休必須指定星期幾" }), { status: 400, headers: corsHeaders });
        }
        const finalDayOfWeek = type === 'weekly' ? day_of_week : null;

        // 2. 寫入資料庫
        await env.reserve_db.prepare(
          "INSERT INTO ShopHolidays (type, date, start_time, end_time, day_of_week, reason) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(type, date || null, start_time || null, end_time || null, finalDayOfWeek, reason || null)
        .run();

        return new Response(JSON.stringify({ success: true, message: "休假設定已新增" }), {
          status: 201,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (error: any) {
        console.error("新增休假失敗：", error);
        return new Response(JSON.stringify({ error: "新增休假失敗" }), { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // 路由 9：取得所有休假設定 (GET /api/holidays)
    // ==========================================
    if (request.method === 'GET' && safePath === '/api/holidays') {
      try {
        // 抓出未來（包含今天）的休假設定，或是固定每週公休的設定
        // 因為舊的單日休假過期了就不太需要再傳給前端
        const { results } = await env.reserve_db.prepare(`
          SELECT * FROM ShopHolidays 
          WHERE type = 'weekly' 
             OR (type IN ('full_day', 'time_range') AND date >= date('now', '+8 hours'))
          ORDER BY type DESC, date ASC, day_of_week ASC
        `).all();

        return new Response(JSON.stringify(results), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
        });
      } catch (error: any) {
        console.error("讀取休假設定失敗：", error);
        return new Response(JSON.stringify({ error: "讀取休假設定失敗" }), { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // 路由 10：刪除指定的休假設定 (DELETE /api/holidays)
    // ==========================================
    if (request.method === 'DELETE' && safePath === '/api/holidays') {
      try {
        const urlObj = new URL(request.url);
        const id = urlObj.searchParams.get('id');

        if (!id) {
          return new Response(JSON.stringify({ error: "缺少要刪除的休假 ID" }), { status: 400, headers: corsHeaders });
        }

        await env.reserve_db.prepare("DELETE FROM ShopHolidays WHERE id = ?").bind(id).run();

        return new Response(JSON.stringify({ success: true, message: "已刪除該休假設定" }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (error: any) {
        console.error("刪除休假失敗：", error);
        return new Response(JSON.stringify({ error: "刪除失敗" }), { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // 預設路由：首頁
    // ==========================================
    return new Response("歡迎來到預約系統 API 伺服器！", {
      headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders }
    });
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    try {
      // ==========================================
      // 任務 1：刪除「未確認(pending)」與「已取消(canceled)」的資料
      // 條件：建立時間超過 30 分鐘
      // ==========================================
      await env.reserve_db.prepare(`
        DELETE FROM Appointments 
        WHERE status IN ('pending', 'canceled') 
        AND created_at <= datetime('now', '-30 minutes')
      `).run();

      // ==========================================
      // 任務 2：刪除「已確認(confirmed)」的歷史預約資料
      // 條件：預約日期 (date) 已經過了 2 天
      // 注意：加上 '+8 hours' 是為了轉換為台灣時區，避免 Cloudflare 的 UTC 時差導致提早刪除
      // ==========================================
      await env.reserve_db.prepare(`
        DELETE FROM Appointments 
        WHERE status = 'confirmed' 
        AND date <= date('now', '+8 hours', '-2 days')
      `).run();

      console.log('✅ 定期清理任務執行完畢');
    } catch (error) {
      console.error('❌ 定期清理任務失敗：', error);
    }
  }
};