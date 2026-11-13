#!/usr/bin/env node

import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
// biome-ignore lint/nursery/useImportRestrictions: 管理协议使用独立类型入口，不引入聚合模块的运行时依赖。
import type * as Admin from "../types/memory-admin.js";
import { checkClientBinding, loadMemoryOptions } from "./config.js";
import { syncHistory } from "./history.js";
import { safeMemoryError } from "./mcp.js";
import { MemoryStore } from "./store.js";
import {
  MemoryError,
  type MemoryOptions,
  type SourceMessage,
  type SummaryRecord,
} from "./types.js";

const MAX_REQUEST_BYTES = 128 * 1024;
const identifierSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/\p{Cc}/u.test(value));
const revisionSchema = z.number().int().positive().safe();
const paginationShape = {
  query: z.string().max(500).optional(),
  page: z.number().int().positive().safe().optional(),
  pageSize: z.number().int().min(1).max(50).optional(),
};
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("chats"), ...paginationShape }).strict(),
  z
    .object({
      action: z.literal("messages"),
      chatId: identifierSchema.optional(),
      ...paginationShape,
    })
    .strict(),
  z
    .object({
      action: z.literal("source"),
      id: identifierSchema,
      revision: revisionSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("memories"),
      status: z.enum(["all", "active", "candidate", "inactive"]).optional(),
      ...paginationShape,
    })
    .strict(),
  z.object({ action: z.literal("detail"), id: identifierSchema }).strict(),
  z.object({ action: z.literal("summaries") }).strict(),
  z.object({ action: z.literal("captures") }).strict(),
  z
    .object({
      action: z.literal("operations"),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("retire"),
      id: identifierSchema,
      revision: revisionSchema,
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z
    .object({ action: z.literal("undo"), operationId: identifierSchema })
    .strict(),
  z.object({ action: z.literal("export") }).strict(),
  z
    .object({
      action: z.literal("backup"),
      // 目标路径仅来自本机后端生成的内部协议，不接受网页传入路径。
      destination: z
        .string()
        .min(1)
        .max(4096)
        .refine((value) => isAbsolute(value) && !value.includes("\0")),
    })
    .strict(),
  z
    .object({
      action: z.literal("sync"),
      maxRequests: z.number().int().safe().min(1).max(1000),
    })
    .strict(),
]);

function sourceView(
  source: SourceMessage | null
): Admin.MemorySourceView | null {
  if (!source) return null;
  return {
    id: source.id,
    chatId: source.chatId,
    role: source.role,
    content: source.content,
    createdAt: source.createdAt,
    sourceId: source.sourceId,
    revision: source.revision,
    processedRevision: source.processedRevision,
  };
}

function summaryView(summary: SummaryRecord): SummaryRecord {
  return {
    id: summary.id,
    requestId: summary.requestId,
    title: summary.title,
    text: summary.text,
    memories: summary.memories.map(({ id, revision }) => ({ id, revision })),
    scope: summary.scope,
    status: summary.status,
    createdAt: summary.createdAt,
  };
}

function captureView(
  capture: Record<string, unknown>
): Admin.MemoryCaptureView {
  return {
    id: String(capture.id),
    text: String(capture.text),
    reason: String(capture.reason),
    status: String(capture.status),
    createdAt: String(capture.createdAt),
  };
}

/** 管理请求每次重新核对单端点绑定；只有显式同步操作可以访问官方接口。 */
export async function executeAdminRequest(
  store: MemoryStore,
  request: Admin.MemoryAdminRequest,
  options: MemoryOptions
): Promise<Admin.MemoryAdminResult> {
  try {
    const input = requestSchema.parse(request);
    checkClientBinding(options, (key, value) => store.bindMetadata(key, value));
    let data: unknown;
    switch (input.action) {
      case "status": {
        const status = store.status();
        const counts: Admin.MemoryAdminCounts = {
          chats: status.chats,
          messages: status.messages,
          pendingMessages: status.pendingMessages,
          memories: status.memories,
          activeMemories: status.activeMemories,
          candidates: status.candidates,
          provisionalCaptures: status.provisionalCaptures,
          summaries: status.summaries,
        };
        data = { counts, sync: status.sync };
        break;
      }
      case "chats":
        data = store.listChats({
          query: input.query,
          page: input.page,
          pageSize: input.pageSize,
        });
        break;
      case "messages":
        data = store.listMessages({
          chatId: input.chatId,
          query: input.query,
          page: input.page,
          pageSize: input.pageSize,
        });
        break;
      case "source":
        data = sourceView(store.getSource(input.id, input.revision));
        break;
      case "memories":
        data = store.listMemories({
          query: input.query,
          status: input.status,
          page: input.page,
          pageSize: input.pageSize,
        });
        break;
      case "detail":
        data = store.getMemoryDetail(input.id);
        break;
      case "summaries":
        data = store.listAdminSummaries().map(summaryView);
        break;
      case "captures":
        data = store.listCaptures().map(captureView);
        break;
      case "operations":
        data = store.listAdminOperations(input.limit);
        break;
      case "retire":
        data = store.retire(input.id, input.revision, input.reason);
        break;
      case "undo":
        data = store.undo(input.operationId);
        break;
      case "export":
        data = store.exportData();
        break;
      case "backup":
        store.backup(input.destination);
        data = { message: "一致性备份已生成。" };
        break;
      case "sync":
        if (!options.tokenFile) {
          throw new MemoryError("请先在本机配置官方历史凭据文件，再手动同步。");
        }
        data = await syncHistory(store, {
          agentId: options.agentId,
          tokenFile: options.tokenFile,
          maxRequests: input.maxRequests,
        });
        break;
    }
    return { success: true, data };
  } catch (error) {
    return { success: false, error: safeMemoryError(error) };
  }
}

async function readRequest(): Promise<Admin.MemoryAdminRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new MemoryError("记忆管理请求不能超过 128 KiB。");
    }
    chunks.push(chunk);
  }
  let request: unknown;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new MemoryError("记忆管理请求必须是单个有效的 JSON 对象。");
  }
  return requestSchema.parse(request);
}

/** 独立进程只处理一项内部请求，标准输出始终只有一份结果 JSON。 */
export async function runMemoryAdmin(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  let store: MemoryStore | undefined;
  let result: Admin.MemoryAdminResult;
  try {
    const request = await readRequest();
    const options = loadMemoryOptions(env);
    // 先排除错误身份和多端点，避免首次读取把空库绑定到尚未通过核对的配置。
    checkClientBinding(options, () => undefined);
    store = new MemoryStore(options.databasePath, options);
    result = await executeAdminRequest(store, request, options);
  } catch (error) {
    result = { success: false, error: safeMemoryError(error) };
  } finally {
    try {
      store?.close();
    } catch (error) {
      result = { success: false, error: safeMemoryError(error) };
    }
  }
  if (!result.success) process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runMemoryAdmin();
}
