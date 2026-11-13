import { z } from "zod";

// 只有明确由本模块编写的业务错误才能显示给工具调用者，底层异常可能含原文或路径。
export class MemoryError extends Error {
  override name = "MemoryError";
}

// 官方档案和模型自报采用独立命名空间。
export interface ArchiveMessage {
  id: string;
  chatId: string;
  role: string;
  content: string;
  createdAt: string | null;
  raw: Record<string, unknown>;
}

export interface ArchiveChat {
  id: string;
  raw: Record<string, unknown>;
}

export interface SourceMessage extends ArchiveMessage {
  origin?: "archive" | "model_reported";
  assistantStage?: "draft" | "final" | "unknown";
  recordedAt?: string;
  sourceId: string;
  revision: number;
  processedRevision: number;
}

export const recordTurnSchema = z
  .object({
    requestId: z.string().min(8).max(128),
    conversationId: z.string().min(1).max(128),
    conversationTitle: z.string().trim().min(1).max(100).optional(),
    role: z.enum(["user", "assistant", "tool"]),
    content: z.string().min(1).max(8000),
    assistantStage: z.enum(["draft", "final", "unknown"]).optional(),
  })
  .strict()
  .refine(
    (value) => value.role === "assistant" || value.assistantStage === undefined,
    {
      message: "只有助手消息可以指定回复阶段。",
    }
  );
export type RecordTurn = z.infer<typeof recordTurnSchema>;

export interface ImportCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface HistorySink {
  upsertChat(chat: ArchiveChat): void;
  upsertMessages(messages: ArchiveMessage[]): ImportCounts;
  getSyncState(): Record<string, unknown> | null;
  setSyncState(state: Record<string, unknown>): void;
}

export interface MemoryOptions {
  agentId: string;
  databasePath: string;
  ownerId?: string;
  tokenFile?: string;
  clientConfigPath?: string;
  syncIntervalSeconds: number;
}

export const sourceReferenceSchema = z
  .object({
    messageId: z.string().min(1).max(200),
    revision: z.number().int().positive(),
    quote: z.string().trim().min(1).max(4000),
  })
  .strict();

export const subjectSchema = z
  .object({
    kind: z.enum(["speaker", "related_person", "entity"]),
    label: z.string().trim().min(1).max(150).optional(),
  })
  .strict();

const timestampSchema = z.string().datetime({ offset: true });

export const memoryProposalSchema = z
  .object({
    requestId: z.string().min(8).max(128),
    operation: z.enum(["add", "replace", "reinforce"]),
    subject: subjectSchema,
    facet: z.string().trim().min(1).max(100),
    value: z.string().trim().min(1).max(2000),
    assertion: z.enum([
      "explicit",
      "reported",
      "inferred",
      "plan",
      "event",
      "assistant_suggestion",
    ]),
    conditions: z.string().trim().max(1000).default(""),
    validFrom: timestampSchema.optional(),
    validUntil: timestampSchema.optional(),
    sources: z.array(sourceReferenceSchema).min(1).max(10),
    targetId: z.string().min(1).max(100).optional(),
    targetRevision: z.number().int().positive().optional(),
    correctionQuote: z.string().trim().min(1).max(4000).optional(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

export type MemoryProposal = z.infer<typeof memoryProposalSchema>;
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type MemorySubject = z.infer<typeof subjectSchema>;
export type MemoryStatus =
  | "active"
  | "candidate"
  | "historical"
  | "superseded"
  | "invalidated"
  | "retracted";

export interface MemoryRecord {
  id: string;
  revision: number;
  scope: string;
  subject: MemorySubject;
  facet: string;
  value: string;
  assertion: MemoryProposal["assertion"];
  conditions: string;
  status: MemoryStatus;
  observedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  sources: SourceReference[];
  reason: string;
  supersedes: string | null;
  createdAt: string;
}

export const summaryProposalSchema = z
  .object({
    requestId: z.string().min(8).max(128),
    title: z.string().trim().min(1).max(200),
    text: z.string().trim().min(1).max(6000),
    memories: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            revision: z.number().int().positive(),
          })
          .strict()
      )
      .min(1)
      .max(30),
  })
  .strict();

export interface SummaryRecord extends z.infer<typeof summaryProposalSchema> {
  id: string;
  scope: string;
  status: "active" | "invalidated" | "retracted";
  createdAt: string;
}

export interface CommitResult {
  operationId: string;
  outcome:
    | "created"
    | "reinforced"
    | "replaced"
    | "duplicate"
    | "candidate"
    | "historical";
  memory: MemoryRecord;
}
