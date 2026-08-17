// ========================================================
// 會員到店問卷 CRUD
// ========================================================
import type { HandlerContext, QuestionnaireBody } from "../types";
import { successResponse, errorResponse } from "../utils";
import { getQuestionnaireByUserId, questionnaireExists, getUserById } from "../db";

/** 取得指定會員的問卷資料 (GET /api/questionnaires) */
export async function handleGetQuestionnaire(ctx: HandlerContext): Promise<Response> {
  const { env, headers, url } = ctx;
  try {
    const userId = url.searchParams.get('user_id');
    if (!userId) {
      return errorResponse("缺少 user_id 參數", 400, headers);
    }

    const questionnaire = await getQuestionnaireByUserId(env, Number(userId));
    return successResponse(questionnaire, undefined, 200, headers);
  } catch (error: unknown) {
    console.error("讀取問卷失敗：", error);
    return errorResponse("讀取問卷資料失敗", 500, headers);
  }
}

/** 建立或更新問卷 (POST /api/questionnaires) */
export async function handleUpsertQuestionnaire(ctx: HandlerContext): Promise<Response> {
  const { request, env, headers } = ctx;
  try {
    const body = (await request.json()) as QuestionnaireBody;
    const {
      user_id,
      how_to_know,
      history_of_treatments,
      allergies,
      medical_history,
      skin_type,
      concerns,
      Habit,
      notes,
      agreed_to_terms
    } = body;

    // 基本驗證
    if (!user_id) {
      return errorResponse("缺少 user_id", 400, headers);
    }

    // 檢查會員是否存在
    const user = await getUserById(env, user_id);
    if (!user) {
      return errorResponse("指定的會員不存在", 404, headers);
    }

    // 檢查 how_to_know 是否在允許範圍內（如果有傳入）
    const validHowToKnow = ['instagram', 'friend', 'search', 'other'];
    if (how_to_know && !validHowToKnow.includes(how_to_know)) {
      return errorResponse(
        `how_to_know 必須是以下之一：${validHowToKnow.join(', ')}`,
        400,
        headers
      );
    }

    // 檢查問券是否存在，決定 INSERT 或 UPDATE
    const exists = await questionnaireExists(env, user_id);

    let result: any;
    if (exists) {
      // 更新現有問卷
      result = await env.reserve_db.prepare(
        `UPDATE client_questionnaires SET
          how_to_know = ?,
          history_of_treatments = ?,
          allergies = ?,
          medical_history = ?,
          skin_type = ?,
          concerns = ?,
          Habit = ?,
          notes = ?,
          agreed_to_terms = ?
        WHERE user_id = ?
        RETURNING *`
      ).bind(
        how_to_know || 'other',
        history_of_treatments || null,
        allergies || null,
        medical_history || null,
        skin_type || null,
        concerns || null,
        Habit || null,
        notes || null,
        agreed_to_terms ? 1 : 0,
        user_id
      ).first();
    } else {
      // 新增問卷
      result = await env.reserve_db.prepare(
        `INSERT INTO client_questionnaires (
          user_id, how_to_know, history_of_treatments, allergies,
          medical_history, skin_type, concerns, Habit, notes, agreed_to_terms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *`
      ).bind(
        user_id,
        how_to_know || 'other',
        history_of_treatments || null,
        allergies || null,
        medical_history || null,
        skin_type || null,
        concerns || null,
        Habit || null,
        notes || null,
        agreed_to_terms ? 1 : 0
      ).first();
    }

    return successResponse(result, exists ? '問卷更新成功' : '問卷建立成功', 200, headers);
  } catch (error: unknown) {
    console.error('問卷儲存失敗：', error);
    return errorResponse('問卷儲存失敗', 500, headers);
  }
}

/** 刪除問卷 (DELETE /api/questionnaires) */
export async function handleDeleteQuestionnaire(ctx: HandlerContext): Promise<Response> {
  const { env, headers, url } = ctx;
  try {
    const userId = url.searchParams.get('user_id');
    if (!userId) {
      return errorResponse('缺少 user_id 參數', 400, headers);
    }

    const exists = await questionnaireExists(env, Number(userId));
    if (!exists) {
      return errorResponse('找不到該會員的問卷', 404, headers);
    }

    await env.reserve_db.prepare(
      `DELETE FROM client_questionnaires WHERE user_id = ?`
    ).bind(userId).run();

    return successResponse({}, '問卷已刪除', 200, headers);
  } catch (error: unknown) {
    console.error('刪除問卷失敗：', error);
    return errorResponse('刪除問卷失敗', 500, headers);
  }
}
