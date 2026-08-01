// ========================================================
// LINE Webhook（訊息接收、預約碼驗證、自動回覆）
// ========================================================
import type { Env, HandlerContext, LineWebhookBody, AppointmentRow } from "../types";
import { AppointmentStatus } from "../types";
import { verifyLineSignature, isBusinessHour } from "../utils";
import { getUserByLineId } from "../db";
import { AUTO_REPLY_INTERVAL } from "../constants";

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
      "SELECT id, user_id, status, date, start_time FROM Appointments WHERE appointment_code = ?"
    ).bind(code).first() as (AppointmentRow & { date: string, start_time: string }) | null;

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

      // ✅ 修改回覆訊息：加入預約日期與時間
      replyText = `✅ 預約驗證成功！\n\n您的預約編號 ${code} 已確認。\n📅 預約日期：${appt.date}\n⏰ 預約時間：${appt.start_time}\n\n期待您的光臨！`;
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

export async function handleLineWebhook(ctx: HandlerContext): Promise<Response> {
  const { request, env } = ctx;

  // 1. Signature 驗證（可開關）
  const enableVerify = env.ENABLE_SIGNATURE_VERIFY !== 'false'; // 預設啟用
  if (enableVerify) {
    const signature = request.headers.get('X-Line-Signature');
    if (!signature) return new Response('Unauthorized', { status: 401 });
    const rawBody = await request.text();

    // 👇 這裡改用 LINE_MESSAGING_CHANNEL_SECRET
    const isValid = await verifyLineSignature(rawBody, signature, env.LINE_MESSAGING_CHANNEL_SECRET);

    if (!isValid) return new Response('Invalid Signature', { status: 401 });
    const body = JSON.parse(rawBody) as LineWebhookBody;
    return processWebhookEvents(body, env);
  } else {
    // 未啟用驗證，直接解析
    const body = (await request.json()) as LineWebhookBody;
    return processWebhookEvents(body, env);
  }
}
