import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";

export interface Env {
  reserve_db: D1Database;
  LINE_ACCESS_TOKEN: string;  
  LINE_CHANNEL_ID: string;  
  LINE_CHANNEL_SECRET: string;  
}

// SHA-256 雜湊密碼的函式[cite: 1]
async function hashPassword(password: string) {
  const msgBuffer = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestOrigin = request.headers.get("Origin") || "";

    const allowedOrigins = [
      "https://hervive-pages.pages.dev",
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      "http://localhost:5173"
    ];

    const validOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
    const safePath = url.pathname.replace(/\/+/g, '/');
    const corsHeaders = {
      "Access-Control-Allow-Origin": validOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ==========================================
    // 路由 1：會員註冊 API (POST /api/users)[cite: 1]
    // ==========================================
    if (request.method === 'POST' && safePath === '/api/users') {
      try {
        const body = await request.json() as any;
        const { last_name, first_name, phone, password, gender, email, notes, line_id } = body;

        // 🌟 本系統只開放透過 LINE 綁定的方式註冊，line_id 一定要有值
        if (!last_name || !first_name || !phone || !password || !gender || !line_id) {
          return new Response(JSON.stringify({ error: "姓、名、電話、密碼、性別與 LINE 綁定皆為必填！請先完成 LINE 驗證再註冊。" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const passwordRegex = /^(?=.*[a-zA-Z])(?=.*\d).+$/;
        if (!passwordRegex.test(password)) {
          return new Response(JSON.stringify({ error: "密碼必須包含至少一個英文字母與數字！" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        // 🌟 綁定防呆：這個 line_id 是否已經有帳號了？有的話代表是老客戶，不該重複建立帳號，直接請他登入
        const existingLineUser = await env.reserve_db.prepare(
          "SELECT id FROM Users WHERE line_id = ?"
        ).bind(line_id).first();

        if (existingLineUser) {
          return new Response(JSON.stringify({
            error: "您的 LINE 帳號已經是會員囉，請直接使用 LINE 登入！",
            action: "require_login"
          }), {
            status: 409,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const existingUser = await env.reserve_db.prepare(
          "SELECT id FROM Users WHERE phone = ?"
        ).bind(phone).first();

        if (existingUser) {
          return new Response(JSON.stringify({ error: "此手機號碼已經註冊過會員了，請直接登入！" }), {
            status: 409,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const hashedPassword = await hashPassword(password);

        const result = await env.reserve_db.prepare(
          "INSERT INTO Users (last_name, first_name, phone, password_hash, gender, email, notes, line_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
        )
        .bind(last_name, first_name, phone, hashedPassword, gender, email || null, notes || null, line_id)
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
    // 路由：修改會員資料 API (PUT /api/users)[cite: 1]
    // ==========================================
    if (request.method === 'PUT' && safePath === '/api/users') {
      try {
        const body = await request.json() as any;
        const { id, last_name, first_name, gender, email, password } = body;

        if (!id) {
          return new Response(JSON.stringify({ error: "缺少會員 ID" }), { status: 400, headers: corsHeaders });
        }

        if (password) {
          const hashedPassword = await hashPassword(password);
          await env.reserve_db.prepare(
            "UPDATE Users SET last_name = ?, first_name = ?, gender = ?, email = ?, password_hash = ? WHERE id = ?"
          )
          .bind(last_name, first_name, gender, email || null, hashedPassword, id)
          .run();
        } else {
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
    // 路由 2：取得所有客戶名單 (GET /api/users)[cite: 1]
    // ==========================================
    if (request.method === 'GET' && safePath === '/api/users') {
      try {
        const { results } = await env.reserve_db.prepare(`
          SELECT id, last_name, first_name, phone, gender, email, notes, created_at
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
    // 路由 3：新增預約 (POST /api/appointments)[cite: 1]
    // ==========================================
    if (request.method === 'POST' && safePath === '/api/appointments') {
      try {
        const body = await request.json() as any;
        const { user_id, date, start_time } = body;

        if (!user_id || !date || !start_time) {
          return new Response(JSON.stringify({ error: "缺少必要的預約資訊" }), { 
            status: 400, 
            headers: { "Content-Type": "application/json", ...corsHeaders } 
          });
        }

        const [hours, minutes] = start_time.split(':').map(Number);
        const startTotalMinutes = hours * 60 + minutes;
        const endTotalMinutes = startTotalMinutes + 150; 
        
        const endHours = Math.floor(endTotalMinutes / 60);
        const endMinutes = endTotalMinutes % 60;
        const end_time = `${String(endHours).padStart(2, '0')}:${String(endMinutes).padStart(2, '0')}`;

        const reqDateObj = new Date(date);
        const dayOfWeek = reqDateObj.getDay();

        const holidayCheck = await env.reserve_db.prepare(`
          SELECT * FROM ShopHolidays 
          WHERE 
            (type = 'full_day' AND date = ?)
            OR 
            (type = 'weekly' AND day_of_week = ?)
            OR
            (type = 'time_range' AND date = ? AND (
               (start_time <= ? AND end_time > ?) OR
               (start_time < ? AND end_time >= ?) OR
               (start_time >= ? AND end_time <= ?)
            ))
        `).bind(
          date, dayOfWeek, date, start_time, start_time, end_time, end_time, start_time, end_time
        ).first();

        if (holidayCheck) {
          return new Response(JSON.stringify({ 
            error: "抱歉！您選擇的時間為店家公休日或休息時段，請重新選擇。" 
          }), { 
            status: 409, 
            headers: { "Content-Type": "application/json", ...corsHeaders } 
          });
        }
        
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

        // 🌟 產生預約編號，若不巧撞號（UNIQUE 衝突）就重新產生再試一次
        const maxRetries = 5;
        let appointment_code = "";
        let result: any = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          const randomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
          appointment_code = `RV-${randomCode}`;

          try {
            result = await env.reserve_db.prepare(
              "INSERT INTO Appointments (user_id, date, start_time, end_time, appointment_code) VALUES (?, ?, ?, ?, ?) RETURNING id"
            ).bind(user_id, date, start_time, end_time, appointment_code).first();
            break; // ✅ 成功寫入，跳出重試迴圈
          } catch (err: any) {
            const isUniqueConflict = typeof err?.message === 'string' && err.message.includes('UNIQUE');
            // 若不是撞號問題，或已經是最後一次重試，直接把錯誤丟出去給外層 catch 處理
            if (!isUniqueConflict || attempt === maxRetries - 1) {
              throw err;
            }
            // 是撞號問題且還有重試次數 → 換一組新的 appointment_code 再試一次
          }
        }

        return new Response(JSON.stringify({ 
          success: true, 
          message: "預約成功！",
          appointment: { 
            id: result?.id, 
            date, 
            start_time, 
            end_time,
            appointment_code 
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
    // 路由 4：取得預約紀錄 (GET /api/appointments)[cite: 1]
    // ==========================================
    if (request.method === 'GET' && safePath === '/api/appointments') {
      try {
        const userId = url.searchParams.get('user_id');
        const date = url.searchParams.get('date');

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
    // 路由 5：會員登入 API (POST /api/login)[cite: 1]
    // ==========================================
    if (request.method === 'POST' && safePath === '/api/login') {
      try {
        const body = await request.json() as any;
        const { phone, password } = body;

        if (!phone || !password) {
          return new Response(JSON.stringify({ error: "手機號碼與密碼為必填！" }), {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const user = await env.reserve_db.prepare(
          "SELECT id, last_name, first_name, gender, email, password_hash FROM Users WHERE phone = ?"
        )
        .bind(phone)
        .first();

        if (!user) {
          return new Response(JSON.stringify({ error: "手機號碼或密碼錯誤！" }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const hashedPassword = await hashPassword(password);

        if (hashedPassword !== user.password_hash) {
          return new Response(JSON.stringify({ error: "手機號碼或密碼錯誤！" }), {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

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
    // 路由 6：LINE 登入與驗證 (POST /api/line-login)[cite: 1]
    // ==========================================
    if (request.method === 'POST' && safePath === '/api/line-login') {
      try {
        const body = await request.json() as any;
        const { code, redirectUri } = body;

        if (!code) {
          return new Response(JSON.stringify({ error: "缺少授權碼" }), { status: 400, headers: corsHeaders });
        }

        const LINE_CHANNEL_ID = env.LINE_CHANNEL_ID; 
        const LINE_CHANNEL_SECRET = env.LINE_CHANNEL_SECRET;

        const tokenResponse = await fetch('https://api.line.me/oauth2/v2.1/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: redirectUri,
            client_id: LINE_CHANNEL_ID,
            client_secret: LINE_CHANNEL_SECRET
          }).toString()
        });

        const tokenData = await tokenResponse.json() as any;
        if (!tokenData.access_token) throw new Error("無法取得 LINE Token");

        const profileResponse = await fetch('https://api.line.me/v2/profile', {
          headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
        });
        const profileData = await profileResponse.json() as any;
        const lineId = profileData.userId;

        if (!lineId) throw new Error("無法取得 LINE 帳號資訊");

        const existingUser = await env.reserve_db.prepare(
          "SELECT id, last_name, first_name, gender, email FROM Users WHERE line_id = ?"
        ).bind(lineId).first();

        if (existingUser) {
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
        
        if (status !== undefined) {
          await env.reserve_db.prepare(
            "UPDATE Appointments SET status = ? WHERE id = ?"
          ).bind(status, id).run();
        }

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
    // 路由 7：LINE Webhook (預約驗證與智慧自動回覆)[cite: 1]
    // ==========================================
    if (request.method === 'POST' && safePath === '/api/line-webhook') {
      try {
        const body = await request.json() as any;
        
        if (!body.events || body.events.length === 0) {
          return new Response("OK", { status: 200 });
        }

        const LINE_ACCESS_TOKEN = env.LINE_ACCESS_TOKEN;

        for (const event of body.events) {
          if (event.type === 'message' && event.message.type === 'text') {
            const replyToken = event.replyToken;
            const userLineId = event.source.userId; // 訊息來源 LINE ID
            const text = event.message.text.trim().toUpperCase();

            // 檢查是否符合預約編號格式 (例如：RV-A8X9K2)
            const codeMatch = text.match(/^RV-[A-Z0-9]{6}$/);

            if (codeMatch) {
              const code = codeMatch[0];
              let replyText = "";

              // 🌟 1. 先用 line_id 找 Users 確定發讯者身分
              const currentUser = await env.reserve_db.prepare(
                "SELECT id FROM Users WHERE line_id = ?"
              ).bind(userLineId).first() as { id: number } | null;

              if (!currentUser) {
                replyText = `❌ 驗證失敗：您的 LINE 尚未綁定網站會員帳號。\n請先至網站註冊或登入後進行 LINE 綁定，才能驗證預約！`;
              } else {
                // 🌟 2. 去資料庫找這個預約編號
                const appt = await env.reserve_db.prepare(
                  "SELECT id, user_id, status FROM Appointments WHERE appointment_code = ?"
                ).bind(code).first() as { id: number; user_id: number; status: string } | null;

                if (!appt) {
                  replyText = `❌ 找不到此預約編號，或該預約已超過 30 分鐘自動失效。\n請重新至網站預約。`;
                } else if (appt.user_id !== currentUser.id) {
                  // 🌟 3. 嚴格檢查：只要不符合 user_id 則代表非本人，拒絕驗證別人的預約！
                  replyText = `❌ 驗證失敗：此預約編號不屬於您的帳號。\n您只能驗證您自己透過網站所建立的預約！`;
                } else if (appt.status === 'confirmed') {
                  replyText = `⚠️ 您的預約編號 ${code} 已經是確認狀態囉，請勿重複驗證！`;
                } else if (appt.status === 'pending') {
                  // 符合本人且為 pending，更新狀態為 confirmed
                  await env.reserve_db.prepare(
                    "UPDATE Appointments SET status = 'confirmed' WHERE id = ?"
                  ).bind(appt.id).run();

                  replyText = `✅ 預約驗證成功！\n\n您的預約編號 ${code} 已確認。\n期待您的光臨！`;
                } else {
                  replyText = `❌ 此預約已被取消或狀態異常。`;
                }
              }

              // 回傳預約驗證結果給 LINE 使用者
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

            } else {
              // ==========================
              // 自動回覆邏輯 (獨立處理，不強制綁定 User)[cite: 1]
              // ==========================

              // 1. 檢查這個 line_id 上一次自動回覆的時間
              const autoReplyRecord = await env.reserve_db.prepare(
                "SELECT last_auto_reply_at FROM LineAutoReplies WHERE line_id = ?"
              ).bind(userLineId).first() as { last_auto_reply_at: string } | null;

              let shouldReply = true;
              if (autoReplyRecord && autoReplyRecord.last_auto_reply_at) {
                // 計算與上次回覆的時間差 (分鐘)
                const lastTime = new Date(autoReplyRecord.last_auto_reply_at.replace(' ', 'T') + '+08:00').getTime();
                const nowTime = new Date().getTime();
                const diffMinutes = (nowTime - lastTime) / (1000 * 60);

                // 🌟 30 分鐘內只回覆一次
                if (diffMinutes < 30) {
                  shouldReply = false;
                }
              }

              if (shouldReply) {
                // 取得台灣時間的小時
                const now = new Date();
                const taipeiHour = Number(
                  new Intl.DateTimeFormat("en-US", {
                    timeZone: "Asia/Taipei",
                    hour: "numeric",
                    hour12: false
                  }).format(now)
                );
                
                // 🌟 10:00～20:00 為上班時間
                const isBusinessHour = taipeiHour >= 10 && taipeiHour < 20;

                const autoReplyText = isBusinessHour
                  ? `感謝您的訊息！\n我們會儘快回覆您\n請耐心稍等噢☺️`
                  : `我們已收到您的訊息！\n目前非上班時間\n我們會在上班後盡快回覆!\n請耐心等候❤️`;

                // 發送自動回覆
                await fetch('https://api.line.me/v2/bot/message/reply', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
                  },
                  body: JSON.stringify({
                    replyToken,
                    messages: [{ type: 'text', text: autoReplyText }]
                  })
                });

                // 🌟 成功回覆後更新/插入 last_auto_reply_at 記錄（不需寫入 Users 表）
                await env.reserve_db.prepare(`
                  INSERT INTO LineAutoReplies (line_id, last_auto_reply_at)
                  VALUES (?, datetime('now', '+8 hours'))
                  ON CONFLICT(line_id) DO UPDATE SET last_auto_reply_at = datetime('now', '+8 hours')
                `).bind(userLineId).run();
              }
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
    // 路由 8：新增休假設定 (POST /api/holidays)[cite: 1]
    // ==========================================
    if (request.method === 'POST' && safePath === '/api/holidays') {
      try {
        const body = await request.json() as any;
        const { type, date, start_time, end_time, day_of_week, reason } = body;

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
    // 路由 9：取得所有休假設定 (GET /api/holidays)[cite: 1]
    // ==========================================
    if (request.method === 'GET' && safePath === '/api/holidays') {
      try {
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
    // 路由 10：刪除指定的休假設定 (DELETE /api/holidays)[cite: 1]
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

    return new Response("歡迎來到預約系統 API 伺服器！", {
      headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders }
    });
  },
  
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    try {
      await env.reserve_db.prepare(`
        DELETE FROM Appointments 
        WHERE status IN ('pending', 'cancelled') 
        AND created_at <= datetime('now','+8 hours','-30 minutes')
      `).run();

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