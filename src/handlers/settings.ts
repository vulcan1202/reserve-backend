// ========================================================
// ⚙️ 系統設定 API (System Settings)
// ========================================================
import type { HandlerContext } from "../types";
import { successResponse, errorResponse } from "../utils";

export async function handleGetSettings(ctx: HandlerContext): Promise<Response> {
  const { env, headers } = ctx;
  try {
    await env.reserve_db.prepare(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT (datetime('now', '+8 hours'))
      );
    `).run();

    const { results } = await env.reserve_db.prepare("SELECT key, value FROM system_settings").all() as { results: Array<{ key: string; value: string }> };
    
    const settingsMap: Record<string, string> = {
      booking_advance_days: "60",
      booking_enabled: "1"
    };

    if (results && results.length > 0) {
      for (const row of results) {
        settingsMap[row.key] = row.value;
      }
    }

    return successResponse({
      booking_advance_days: Number(settingsMap.booking_advance_days || 60),
      booking_enabled: settingsMap.booking_enabled === "1" || settingsMap.booking_enabled === "true"
    }, undefined, 200, headers);
  } catch (error: unknown) {
    console.error("讀取系統設定失敗：", error);
    return errorResponse("讀取系統設定失敗", 500, headers);
  }
}

export async function handleUpdateSettings(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as any;
    const { booking_advance_days, booking_enabled } = body;

    await env.reserve_db.prepare(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT (datetime('now', '+8 hours'))
      );
    `).run();

    const statements: any[] = [];

    if (typeof booking_advance_days === 'number' && booking_advance_days >= 1) {
      statements.push(
        env.reserve_db.prepare(`
          INSERT INTO system_settings (key, value, updated_at)
          VALUES ('booking_advance_days', ?, datetime('now', '+8 hours'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).bind(String(booking_advance_days))
      );
    }

    if (typeof booking_enabled === 'boolean') {
      statements.push(
        env.reserve_db.prepare(`
          INSERT INTO system_settings (key, value, updated_at)
          VALUES ('booking_enabled', ?, datetime('now', '+8 hours'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).bind(booking_enabled ? "1" : "0")
      );
    }

    if (statements.length > 0) {
      await env.reserve_db.batch(statements);
    }

    return successResponse({}, "系統設定已更新", 200, headers);
  } catch (error: unknown) {
    console.error("更新系統設定失敗：", error);
    return errorResponse("更新系統設定失敗", 500, headers);
  }
}
