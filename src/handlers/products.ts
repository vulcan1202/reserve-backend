// ========================================================
// 📦 產品管理 API (Products)
// ========================================================
import type { HandlerContext, ProductBody } from "../types";
import { successResponse, errorResponse } from "../utils";

/** 取得產品清單或單一產品 */
export async function handleGetProducts(ctx: HandlerContext): Promise<Response> {
  const { env, headers, url } = ctx;
  try {
    const id = url.searchParams.get('id');
    if (id) {
      const product = await env.reserve_db.prepare("SELECT * FROM products WHERE id = ?").bind(id).first();
      if (!product) return errorResponse("找不到該產品", 404, headers);
      return successResponse(product, undefined, 200, headers);
    }

    const { results } = await env.reserve_db.prepare("SELECT * FROM products ORDER BY id ASC").all();
    return successResponse(results, undefined, 200, headers);
  } catch (error: unknown) {
    console.error("讀取產品失敗：", error);
    return errorResponse("讀取產品清單失敗", 500, headers);
  }
}

/** 新增產品 */
export async function handleCreateProduct(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as ProductBody;
    const { name, cost_price, selling_price, stock_quantity = 0 } = body;

    if (!name || !name.trim()) return errorResponse("產品名稱為必填", 400, headers);
    if (typeof cost_price !== 'number' || cost_price < 0) return errorResponse("成本價格式不正確", 400, headers);
    if (typeof selling_price !== 'number' || selling_price < 0) return errorResponse("售價格式不正確", 400, headers);

    const result = await env.reserve_db.prepare(
      `INSERT INTO products (name, cost_price, selling_price, stock_quantity)
       VALUES (?, ?, ?, 0) RETURNING *`
    ).bind(name.trim(), cost_price, selling_price).first();

    return successResponse(result, "產品建立成功", 201, headers);
  } catch (error: unknown) {
    console.error("新增產品失敗：", error);
    return errorResponse("新增產品失敗", 500, headers);
  }
}

/** 更新產品資料 */
export async function handleUpdateProduct(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as ProductBody;
    const { id, name, cost_price, selling_price } = body;

    if (!id) return errorResponse("缺少產品 ID", 400, headers);
    if (!name || !name.trim()) return errorResponse("產品名稱為必填", 400, headers);

    await env.reserve_db.prepare(
      `UPDATE products SET name = ?, cost_price = ?, selling_price = ? WHERE id = ?`
    ).bind(name.trim(), cost_price, selling_price, id).run();

    return successResponse({}, "產品資料更新成功", 200, headers);
  } catch (error: unknown) {
    console.error("更新產品失敗：", error);
    return errorResponse("更新產品失敗", 500, headers);
  }
}

/** 刪除產品（同時清除：庫存異動 + 相關現金收支紀錄 + 相關營收認列紀錄） */
export async function handleDeleteProduct(ctx: HandlerContext): Promise<Response> {
  const { env, headers, url } = ctx;
  try {
    const id = url.searchParams.get('id');
    if (!id) return errorResponse("缺少產品 ID", 400, headers);

    // 1. 檢查產品是否存在
    const product = await env.reserve_db.prepare("SELECT * FROM products WHERE id = ?").bind(id).first() as any;
    if (!product) return errorResponse("找不到該產品", 404, headers);

    const productName = product.name;

    // 2. 建立批次刪除 SQL 語句
    // 透過描述（LIKE '[進貨] 產品名%' / '[銷售] 產品名%'）來精準連帶清理財務紀錄
    const statements = [
      // 刪除產品本身（SQLite ON DELETE CASCADE 會自動連帶刪除 inventory_transactions）
      env.reserve_db.prepare("DELETE FROM products WHERE id = ?").bind(id),

      // 清理現金收支表 (cash_transactions) 中關於此產品的進貨成本與銷售收入
      env.reserve_db.prepare(
        "DELETE FROM cash_transactions WHERE description LIKE ? OR description LIKE ?"
      ).bind(`[進貨] ${productName}%`, `[銷售] ${productName}%`),

      // 清理實質營收表 (revenue_recognitions) 中關於此產品的銷貨營收
      env.reserve_db.prepare(
        "DELETE FROM revenue_recognitions WHERE source_type = 'product_sale' AND description LIKE ?"
      ).bind(`[銷貨營收] ${productName}%`)
    ];

    // 3. 執行批次原子交易 (Batch Transaction)
    await env.reserve_db.batch(statements);
    
    return successResponse({}, "產品、庫存異動及其連動的財務紀錄已一併清除", 200, headers);
  } catch (error: unknown) {
    console.error("刪除產品及連帶財務資料失敗：", error);
    return errorResponse("刪除產品失敗，請確認是否有其他關聯資料", 500, headers);
  }
}