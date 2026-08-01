// ========================================================
// 資料庫輔助查詢（共用的簡單查詢邏輯，供多個 handler 使用）
// ========================================================
import type { Env, UserRow } from "./types";

export async function getUserByLineId(env: Env, lineId: string): Promise<UserRow | null> {
  return env.reserve_db.prepare(
    `SELECT id, last_name, first_name, gender, date_of_birth, location, email, password_hash
     FROM Users WHERE line_id = ?`
  ).bind(lineId).first() as Promise<UserRow | null>;
}

export async function getUserByPhone(env: Env, phone: string): Promise<UserRow | null> {
  return env.reserve_db.prepare(
    `SELECT id, last_name, first_name, gender, date_of_birth, location, email, password_hash
     FROM Users WHERE phone = ?`
  ).bind(phone).first() as Promise<UserRow | null>;
}

/** 取得會員問卷（依 user_id） */
export async function getQuestionnaireByUserId(env: Env, userId: number): Promise<any | null> {
  return env.reserve_db.prepare(
    `SELECT * FROM client_questionnaires WHERE user_id = ?`
  ).bind(userId).first();
}

/** 檢查問卷是否存在（依 user_id） */
export async function questionnaireExists(env: Env, userId: number): Promise<boolean> {
  const result = await env.reserve_db.prepare(
    `SELECT id FROM client_questionnaires WHERE user_id = ?`
  ).bind(userId).first();
  return !!result;
}

/** 依 ID 查詢會員（用於驗證 user_id 是否存在） */
export async function getUserById(env: Env, userId: number): Promise<any | null> {
  return env.reserve_db.prepare(
    `SELECT id, last_name, first_name FROM Users WHERE id = ?`
  ).bind(userId).first();
}
