// ========================================================
// 路由表：集中管理「方法 + 路徑」對應到各功能模組的 handler
// ========================================================
import type { HandlerContext } from "./types";

import { handleRoot } from "./handlers/root";
import {
  handleRegister,
  handleUpdateUser,
  handleGetUsers,
  handleLogin,
  handleLiffLogin,
  handleLineLogin,
} from "./handlers/users";
import {
  handleCreateAppointment,
  handleGetAppointments,
  handlePatchAppointment,
  handleCompleteAppointment,
} from "./handlers/appointments";
import { handleBeauticians } from "./handlers/beauticians";
import { handleHolidays } from "./handlers/holidays";
import { handleLineWebhook } from "./handlers/lineWebhook";
import {
  handleGetQuestionnaire,
  handleUpsertQuestionnaire,
  handleDeleteQuestionnaire,
} from "./handlers/questionnaires";
import {
  handleGetCashTransactions,
  handleCreateCashTransaction,
  handleDeleteCashTransaction,
  handleUpdateCashTransaction,
} from "./handlers/cashTransactions";
import {
  handleGetProducts,
  handleCreateProduct,
  handleUpdateProduct,
  handleDeleteProduct,
} from "./handlers/products";
import {
  handleGetCourses,
  handleCreateCourse,
  handleUpdateCourse,
  handleDeleteCourse,
} from "./handlers/courses";
import {
  handleGetUsersCourses,
  handleGetUserCourseHistory,
  handleCreateUserCourse,
  handleUpdateUserCourse,
  handleDeleteUserCourse,
  handleRefundUserCourse,
} from "./handlers/usersCourses";
import {
  handleGetInventoryTransactions,
  handleCreateInventoryTransaction,
  handleUpdateInventoryTransaction,
  handleDeleteInventoryTransaction,
} from "./handlers/inventory";
import {
  handleGetRevenueRecognitions,
  handleCreateRevenueRecognition,
} from "./handlers/revenue";
import { handleGetFinancialSummary } from "./handlers/financial";
import {
  handleAdminLogin,
  handleAdminLogout,
  handleAdminMe,
  handleAdminRegister,
} from "./handlers/adminAuth";
import {
  handleGetAdminNotifications,
  handleMarkAdminNotificationRead,
  handleDeleteAdminNotification,
  handleNotificationProbe,
} from "./handlers/adminNotifications";
import {
  handleGetSettings,
  handleUpdateSettings,
} from "./handlers/settings";

export type RouteHandler = (ctx: HandlerContext) => Promise<Response>;

export const routeHandlers: Record<string, RouteHandler> = {
  'GET:/': handleRoot,

  // --- ⚙️ 系統設定 (System Settings) ---
  'GET:/api/settings': handleGetSettings,
  'PUT:/api/settings': handleUpdateSettings,

  // --- 🔐 管理員驗證 (Argon2id + Cookie Session) ---
  'POST:/api/admin/login': handleAdminLogin,
  'POST:/api/admin/logout': handleAdminLogout,
  'GET:/api/admin/me': handleAdminMe,
  'POST:/api/admin/register': handleAdminRegister,

  // --- 🔔 管理員個人化通知與物理刪除 (Admin Notifications) ---
  'GET:/api/admin/notifications': handleGetAdminNotifications,
  'GET:/api/admin/notifications/check-probe': handleNotificationProbe,
  'POST:/api/admin/notifications/mark-read': handleMarkAdminNotificationRead,
  'DELETE:/api/admin/notifications': handleDeleteAdminNotification,

  // --- 👤 會員 / 登入 ---
  'POST:/api/users': handleRegister,
  'PUT:/api/users': handleUpdateUser,
  'GET:/api/users': handleGetUsers,
  'POST:/api/login': handleLogin,
  'POST:/api/liff-login': handleLiffLogin,
  'POST:/api/line-login': handleLineLogin,

  // --- 📅 預約 ---
  'POST:/api/appointments': handleCreateAppointment,
  'GET:/api/appointments': handleGetAppointments,
  'PATCH:/api/appointments': handlePatchAppointment,
  'POST:/api/appointments/complete': handleCompleteAppointment,

  // --- 💇 美容師 ---
  'GET:/api/beauticians': handleBeauticians,
  'POST:/api/beauticians': handleBeauticians,
  'PUT:/api/beauticians': handleBeauticians,
  'DELETE:/api/beauticians': handleBeauticians,

  // --- 🏖️ 休假設定 ---
  'GET:/api/holidays': handleHolidays,
  'POST:/api/holidays': handleHolidays,
  'DELETE:/api/holidays': handleHolidays,

  // --- 🤖 LINE Webhook ---
  'POST:/api/line-webhook': handleLineWebhook,

  // --- 📝 會員到店問卷 ---
  'GET:/api/questionnaires': handleGetQuestionnaire,
  'POST:/api/questionnaires': handleUpsertQuestionnaire,
  'DELETE:/api/questionnaires': handleDeleteQuestionnaire,

  // --- 💰 現金收支 API (Cash Transactions) ---
  'GET:/api/cash-transactions': handleGetCashTransactions,
  'POST:/api/cash-transactions': handleCreateCashTransaction,
  'PUT:/api/cash-transactions': handleUpdateCashTransaction,
  'DELETE:/api/cash-transactions': handleDeleteCashTransaction,

  // --- 📦 產品與進銷存 API (Products & Inventory) ---
  'GET:/api/products': handleGetProducts,
  'POST:/api/products': handleCreateProduct,
  'PUT:/api/products': handleUpdateProduct,
  'DELETE:/api/products': handleDeleteProduct,
  'PUT:/api/inventory-transactions': handleUpdateInventoryTransaction,
  'DELETE:/api/inventory-transactions': handleDeleteInventoryTransaction,
  'GET:/api/inventory-transactions': handleGetInventoryTransactions,
  'POST:/api/inventory-transactions': handleCreateInventoryTransaction,

  // --- 📚 課程方案 API (Courses) ---
  'GET:/api/courses': handleGetCourses,
  'POST:/api/courses': handleCreateCourse,
  'PUT:/api/courses': handleUpdateCourse,
  'DELETE:/api/courses': handleDeleteCourse,

  // --- 🎫 會員已購買課程 API (Users Courses) ---
  'GET:/api/users-courses': handleGetUsersCourses,
  'GET:/api/users-courses/history': handleGetUserCourseHistory,
  'POST:/api/users-courses': handleCreateUserCourse,
  'PUT:/api/users-courses': handleUpdateUserCourse,
  'DELETE:/api/users-courses': handleDeleteUserCourse,
  'POST:/api/users-courses/refund': handleRefundUserCourse,

  // --- 📈 實質營收認列 API (Revenue Recognitions) ---
  'GET:/api/revenue-recognitions': handleGetRevenueRecognitions,
  'POST:/api/revenue-recognitions': handleCreateRevenueRecognition,

  // --- 📊 財務綜合損益報表 API (Financial Reports) ---
  'GET:/api/financial-summary': handleGetFinancialSummary,
};