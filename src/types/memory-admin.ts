// biome-ignore lint/nursery/useImportRestrictions: 管理协议只引用记忆领域类型，避免引入运行时模块。
import type { MemoryRecord, SourceMessage } from "../memory/types.js";

/** 网页管理接口只传递必要正文，不返回官方凭据或原始工具载荷。 */
export type MemorySourceView = Omit<SourceMessage, "raw">;

export interface MemoryPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface MemoryChatView {
  id: string;
  title: string;
  messageCount: number;
  pendingCount: number;
  lastMessageAt: string | null;
  preview: string;
}

export interface MemoryDetailView {
  memory: MemoryRecord;
  versions: MemoryRecord[];
  sources: Array<{
    messageId: string;
    revision: number;
    quote: string;
    message: MemorySourceView | null;
    currentRevision: number | null;
  }>;
}

export interface MemoryOperationView {
  id: string;
  kind: string;
  createdAt: string;
  reason?: string;
  undoneBy?: string;
  canUndo: boolean;
  memoryIds: string[];
}

export interface MemoryAdminSettings {
  configured: boolean;
  serviceName: string;
  agentId: string;
  ownerId: string;
  databasePath: string;
  tokenConfigured: boolean;
  syncIntervalSeconds: number;
  syncMaxRequests: number;
  identityLocked: boolean;
  restartRequired: boolean;
  containerMode?: boolean;
}

export interface MemorySettingsInput {
  agentId: string;
  ownerId: string;
  syncIntervalSeconds: number;
  syncMaxRequests: number;
}

export interface MemorySyncJob {
  state: "idle" | "running" | "complete" | "partial" | "error";
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
}

export interface MemoryAdminCounts {
  chats: number;
  messages: number;
  pendingMessages: number;
  memories: number;
  activeMemories: number;
  candidates: number;
  provisionalCaptures: number;
  summaries: number;
}

export interface MemoryAdminOverview {
  settings: MemoryAdminSettings;
  ready: boolean;
  error: string | null;
  counts: MemoryAdminCounts | null;
  status: { autoExtractEnabled: boolean } | null;
  sync: Record<string, unknown> | null;
  syncJob: MemorySyncJob;
  extractionPrompt: string;
  recordingPrompt: string;
}

export interface MemoryCaptureView {
  id: string;
  text: string;
  reason: string;
  status: string;
  createdAt: string;
}

export type MemoryListStatus =
  | "all"
  | "active"
  | "candidate"
  | "inactive"
  | "current";
// biome-ignore lint/nursery/useImportRestrictions: 前端复用只含类型的契约，不加载 SQLite。
export type { MemoryRecord, SummaryRecord } from "../memory/types.js";

/** 仅由本机管理进程调用的工作进程协议，不向模型注册。 */
export type MemoryAdminRequest =
  | { action: "status" }
  | { action: "setAutoExtractEnabled"; enabled: boolean }
  | { action: "chats"; query?: string; page?: number; pageSize?: number }
  | {
      action: "messages";
      chatId?: string;
      query?: string;
      page?: number;
      pageSize?: number;
    }
  | { action: "source"; id: string; revision?: number }
  | {
      action: "memories";
      category?: "user_profile" | "situational";
      query?: string;
      status?: MemoryListStatus;
      page?: number;
      pageSize?: number;
    }
  | { action: "detail"; id: string }
  | { action: "summaries" }
  | { action: "captures" }
  | { action: "operations"; limit?: number }
  | { action: "retire"; id: string; revision: number; reason: string }
  | { action: "delete"; id: string; revision: number }
  | { action: "undo"; operationId: string }
  | { action: "export" }
  | { action: "backup"; destination: string }
  | { action: "sync"; maxRequests: number };

export type MemoryAdminResult =
  | { success: true; data: unknown }
  | { success: false; error: string };
