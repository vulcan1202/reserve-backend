// ========================================================
// 型別與 Env 定義
// ========================================================
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";

export interface Env {
  reserve_db: D1Database;

  // --- Messaging API (機器人傳訊息與 Webhook) ---
  LINE_ACCESS_TOKEN: string;
  LINE_MESSAGING_CHANNEL_SECRET: string;

  // --- LINE Login (網站登入用) ---
  LINE_LOGIN_CHANNEL_ID: string;
  LINE_LOGIN_CHANNEL_SECRET: string;

  ENABLE_SIGNATURE_VERIFY?: string;

  // --- Google Calendar API (服務帳號與日曆 ID) ---
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_PRIVATE_KEY?: string;
  GOOGLE_CALENDAR_ID?: string;
  DEFAULT_GOOGLE_CALENDAR_ID?: string;
  CALENDAR_CONFIG?: string;
}

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
export interface RegisterBody {
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

export interface LiffLoginBody { line_id: string; }
export interface UpdateUserBody { id: number; last_name: string; first_name: string; gender: string; date_of_birth: string; location?: string; email?: string; password?: string; }
export interface AppointmentCreateBody { user_id: number; date: string; start_time: string; beautician_id?: number; }
export interface AppointmentPatchBody { id: number; status?: AppointmentStatus | string; notes?: string; user_id?: number; user_notes?: string; beautician_id?: number | null; }
export interface LoginBody { phone: string; password: string; }
export interface LineLoginBody { code: string; redirectUri: string; }
export interface BeauticianCreateBody { name: string; }
export interface BeauticianUpdateBody { id: number; name: string; }
export interface HolidayCreateBody { type: HolidayType | string; date?: string; start_time?: string; end_time?: string; day_of_week?: number; reason?: string; }

// ---------- LINE API 回應型別 ----------
export interface LineTokenResponse { access_token: string; }
export interface LineProfileResponse { userId: string; }
export interface LineWebhookBody { events: LineWebhookEvent[]; }
export interface LineWebhookEvent { type: string; replyToken: string; source: { userId: string; type: string }; message?: { type: string; text: string }; }

// ---------- 資料庫行型別 ----------
export interface UserRow { id: number; last_name: string; first_name: string; gender: string; date_of_birth: string; location: string | null; email: string | null; password_hash: string; }
export interface AppointmentRow { id: number; user_id: number; status: string; }

// ---------- 統一 Handler Context ----------
export interface HandlerContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  headers: Record<string, string>;
}

export interface QuestionnaireBody {
  user_id: number;
  how_to_know?: 'instagram' | 'friend' | 'search' | 'other';
  history_of_treatments?: string;
  allergies?: string;
  medical_history?: string;
  skin_type?: string;
  concerns?: string;
  Habit?: string;
  notes?: string;
  agreed_to_terms?: boolean;
}

export interface CashTransactionBody {
  type: 'income' | 'expense';
  category: string;
  amount: number;
  payment_method?: string;
  user_id?: number | null;
  description?: string;
  date: string; // YYYY-MM-DD
}

export interface ProductBody {
  id?: number;
  name: string;
  cost_price: number;
  selling_price: number;
  stock_quantity?: number;
}

export interface InventoryTransactionBody {
  product_id: number;
  type: 'purchase' | 'sale' | 'usage' | 'adjustment';
  quantity: number;
  unit_price: number;
  user_id?: number | null;
  description?: string;
  date: string; // YYYY-MM-DD
}

export interface CourseBody {
  id?: number;
  name: string;
  description?: string;
  price: number;
}

export interface UserCourseCreateBody {
  user_id: number;
  course_id: number;
  amount: number;
  remaining_count?: number;
}

export interface UserCourseUpdateBody {
  id: number;
  amount?: number;
  remaining_count?: number;
}

export interface RevenueRecognitionBody {
  source_type: 'course_usage' | 'product_sale';
  amount: number;
  user_id: number;
  appointment_id?: number | null;
  user_course_id?: number | null;
  description?: string;
  date: string; // YYYY-MM-DD
}

// 🌟 既有包套扣堂項型別
export interface ExistingCourseUsageItem {
  user_course_id: number;
  use_count: number;
}

// 🌟 當下購買即使用項型別 (當客戶無課程或現場加購時)
export interface NewCoursePurchaseItem {
  course_id: number;
  buy_amount: number;       // 購買總堂數 (例如單次買 1 堂，或買包套 10 堂)
  use_count: number;        // 本次當下要消耗使用的堂數 (通常為 1)
  payment_method?: string;  // 支付方式 (Cash, Line Pay, etc.)
}

export interface CompleteAppointmentBody {
  appointment_id: number;
  courses_used?: ExistingCourseUsageItem[];     // 1. 既有包套扣堂
  new_courses_bought?: NewCoursePurchaseItem[]; // 2. 現場當下購買即使用
  date?: string;                                // 認列營收與現金交易日期 YYYY-MM-DD (選填，預設採預約原日期)
}