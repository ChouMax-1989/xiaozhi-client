import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
// biome-ignore lint/nursery/useImportRestrictions: 管理协议使用独立类型入口，不引入聚合模块的运行时依赖。
import type * as Admin from "../types/memory-admin.js";
// biome-ignore lint/nursery/useImportRestrictions: 与前端共用纯展示分类。
import { getMemoryCategory } from "../types/memory-display.js";
import {
  type ArchiveChat,
  type ArchiveMessage,
  type CommitResult,
  type ImportCounts,
  MemoryError,
  type MemoryOptions,
  type MemoryProposal,
  type MemoryRecord,
  type RecordTurn,
  type SourceMessage,
  type SourceReference,
  type SummaryRecord,
  memoryProposalSchema,
  recordTurnSchema,
  summaryProposalSchema,
} from "./types.js";

const archiveSchema = z
  .object({
    id: z.string().min(1).max(200),
    chatId: z.string().min(1).max(200),
    role: z.string().min(1).max(100),
    content: z.string().max(2_000_000),
    createdAt: z.string().datetime({ offset: true }).nullable(),
    raw: z.record(z.string(), z.unknown()),
  })
  .strict();

interface Snapshot {
  id: string;
  before: MemoryRecord | null;
  afterRevision: number;
}

interface Operation {
  id: string;
  kind: string;
  createdAt: string;
  snapshots: Snapshot[];
  reason?: string;
  undoneBy?: string;
}

interface PageOptions {
  query?: string;
  page?: number;
  pageSize?: number;
}

const identifierSchema = z.string().min(1).max(200);
const revisionSchema = z.number().int().positive().safe();
const supportedUndoKinds = new Set(["add", "replace", "reinforce", "retire"]);

function pagination(options: PageOptions) {
  const input = z
    .object({
      query: z.string().trim().max(500).default(""),
      page: z.number().int().positive().safe().default(1),
      pageSize: z.number().int().min(1).max(50).default(20),
    })
    .parse(options);
  const offset = (input.page - 1) * input.pageSize;
  if (!Number.isSafeInteger(offset)) {
    throw new MemoryError("页码超出有效范围，请重新选择页码。");
  }
  return { ...input, offset };
}

function sourceView(message: SourceMessage): Admin.MemorySourceView {
  return {
    id: message.id,
    chatId: message.chatId,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    sourceId: message.sourceId,
    revision: message.revision,
    processedRevision: message.processedRevision,
    origin:
      message.origin ??
      (message.sourceId.startsWith("model_msg_")
        ? "model_reported"
        : "archive"),
    ...(message.assistantStage
      ? { assistantStage: message.assistantStage }
      : {}),
    ...(message.recordedAt ? { recordedAt: message.recordedAt } : {}),
  };
}

// 对象键顺序不同不代表原始资料改变；数组顺序仍然保留。
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
      );
    }
    return item;
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function parseRow<T>(row: Record<string, unknown> | undefined): T | null {
  return row ? (JSON.parse(String(row.json)) as T) : null;
}

export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly agentId: string;
  private readonly ownerId?: string;

  constructor(
    private readonly databasePath: string,
    options: Pick<MemoryOptions, "agentId" | "ownerId">
  ) {
    this.agentId = z.string().min(1).max(200).parse(options.agentId);
    this.ownerId = options.ownerId;
    if (databasePath !== ":memory:") {
      if (!isAbsolute(databasePath))
        throw new MemoryError("记忆数据库必须使用绝对路径");
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
      if (!existsSync(databasePath))
        closeSync(openSync(databasePath, "wx", 0o600));
      if (!statSync(databasePath).isFile())
        throw new MemoryError("记忆数据库路径必须是普通文件");
      chmodSync(databasePath, 0o600);
    }
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, revision INTEGER NOT NULL,
          processed_revision INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL, fingerprint TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id);
        CREATE TABLE IF NOT EXISTS message_versions (
          id TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL,
          PRIMARY KEY (id, revision)
        );
        CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_versions (
          id TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL,
          PRIMARY KEY (id, revision)
        );
        CREATE TABLE IF NOT EXISTS memory_sources (
          memory_id TEXT NOT NULL, message_id TEXT NOT NULL, revision INTEGER NOT NULL,
          PRIMARY KEY (memory_id, message_id, revision)
        );
        CREATE INDEX IF NOT EXISTS memory_source_message ON memory_sources(message_id);
        CREATE TABLE IF NOT EXISTS summaries (id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS summary_sources (
          summary_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL,
          PRIMARY KEY (summary_id, memory_id, revision)
        );
        CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests (
          id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS captures (
          id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, json TEXT NOT NULL
        );
      `);
      this.bindMetadata("schema", "1");
      this.bindMetadata("agent", this.agentId);
      this.bindMetadata("owner", this.ownerId ?? "");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  dataVersion(): number {
    return Number(this.db.prepare("PRAGMA data_version").get()?.data_version);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  bindMetadata(key: string, value: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)")
      .run(key, value);
    const existing = this.db
      .prepare("SELECT value FROM metadata WHERE key = ?")
      .get(key);
    if (existing && existing.value !== value) {
      throw new MemoryError(
        "记忆库绑定与当前配置不一致，请使用独立数据目录或在本机核对绑定"
      );
    }
  }

  upsertChat(chat: ArchiveChat): void {
    z.object({
      id: z.string().min(1).max(200),
      raw: z.record(z.string(), z.unknown()),
    })
      .strict()
      .parse(chat);
    if (chat.id.startsWith("model_chat_"))
      throw new MemoryError("该会话标识保留给模型自报记录。");
    this.db
      .prepare(
        "INSERT INTO chats VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json"
      )
      .run(chat.id, canonical(chat));
  }

  upsertMessages(inputs: ArchiveMessage[]): ImportCounts {
    const messages = z.array(archiveSchema).max(10_000).parse(inputs);
    if (messages.some((message) => message.chatId.startsWith("model_chat_"))) {
      throw new MemoryError("该会话标识保留给模型自报记录。");
    }
    return this.transaction(() => {
      const counts: ImportCounts = { inserted: 0, updated: 0, unchanged: 0 };
      for (const input of messages) {
        const id = `msg_${digest([this.agentId, input.chatId, input.id])}`;
        const fingerprint = digest(input);
        const row = this.db
          .prepare("SELECT * FROM messages WHERE id = ?")
          .get(id);
        if (row?.fingerprint === fingerprint) {
          counts.unchanged++;
          continue;
        }
        const revision = row ? Number(row.revision) + 1 : 1;
        const message: SourceMessage = {
          ...input,
          createdAt: input.createdAt
            ? new Date(input.createdAt).toISOString()
            : null,
          sourceId: id,
          revision,
          processedRevision: row ? Number(row.processed_revision) : 0,
        };
        this.db
          .prepare("INSERT INTO message_versions VALUES (?, ?, ?)")
          .run(id, revision, canonical(message));
        this.db
          .prepare(`INSERT INTO messages(id, chat_id, revision, processed_revision, json, fingerprint)
          VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(id) DO UPDATE SET
          revision = excluded.revision, json = excluded.json, fingerprint = excluded.fingerprint`)
          .run(id, input.chatId, revision, canonical(message), fingerprint);
        if (row) {
          counts.updated++;
          this.invalidateSource(id);
        } else counts.inserted++;
      }
      return counts;
    });
  }

  recordTurn(value: RecordTurn) {
    const input = recordTurnSchema.parse(value);
    return this.transaction(() => {
      const key = `record_turn:${input.requestId}`;
      const cached = this.cachedRequest<{
        receiptId: string;
        sourceId: string;
        chatId: string;
        origin: "model_reported";
        assistantStage?: "draft" | "final" | "unknown";
      }>(key, input);
      if (cached) return { ...cached, duplicate: true };
      const chatId = `model_chat_${digest([this.agentId, input.conversationId])}`;
      const sourceId = `model_msg_${randomUUID()}`;
      const receiptId = randomUUID();
      const createdAt = new Date().toISOString();
      const existingChat = parseRow<ArchiveChat>(
        this.db.prepare("SELECT json FROM chats WHERE id = ?").get(chatId)
      );
      const previousTitle =
        typeof existingChat?.raw.title === "string"
          ? existingChat.raw.title
          : "";
      const title =
        previousTitle ||
        input.conversationTitle ||
        (input.role === "user"
          ? input.content
              .trim()
              .slice(0, 100)
              .replace(/[\uD800-\uDBFF]$/u, "")
          : "");
      const chat: ArchiveChat = {
        id: chatId,
        raw: { origin: "model_reported", ...(title ? { title } : {}) },
      };
      const message: SourceMessage = {
        id: sourceId,
        sourceId,
        chatId,
        role: input.role,
        content: input.content,
        createdAt: null,
        recordedAt: createdAt,
        origin: "model_reported",
        revision: 1,
        processedRevision: 0,
        ...(input.role === "assistant"
          ? { assistantStage: input.assistantStage ?? "unknown" }
          : {}),
        raw: {
          origin: "model_reported",
          receivedAt: createdAt,
          assistantStage:
            input.assistantStage ??
            (input.role === "assistant" ? "unknown" : null),
        },
      };
      this.db
        .prepare(
          "INSERT INTO chats VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json"
        )
        .run(chatId, canonical(chat));
      this.db
        .prepare("INSERT INTO message_versions VALUES (?, ?, ?)")
        .run(sourceId, 1, canonical(message));
      this.db
        .prepare(
          "INSERT INTO messages(id, chat_id, revision, processed_revision, json, fingerprint) VALUES (?, ?, 1, 0, ?, ?)"
        )
        .run(sourceId, chatId, canonical(message), digest(message));
      const receipt = {
        receiptId,
        sourceId,
        chatId,
        origin: "model_reported" as const,
        ...(message.assistantStage
          ? { assistantStage: message.assistantStage }
          : {}),
      };
      this.cacheRequest(key, input, receipt);
      return { ...receipt, duplicate: false };
    });
  }

  getSource(id: string, revision?: number): SourceMessage | null {
    identifierSchema.parse(id);
    if (revision !== undefined) {
      revisionSchema.parse(revision);
      // 必须命中请求的历史版本，不能拿当前正文代替旧版证据。
      const row = this.db
        .prepare(`SELECT message_versions.json, messages.processed_revision
          FROM message_versions JOIN messages ON messages.id = message_versions.id
          WHERE message_versions.id = ? AND message_versions.revision = ?`)
        .get(id, revision);
      const message = parseRow<SourceMessage>(row);
      return message
        ? { ...message, processedRevision: Number(row?.processed_revision) }
        : null;
    }
    const row = this.db
      .prepare("SELECT json, processed_revision FROM messages WHERE id = ?")
      .get(id);
    const message = parseRow<SourceMessage>(row);
    return message
      ? { ...message, processedRevision: Number(row?.processed_revision) }
      : null;
  }

  listChats(options: PageOptions = {}): Admin.MemoryPage<Admin.MemoryChatView> {
    const { query, page, pageSize, offset } = pagination(options);
    // 导入器允许先写消息；这些会话也必须能在管理页中回查。
    const chats = `WITH chat_ids AS (
      SELECT id FROM chats UNION SELECT chat_id AS id FROM messages
    ), chat_rows AS (
      SELECT chat_ids.id AS id,
        substr(COALESCE(
          CASE WHEN json_type(chats.json, '$.raw.chat_summary.title') = 'text'
            THEN NULLIF(json_extract(chats.json, '$.raw.chat_summary.title'), '') END,
          CASE WHEN json_type(chats.json, '$.raw.title') = 'text'
            THEN NULLIF(json_extract(chats.json, '$.raw.title'), '') END,
          CASE WHEN json_type(chats.json, '$.raw.name') = 'text'
            THEN NULLIF(json_extract(chats.json, '$.raw.name'), '') END,
          chat_ids.id
        ), 1, 200) AS title
      FROM chat_ids LEFT JOIN chats ON chats.id = chat_ids.id
    )`;
    const where = `(? = '' OR instr(lower(chat_rows.id || ' ' || chat_rows.title), lower(?)) > 0
      OR EXISTS (SELECT 1 FROM messages WHERE messages.chat_id = chat_rows.id
        AND instr(lower(json_extract(messages.json, '$.content')), lower(?)) > 0))`;
    const parameters = [query, query, query];
    const total = Number(
      this.db
        .prepare(
          `${chats} SELECT COUNT(*) AS count FROM chat_rows WHERE ${where}`
        )
        .get(...parameters)?.count
    );
    const items = this.db
      .prepare(`${chats} SELECT chat_rows.id, chat_rows.title,
        (SELECT COUNT(*) FROM messages WHERE chat_id = chat_rows.id) AS message_count,
        (SELECT COUNT(*) FROM messages WHERE chat_id = chat_rows.id
          AND processed_revision < revision) AS pending_count,
        (SELECT MAX(COALESCE(json_extract(json, '$.createdAt'), json_extract(json, '$.recordedAt'))) FROM messages
          WHERE chat_id = chat_rows.id) AS last_message_at,
        (SELECT substr(json_extract(json, '$.content'), 1, 200) FROM messages
          WHERE chat_id = chat_rows.id
          ORDER BY COALESCE(json_extract(json, '$.createdAt'), json_extract(json, '$.recordedAt')) DESC, rowid DESC LIMIT 1) AS preview
        FROM chat_rows WHERE ${where}
        ORDER BY last_message_at DESC, chat_rows.id LIMIT ? OFFSET ?`)
      .all(...parameters, pageSize, offset)
      .map(
        (row): Admin.MemoryChatView => ({
          id: String(row.id),
          title: String(row.title),
          messageCount: Number(row.message_count),
          pendingCount: Number(row.pending_count),
          lastMessageAt:
            typeof row.last_message_at === "string"
              ? row.last_message_at
              : null,
          preview: typeof row.preview === "string" ? row.preview : "",
        })
      );
    return { items, page, pageSize, total };
  }

  listMessages(
    options: PageOptions & { chatId?: string } = {}
  ): Admin.MemoryPage<Admin.MemorySourceView> {
    const { query, page, pageSize, offset } = pagination(options);
    const chatId = identifierSchema.optional().parse(options.chatId) ?? null;
    const where = `(? IS NULL OR chat_id = ?) AND (? = ''
      OR instr(lower(json_extract(json, '$.content')), lower(?)) > 0)`;
    const parameters = [chatId, chatId, query, query];
    const total = Number(
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${where}`)
        .get(...parameters)?.count
    );
    const items = this.db
      .prepare(`SELECT json, processed_revision FROM messages WHERE ${where}
        ORDER BY COALESCE(json_extract(json, '$.createdAt'), json_extract(json, '$.recordedAt')) DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...parameters, pageSize, offset)
      .map((row) =>
        sourceView({
          ...(parseRow<SourceMessage>(row) as SourceMessage),
          processedRevision: Number(row.processed_revision),
        })
      );
    return { items, page, pageSize, total };
  }

  scopeForChat(chatId: string): string {
    return this.ownerId ? `person:${this.ownerId}` : `chat:${chatId}:unknown`;
  }

  readSources(
    options: {
      chatId?: string;
      afterId?: string;
      limit?: number;
      pendingOnly?: boolean;
    } = {}
  ) {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
    let afterRow = 0;
    if (options.afterId) {
      const cursor = this.db
        .prepare("SELECT rowid AS position FROM messages WHERE id = ?")
        .get(options.afterId);
      if (!cursor)
        throw new MemoryError("消息游标不存在，请从本批原文开头重新读取");
      afterRow = Number(cursor.position);
    }
    const rows = this.db
      .prepare(`SELECT json, processed_revision FROM messages
      WHERE (? IS NULL OR chat_id = ?) AND rowid > ? AND (? = 0 OR processed_revision < revision)
      ORDER BY rowid LIMIT ?`)
      .all(
        options.chatId ?? null,
        options.chatId ?? null,
        afterRow,
        options.pendingOnly === false ? 0 : 1,
        limit + 1
      );
    const messages = rows.slice(0, limit).map((row) => ({
      ...(parseRow<SourceMessage>(row) as SourceMessage),
      processedRevision: Number(row.processed_revision),
    }));
    return {
      messages,
      nextCursor:
        rows.length > limit ? (messages.at(-1)?.sourceId ?? null) : null,
    };
  }

  finishSources(
    refs: { messageId: string; revision: number }[],
    reason: string
  ) {
    const validated = z
      .array(
        z
          .object({
            messageId: z.string().min(1),
            revision: z.number().int().positive(),
          })
          .strict()
      )
      .min(1)
      .max(50)
      .parse(refs);
    z.string().trim().min(1).max(1000).parse(reason);
    return this.transaction(() => {
      const requestId = `finish:${digest({ refs: validated, reason })}`;
      const cached = this.cachedRequest<{
        processed: number;
        operationId: string;
      }>(requestId, validated);
      if (cached) return cached;
      for (const ref of validated) {
        const source = this.getSource(ref.messageId);
        if (!source || source.revision !== ref.revision)
          throw new MemoryError("来源不存在或已经修改，请重新读取原文");
      }
      for (const ref of validated) {
        this.db
          .prepare("UPDATE messages SET processed_revision = ? WHERE id = ?")
          .run(ref.revision, ref.messageId);
      }
      const operationId = randomUUID();
      this.db.prepare("INSERT INTO operations VALUES (?, ?)").run(
        operationId,
        canonical({
          id: operationId,
          kind: "finish_sources",
          createdAt: new Date().toISOString(),
          sources: validated,
          reason,
          snapshots: [],
        })
      );
      const result = { processed: validated.length, operationId };
      this.cacheRequest(requestId, validated, result);
      return result;
    });
  }

  getSyncState(): Record<string, unknown> | null {
    const row = this.db
      .prepare("SELECT value FROM metadata WHERE key = 'sync'")
      .get();
    return row
      ? (JSON.parse(String(row.value)) as Record<string, unknown>)
      : null;
  }

  setSyncState(state: Record<string, unknown>): void {
    this.db
      .prepare(
        "INSERT INTO metadata VALUES ('sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(canonical(state));
  }

  getMemory(id: string): MemoryRecord | null {
    return parseRow<MemoryRecord>(
      this.db.prepare("SELECT json FROM memories WHERE id = ?").get(id)
    );
  }

  listMemories(
    options: PageOptions & {
      status?: Admin.MemoryListStatus;
      category?: "user_profile" | "situational";
    } = {}
  ): Admin.MemoryPage<MemoryRecord> {
    const { query, page, pageSize, offset } = pagination(options);
    const status = z
      .enum(["all", "active", "candidate", "inactive", "current"])
      .default("all")
      .parse(options.status);
    const now = new Date().toISOString();
    const current = `(json_extract(json, '$.status') = 'active'
      AND (json_extract(json, '$.validFrom') IS NULL OR json_extract(json, '$.validFrom') <= ?)
      AND (json_extract(json, '$.validUntil') IS NULL OR json_extract(json, '$.validUntil') > ?))`;
    const filters = [
      `(? = '' OR instr(lower(
        COALESCE(json_extract(json, '$.subject.label'), '说话人') || ' ' ||
        json_extract(json, '$.facet') || ' ' || json_extract(json, '$.value') || ' ' ||
        json_extract(json, '$.conditions') || ' ' || json_extract(json, '$.scope')
      ), lower(?)) > 0)`,
    ];
    const parameters: Array<string | number> = [query, query];
    if (status === "active" || status === "current") {
      filters.push(
        status === "current"
          ? `(${current} OR json_extract(json, '$.status') = 'candidate')`
          : current
      );
      parameters.push(now, now);
    } else if (status === "candidate") {
      filters.push("json_extract(json, '$.status') = 'candidate'");
    } else if (status === "inactive") {
      filters.push(
        `json_extract(json, '$.status') <> 'candidate' AND NOT ${current}`
      );
      parameters.push(now, now);
    }
    const where = filters.join(" AND ");
    const category = z
      .enum(["user_profile", "situational"])
      .optional()
      .parse(options.category);
    if (category) {
      const matching = this.db
        .prepare(`SELECT json FROM memories WHERE ${where}
        ORDER BY json_extract(json, '$.observedAt') DESC, id`)
        .all(...parameters)
        .map((row) => parseRow<MemoryRecord>(row) as MemoryRecord)
        .filter((memory) => getMemoryCategory(memory) === category);
      return {
        items: matching.slice(offset, offset + pageSize),
        page,
        pageSize,
        total: matching.length,
      };
    }
    const total = Number(
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM memories WHERE ${where}`)
        .get(...parameters)?.count
    );
    const items = this.db
      .prepare(`SELECT json FROM memories WHERE ${where}
        ORDER BY json_extract(json, '$.observedAt') DESC, id LIMIT ? OFFSET ?`)
      .all(...parameters, pageSize, offset)
      .map((row) => parseRow<MemoryRecord>(row) as MemoryRecord);
    return { items, page, pageSize, total };
  }

  getMemoryDetail(id: string): Admin.MemoryDetailView | null {
    identifierSchema.parse(id);
    const memory = this.getMemory(id);
    if (!memory) return null;
    const versions = this.db
      .prepare(
        "SELECT json FROM memory_versions WHERE id = ? ORDER BY revision DESC"
      )
      .all(id)
      .map((row) => parseRow<MemoryRecord>(row) as MemoryRecord);
    const references = new Map<string, SourceReference>();
    for (const version of versions) {
      for (const reference of version.sources) {
        references.set(canonical(reference), reference);
      }
    }
    const sources = Array.from(references.values()).map((reference) => {
      const message = this.getSource(reference.messageId, reference.revision);
      return {
        ...reference,
        message: message ? sourceView(message) : null,
        currentRevision: this.getSource(reference.messageId)?.revision ?? null,
      };
    });
    return { memory, versions, sources };
  }

  private allMemories(): MemoryRecord[] {
    return this.db
      .prepare("SELECT json FROM memories")
      .all()
      .map((row) => parseRow<MemoryRecord>(row) as MemoryRecord);
  }

  private isCurrent(memory: MemoryRecord): boolean {
    const now = new Date().toISOString();
    return (
      memory.status === "active" &&
      (!memory.validFrom || memory.validFrom <= now) &&
      (!memory.validUntil || memory.validUntil > now)
    );
  }

  searchMemories(
    options: {
      query?: string;
      scope?: string;
      includeCandidates?: boolean;
      includeHistory?: boolean;
      category?: "user_profile" | "situational";
      limit?: number;
    } = {}
  ): MemoryRecord[] {
    const terms = normalized(options.query ?? "")
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
    return this.allMemories()
      .filter((memory) => {
        if (options.scope && memory.scope !== options.scope) return false;
        if (options.category && getMemoryCategory(memory) !== options.category)
          return false;
        if (
          !this.isCurrent(memory) &&
          !(options.includeCandidates && memory.status === "candidate") &&
          !options.includeHistory
        )
          return false;
        const searchable = normalized(
          `${memory.subject.label ?? "说话人"} ${memory.facet} ${memory.value} ${memory.conditions}`
        ).toLocaleLowerCase();
        return terms.every((term) => searchable.includes(term));
      })
      .sort(
        (a, b) =>
          (b.observedAt ?? "").localeCompare(a.observedAt ?? "") ||
          a.id.localeCompare(b.id)
      )
      .slice(0, limit);
  }

  private validateSources(refs: SourceReference[]): SourceMessage[] {
    return refs.map((ref) => {
      const source = this.getSource(ref.messageId);
      if (!source)
        throw new MemoryError(
          "来源尚未同步或不存在，请先读取存档，不能编造消息 ID"
        );
      if (source.revision !== ref.revision)
        throw new MemoryError("来源版本已改变，请重新提炼");
      if (!source.content.includes(ref.quote))
        throw new MemoryError("证据引文与原文不一致");
      return source;
    });
  }

  private sameSlot(a: MemoryRecord, b: MemoryRecord): boolean {
    return (
      a.scope === b.scope &&
      canonical(a.subject) === canonical(b.subject) &&
      normalized(a.facet) === normalized(b.facet) &&
      normalized(a.conditions) === normalized(b.conditions)
    );
  }

  private sameFact(a: MemoryRecord, b: MemoryRecord): boolean {
    return (
      this.sameSlot(a, b) &&
      normalized(a.value) === normalized(b.value) &&
      a.assertion === b.assertion &&
      a.validFrom === b.validFrom &&
      a.validUntil === b.validUntil
    );
  }

  private writeMemory(memory: MemoryRecord): void {
    this.db
      .prepare("INSERT INTO memory_versions VALUES (?, ?, ?)")
      .run(memory.id, memory.revision, canonical(memory));
    this.db
      .prepare(
        "INSERT INTO memories VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json"
      )
      .run(memory.id, canonical(memory));
    this.db
      .prepare("DELETE FROM memory_sources WHERE memory_id = ?")
      .run(memory.id);
    for (const source of memory.sources) {
      this.db
        .prepare("INSERT OR IGNORE INTO memory_sources VALUES (?, ?, ?)")
        .run(memory.id, source.messageId, source.revision);
    }
    this.invalidateSummaries(memory.id);
  }

  private invalidateSummaries(memoryId: string): void {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT summary_id FROM summary_sources WHERE memory_id = ?"
      )
      .all(memoryId);
    for (const row of rows) {
      const summary = parseRow<SummaryRecord>(
        this.db
          .prepare("SELECT json FROM summaries WHERE id = ?")
          .get(String(row.summary_id))
      );
      if (summary?.status === "active") {
        summary.status = "invalidated";
        this.db
          .prepare("UPDATE summaries SET json = ? WHERE id = ?")
          .run(canonical(summary), summary.id);
      }
    }
  }

  private invalidateSource(messageId: string): void {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT memory_id FROM memory_sources WHERE message_id = ?"
      )
      .all(messageId);
    for (const row of rows) {
      const memory = this.getMemory(String(row.memory_id));
      if (memory && !["invalidated", "retracted"].includes(memory.status)) {
        this.writeMemory({
          ...memory,
          revision: memory.revision + 1,
          status: "invalidated",
          reason: "来源消息已改变，等待重新提炼",
        });
      }
    }
  }

  private cachedRequest<T>(requestId: string, input: unknown): T | null {
    const row = this.db
      .prepare("SELECT * FROM requests WHERE id = ?")
      .get(requestId);
    if (!row) return null;
    if (row.json === '{"deleted":true}')
      throw new MemoryError("该请求涉及已删除记忆，不能重试恢复。");
    if (row.fingerprint !== digest(input))
      throw new MemoryError("请求标识已用于不同内容，请创建新的请求标识");
    return parseRow<T>(row);
  }

  private cacheRequest(
    requestId: string,
    input: unknown,
    result: unknown
  ): void {
    this.db
      .prepare("INSERT INTO requests VALUES (?, ?, ?)")
      .run(requestId, digest(input), canonical(result));
  }

  private prepareMemory(input: MemoryProposal): MemoryRecord {
    const sources = this.validateSources(input.sources);
    const roles = new Set(sources.map((source) => source.role));
    if (
      roles.has("tool") ||
      Array.from(roles).some((role) => !["user", "assistant"].includes(role))
    ) {
      throw new MemoryError("工具和未知角色消息不能作为人物记忆的依据");
    }
    if (input.assertion === "assistant_suggestion") {
      if (!roles.has("assistant"))
        throw new MemoryError("助手建议必须引用助手原话");
    } else if (roles.has("assistant") || !roles.has("user")) {
      throw new MemoryError(
        "人物记忆只能引用用户原话，不能把助手建议当作用户确认"
      );
    }
    if (input.subject.kind !== "speaker" && !input.subject.label)
      throw new MemoryError("相关人物或实体必须提供明确名称");
    if (input.subject.kind === "speaker" && input.subject.label)
      throw new MemoryError("说话人身份由本地配置确定，不能由模型命名");
    const chats = new Set(sources.map((source) => source.chatId));
    if (!this.ownerId && chats.size !== 1)
      throw new MemoryError("说话人未确认，不能跨会话合并身份");
    const knownTimes = sources
      .map((source) => source.createdAt)
      .filter((time): time is string => time !== null);
    const observedAt =
      knownTimes.length === sources.length
        ? (knownTimes.sort().at(-1) ?? null)
        : null;
    const validFrom = input.validFrom
      ? new Date(input.validFrom).toISOString()
      : null;
    const validUntil = input.validUntil
      ? new Date(input.validUntil).toISOString()
      : null;
    if (validFrom && validUntil && validUntil <= validFrom)
      throw new MemoryError("记忆结束时间必须晚于开始时间");
    const now = new Date().toISOString();
    let status: MemoryRecord["status"] = "active";
    if (
      ["inferred", "assistant_suggestion"].includes(input.assertion) ||
      !observedAt ||
      observedAt > now
    )
      status = "candidate";
    if (["event", "plan"].includes(input.assertion)) status = "candidate";
    if (validFrom && validFrom > now) status = "candidate";
    if (validUntil && validUntil <= now) status = "historical";
    return {
      id: randomUUID(),
      revision: 1,
      scope: this.scopeForChat(sources[0].chatId),
      subject: input.subject,
      facet: input.facet,
      value: input.value,
      assertion:
        input.subject.kind === "related_person" &&
        input.assertion === "explicit"
          ? "reported"
          : input.assertion,
      conditions: input.conditions,
      status,
      observedAt,
      validFrom,
      validUntil,
      sources: Array.from(
        new Map(input.sources.map((ref) => [canonical(ref), ref])).values()
      ),
      reason: input.reason,
      supersedes: null,
      createdAt: now,
    };
  }

  submit(raw: MemoryProposal): CommitResult {
    const input = memoryProposalSchema.parse(raw);
    return this.transaction(() => {
      const cached = this.cachedRequest<CommitResult>(input.requestId, input);
      if (cached)
        return {
          ...cached,
          memory: this.getMemory(cached.memory.id) ?? cached.memory,
        };
      let memory = this.prepareMemory(input);
      const snapshots: Snapshot[] = [];
      let outcome: CommitResult["outcome"] = "created";
      const target = input.targetId ? this.getMemory(input.targetId) : null;
      if (input.operation !== "add") {
        if (
          !target ||
          target.revision !== input.targetRevision ||
          target.status !== "active"
        ) {
          throw new MemoryError("目标记忆不存在、已改变或不可修改，请重新读取");
        }
        if (!this.sameSlot(memory, target))
          throw new MemoryError("不同主体、属性或条件的记忆不能互相覆盖");
      } else if (
        input.targetId ||
        input.targetRevision ||
        input.correctionQuote
      ) {
        throw new MemoryError("新增记忆不能附带覆盖目标");
      }
      if (input.operation === "reinforce" && target) {
        if (!this.sameFact(memory, target))
          throw new MemoryError("补证必须是同一事实，内容变化请提交纠正或候选");
        if (memory.status !== "active") {
          throw new MemoryError(
            "新证据的时间或性质尚未确认，请新增为独立候选，不能补入当前事实"
          );
        }
        const combined = Array.from(
          new Map(
            [...target.sources, ...memory.sources].map((ref) => [
              canonical(ref),
              ref,
            ])
          ).values()
        );
        if (canonical(combined) === canonical(target.sources)) {
          memory = target;
          outcome = "duplicate";
        } else {
          memory = {
            ...target,
            revision: target.revision + 1,
            sources: combined,
            observedAt:
              [target.observedAt, memory.observedAt]
                .filter((time): time is string => time !== null)
                .sort()
                .at(-1) ?? null,
          };
          snapshots.push({
            id: target.id,
            before: target,
            afterRevision: memory.revision,
          });
          this.writeMemory(memory);
          outcome = "reinforced";
        }
      } else if (input.operation === "replace" && target) {
        if (
          !input.correctionQuote ||
          !input.sources.some((ref) =>
            ref.quote.includes(input.correctionQuote ?? "")
          )
        ) {
          throw new MemoryError("纠正必须提供包含在用户证据中的明确纠正原话");
        }
        // 纠正时间只取真正包含纠正引文的消息，不能靠附加一条新消息抬高旧证据的时间。
        const correctionTimes = input.sources
          .filter((ref) => ref.quote.includes(input.correctionQuote ?? ""))
          .map((ref) => this.getSource(ref.messageId)?.createdAt ?? null);
        memory.observedAt = correctionTimes.every((time) => time !== null)
          ? (correctionTimes
              .filter((time): time is string => time !== null)
              .sort()
              .at(-1) ?? null)
          : null;
        if (
          memory.status !== "active" ||
          !memory.observedAt ||
          !target.observedAt
        ) {
          memory.status = "candidate";
          outcome = "candidate";
        } else if (
          memory.observedAt < target.observedAt ||
          (memory.validFrom &&
            target.validFrom &&
            memory.validFrom < target.validFrom)
        ) {
          memory.status = "historical";
          outcome = "historical";
        } else if (memory.observedAt === target.observedAt) {
          memory.status = "candidate";
          outcome = "candidate";
        } else {
          const superseded = {
            ...target,
            revision: target.revision + 1,
            status: "superseded" as const,
          };
          snapshots.push({
            id: target.id,
            before: target,
            afterRevision: superseded.revision,
          });
          this.writeMemory(superseded);
          memory.supersedes = target.id;
          outcome = "replaced";
        }
        snapshots.push({ id: memory.id, before: null, afterRevision: 1 });
        this.writeMemory(memory);
      } else {
        const peers = this.allMemories().filter(
          (item) =>
            this.sameSlot(item, memory) &&
            ["active", "candidate", "historical"].includes(item.status)
        );
        const duplicate = peers.find(
          (item) => item.status === memory.status && this.sameFact(item, memory)
        );
        if (duplicate) {
          const observedAt = memory.observedAt;
          const combined = Array.from(
            new Map(
              [...duplicate.sources, ...memory.sources].map((ref) => [
                canonical(ref),
                ref,
              ])
            ).values()
          );
          memory = duplicate;
          outcome = "duplicate";
          if (canonical(combined) !== canonical(duplicate.sources)) {
            memory = {
              ...duplicate,
              revision: duplicate.revision + 1,
              sources: combined,
              observedAt:
                [duplicate.observedAt, observedAt]
                  .filter((time): time is string => time !== null)
                  .sort()
                  .at(-1) ?? null,
            };
            snapshots.push({
              id: duplicate.id,
              before: duplicate,
              afterRevision: memory.revision,
            });
            this.writeMemory(memory);
            outcome = "reinforced";
          }
        } else {
          if (
            peers.some((item) => this.isCurrent(item)) &&
            memory.status === "active"
          ) {
            memory.status = "candidate";
            memory.reason = `${memory.reason}；同一属性存在不同内容，等待明确纠正`;
          }
          if (memory.status === "candidate") outcome = "candidate";
          if (memory.status === "historical") outcome = "historical";
          snapshots.push({ id: memory.id, before: null, afterRevision: 1 });
          this.writeMemory(memory);
        }
      }
      const operation: Operation = {
        id: randomUUID(),
        kind: input.operation,
        createdAt: new Date().toISOString(),
        snapshots,
      };
      this.db
        .prepare("INSERT INTO operations VALUES (?, ?)")
        .run(operation.id, canonical(operation));
      const result = { operationId: operation.id, outcome, memory };
      this.cacheRequest(input.requestId, input, result);
      return result;
    });
  }

  saveSummary(raw: z.infer<typeof summaryProposalSchema>): SummaryRecord {
    const input = summaryProposalSchema.parse(raw);
    return this.transaction(() => {
      const cached = this.cachedRequest<SummaryRecord>(input.requestId, input);
      if (cached)
        return (
          parseRow<SummaryRecord>(
            this.db
              .prepare("SELECT json FROM summaries WHERE id = ?")
              .get(cached.id)
          ) ?? cached
        );
      const memories = input.memories.map((ref) => {
        const memory = this.getMemory(ref.id);
        if (
          !memory ||
          memory.revision !== ref.revision ||
          !this.isCurrent(memory)
        )
          throw new MemoryError("概要引用了过期或无效记忆");
        return memory;
      });
      if (new Set(memories.map((memory) => memory.scope)).size !== 1)
        throw new MemoryError("概要不能合并身份未确认的不同会话");
      const summary: SummaryRecord = {
        ...input,
        id: randomUUID(),
        scope: memories[0].scope,
        status: "active",
        createdAt: new Date().toISOString(),
      };
      this.db
        .prepare("INSERT INTO summaries VALUES (?, ?)")
        .run(summary.id, canonical(summary));
      for (const ref of input.memories) {
        this.db
          .prepare("INSERT OR IGNORE INTO summary_sources VALUES (?, ?, ?)")
          .run(summary.id, ref.id, ref.revision);
      }
      this.cacheRequest(input.requestId, input, summary);
      return summary;
    });
  }

  private isCurrentSummary(summary: SummaryRecord): boolean {
    return (
      summary.status === "active" &&
      summary.memories.every((ref) => {
        const memory = this.getMemory(ref.id);
        return memory?.revision === ref.revision && this.isCurrent(memory);
      })
    );
  }

  listSummaries(): SummaryRecord[] {
    return this.db
      .prepare("SELECT json FROM summaries")
      .all()
      .map((row) => parseRow<SummaryRecord>(row) as SummaryRecord)
      .filter((summary) => this.isCurrentSummary(summary));
  }

  listAdminSummaries(limit = 100): SummaryRecord[] {
    z.number().int().min(1).max(100).parse(limit);
    return this.db
      .prepare("SELECT json FROM summaries ORDER BY rowid DESC LIMIT ?")
      .all(limit)
      .map((row) => {
        const summary = parseRow<SummaryRecord>(row) as SummaryRecord;
        // 到期不触发隐式写入，但管理界面不能继续把不可用的概要标为有效。
        return summary.status === "active" && !this.isCurrentSummary(summary)
          ? { ...summary, status: "invalidated" as const }
          : summary;
      });
  }

  captureCandidate(text: string, reason: string) {
    z.string().trim().min(1).max(2000).parse(text);
    z.string().trim().min(1).max(1000).parse(reason);
    const fingerprint = digest(normalized(text));
    const existing = this.db
      .prepare("SELECT json FROM captures WHERE fingerprint = ?")
      .get(fingerprint);
    if (existing)
      return parseRow<Record<string, unknown>>(existing) as Record<
        string,
        unknown
      >;
    const capture = {
      id: randomUUID(),
      text,
      reason,
      status: "unverified",
      createdAt: new Date().toISOString(),
      warning: "仅为模型暂存候选，不能作为原始消息证据",
    };
    this.db
      .prepare("INSERT INTO captures VALUES (?, ?, ?)")
      .run(capture.id, fingerprint, canonical(capture));
    return capture;
  }

  listCaptures(): Record<string, unknown>[] {
    return this.db
      .prepare("SELECT json FROM captures ORDER BY rowid DESC LIMIT 50")
      .all()
      .map(
        (row) =>
          parseRow<Record<string, unknown>>(row) as Record<string, unknown>
      );
  }

  operations(limit = 20): Operation[] {
    return this.db
      .prepare("SELECT json FROM operations ORDER BY rowid DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 100)))
      .map((row) => parseRow<Operation>(row) as Operation);
  }

  listAdminOperations(limit = 20): Admin.MemoryOperationView[] {
    z.number().int().min(1).max(100).parse(limit);
    return this.operations(limit).map((operation) => {
      let canUndo =
        supportedUndoKinds.has(operation.kind) &&
        !operation.undoneBy &&
        operation.snapshots.length > 0;
      if (canUndo) {
        for (const snapshot of operation.snapshots) {
          if (
            this.getMemory(snapshot.id)?.revision !== snapshot.afterRevision
          ) {
            canUndo = false;
            break;
          }
          // 与真正撤销使用相同证据保护，避免显示实际不能执行的恢复按钮。
          if (snapshot.before) {
            try {
              this.validateSources(snapshot.before.sources);
            } catch (error) {
              if (!(error instanceof MemoryError)) throw error;
              canUndo = false;
              break;
            }
          }
        }
      }
      return {
        id: operation.id,
        kind: operation.kind,
        createdAt: operation.createdAt,
        ...(operation.reason ? { reason: operation.reason } : {}),
        ...(operation.undoneBy ? { undoneBy: operation.undoneBy } : {}),
        canUndo,
        memoryIds: operation.snapshots.map((snapshot) => snapshot.id),
      };
    });
  }

  deleteMemory(id: string, revision: number): { deleted: true; id: string } {
    identifierSchema.parse(id);
    revisionSchema.parse(revision);
    return this.transaction(() => {
      const memory = this.getMemory(id);
      if (!memory) throw new MemoryError("记忆不存在或已删除。");
      if (memory.revision !== revision)
        throw new MemoryError("目标记忆版本已改变，请刷新后重试。");
      const summaries = this.db
        .prepare(
          "SELECT DISTINCT summary_id FROM summary_sources WHERE memory_id = ?"
        )
        .all(id)
        .map((row) => String(row.summary_id));
      for (const summaryId of summaries) {
        this.db
          .prepare("DELETE FROM summary_sources WHERE summary_id = ?")
          .run(summaryId);
        this.db.prepare("DELETE FROM summaries WHERE id = ?").run(summaryId);
      }
      this.db.prepare("DELETE FROM memory_sources WHERE memory_id = ?").run(id);
      this.db.prepare("DELETE FROM memory_versions WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      this.db
        .prepare("DELETE FROM operations WHERE instr(json, ?) > 0")
        .run(id);
      for (const target of [id, ...summaries]) {
        this.db
          .prepare("UPDATE requests SET json = ? WHERE instr(json, ?) > 0")
          .run('{"deleted":true}', target);
      }
      const operationId = randomUUID();
      this.db.prepare("INSERT INTO operations VALUES (?, ?)").run(
        operationId,
        canonical({
          id: operationId,
          kind: "delete",
          targetId: id,
          createdAt: new Date().toISOString(),
          snapshots: [],
        })
      );
      return { deleted: true, id };
    });
  }

  retire(
    id: string,
    revision: number,
    reason: string
  ): { operationId: string; memory: MemoryRecord } {
    identifierSchema.parse(id);
    revisionSchema.parse(revision);
    const explanation = z.string().trim().min(1).max(1000).parse(reason);
    return this.transaction(() => {
      const before = this.getMemory(id);
      if (!before || before.revision !== revision) {
        throw new MemoryError("目标记忆不存在或版本已改变，请刷新后重试。");
      }
      if (!["active", "candidate"].includes(before.status)) {
        throw new MemoryError("这条记忆已不再生效，无需重复停用。");
      }
      const memory: MemoryRecord = {
        ...before,
        revision: before.revision + 1,
        status: "retracted",
        reason: explanation,
      };
      this.writeMemory(memory);
      const operation: Operation = {
        id: randomUUID(),
        kind: "retire",
        createdAt: new Date().toISOString(),
        reason: explanation,
        snapshots: [{ id, before, afterRevision: memory.revision }],
      };
      this.db
        .prepare("INSERT INTO operations VALUES (?, ?)")
        .run(operation.id, canonical(operation));
      return { operationId: operation.id, memory };
    });
  }

  undo(operationId: string) {
    return this.transaction(() => {
      const operation = parseRow<Operation>(
        this.db
          .prepare("SELECT json FROM operations WHERE id = ?")
          .get(operationId)
      );
      if (!operation || !supportedUndoKinds.has(operation.kind))
        throw new MemoryError("该操作不存在或不支持撤销");
      if (operation.undoneBy)
        return { operationId: operation.undoneBy, alreadyUndone: true };
      for (const snapshot of operation.snapshots) {
        const current = this.getMemory(snapshot.id);
        if (!current || current.revision !== snapshot.afterRevision)
          throw new MemoryError("记忆已有后续修改，不能覆盖后续操作");
        if (snapshot.before) this.validateSources(snapshot.before.sources);
      }
      for (const snapshot of operation.snapshots) {
        const current = this.getMemory(snapshot.id) as MemoryRecord;
        this.writeMemory(
          snapshot.before
            ? { ...snapshot.before, revision: current.revision + 1 }
            : {
                ...current,
                revision: current.revision + 1,
                status: "retracted",
                reason: "本机管理员已撤销",
              }
        );
      }
      const id = randomUUID();
      operation.undoneBy = id;
      this.db
        .prepare("UPDATE operations SET json = ? WHERE id = ?")
        .run(canonical(operation), operation.id);
      this.db.prepare("INSERT INTO operations VALUES (?, ?)").run(
        id,
        canonical({
          id,
          kind: "undo",
          createdAt: new Date().toISOString(),
          target: operation.id,
          snapshots: [],
        })
      );
      return {
        operationId: id,
        restored: operation.snapshots.length,
        alreadyUndone: false,
      };
    });
  }

  getAutoExtractEnabled(): boolean {
    return (
      this.db
        .prepare("SELECT value FROM metadata WHERE key = 'autoExtract'")
        .get()?.value === "1"
    );
  }

  setAutoExtractEnabled(enabled: boolean): void {
    this.db
      .prepare(
        "INSERT INTO metadata(key, value) VALUES ('autoExtract', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(enabled ? "1" : "0");
  }

  hasPendingSources(): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM messages WHERE processed_revision < revision LIMIT 1"
        )
        .get()
    );
  }

  status() {
    const count = (table: string) =>
      Number(
        this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count
      );
    return {
      agentId: this.agentId,
      autoExtractEnabled: this.getAutoExtractEnabled(),
      identityMode: this.ownerId
        ? "explicit_single_person"
        : "unknown_per_chat",
      chats: Number(
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM (SELECT id FROM chats UNION SELECT chat_id AS id FROM messages)"
          )
          .get()?.count
      ),
      messages: count("messages"),
      pendingMessages: Number(
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM messages WHERE processed_revision < revision"
          )
          .get()?.count
      ),
      memories: count("memories"),
      activeMemories: this.allMemories().filter((memory) =>
        this.isCurrent(memory)
      ).length,
      candidates: this.allMemories().filter(
        (memory) => memory.status === "candidate"
      ).length,
      provisionalCaptures: count("captures"),
      summaries: this.listSummaries().length,
      sync: this.getSyncState(),
    };
  }

  exportData() {
    const rows = (table: string) =>
      this.db
        .prepare(`SELECT json FROM ${table}`)
        .all()
        .map((row) => JSON.parse(String(row.json)) as unknown);
    return {
      schema: 1,
      exportedAt: new Date().toISOString(),
      agentId: this.agentId,
      chats: rows("chats"),
      messages: rows("messages"),
      messageVersions: rows("message_versions"),
      memories: rows("memories"),
      memoryVersions: rows("memory_versions"),
      summaries: rows("summaries"),
      operations: rows("operations"),
      captures: rows("captures"),
    };
  }

  backup(destination: string): void {
    if (
      !isAbsolute(destination) ||
      resolve(destination) === resolve(this.databasePath) ||
      existsSync(destination)
    ) {
      throw new MemoryError(
        "备份必须使用不存在的绝对路径，不能覆盖正在使用的数据库"
      );
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    // VACUUM INTO 在同一 SQLite 快照内包含 WAL 内容，不能直接复制主文件。
    this.db.prepare("VACUUM INTO ?").run(destination);
    chmodSync(destination, 0o600);
  }

  rebindEndpoint(fingerprint: string): { rebound: true; operationId: string } {
    if (!/^[a-f0-9]{64}$/.test(fingerprint))
      throw new MemoryError("端点指纹无效");
    return this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO metadata VALUES ('endpoint', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(fingerprint);
      const operationId = randomUUID();
      this.db.prepare("INSERT INTO operations VALUES (?, ?)").run(
        operationId,
        canonical({
          id: operationId,
          kind: "rebind_endpoint",
          createdAt: new Date().toISOString(),
          snapshots: [],
        })
      );
      return { rebound: true, operationId };
    });
  }
}
