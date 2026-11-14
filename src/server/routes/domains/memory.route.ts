import { type RouteDefinition, createHandler } from "../types.js";

const h = createHandler("memoryApiHandler");

/** 这些路由只属于网页管理端，不注册为模型可调用的 MCP 工具。 */
export const memoryRoutes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/memory/overview",
    handler: h((handler, c) => handler.getOverview(c)),
  },
  {
    method: "GET",
    path: "/api/memory/settings",
    handler: h((handler, c) => handler.getSettings(c)),
  },
  {
    method: "PUT",
    path: "/api/memory/auto-extract",
    handler: h((handler, c) => handler.setAutoExtract(c)),
  },
  {
    method: "PUT",
    path: "/api/memory/settings",
    handler: h((handler, c) => handler.saveSettings(c)),
  },
  {
    method: "POST",
    path: "/api/memory/credential",
    handler: h((handler, c) => handler.saveCredential(c)),
  },
  {
    method: "GET",
    path: "/api/memory/chats",
    handler: h((handler, c) => handler.getChats(c)),
  },
  {
    method: "GET",
    path: "/api/memory/messages",
    handler: h((handler, c) => handler.getMessages(c)),
  },
  {
    method: "GET",
    path: "/api/memory/sources/:id",
    handler: h((handler, c) => handler.getSource(c)),
  },
  {
    method: "GET",
    path: "/api/memory/entries",
    handler: h((handler, c) => handler.getEntries(c)),
  },
  {
    method: "GET",
    path: "/api/memory/entries/:id",
    handler: h((handler, c) => handler.getEntry(c)),
  },
  {
    method: "POST",
    path: "/api/memory/entries/:id/retire",
    handler: h((handler, c) => handler.retireEntry(c)),
  },
  {
    method: "DELETE",
    path: "/api/memory/entries/:id",
    handler: h((handler, c) => handler.deleteEntry(c)),
  },
  {
    method: "GET",
    path: "/api/memory/summaries",
    handler: h((handler, c) => handler.getList(c, "summaries")),
  },
  {
    method: "GET",
    path: "/api/memory/captures",
    handler: h((handler, c) => handler.getList(c, "captures")),
  },
  {
    method: "GET",
    path: "/api/memory/operations",
    handler: h((handler, c) => handler.getList(c, "operations")),
  },
  {
    method: "POST",
    path: "/api/memory/operations/:id/undo",
    handler: h((handler, c) => handler.undoOperation(c)),
  },
  {
    method: "POST",
    path: "/api/memory/sync",
    handler: h((handler, c) => handler.startSync(c)),
  },
  {
    method: "GET",
    path: "/api/memory/export",
    handler: h((handler, c) => handler.exportData(c)),
  },
  {
    method: "POST",
    path: "/api/memory/backup",
    handler: h((handler, c) => handler.createBackup(c)),
  },
  {
    method: "GET",
    path: "/api/memory/backups/:fileName",
    handler: h((handler, c) => handler.downloadBackup(c)),
  },
];
