// handlers/financial.ts
import type { HandlerContext } from "../types";
import { successResponse, errorResponse } from "../utils";

export async function handleGetFinancialSummary(ctx: HandlerContext): Promise<Response> {
  const { env, headers, url } = ctx;
  try {
    const startDate = url.searchParams.get('start_date') || new Date().toISOString().slice(0, 7) + '-01';
    const endDate = url.searchParams.get('end_date') || new Date().toISOString().slice(0, 10);

    // 1. 現金收入總額
    const cashIncomeRow = await env.reserve_db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM cash_transactions WHERE type = 'income' AND date >= ? AND date <= ?`
    ).bind(startDate, endDate).first() as { total: number };

    // 2. 現金支出總額
    const cashExpenseRow = await env.reserve_db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM cash_transactions WHERE type = 'expense' AND date >= ? AND date <= ?`
    ).bind(startDate, endDate).first() as { total: number };

    // 3. 實質認列營收總額 (依來源區分)
    const revenueRows = await env.reserve_db.prepare(
      `SELECT source_type, COALESCE(SUM(amount), 0) AS total 
       FROM revenue_recognitions WHERE date >= ? AND date <= ? GROUP BY source_type`
    ).bind(startDate, endDate).all();

    // 4. 🌟 終極精準版：計算預估總成本
    // 優先使用明細表 (appointment_courses) 內確實扣減的堂數 (ac.use_count) 來計算
    // 如果是舊資料沒有明細，則 fallback 用金額除以單價來估算
    const costRow = await env.reserve_db.prepare(
      `SELECT COALESCE(SUM(
         c.cost * COALESCE(ac.use_count, CASE WHEN c.price > 0 THEN (CAST(rr.amount AS REAL) / c.price) ELSE 1 END)
       ), 0) AS total_cost
       FROM revenue_recognitions rr
       LEFT JOIN appointment_courses ac 
         ON rr.appointment_id = ac.appointment_id AND rr.user_course_id = ac.user_course_id
       JOIN users_courses uc ON rr.user_course_id = uc.id
       JOIN courses c ON uc.course_id = c.id
       WHERE rr.date >= ? AND rr.date <= ? AND rr.source_type = 'course_usage'`
    ).bind(startDate, endDate).first() as { total_cost: number };

    let courseRevenue = 0;
    let productRevenue = 0;
    for (const row of revenueRows.results as any[]) {
      if (row.source_type === 'course_usage') courseRevenue = row.total;
      if (row.source_type === 'product_sale') productRevenue = row.total;
    }

    const totalCashIncome = cashIncomeRow?.total || 0;
    const totalCashExpense = cashExpenseRow?.total || 0;
    const totalRecognizedRevenue = courseRevenue + productRevenue;
    const estimatedCost = Math.round(costRow?.total_cost || 0);

    return successResponse({
      start_date: startDate,
      end_date: endDate,
      cash_flow: {
        total_income: totalCashIncome,
        total_expense: totalCashExpense,
        net_cash_flow: totalCashIncome - totalCashExpense,
      },
      revenue_recognition: {
        course_revenue: courseRevenue,
        course_recognized_revenue: courseRevenue,
        product_revenue: productRevenue,
        product_recognized_revenue: productRevenue,
        total_recognized_revenue: totalRecognizedRevenue,
        estimated_cost: estimatedCost
      }
    }, undefined, 200, headers);
  } catch (error: unknown) {
    console.error("計算財務報表失敗：", error);
    return errorResponse("計算財務報表失敗", 500, headers);
  }
}