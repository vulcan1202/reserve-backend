// ========================================================
// 📦 進銷存 API (Inventory Transactions)
// ========================================================
import type { HandlerContext, InventoryTransactionBody } from "../types";
import { successResponse, errorResponse } from "../utils";

/** 計算特定異動對庫存的淨影響量 (+/-) */
function getStockChange(type: string, quantity: number): number {
  const qty = Math.abs(quantity);
  if (type === 'purchase') return qty;
  if (type === 'sale' || type === 'usage') return -qty;
  if (type === 'adjustment') return quantity; // 盤點可正可負
  return 0;
}

/** 建立庫存異動 (連結財務) */
export async function handleCreateInventoryTransaction(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as InventoryTransactionBody;
    const { product_id, type, quantity, unit_price, user_id, description, date } = body;

    if (!product_id) return errorResponse("缺少產品 ID", 400, headers);
    if (!type || !['purchase', 'sale', 'usage', 'adjustment'].includes(type)) {
      return errorResponse("無效的異動類型", 400, headers);
    }
    // 🌟 檢查變動數量（盤點 adjustment 可為負數，但不能為 0）
    if (typeof quantity !== 'number' || isNaN(quantity) || quantity === 0) {
      return errorResponse("變動數量不能為 0", 400, headers);
    }
    if (!date) return errorResponse("請指定發生日期", 400, headers);

    const product = await env.reserve_db.prepare("SELECT * FROM products WHERE id = ?").bind(product_id).first() as any;
    if (!product) return errorResponse("找不到對應的產品", 404, headers);

    const total_amount = Math.abs(quantity * unit_price);
    const stockChange = getStockChange(type, quantity);

    const statements: any[] = [];

    // 1. 寫入庫存異動
    statements.push(
      env.reserve_db.prepare(
        `INSERT INTO inventory_transactions (product_id, type, quantity, unit_price, total_amount, user_id, description, date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).bind(product_id, type, quantity, unit_price, total_amount, user_id || null, description || null, date)
    );
    

    // 2. 更新產品庫存
    statements.push(
      env.reserve_db.prepare(
        `UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?`
      ).bind(stockChange, product_id)
    );

    // 3. 連結財務報表 (僅 purchase 與 sale)
    if (type === 'purchase') {
      // 進貨：增加成本支出
      statements.push(
        env.reserve_db.prepare(
          `INSERT INTO cash_transactions (type, category, amount, payment_method, user_id, description, date)
           VALUES ('expense', '產品進貨成本', ?, '現金', ?, ?, ?)`
        ).bind(total_amount, user_id || null, `[進貨] ${product.name} x${quantity} (${description || ''})`, date)
      );
    } else if (type === 'sale') {
      // 銷售：增加現金收入 + 認列實質營收
      statements.push(
        env.reserve_db.prepare(
          `INSERT INTO cash_transactions (type, category, amount, payment_method, user_id, description, date)
           VALUES ('income', '產品銷售收入', ?, '現金', ?, ?, ?)`
        ).bind(total_amount, user_id || null, `[銷售] ${product.name} x${quantity} (${description || ''})`, date)
      );

      if (user_id) {
        statements.push(
          env.reserve_db.prepare(
            `INSERT INTO revenue_recognitions (source_type, amount, user_id, description, date)
             VALUES ('product_sale', ?, ?, ?, ?)`
          ).bind(total_amount, user_id, `[銷貨營收] ${product.name} x${quantity}`, date)
        );
      }
    }

    await env.reserve_db.batch(statements);
    return successResponse({}, "庫存異動已登記並自動連動財務", 201, headers);
  } catch (error: unknown) {
    console.error("庫存異動失敗：", error);
    return errorResponse("登記庫存異動失敗", 500, headers);
  }
}

/** 更新庫存異動 (自動恢復舊數量並重算) */
export async function handleUpdateInventoryTransaction(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as InventoryTransactionBody & { id: number };
    const { id, type, quantity, unit_price, user_id, description, date } = body;
    if (!id) return errorResponse("缺少異動紀錄 ID", 400, headers);
    // 🌟 檢查變動數量（盤點 adjustment 可為負數，但不能為 0）
    if (typeof quantity !== 'number' || isNaN(quantity) || quantity === 0) {
      return errorResponse("變動數量不能為 0", 400, headers);
    }

    const oldTrans = await env.reserve_db.prepare("SELECT * FROM inventory_transactions WHERE id = ?").bind(id).first() as any;
    if (!oldTrans) return errorResponse("找不到該筆異動紀錄", 404, headers);

    const product = await env.reserve_db.prepare("SELECT * FROM products WHERE id = ?").bind(oldTrans.product_id).first() as any;

    // 計算原異動量逆向回滾與新異動量
    const revertChange = -getStockChange(oldTrans.type, oldTrans.quantity);
    const newChange = getStockChange(type, quantity);
    const netStockChange = revertChange + newChange;

    const total_amount = Math.abs(quantity * unit_price);


    const statements: any[] = [];

    // 1. 更新庫存紀錄
    statements.push(
      env.reserve_db.prepare(
        `UPDATE inventory_transactions 
         SET type = ?, quantity = ?, unit_price = ?, total_amount = ?, user_id = ?, description = ?, date = ?
         WHERE id = ?`
      ).bind(type, quantity, unit_price, total_amount, user_id || null, description || null, date, id)
    );

    // 2. 恢復舊庫存並更新新庫存
    statements.push(
      env.reserve_db.prepare(
        `UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?`
      ).bind(netStockChange, oldTrans.product_id)
    );

    await env.reserve_db.batch(statements);
    return successResponse({}, "異動紀錄已更新，庫存已自動重算恢復", 200, headers);
  } catch (error: unknown) {
    console.error("更新庫存紀錄失敗：", error);
    return errorResponse("更新庫存紀錄失敗", 500, headers);
  }
}

/** 刪除單筆庫存異動 (恢復庫存 + 移除對應財務紀錄) */
export async function handleDeleteInventoryTransaction(ctx: HandlerContext): Promise<Response> {
  const { env, headers, url } = ctx;
  try {
    const id = url.searchParams.get('id');
    if (!id) return errorResponse("缺少異動 ID", 400, headers);

    const trans = await env.reserve_db.prepare("SELECT * FROM inventory_transactions WHERE id = ?").bind(id).first() as any;
    if (!trans) return errorResponse("找不到該筆異動紀錄", 404, headers);

    const product = await env.reserve_db.prepare("SELECT * FROM products WHERE id = ?").bind(trans.product_id).first() as any;

    // 計算刪除時逆向恢復的庫存量
    const revertChange = -getStockChange(trans.type, trans.quantity);

    const statements: any[] = [
      // 1. 刪除異動紀錄
      env.reserve_db.prepare("DELETE FROM inventory_transactions WHERE id = ?").bind(id),
      // 2. 還原產品庫存
      env.reserve_db.prepare("UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?").bind(revertChange, trans.product_id)
    ];

    // 3. 清理當初寫入的財務紀錄
    if (product) {
      if (trans.type === 'purchase') {
        statements.push(
          env.reserve_db.prepare(
            "DELETE FROM cash_transactions WHERE type = 'expense' AND date = ? AND description LIKE ?"
          ).bind(trans.date, `[進貨] ${product.name} x${trans.quantity}%`)
        );
      } else if (trans.type === 'sale') {
        statements.push(
          env.reserve_db.prepare(
            "DELETE FROM cash_transactions WHERE type = 'income' AND date = ? AND description LIKE ?"
          ).bind(trans.date, `[銷售] ${product.name} x${trans.quantity}%`)
        );
        statements.push(
          env.reserve_db.prepare(
            "DELETE FROM revenue_recognitions WHERE source_type = 'product_sale' AND date = ? AND description LIKE ?"
          ).bind(trans.date, `[銷貨營收] ${product.name} x${trans.quantity}%`)
        );
      }
    }

    await env.reserve_db.batch(statements);

    return successResponse({}, "異動紀錄已刪除，庫存與財務帳目已同步還原", 200, headers);
  } catch (error: unknown) {
    console.error("刪除庫存紀錄失敗：", error);
    return errorResponse("刪除庫存紀錄失敗", 500, headers);
  }
}

/** 取得異動歷史紀錄 */
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