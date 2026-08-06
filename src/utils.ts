// ========================================================
// 共用工具函式
// ========================================================
import { APPOINTMENT_DURATION, BUSINESS_HOUR_START, BUSINESS_HOUR_END } from "./constants";

/** SHA-256 雜湊 */
export async function hashPassword(password: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/** CORS 標頭 */
export function buildCorsHeaders(requestOrigin: string): Record<string, string> {
  const allowedOrigins = [
    "https://hervive-pages.pages.dev",
    "https://hervive-admin.pages.dev",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://127.0.0.1:3001",
    "http://localhost:3001",
    "http://localhost:5173"
  ];
  const validOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": validOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
  };
}

/** 統一成功回應（強制格式：{ success: true, data, message? }） */
export function successResponse<T>(data: T, message?: string, status = 200, headers: Record<string, string> = {}) {
  const payload: any = { success: true, data };
  if (message) payload.message = message;
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

/** 統一錯誤回應（保留 error 欄位以向後相容，新增 success: false） */
export function errorResponse(message: string, status = 400, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

/** 判斷營業時間 */
export function isBusinessHour(): boolean {
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
export function calculateEndTime(startTime: string): string {
  const [h, m] = startTime.split(':').map(Number);
  const endTotal = h * 60 + m + APPOINTMENT_DURATION;
  const endH = Math.floor(endTotal / 60);
  const endM = endTotal % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

/** 驗證 LINE Webhook Signature（使用 Web Crypto API） */
export async function verifyLineSignature(rawBody: string, signatureHeader: string | null, secret: string): Promise<boolean> {
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
  const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));

  return sigBase64 === signatureHeader;
}

/** 計算年齡（基於台灣時區） */
export function calculateAge(dateOfBirth: string | null): number | null {
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
