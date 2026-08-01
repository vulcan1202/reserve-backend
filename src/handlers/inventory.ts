// ========================================================
// 📦 進銷存 API (Inventory Transactions)
// ========================================================
import type { HandlerContext, InventoryTransactionBody } from "../types";
import { successResponse, errorResponse } from "../utils";

/** 建立庫存異動 (進貨/銷售/耗用/調整) 並同步自動更新產品庫存 */
export async function handleCreateInventoryTransaction(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as InventoryTransactionBody;
    const { product_id, type, quantity, unit_price, user_id, description, date } = body;

    if (!product_id) return errorResponse("缺少產品 ID", 400, headers);
    if (!type || !['purchase', 'sale', 'usage', 'adjustment'].includes(type)) {
      return errorResponse("無效的異動類型，必須是 purchase, sale, usage 或 adjustment", 400, headers);
    }
    if (typeof quantity !== 'number' || quantity === 0) return errorResponse("變動數量不可以為 0", 400, headers);
    if (!date) return errorResponse("請指定發生日期", 400, headers);

    // 檢查產品是否存在
    const product = await env.reserve_db.prepare("SELECT * FROM products WHERE id = ?").bind(product_id).first();
    if (!product) return errorResponse("找不到對應的產品", 404, headers);

    const total_amount = Math.abs(quantity * unit_price);

    // 計算庫存變動方向 (+ 或 -)
    let stockChange = 0;
    if (type === 'purchase') stockChange = Math.abs(quantity); // 進貨庫存增加
    else if (type === 'sale' || type === 'usage') stockChange = -Math.abs(quantity); // 銷售與耗用庫存減少
    else if (type === 'adjustment') stockChange = quantity; // 調整依據帶入的正負值

    // 寫入異動與更新庫存 (採用 D1 Batch 批次確保交易一致性)
    await env.reserve_db.batch([
      env.reserve_db.prepare(
        `INSERT INTO inventory_transactions (product_id, type, quantity, unit_price, total_amount, user_id, description, date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(product_id, type, quantity, unit_price, total_amount, user_id || null, description || null, date),

      env.reserve_db.prepare(
        `UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?`
      ).bind(stockChange, product_id)
    ]);

    return successResponse({}, "庫存異動已登記且產品庫存已自動更新", 201, headers);
  } catch (error: unknown) {
    console.error("庫存異動失敗：", error);
    return errorResponse("登記庫存異動失敗", 500, headers);
  }
}

/** 取得庫存異動歷史紀錄 */
export async function handleGetInventoryTransactions(ctx: HandlerContext): Promise<Response> {
  const { env, headers, url } = ctx;
  try {
    const productId = url.searchParams.get('product_id');
    const startDate = url.searchParams.get('start_date');
    const endDate = url.searchParams.get('end_date');

    let query = `
      SELECT it.*, products.name AS product_name, Users.last_name || Users.first_name AS client_name
      FROM inventory_transactions it
      JOIN products ON it.product_id = products.id
      LEFT JOIN Users ON it.user_id = Users.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (productId) { query += " AND it.product_id = ?"; params.push(productId); }
    if (startDate) { query += " AND it.date >= ?"; params.push(startDate); }
    if (endDate) { query += " AND it.date <= ?"; params.push(endDate); }

    query += " ORDER BY it.date DESC, it.created_at DESC";

    const { results } = params.length > 0 
      ? await env.reserve_db.prepare(query).bind(...params).all()
      : await env.reserve_db.prepare(query).all();

    return successResponse(results, undefined, 200, headers);
  } catch (error: unknown) {
    console.error("讀取庫存紀錄失敗：", error);
    return errorResponse("讀取庫存異動紀錄失敗", 500, headers);
  }
}
