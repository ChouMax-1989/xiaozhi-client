import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
// biome-ignore lint/nursery/useImportRestrictions: 前后端共享纯展示分类，避免聚合入口的运行时依赖。
import { getMemoryCategory } from "../types/memory-display.js";
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
  recordTurnSchema,
  summaryProposalSchema,
} from "./types.js";

const MAX_RESPONSE_CHARS = 32_000;
const MAX_RESULT_BYTES = 768;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_TTL_MS = 120_000;
const identifierSchema = z.string().min(1).max(200);
const emptySchema = z.object({}).strict();
const bulkInstruction =
  "调用 memory_read_sources(bulk:true) 整理一批。读全原文，提交值得保存的记忆，用 memory_finish_sources 标记已处理的消息。按回执继续取下一批，直到完成或暂停。";

function openingTask(store: MemoryStore) {
  return store.startBulkExtractOnChat() ? { autoExtract: bulkInstruction } : {};
}

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

function memoryView(store: MemoryStore, memory: MemoryRecord) {
  return {
    ...memory,
    category: getMemoryCategory(memory),
    sources: memory.sources.map((source) => ({
      ...source,
      origin:
        store.getSource(source.messageId, source.revision)?.origin ?? "archive",
    })),
    sourceCount: memory.sources.length,
    omittedSources: 0,
  };
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
    origin: source.origin ?? "archive",
    ...(source.assistantStage ? { assistantStage: source.assistantStage } : {}),
    ...(source.recordedAt ? { recordedAt: source.recordedAt } : {}),
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
  // SDK 会在调用处理器前生成参数错误，统一收敛以避免超长错误及参数泄露。
  const connect = server.connect.bind(server);
  server.connect = async (transport) => {
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      if (
        "result" in message &&
        message.result &&
        typeof message.result === "object"
      ) {
        const value = message.result as Record<string, unknown>;
        if (
          value.isError === true &&
          (Buffer.byteLength(JSON.stringify(value), "utf8") >
            MAX_RESULT_BYTES ||
            JSON.stringify(value).includes("Input validation error:"))
        ) {
          return send(
            {
              ...message,
              result: result(
                { error: "参数格式无效，请检查工具字段和长度。" },
                true
              ),
            },
            options
          );
        }
      }
      return send(message, options);
    };
    await connect(transport);
  };
  let snapshot:
    | {
        cursor: string;
        text: string;
        hash: string;
        version: number;
        expires: number;
        offsets: Map<number, number>;
      }
    | undefined;
  const segment = (offset: number): CallToolResult => {
    if (
      !snapshot ||
      Date.now() > snapshot.expires ||
      snapshot.version !== store.dataVersion() ||
      !snapshot.offsets.has(offset)
    ) {
      snapshot = undefined;
      throw new MemoryError(
        "续读结果已失效或位置无效，请重新调用原工具；写入重试保持原 requestId 和参数。"
      );
    }
    const current = snapshot;
    const build = (end: number) =>
      result({
        segmented: true,
        cursor: current.cursor,
        offset,
        nextOffset: end < current.text.length ? end : null,
        totalLength: current.text.length,
        sha256: current.hash,
        chunk: current.text.slice(offset, end),
      });
    let low = offset;
    let high = current.text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (
        Buffer.byteLength(JSON.stringify(build(mid)), "utf8") <=
        MAX_RESULT_BYTES
      )
        low = mid;
      else high = mid - 1;
    }
    let end = low;
    if (
      end < current.text.length &&
      /[\uD800-\uDBFF]/u.test(current.text.charAt(end - 1))
    )
      end--;
    if (end <= offset)
      throw new MemoryError("结果分段失败，请重新调用原工具。");
    const existing = current.offsets.get(offset);
    if (existing !== -1 && existing !== end)
      throw new MemoryError("结果分段位置不一致，请重新调用原工具。");
    current.offsets.set(offset, end);
    if (end < current.text.length && !current.offsets.has(end))
      current.offsets.set(end, -1);
    current.expires = Date.now() + SNAPSHOT_TTL_MS;
    return build(end);
  };
  const run = (work: () => unknown): CallToolResult => {
    try {
      snapshot = undefined;
      guard();
      const value = work();
      const response = result(value);
      if (
        Buffer.byteLength(JSON.stringify(response), "utf8") <= MAX_RESULT_BYTES
      )
        return response;
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES)
        throw new MemoryError("结果超过可续读上限，请缩小查询范围后重试。");
      snapshot = {
        cursor: randomUUID(),
        text,
        hash: createHash("sha256").update(text, "utf8").digest("hex"),
        version: store.dataVersion(),
        expires: Date.now() + SNAPSHOT_TTL_MS,
        offsets: new Map([[0, -1]]),
      };
      return segment(0);
    } catch (error) {
      return result({ error: safeMemoryError(error) }, true);
    }
  };
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, openWorldHint: false };

  server.registerTool(
    "memory_read_result",
    {
      title: "继续读取工具结果",
      description:
        "任何工具返回 segmented=true 时，先按 cursor 和 nextOffset 连续调用本工具；按 offset 拼接 chunk，直到 nextOffset 为 null，校验 totalLength（UTF-16）和 sha256（UTF-8），再解析完整 JSON。中途不要调用其他工具；失效时重试原工具，写入沿用同一 requestId 和全部参数。聚合工具名前缀以列表为准。完成传输后，原文自身 nextOffset 仍须用 memory_read_source 逐段读取。",
      inputSchema: z
        .object({
          cursor: z.string().uuid(),
          offset: z.number().int().min(0).max(MAX_SNAPSHOT_BYTES),
        })
        .strict(),
      annotations: readOnly,
    },
    ({ cursor, offset }) => {
      try {
        guard();
        if (!snapshot || cursor !== snapshot.cursor)
          throw new MemoryError("续读游标无效或已失效，请重新调用原工具。");
        return segment(offset);
      } catch (error) {
        return result({ error: safeMemoryError(error) }, true);
      }
    }
  );

  server.registerTool(
    "memory_record_turn",
    {
      title: "记录模型自报对话片段",
      description:
        "逐条提交用户、助手或工具的原样文本，跳过记忆工具自身的调用和回执。同一会话沿用 conversationId，新会话换 ID，首条附 conversationTitle。拟回复标 draft，已知最终回复标 final，其余标 unknown。每次最多8000个UTF-16单元；超长按顺序分段，每段使用不同requestId。重试相同片段使用完全相同参数。记录是模型自报，并非官方原文；不能提交智能体、端点或官方来源ID。",
      inputSchema: recordTurnSchema,
      annotations: { ...write, destructiveHint: false, idempotentHint: true },
    },
    (input) => run(() => store.recordTurn(input))
  );

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
        "默认读取尚未处理的已保存消息、来源标识及其版本，并给出同作用域旧记忆与提炼规则。afterId使用上次的nextCursor；原文过长会标明截断，需继续用memory_read_source读取。",
      inputSchema: z
        .object({
          chatId: identifierSchema
            .optional()
            .describe(
              "只读取指定会话。整理当前对话时使用 memory_record_turn 回执中的 chatId"
            ),
          afterId: identifierSchema
            .optional()
            .describe("上一页返回的nextCursor"),
          pendingOnly: z
            .boolean()
            .default(true)
            .describe("默认只读取未处理或已改版来源"),
          automatic: z
            .literal(true)
            .optional()
            .describe("开聊自动提炼时传 true，按网页开关读取一小批待整理消息"),
          bulk: z
            .literal(true)
            .optional()
            .describe(
              "网页「整理全部」任务：传 true 读取下一批，忽略游标。先完成本批再取下一批。"
            ),
          limit: z.number().int().min(1).max(12).default(4),
        })
        .strict(),
      annotations: readOnly,
    },
    (args) =>
      run(() => {
        if (!args.bulk && args.automatic && !store.getAutoExtractEnabled())
          return {
            messages: [],
            nextCursor: null,
            note: "自动提炼已关闭，继续聊天。",
          };
        const page = store.readSources(
          args.bulk
            ? { bulk: true, limit: 12 }
            : args.automatic
              ? {
                  pendingOnly: true,
                  limit: 2,
                  bulk: store.getBulkExtractStatus().active,
                }
              : args
        );
        if (args.bulk && !page.messages.length)
          return {
            messages: [],
            nextCursor: null,
            bulkExtract: store.getBulkExtractStatus(),
            note: "本次没有可领取的消息，结束整理。",
          };
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
        const relatedMemories = related.map((memory) =>
          memoryView(store, memory)
        );
        return {
          rules: MEMORY_EXTRACTION_RULES,
          messages,
          nextCursor: args.bulk ? null : page.nextCursor,
          ...(args.bulk
            ? {
                instruction:
                  "本批完整处理后调用 memory_finish_sources；若回执要求继续，仍用 bulk:true 读取下一批。",
              }
            : {}),
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
        "按短关键词及可选本地category检索本库记忆，默认只返回有效正式条目。开聊或回忆往事时设 includeCandidates:true，同时查找待核实的记忆。includeCandidates还会返回最近的未验证暂存provisionalCaptures，只供复核，不能作为来源；指定category时不返回没有分类的暂存候选。limit限制两个列表的总条数。候选和历史需按各自status理解；不同scope不能默认当作同一个说话人。返回的证据片段可能截断，可按messageId读取原文。",
      inputSchema: z
        .object({
          query: z.string().trim().max(200).optional(),
          chatStart: z
            .boolean()
            .optional()
            .describe(
              "仅在新对话第一次查记忆时传 true，同时检查有无自动提炼任务"
            ),
          category: z.enum(["user_profile", "situational"]).optional(),
          includeCandidates: z.boolean().default(false),
          includeHistory: z.boolean().default(false),
          limit: z.number().int().min(1).max(20).default(5),
        })
        .strict(),
      annotations: { ...write, destructiveHint: false },
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
        const captureMatches =
          args.includeCandidates && !args.category
            ? store.listCaptures().filter((capture) => {
                const searchable =
                  `${capture.text ?? ""} ${capture.reason ?? ""}`
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
        const provisionalCaptures = captureMatches
          .slice(0, captureSlots)
          .map((capture) => ({
            id: capture.id,
            text: capture.text,
            reason: capture.reason,
            createdAt: capture.createdAt,
            status: "unverified",
            warning: CANDIDATE_WARNING,
          }));
        const memories = matches
          .slice(0, args.limit - provisionalCaptures.length)
          .map((memory) => memoryView(store, memory));
        return {
          ...(args.chatStart ? openingTask(store) : {}),
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
        return { ...committed, memory: memoryView(store, committed.memory) };
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
    ({ sources, reason }) =>
      run(() => {
        const result = store.finishSources(sources, reason);
        const bulkExtract = store.getBulkExtractStatus();
        return {
          ...result,
          ...(bulkExtract.total > 0 ? { bulkExtract } : {}),
          ...(bulkExtract.active
            ? {
                autoExtract:
                  "继续调用 memory_read_sources(bulk:true) 取下一批。",
              }
            : {}),
        };
      })
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
        const summaries = matches.slice(0, limit);
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
