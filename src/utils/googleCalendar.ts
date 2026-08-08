// ========================================================
// Google Calendar API 同步服務 (utils/googleCalendar.ts)
// ========================================================
import type { Env } from "../types";

export interface GoogleCalendarEventInput {
  clientName: string;          // 客戶姓名 (例如: 王小明)
  date: string;                // YYYY-MM-DD
  startTime: string;           // HH:mm 或 ISO 8601 時間
  endTime: string;             // HH:mm 或 ISO 8601 時間
}

/**
 * 將 Base64 字串轉為 Base64URL 格式
 */
function base64UrlEncode(data: Uint8Array | string): string {
  let base64: string;
  if (typeof data === 'string') {
    base64 = btoa(unescape(encodeURIComponent(data)));
  } else {
    let binary = '';
    data.forEach((byte) => (binary += String.fromCharCode(byte)));
    base64 = btoa(binary);
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 將 PEM 格式的私鑰字串轉換為 ArrayBuffer (PKCS#8 格式)
 */
function pemToBinary(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/^["']|["']$/g, '')
    .replace(/----+BEGIN PRIVATE KEY----+/g, '')
    .replace(/----+END PRIVATE KEY----+/g, '')
    .replace(/\\n/g, '')
    .replace(/\\r/g, '')
    .replace(/\s+/g, '');
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * 使用 Web Crypto API 產生 Google Service Account Access Token
 */
export async function getGoogleAccessToken(env: Env): Promise<string> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
    throw new Error("缺少 Google Service Account 環境變數設定");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedJwt = `${encodedHeader}.${encodedPayload}`;

  const keyBuffer = pemToBinary(env.GOOGLE_PRIVATE_KEY);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(unsignedJwt)
  );

  const jwt = `${unsignedJwt}.${base64UrlEncode(new Uint8Array(signature))}`;

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!tokenData.access_token) {
    throw new Error(
      `Google OAuth 認證失敗: ${tokenData.error_description || tokenData.error}`
    );
  }

  return tokenData.access_token;
}

/**
 * 取得設定的所有 Google Calendar ID 列表 (支援 JSON 陣列、JSON 物件與單一變數)
 */
export function getAllCalendarIds(env: Env): string[] {
  const ids: string[] = [];

  if (env.GOOGLE_CALENDAR_ID) ids.push(env.GOOGLE_CALENDAR_ID);
  if (env.DEFAULT_GOOGLE_CALENDAR_ID && !ids.includes(env.DEFAULT_GOOGLE_CALENDAR_ID)) {
    ids.push(env.DEFAULT_GOOGLE_CALENDAR_ID);
  }

  if (env.CALENDAR_CONFIG) {
    try {
      const raw = env.CALENDAR_CONFIG.trim();
      if (raw.startsWith('[') || raw.startsWith('{')) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          parsed.forEach((val) => {
            if (typeof val === 'string' && val.trim() && !ids.includes(val.trim())) {
              ids.push(val.trim());
            }
          });
        } else if (typeof parsed === 'object' && parsed !== null) {
          Object.values(parsed).forEach((val) => {
            if (typeof val === 'string' && val.trim() && !ids.includes(val.trim())) {
              ids.push(val.trim());
            }
          });
        }
      } else {
        raw.split(',').forEach((val) => {
          if (val.trim() && !ids.includes(val.trim())) {
            ids.push(val.trim());
          }
        });
      }
    } catch (e) {
      console.error("解析 CALENDAR_CONFIG 失敗:", e);
    }
  }

  if (ids.length === 0) {
    throw new Error("無法取得任何 Google Calendar ID，請確認環境變數中已設定日曆 ID");
  }

  return ids;
}

/**
 * 格式化時間為 HH:mm 格式 (Asia/Taipei 時區)
 */
function formatHHmm(timeStr: string, dateStr?: string): string {
  if (/^\d{2}:\d{2}$/.test(timeStr)) {
    return timeStr;
  }
  let fullDateStr = timeStr;
  if (dateStr && !timeStr.includes('T')) {
    fullDateStr = `${dateStr}T${timeStr}:00+08:00`;
  }
  const dateObj = new Date(fullDateStr);
  if (isNaN(dateObj.getTime())) {
    return timeStr.substring(0, 5);
  }
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(dateObj);
}

/**
 * 格式化起訖時間為完整 ISO 8601 (帶 Asia/Taipei 時區位移)
 */
function toIsoWithTimezone(dateStr: string, timeStr: string): string {
  if (timeStr.includes('T') || timeStr.includes('+')) {
    return timeStr;
  }
  let cleanTime = timeStr.trim();
  if (/^\d{1,2}:\d{2}$/.test(cleanTime)) {
    cleanTime = `${cleanTime}:00`;
  }
  if (/^\d:\d{2}:\d{2}$/.test(cleanTime)) {
    cleanTime = `0${cleanTime}`;
  }
  return `${dateStr}T${cleanTime}+08:00`;
}

/**
 * 建立 Google 日曆事件 (同步傳送至所有設定的 Google 日曆)
 */
export async function syncAppointmentToGoogleCalendar(
  env: Env,
  input: GoogleCalendarEventInput
): Promise<any[]> {
  const calendarIds = getAllCalendarIds(env);
  const accessToken = await getGoogleAccessToken(env);

  const hhmm = formatHHmm(input.startTime, input.date);
  const summary = `${hhmm}${input.clientName}`;

  const startIso = toIsoWithTimezone(input.date, input.startTime);
  const endIso = toIsoWithTimezone(input.date, input.endTime);

  const eventBody = {
    summary: summary,
    description: "", // 保持空白
    start: {
      dateTime: startIso,
      timeZone: "Asia/Taipei",
    },
    end: {
      dateTime: endIso,
      timeZone: "Asia/Taipei",
    },
  };

  const results: any[] = [];

  for (const calendarId of calendarIds) {
    const calendarUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

    const response = await fetch(calendarUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`寫入 Google 日曆 [${calendarId}] 失敗 [${response.status}]: ${errorText}`);
    } else {
      const resJson = await response.json();
      results.push(resJson);
    }
  }

  if (results.length === 0) {
    throw new Error("無法將預約寫入任何設定的 Google 日曆，請檢查日曆權限");
  }

  return results;
}

export interface DeleteCalendarEventInput {
  clientName: string;          // 客戶姓名 (例如: 王小明)
  date: string;                // YYYY-MM-DD
  startTime: string;           // HH:mm 或 ISO 8601 時間
  endTime: string;             // HH:mm 或 ISO 8601 時間
  eventId?: string | null;     // 若有保留 Google Event ID
}

/**
 * 刪除 Google 日曆事件 (全天範圍搜尋 + JS 精準匹配刪除)
 */
export async function deleteGoogleCalendarEvent(
  env: Env,
  input: DeleteCalendarEventInput
): Promise<boolean> {
  const calendarIds = getAllCalendarIds(env);
  const accessToken = await getGoogleAccessToken(env);
  let deletedAny = false;

  const hhmm = formatHHmm(input.startTime, input.date);
  const summaryTarget = `${hhmm}${input.clientName}`;

  // 設定搜尋時間區間為當天全天 (00:00:00 ~ 23:59:59)
  const dayStart = `${input.date}T00:00:00+08:00`;
  const dayEnd = `${input.date}T23:59:59+08:00`;

  for (const calendarId of calendarIds) {
    const matchingEventIds: string[] = [];

    if (input.eventId) {
      matchingEventIds.push(input.eventId);
    } else {
      const listUrl = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
      listUrl.searchParams.set('timeMin', dayStart);
      listUrl.searchParams.set('timeMax', dayEnd);
      listUrl.searchParams.set('singleEvents', 'true');

      const listRes = await fetch(listUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (listRes.ok) {
        const listData = (await listRes.json()) as { 
          items?: Array<{ 
            id: string; 
            summary?: string; 
            start?: { dateTime?: string; date?: string };
          }> 
        };
        if (listData.items && listData.items.length > 0) {
          listData.items.forEach((item) => {
            if (!item.summary) return;

            // 🌟 1. 比對事件標題是否精準包含「時間+客戶姓名」(例如: 17:00王小明)
            const hasSummaryTarget = item.summary.includes(summaryTarget);

            // 🌟 2. 若僅比對客戶姓名，必須同時驗證「事件開始時間」是否一致
            const eventStartTimeStr = item.start?.dateTime || '';
            const isTimeMatch = eventStartTimeStr.includes(hhmm) || eventStartTimeStr.includes(input.startTime);
            const hasNameAndTimeMatch = item.summary.includes(input.clientName) && isTimeMatch;

            if (hasSummaryTarget || hasNameAndTimeMatch) {
              matchingEventIds.push(item.id);
            }
          });
        }
      }
    }

    for (const targetEventId of matchingEventIds) {
      const deleteUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(targetEventId)}`;

      const response = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (response.ok || response.status === 204) {
        deletedAny = true;
        console.log(`成功從日曆 ${calendarId} 刪除事件 ${targetEventId}`);
      }
    }
  }

  return deletedAny;
}
