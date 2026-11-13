import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ArchiveMessage, HistorySink, ImportCounts } from "./types.js";

const API_ORIGIN = "https://xiaozhi.me";
const REQUEST_TIMEOUT_MS = 15_000;
const INITIAL_DIGEST = createHash("sha256")
  .update("xiaozhi-history-v1")
  .digest("hex");
const timestampSchema = z.string().datetime({ offset: true });
const checkpointSchema = z
  .object({
    version: z.literal(1),
    agentId: z.string().min(1).max(200),
    phase: z.enum(["chats", "messages"]),
    page: z.number().int().positive().safe(),
    expectedPages: z.number().int().nonnegative().safe().nullable(),
    chatIds: z.array(z.string().min(1).max(200)),
    chatIndex: z.number().int().nonnegative().safe(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    previousDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    completedScans: z.number().int().nonnegative().safe(),
    complete: z.boolean(),
    lastVerifiedAt: timestampSchema.nullable(),
  })
  .strict();

type Checkpoint = z.infer<typeof checkpointSchema>;
type SyncStatus = "complete" | "incomplete" | "error";

const REASONS = {
  verified: "连续两轮完整遍历的列表与消息指纹一致。",
  request_budget: "已达到本次请求预算，进度已保存，尚未完成两轮一致性核对。",
  remote_changed: "分页数据在同步期间发生变化，已保存原文并重置本轮核对。",
  authentication_failed: "官方历史接口认证失败，请在本机更新凭据后再试。",
  rate_limited: "官方历史接口限制了请求频率，已保留进度，请稍后再试。",
  server_error: "官方历史接口暂时不可用，已保留进度，请稍后再试。",
  request_failed: "历史请求失败，已保留进度，可稍后重试当前页。",
  request_timeout: "历史请求超时，已保留进度，可稍后重试当前页。",
  cancelled: "历史同步已停止，已存档内容和检查点保留。",
  invalid_response: "历史接口响应结构不符合已核实格式，请核验接口后再继续。",
  invalid_checkpoint:
    "历史同步检查点无效或属于其他智能体，请检查本机配置与数据。",
  token_file_error: "无法读取有效的本机令牌文件，请检查文件内容和权限。",
  invalid_configuration: "历史同步配置无效，请检查智能体标识和请求预算。",
  http_error: "官方历史接口返回非成功状态，已保留进度。",
  storage_error: "本地历史保存失败，已成功写入的内容保留，请检查本机存储。",
} as const;

export type HistorySyncReason = keyof typeof REASONS;

export interface HistorySyncSummary {
  status: SyncStatus;
  reason: HistorySyncReason;
  message: string;
  requests: number;
  // 统计本次调用的写入次数；复核时可能再次访问同一会话和消息。
  chatsVisited: number;
  messages: ImportCounts;
  completedScans: number;
  lastVerifiedAt: string | null;
  httpStatus?: number;
}

export interface HistorySyncOptions {
  agentId: string;
  tokenFile: string;
  maxRequests?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

class SyncFailure extends Error {
  constructor(
    readonly status: Exclude<SyncStatus, "complete">,
    readonly reason: HistorySyncReason,
    readonly httpStatus?: number
  ) {
    super(REASONS[reason]);
  }
}

interface HistoryPage {
  list: Record<string, unknown>[];
  totalPages: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new SyncFailure("error", "invalid_response");
}

function sourceId(value: unknown): string {
  if (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 200
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return invalidResponse();
}

function checkScope(
  raw: Record<string, unknown>,
  agentId: string,
  chatId: string
): void {
  for (const key of ["agentId", "agent_id"]) {
    if (raw[key] !== undefined && raw[key] !== null) {
      if (sourceId(raw[key]) !== agentId) invalidResponse();
    }
  }
  for (const key of ["chatId", "chat_id"]) {
    if (raw[key] !== undefined && raw[key] !== null) {
      if (sourceId(raw[key]) !== chatId) invalidResponse();
    }
  }
}

function archiveMessage(
  raw: Record<string, unknown>,
  agentId: string,
  chatId: string
): ArchiveMessage {
  checkScope(raw, agentId, chatId);
  const parsedTime = timestampSchema.safeParse(raw.created_at);
  const instant = parsedTime.success ? Date.parse(parsedTime.data) : Number.NaN;
  return {
    id: sourceId(raw.id),
    chatId,
    role:
      typeof raw.role === "string" && raw.role.length > 0
        ? raw.role
        : "unknown",
    content:
      raw.content === null || raw.content === undefined
        ? ""
        : typeof raw.content === "string"
          ? raw.content
          : JSON.stringify(raw.content),
    // 缺少时区或格式未知时不推断，原值仍完整保留在 raw 中。
    createdAt: Number.isFinite(instant)
      ? new Date(instant).toISOString()
      : null,
    raw,
  };
}

function nextDigest(state: Checkpoint, page: HistoryPage): string {
  const serialized = JSON.stringify(
    {
      phase: state.phase,
      chatId:
        state.phase === "messages" ? state.chatIds[state.chatIndex] : null,
      page: state.page,
      totalPages: page.totalPages,
      list: page.list,
    },
    (_key, value: unknown) =>
      isRecord(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0
            )
          )
        : value
  );
  return createHash("sha256")
    .update(state.digest)
    .update(serialized)
    .digest("hex");
}

function restartScan(state: Checkpoint): Checkpoint {
  return {
    ...state,
    phase: "chats",
    page: 1,
    expectedPages: null,
    chatIds: [],
    chatIndex: 0,
    digest: INITIAL_DIGEST,
    complete: false,
  };
}

function loadCheckpoint(sink: HistorySink, agentId: string): Checkpoint {
  const saved = sink.getSyncState();
  if (saved === null) {
    return {
      version: 1,
      agentId,
      phase: "chats",
      page: 1,
      expectedPages: null,
      chatIds: [],
      chatIndex: 0,
      digest: INITIAL_DIGEST,
      previousDigest: null,
      completedScans: 0,
      complete: false,
      lastVerifiedAt: null,
    };
  }
  const parsed = checkpointSchema.safeParse(saved);
  if (!parsed.success) throw new SyncFailure("error", "invalid_checkpoint");
  const state = parsed.data;
  if (
    state.agentId !== agentId ||
    new Set(state.chatIds).size !== state.chatIds.length ||
    (state.phase === "chats" && state.chatIndex !== 0) ||
    (state.phase === "messages" && state.chatIndex >= state.chatIds.length) ||
    (state.page === 1 && state.expectedPages !== null) ||
    (state.page > 1 &&
      (state.expectedPages === null || state.expectedPages < state.page))
  ) {
    throw new SyncFailure("error", "invalid_checkpoint");
  }
  // 已完成的上一次同步不替代本次核对；新调用重新做两轮遍历。
  return state.complete
    ? {
        ...restartScan(state),
        previousDigest: null,
        completedScans: 0,
      }
    : state;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SyncFailure("incomplete", "cancelled");
}

function requestFailure(
  signal: AbortSignal,
  callerSignal?: AbortSignal
): never {
  checkCancelled(callerSignal);
  throw new SyncFailure(
    "incomplete",
    signal.aborted ? "request_timeout" : "request_failed"
  );
}

async function fetchPage(
  state: Checkpoint,
  token: string,
  options: HistorySyncOptions
): Promise<HistoryPage> {
  const url = new URL(
    `/api/chats/${state.phase === "chats" ? "list" : "messages"}`,
    API_ORIGIN
  );
  url.searchParams.set("page", String(state.page));
  if (state.phase === "chats") {
    url.searchParams.set("agentId", options.agentId);
    url.searchParams.set("pageSize", "20");
  } else {
    url.searchParams.set("chatId", state.chatIds[state.chatIndex]);
    url.searchParams.set("pageSize", "50");
    url.searchParams.set("includeTools", "1");
    url.searchParams.set("order", "asc");
  }
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal,
    });
  } catch {
    return requestFailure(signal, options.signal);
  }
  checkCancelled(options.signal);
  // 不读取失败响应的正文，也不转发底层异常，避免其中回显凭据。
  if (response.status === 401 || response.status === 403) {
    throw new SyncFailure("error", "authentication_failed", response.status);
  }
  if (response.status === 429) {
    throw new SyncFailure("incomplete", "rate_limited", response.status);
  }
  if (response.status >= 500) {
    throw new SyncFailure("incomplete", "server_error", response.status);
  }
  if (!response.ok || response.redirected) {
    throw new SyncFailure("error", "http_error", response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (signal.aborted) return requestFailure(signal, options.signal);
    return invalidResponse();
  }
  if (!isRecord(body) || !isRecord(body.data)) return invalidResponse();
  const { list, pagination } = body.data;
  if (
    !Array.isArray(list) ||
    !list.every(isRecord) ||
    !isRecord(pagination) ||
    !Number.isSafeInteger(pagination.page) ||
    pagination.page !== state.page ||
    typeof pagination.totalPages !== "number" ||
    !Number.isSafeInteger(pagination.totalPages) ||
    pagination.totalPages < 0
  ) {
    return invalidResponse();
  }
  return { list, totalPages: pagination.totalPages };
}

/** 只使用本机配置访问官方只读历史接口；摘要不含凭据、正文或底层异常。 */
export async function syncHistory(
  sink: HistorySink,
  options: HistorySyncOptions
): Promise<HistorySyncSummary> {
  const counts: ImportCounts = { inserted: 0, updated: 0, unchanged: 0 };
  let requests = 0;
  let chatsVisited = 0;
  let state: Checkpoint | undefined;
  const summary = (
    status: SyncStatus,
    reason: HistorySyncReason,
    httpStatus?: number
  ): HistorySyncSummary => ({
    status,
    reason,
    message: REASONS[reason],
    requests,
    chatsVisited,
    messages: counts,
    completedScans: state?.completedScans ?? 0,
    lastVerifiedAt: state?.lastVerifiedAt ?? null,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

  try {
    const budget = options.maxRequests ?? 100;
    if (
      typeof options.agentId !== "string" ||
      options.agentId.trim().length === 0 ||
      options.agentId.length > 200 ||
      !Number.isSafeInteger(budget) ||
      budget < 0 ||
      budget > 10_000
    ) {
      throw new SyncFailure("error", "invalid_configuration");
    }
    checkCancelled(options.signal);
    state = loadCheckpoint(sink, options.agentId);
    let token: string;
    try {
      token = (
        await readFile(options.tokenFile, {
          encoding: "utf8",
          signal: options.signal,
        })
      ).trim();
      if (token.length > 16_384 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
        throw new SyncFailure("error", "token_file_error");
      }
    } catch {
      checkCancelled(options.signal);
      throw new SyncFailure("error", "token_file_error");
    }
    sink.setSyncState({ ...state, chatIds: [...state.chatIds] });
    while (requests < budget) {
      checkCancelled(options.signal);
      requests++;
      const page = await fetchPage(state, token, options);
      checkCancelled(options.signal);
      if (
        state.expectedPages !== null &&
        state.expectedPages !== page.totalPages
      ) {
        state = restartScan(state);
        sink.setSyncState({ ...state, chatIds: [...state.chatIds] });
        return summary("incomplete", "remote_changed");
      }
      if (
        (page.totalPages === 0 &&
          (state.page !== 1 || page.list.length !== 0)) ||
        (page.totalPages > 0 && state.page > page.totalPages) ||
        (page.list.length === 0 && state.page < page.totalPages)
      ) {
        invalidResponse();
      }
      if (state.phase === "chats") {
        const chats = page.list.map((raw) => {
          const id = sourceId(raw.id);
          checkScope(raw, options.agentId, id);
          return { id, raw };
        });
        for (const chat of chats) {
          sink.upsertChat(chat);
          chatsVisited++;
        }
        state.chatIds = [
          ...new Set([...state.chatIds, ...chats.map((chat) => chat.id)]),
        ];
      } else {
        const chatId = state.chatIds[state.chatIndex];
        const messages = page.list.map((raw) =>
          archiveMessage(raw, options.agentId, chatId)
        );
        const imported = sink.upsertMessages(messages);
        counts.inserted += imported.inserted;
        counts.updated += imported.updated;
        counts.unchanged += imported.unchanged;
      }
      state.digest = nextDigest(state, page);
      if (state.page < page.totalPages) {
        state.page++;
        state.expectedPages = page.totalPages;
      } else {
        state.page = 1;
        state.expectedPages = null;
        if (state.phase === "chats") {
          state.phase = "messages";
        } else {
          state.chatIndex++;
        }
        if (state.chatIndex === state.chatIds.length) {
          state.completedScans++;
          const digest = state.digest;
          const matched = state.previousDigest === digest;
          state = restartScan(state);
          state.previousDigest = digest;
          if (matched) {
            state.complete = true;
            state.lastVerifiedAt = new Date().toISOString();
          }
        }
      }
      // 先写原文再提交下一页检查点；中断后重读当前页由消息 ID 幂等去重。
      sink.setSyncState({ ...state, chatIds: [...state.chatIds] });
      if (state.complete) return summary("complete", "verified");
    }
    return summary("incomplete", "request_budget");
  } catch (error) {
    if (error instanceof SyncFailure) {
      return summary(error.status, error.reason, error.httpStatus);
    }
    return summary("error", "storage_error");
  }
}
