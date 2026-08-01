// ========================================================
// 💰 現金收支 API (Cash Transactions)
// ========================================================
import type { HandlerContext, CashTransactionBody } from "../types";
import { successResponse, errorResponse } from "../utils";

export async function handleGetCashTransactions(ctx: HandlerContext): Promise<Response> {
  const { env, headers, url } = ctx;
  try {
    const startDate = url.searchParams.get('start_date');
    const endDate = url.searchParams.get('end_date');
    const type = url.searchParams.get('type');
    const userId = url.searchParams.get('user_id');

    let query = `
      SELECT ct.*, Users.last_name || Users.first_name AS client_name, Users.phone AS client_phone
      FROM cash_transactions ct
      LEFT JOIN Users ON ct.user_id = Users.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (startDate) { query += " AND ct.date >= ?"; params.push(startDate); }
    if (endDate) { query += " AND ct.date <= ?"; params.push(endDate); }
    if (type) { query += " AND ct.type = ?"; params.push(type); }
    if (userId) { query += " AND ct.user_id = ?"; params.push(userId); }

    query += " ORDER BY ct.date DESC, ct.created_at DESC";

    const stmt = env.reserve_db.prepare(query);
    const { results } = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();

    return successResponse(results, undefined, 200, headers);
  } catch (error: unknown) {
    console.error("讀取現金收支失敗：", error);
    return errorResponse("讀取現金收支紀錄失敗", 500, headers);
  }
}

/** 新增現金收支紀錄 */
export async function handleCreateCashTransaction(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as CashTransactionBody;
    const { type, category, amount, payment_method, user_id, description, date } = body;

    if (!type || !['income', 'expense'].includes(type)) return errorResponse("類型必須為 income 或 expense", 400, headers);
    if (!category || !category.trim()) return errorResponse("分類為必填欄位", 400, headers);
    if (typeof amount !== 'number' || amount <= 0) return errorResponse("金額必須為大於 0 的數字", 400, headers);
    if (!date) return errorResponse("請指定交易發生日期 (YYYY-MM-DD)", 400, headers);

    const result = await env.reserve_db.prepare(
      `INSERT INTO cash_transactions (type, category, amount, payment_method, user_id, description, date)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ).bind(type, category.trim(), amount, payment_method || null, user_id || null, description || null, date).first();

    return successResponse(result, "收支紀錄建立成功", 201, headers);
  } catch (error: unknown) {
    console.error("新增現金收支失敗：", error);
    return errorResponse("新增現金收支失敗", 500, headers);
  }
}

/** 編輯現金收支紀錄 */
export async function handleUpdateCashTransaction(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = await request.json() as any;
    const { id, type, category, amount, payment_method, description, date } = body;

    if (!id) return errorResponse("缺少收支紀錄 ID", 400, headers);
    if (type && !['income', 'expense'].includes(type)) return errorResponse("類型必須為 income 或 expense", 400, headers);
    if (amount !== undefined && (typeof amount !== 'number' || amount <= 0)) return errorResponse("金額必須大於 0", 400, headers);

    await env.reserve_db.prepare(
      `UPDATE cash_transactions 
       SET type = COALESCE(?, type), 
           category = COALESCE(?, category), 
           amount = COALESCE(?, amount), 
           payment_method = COALESCE(?, payment_method), 
           description = COALESCE(?, description), 
           date = COALESCE(?, date) 
       WHERE id = ?`
    ).bind(type || null, category || null, amount || null, payment_method || null, description || null, date || null, id).run();

    return successResponse({}, "收支紀錄更新成功", 200, headers);
  } catch (error: unknown) {
    console.error("更新現金收支失敗：", error);
    return errorResponse("更新現金收支紀錄失敗", 500, headers);
  }
}

/** 🌟 刪除現金收支紀錄 (智慧連動：若為退款則加回堂數；若為預收收入則自動連動刪除未消耗包套) */
export async function handleDeleteCashTransaction(ctx: HandlerContext): Promise<Response> {
  const { env, headers, url } = ctx;
  try {
    const id = url.searchParams.get('id');
    if (!id) return errorResponse("缺少收支紀錄 ID", 400, headers);

    // 取得要刪除的收支紀錄詳情
    const ct = await env.reserve_db.prepare(
      "SELECT * FROM cash_transactions WHERE id = ?"
    ).bind(id).first() as any;

    if (!ct) return errorResponse("找不到該筆收支紀錄", 404, headers);

    const batchStatements: any[] = [];

    // 1. 檢查是否為「課程退款」支出
    const refundLog = await env.reserve_db.prepare(
      `SELECT * FROM appointment_courses WHERE cash_transaction_id = ? AND type = 'refund'`
    ).bind(id).first() as any;

    if (refundLog) {
      batchStatements.push(
        env.reserve_db.prepare(
          `UPDATE users_courses SET remaining_count = remaining_count + ? WHERE id = ?`
        ).bind(refundLog.use_count, refundLog.user_course_id)
      );
      batchStatements.push(
        env.reserve_db.prepare(`DELETE FROM appointment_courses WHERE id = ?`).bind(refundLog.id)
      );
    }

    // 2. 🌟 檢查是否為「課程包套預收」收入
    if (ct.type === 'income' && ct.category === '課程包套預收' && ct.user_id) {
      // 尋找對應金額的包套紀錄
      const pkg = await env.reserve_db.prepare(`
        SELECT uc.id, uc.amount, uc.remaining_count 
        FROM users_courses uc
        JOIN courses c ON uc.course_id = c.id
        WHERE uc.user_id = ? AND (c.price * uc.amount) = ?
        ORDER BY uc.purchase_date DESC LIMIT 1
      `).bind(ct.user_id, ct.amount).first() as any;

      if (pkg) {
        // 防呆：如果此包套已經有被消耗過堂數，禁止直接刪除收入
        if (pkg.amount !== pkg.remaining_count) {
          return errorResponse("無法刪除此筆收入：對應的會員包套已有部分堂數被預約消耗使用過！", 400, headers);
        }
        // 若完全未消耗，一併刪除該筆會員包套合約
        batchStatements.push(
          env.reserve_db.prepare("DELETE FROM users_courses WHERE id = ?").bind(pkg.id)
        );
      }
    }

    // 3. 刪除現金收支紀錄本身
    batchStatements.push(
      env.reserve_db.prepare("DELETE FROM cash_transactions WHERE id = ?").bind(id)
    );

    await env.reserve_db.batch(batchStatements);

    return successResponse({}, "收支紀錄已刪除，相關聯的會員包套或退款帳務已同步更新", 200, headers);
  } catch (error: unknown) {
    console.error("刪除現金收支失敗：", error);
    return errorResponse("刪除現金收支紀錄失敗", 500, headers);
  }
}