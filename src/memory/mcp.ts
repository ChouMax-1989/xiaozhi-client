import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  CANDIDATE_WARNING,
  MEMORY_EXTRACTION_RULES,
  MEMORY_SERVER_INSTRUCTIONS,
  TRUNCATED_SOURCE_WARNING,
} from "./prompts.js";
import type { MemoryStore } from "./store.js";
import {
  MemoryError,
  type MemoryRecord,
  type SourceMessage,
  memoryProposalSchema,
  summaryProposalSchema,
} from "./types.js";

const MAX_RESPONSE_CHARS = 32_000;
const identifierSchema = z.string().min(1).max(200);
const emptySchema = z.object({}).strict();

/** 底层解析或文件错误可能含原文和路径，只向调用者返回固定说明。 */
export function safeMemoryError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return "参数格式无效，请检查字段、长度和来源版本后重试。";
  }
  if (error instanceof MemoryError) {
    return error.message;
  }
  return "本地记忆操作未完成，请在本机检查配置、档案格式和存储状态。";
}

function result(value: unknown, isError = false): CallToolResult {
  const text = JSON.stringify(value);
  if (text.length > MAX_RESPONSE_CHARS) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "结果超过单次读取上限，请减少 limit 或使用更精确的关键词后重试。",
        },
      ],
    };
  }
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

function prefix(text: string, length: number): string {
  let end = Math.max(0, Math.min(text.length, length));
  if (end > 0 && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

function jsonPrefix(text: string, budget: number): string {
  if (JSON.stringify(text).length - 2 <= budget) return text;
  let lower = 0;
  let upper = text.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (JSON.stringify(text.slice(0, middle)).length - 2 <= budget) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  return prefix(text, lower);
}

function memoryView(memory: MemoryRecord) {
  return {
    ...memory,
    reason: prefix(memory.reason, 400),
    reasonTruncated: memory.reason.length > 400,
    sources: memory.sources.slice(0, 3).map((source) => ({
      ...source,
      quote: prefix(source.quote, 500),
      quoteTruncated: source.quote.length > 500,
    })),
    sourceCount: memory.sources.length,
    omittedSources: Math.max(0, memory.sources.length - 3),
  };
}

function fitItems<T>(items: T[], budget: number): T[] {
  const included: T[] = [];
  let used = 2;
  for (const item of items) {
    const length = JSON.stringify(item).length + 1;
    if (used + length > budget) break;
    included.push(item);
    used += length;
  }
  return included;
}

function sourceView(
  store: MemoryStore,
  source: SourceMessage,
  offset: number,
  length: number,
  contentBudget = MAX_RESPONSE_CHARS - 2_000
) {
  const content = jsonPrefix(
    prefix(source.content.slice(offset), length),
    contentBudget
  );
  const end = offset + content.length;
  const truncated = offset > 0 || end < source.content.length;
  return {
    sourceId: source.sourceId,
    revision: source.revision,
    chatId: source.chatId,
    scope: store.scopeForChat(source.chatId),
    role: source.role,
    createdAt: source.createdAt,
    processedRevision: source.processedRevision,
    content,
    contentOffset: offset,
    contentLength: source.content.length,
    truncated,
    nextOffset: end < source.content.length ? end : null,
    ...(truncated
      ? {
          warning:
            end < source.content.length
              ? TRUNCATED_SOURCE_WARNING
              : "这是原文末尾片段，前文未显示。只有已读取前面全部片段，才可以标记整条来源已处理；缺失上下文不能作证据。",
        }
      : {}),
  };
}

function safeStatus(store: MemoryStore) {
  const { sync, ...status } = store.status();
  const summary: Record<string, unknown> = {};
  for (const key of [
    "phase",
    "page",
    "expectedPages",
    "chatIndex",
    "complete",
    "lastVerifiedAt",
    "completedScans",
  ]) {
    const value = sync?.[key];
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      (typeof value === "string" && value.length <= 100)
    ) {
      summary[key] = value;
    }
  }
  return {
    ...status,
    sync: sync ? summary : null,
    syncNote:
      "complete 与 lastVerifiedAt 只表示上次完成的分页一致性核对，不保证远端此刻没有新对话。",
  };
}

/** 权限检查先于每次读取或写入，输入对象在 SDK 层严格拒绝额外字段。 */
export function createMemoryServer(store: MemoryStore, guard: () => void) {
  const server = new McpServer(
    { name: "xiaozhi-local-memory", version: "1.0.0" },
    { instructions: MEMORY_SERVER_INSTRUCTIONS }
  );
  const run = (work: () => unknown): CallToolResult => {
    try {
      guard();
      return result(work());
    } catch (error) {
      return result({ error: safeMemoryError(error) }, true);
    }
  };
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, openWorldHint: false };

  server.registerTool(
    "memory_status",
    {
      title: "查看本地记忆状态",
      description:
        "查看档案、待处理来源、正式记忆和候选数量；不返回凭据或本机路径。",
      inputSchema: emptySchema,
      annotations: readOnly,
    },
    () => run(() => safeStatus(store))
  );

  server.registerTool(
    "memory_read_sources",
    {
      title: "读取待提炼原文",
      description:
        "默认读取尚未处理的真实消息及其版本，并给出同作用域旧记忆与提炼规则。afterId使用上次的nextCursor；原文过长会标明截断，需继续用memory_read_source读取。",
      inputSchema: z
        .object({
          chatId: identifierSchema
            .optional()
            .describe("只读取指定会话；不能改变智能体或人物身份"),
          afterId: identifierSchema
            .optional()
            .describe("上一页返回的nextCursor"),
          pendingOnly: z
            .boolean()
            .default(true)
            .describe("默认只读取未处理或已改版来源"),
          limit: z.number().int().min(1).max(12).default(4),
        })
        .strict(),
      annotations: readOnly,
    },
    (args) =>
      run(() => {
        const page = store.readSources(args);
        const emptyMessages = page.messages.map((source) =>
          sourceView(store, source, 0, 0)
        );
        const overhead = JSON.stringify(emptyMessages).length;
        const perMessage = Math.max(
          0,
          Math.min(
            6_000,
            Math.floor((18_000 - overhead) / Math.max(page.messages.length, 1))
          )
        );
        const messages = page.messages.map((source) =>
          sourceView(store, source, 0, perMessage, perMessage)
        );
        const scopes = [
          ...new Set(
            page.messages.map((source) => store.scopeForChat(source.chatId))
          ),
        ];
        const related = scopes.flatMap((scope) =>
          store.searchMemories({ scope, limit: 3 })
        );
        const relatedMemories = fitItems(related.map(memoryView), 6_500);
        return {
          rules: MEMORY_EXTRACTION_RULES,
          messages,
          nextCursor: page.nextCursor,
          relatedMemories,
          omittedRelatedMemories: related.length - relatedMemories.length,
          note: "旧记忆仅作比较参考，不能代替原始来源。可使用短关键词继续 memory_search；raw 信封完整保存在本机档案中。",
        };
      })
  );

  server.registerTool(
    "memory_read_source",
    {
      title: "读取单条原文片段",
      description:
        "按真实sourceId读取原文，用于核对证据或继续长消息。offset按UTF-16字符位置计数，使用返回的nextOffset继续。继续读取时必须携带上一片段的revision，版本变化应从头重读。",
      inputSchema: z
        .object({
          messageId: identifierSchema.describe("原文的sourceId，不是候选ID"),
          revision: z.number().int().positive().optional(),
          offset: z.number().int().min(0).max(2_000_000).default(0),
          length: z.number().int().min(256).max(8_000).default(6_000),
        })
        .strict(),
      annotations: readOnly,
    },
    ({ messageId, revision, offset, length }) =>
      run(() => {
        if (offset > 0 && revision === undefined) {
          throw new MemoryError(
            "继续读取原文必须提供上一片段的 revision。请重新读取首段。"
          );
        }
        const source = store.getSource(messageId);
        if (
          !source ||
          (revision !== undefined && source.revision !== revision)
        ) {
          throw new MemoryError("来源不存在或已经修改，请重新读取原文。");
        }
        if (offset > source.content.length)
          throw new MemoryError("原文读取位置超出范围，请从头读取。");
        if (
          offset > 0 &&
          /[\uDC00-\uDFFF]/u.test(source.content.charAt(offset))
        ) {
          throw new MemoryError(
            "原文读取位置落在字符中间，请使用上一片段返回的 nextOffset。"
          );
        }
        return sourceView(store, source, offset, length);
      })
  );

  server.registerTool(
    "memory_search",
    {
      title: "检索本地记忆",
      description:
        "按短关键词检索本库记忆，默认只返回有效正式条目。includeCandidates还会返回最近的未验证暂存provisionalCaptures，只供复核，不能作为来源。limit限制两个列表的总条数。候选和历史需按各自status理解；不同scope不能默认当作同一个说话人。返回的证据片段可能截断，可按messageId读取原文。",
      inputSchema: z
        .object({
          query: z.string().trim().max(200).optional(),
          includeCandidates: z.boolean().default(false),
          includeHistory: z.boolean().default(false),
          limit: z.number().int().min(1).max(20).default(5),
        })
        .strict(),
      annotations: readOnly,
    },
    (args) =>
      run(() => {
        const matches = store.searchMemories({
          ...args,
          limit: args.limit + 1,
        });
        const terms = (args.query ?? "")
          .normalize("NFKC")
          .toLocaleLowerCase()
          .split(/\s+/u)
          .filter(Boolean);
        const captureMatches = args.includeCandidates
          ? store.listCaptures().filter((capture) => {
              const searchable = `${capture.text ?? ""} ${capture.reason ?? ""}`
                .normalize("NFKC")
                .toLocaleLowerCase();
              return terms.every((term) => searchable.includes(term));
            })
          : [];
        // 显式复核候选时，为两个列表分配名额；总条数和序列化体积共同受限。
        const captureSlots = captureMatches.length
          ? Math.max(
              1,
              args.limit - Math.min(matches.length, Math.ceil(args.limit / 2))
            )
          : 0;
        const provisionalCaptures = fitItems(
          captureMatches.slice(0, captureSlots).map((capture) => ({
            id: capture.id,
            text: capture.text,
            reason: capture.reason,
            createdAt: capture.createdAt,
            status: "unverified",
            warning: CANDIDATE_WARNING,
          })),
          20_000
        );
        const memories = fitItems(
          matches
            .slice(0, args.limit - provisionalCaptures.length)
            .map(memoryView),
          28_000 - JSON.stringify(provisionalCaptures).length
        );
        return {
          memories,
          ...(args.includeCandidates ? { provisionalCaptures } : {}),
          hasMore:
            matches.length > memories.length ||
            captureMatches.length > provisionalCaptures.length,
          note: "候选不是已确认事实。暂存候选只检索最近50条，固定为unverified，不能作为原始来源。结构化记忆保留作用域、时间和来源；有更多结果时请缩小关键词或调整limit。",
        };
      })
  );

  server.registerTool(
    "memory_submit",
    {
      title: "提交有来源的记忆",
      description:
        "提交一条来源可核对的结构化记忆。引用真实sourceId、当前revision和用户逐字原话；保留否定、人物归属、时间和条件。计划、单次事件和推断进入候选。纠正需明确纠正引文及最新目标版本。requestId对同一内容重试保持不变，不同内容不可复用。",
      inputSchema: memoryProposalSchema,
      annotations: { ...write, destructiveHint: true, idempotentHint: true },
    },
    (proposal) =>
      run(() => {
        const committed = store.submit(proposal);
        return { ...committed, memory: memoryView(committed.memory) };
      })
  );

  server.registerTool(
    "memory_finish_sources",
    {
      title: "标记来源已审阅",
      description:
        "仅在完整阅读并保存必要记忆、或确认没有长期价值后，标记该来源版本已处理。截断、失败或尚未理解的消息不要标记。原始档案不会删除，改版后需再次处理。",
      inputSchema: z
        .object({
          sources: z
            .array(
              z
                .object({
                  messageId: identifierSchema,
                  revision: z.number().int().positive(),
                })
                .strict()
            )
            .min(1)
            .max(30),
          reason: z.string().trim().min(1).max(1_000),
        })
        .strict(),
      annotations: { ...write, destructiveHint: false, idempotentHint: true },
    },
    ({ sources, reason }) => run(() => store.finishSources(sources, reason))
  );

  server.registerTool(
    "memory_save_summary",
    {
      title: "保存有版本依据的概要",
      description:
        "概括同一作用域的当前正式记忆，引用每条记忆的ID和最新revision，保留否定、条件和时间；来源失效后概要也会失效。requestId仅用于同内容幂等重试。",
      inputSchema: summaryProposalSchema,
      annotations: { ...write, destructiveHint: false, idempotentHint: true },
    },
    (proposal) => run(() => store.saveSummary(proposal))
  );

  server.registerTool(
    "memory_read_summaries",
    {
      title: "读取有效概要",
      description:
        "只读取其依赖记忆仍有效且版本一致的概要；概要不是独立原始证据。",
      inputSchema: z
        .object({
          query: z.string().trim().max(200).optional(),
          limit: z.number().int().min(1).max(10).default(3),
        })
        .strict(),
      annotations: readOnly,
    },
    ({ query, limit }) =>
      run(() => {
        const matches = store
          .listSummaries()
          .filter(
            (summary) =>
              !query || `${summary.title}\n${summary.text}`.includes(query)
          );
        const summaries = fitItems(matches.slice(0, limit), 28_000);
        return { summaries, hasMore: matches.length > summaries.length };
      })
  );

  server.registerTool(
    "memory_capture_candidate",
    {
      title: "暂存未验证候选",
      description:
        "当前对话尚未同步为真实来源，或信息含糊、需要确认时，可暂存候选。候选不能进入默认事实检索，不能当作用户已确认内容，也不能用来给自己提供来源证据。",
      inputSchema: z
        .object({
          text: z.string().trim().min(1).max(2_000),
          reason: z.string().trim().min(1).max(1_000),
        })
        .strict(),
      annotations: { ...write, destructiveHint: false, idempotentHint: true },
    },
    ({ text, reason }) =>
      run(() => ({
        capture: store.captureCandidate(text, reason),
        warning: CANDIDATE_WARNING,
      }))
  );

  return server;
}
