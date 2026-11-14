import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkClientBinding } from "../config.js";
import { createMemoryServer } from "../mcp.js";
import {
  MEMORY_EXTRACTION_RULES,
  MEMORY_SERVER_INSTRUCTIONS,
} from "../prompts.js";
import { MemoryStore } from "../store.js";
import type {
  ArchiveMessage,
  MemoryOptions,
  MemoryProposal,
} from "../types.js";

interface SourceView {
  sourceId: string;
  revision: number;
  content: string;
  contentLength: number;
  contentOffset: number;
  truncated: boolean;
  nextOffset: number | null;
  warning?: string;
}

function decoded<T>(response: CallToolResult): T {
  const text = response.content.find((item) => item.type === "text");
  if (!text || text.type !== "text") throw new Error("测试未收到文本响应");
  return JSON.parse(text.text) as T;
}

function responseText(response: CallToolResult): string {
  return response.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
}

describe("本地记忆 MCP 真实协议集成", () => {
  let directory: string;
  let store: MemoryStore;
  let server: ReturnType<typeof createMemoryServer>;
  let client: Client;
  let guard: ReturnType<typeof vi.fn>;
  let options: MemoryOptions;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "xiaozhi-memory-mcp-"));
    const clientConfigPath = join(directory, "client.json");
    writeFileSync(
      clientConfigPath,
      JSON.stringify({
        mcpEndpoint: "wss://example.test/mcp?token=test-endpoint-one",
      }),
      { mode: 0o600 }
    );
    options = {
      agentId: "测试智能体",
      databasePath: join(directory, "memory.sqlite"),
      clientConfigPath,
      syncIntervalSeconds: 0,
    };
    store = new MemoryStore(options.databasePath, options);
    guard = vi.fn(() =>
      checkClientBinding(options, (key, value) =>
        store.bindMetadata(key, value)
      )
    );
    server = createMemoryServer(store, guard);
    client = new Client({ name: "memory-protocol-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const archive = (
    id: string,
    content: string,
    changes: Partial<ArchiveMessage> = {}
  ): ArchiveMessage => ({
    id,
    chatId: "会话甲",
    role: "user",
    content,
    createdAt: "2026-01-01T08:00:00.000Z",
    raw: { content },
    ...changes,
  });

  const callRaw = async (
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<CallToolResult> =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;

  const call = async (
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<CallToolResult> => {
    let response = await callRaw(name, args);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(
      768
    );
    if (response.isError) return response;
    let part = decoded<{
      segmented?: boolean;
      cursor: string;
      offset: number;
      nextOffset: number | null;
      totalLength: number;
      sha256: string;
      chunk: string;
    }>(response);
    if (!part.segmented) return response;
    const { cursor, totalLength, sha256 } = part;
    let assembled = "";
    for (;;) {
      expect(part.offset).toBe(assembled.length);
      expect(part.sha256).toBe(sha256);
      assembled += part.chunk;
      if (part.nextOffset === null) break;
      response = await callRaw("memory_read_result", {
        cursor,
        offset: part.nextOffset,
      });
      expect(response.isError).not.toBe(true);
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(
        768
      );
      part = decoded(response);
    }
    expect(assembled.length).toBe(totalLength);
    expect(createHash("sha256").update(assembled, "utf8").digest("hex")).toBe(
      sha256
    );
    return { content: [{ type: "text", text: assembled }] };
  };

  function proposal(
    sourceId: string,
    quote: string,
    changes: Partial<MemoryProposal> = {}
  ): MemoryProposal {
    return {
      requestId: "测试稳定请求-0001",
      operation: "add",
      subject: { kind: "speaker" },
      facet: "咖啡偏好",
      value: "喝咖啡不加糖",
      assertion: "explicit",
      conditions: "",
      sources: [{ messageId: sourceId, revision: 1, quote }],
      reason: "用户明确表达了长期偏好",
      ...changes,
    };
  }

  it("通过真实客户端列出十一个严格工具且不开放管理权限", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(11);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^memory_/u);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toEqual(
        expect.arrayContaining(["agentId"])
      );
      for (const forbidden of [
        "agentId",
        "ownerId",
        "scope",
        "databasePath",
        "token",
        "file",
      ]) {
        expect(tool.inputSchema.properties).not.toHaveProperty(forbidden);
      }
    }
    expect(tools.map((tool) => tool.name).join(" ")).not.toMatch(
      /import|undo|backup|sync|rebind/u
    );
    const status = await call("memory_status");
    expect(status.isError).not.toBe(true);
    expect(decoded<{ messages: number }>(status).messages).toBe(0);
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it("拒绝越权额外字段、嵌套额外字段和超长检索词", async () => {
    store.upsertMessages([archive("消息甲", "我喝咖啡不加糖。")]);
    const source = store.readSources().messages[0];
    const valid = proposal(source.sourceId, source.content);
    const malicious = await call("memory_submit", {
      ...valid,
      scope: "person:另一人",
      agentId: "另一智能体",
    });
    expect(malicious.isError).toBe(true);
    const nested = await call("memory_submit", {
      ...valid,
      sources: [{ ...valid.sources[0], originalText: "伪造内容" }],
    });
    expect(nested.isError).toBe(true);
    const token = "不能回显的凭据正文";
    const extra = await call("memory_status", { token });
    expect(extra.isError).toBe(true);
    expect(responseText(extra)).not.toContain(token);
    expect(
      (await call("memory_search", { query: "词".repeat(201) })).isError
    ).toBe(true);
    expect((await call("memory_read_sources", { limit: 13 })).isError).toBe(
      true
    );
    expect(store.status().memories).toBe(0);
  });

  it("新对话按网页开关分批整理旧消息，中断后继续且不重复读取已完成的版本", async () => {
    const opening = async () =>
      decoded(await call("memory_search", { chatStart: true }));
    const batch = async () =>
      decoded<{ messages: SourceView[] }>(
        await call("memory_read_sources", { automatic: true })
      );
    const admin = new MemoryStore(options.databasePath, options);
    try {
      store.upsertMessages([
        archive("甲", "我喝咖啡不加糖。"),
        archive("乙", "好的。"),
        archive("丙", "明天见。"),
      ]);
      expect(await opening()).not.toHaveProperty("autoExtract");
      expect((await batch()).messages).toHaveLength(0);
      admin.setAutoExtractEnabled(true);
      expect(decoded(await call("memory_search"))).not.toHaveProperty(
        "autoExtract"
      );
      expect(await opening()).toHaveProperty("autoExtract");
      const first = (await batch()).messages;
      expect(first).toHaveLength(2);
      expect(
        (
          await call(
            "memory_submit",
            proposal(first[0].sourceId, first[0].content)
          )
        ).isError
      ).not.toBe(true);
      const finish = (messages: SourceView[]) =>
        call("memory_finish_sources", {
          sources: messages.map(({ sourceId, revision }) => ({
            messageId: sourceId,
            revision,
          })),
          reason: "已读完并保存值得记住的内容",
        });
      expect((await finish(first.slice(0, 1))).isError).not.toBe(true);
      expect(await opening()).toHaveProperty("autoExtract");
      admin.setAutoExtractEnabled(false);
      expect((await batch()).messages).toHaveLength(0);
      expect(
        decoded<{ messages: SourceView[] }>(await call("memory_read_sources"))
          .messages
      ).toHaveLength(2);
      admin.setAutoExtractEnabled(true);
      const remaining = (await batch()).messages;
      expect(remaining.map(({ content }) => content)).toEqual([
        "好的。",
        "明天见。",
      ]);
      expect((await finish(remaining)).isError).not.toBe(true);
      expect(await opening()).not.toHaveProperty("autoExtract");
      expect(store.status().memories).toBe(1);
    } finally {
      admin.close();
    }
  });

  it("整理全部在同一对话中接力下一批，暂停后不领取，完成后停止提示", async () => {
    const messages = Array.from({ length: 13 }, (_, i) =>
      archive(String(i), i ? "你好" : "我喝咖啡不加糖。")
    );
    store.upsertMessages(messages);
    store.setBulkExtractEnabled(true);
    const read = async () =>
      decoded<{ messages: SourceView[] }>(
        await call("memory_read_sources", { bulk: true })
      ).messages;
    const finish = async (messages: SourceView[]) =>
      decoded(
        await call("memory_finish_sources", {
          sources: messages.map(({ sourceId, revision }) => ({
            messageId: sourceId,
            revision,
          })),
          reason: "已审阅",
        })
      );
    expect(
      decoded(await call("memory_search", { chatStart: true }))
    ).toMatchObject({ autoExtract: expect.stringContaining("bulk:true") });
    const batch = await read();
    expect(batch).toHaveLength(12);
    const proposalInput = proposal(batch[0].sourceId, batch[0].content);
    expect((await call("memory_submit", proposalInput)).isError).not.toBe(true);
    expect(await finish(batch)).toMatchObject({
      autoExtract: expect.stringContaining("bulk:true"),
      bulkExtract: { remaining: 1 },
    });
    store.setBulkExtractEnabled(false);
    expect(await read()).toEqual([]);
    store.setAutoExtractEnabled(true);
    expect(
      decoded(await call("memory_search", { chatStart: true }))
    ).not.toHaveProperty("autoExtract");
    expect(
      decoded<{ messages: SourceView[] }>(
        await call("memory_read_sources", { automatic: true })
      ).messages
    ).toEqual([]);
    store.setBulkExtractEnabled(true);
    const last = await read();
    expect(last).toHaveLength(1);
    expect(await finish(last)).not.toHaveProperty("autoExtract");
    expect(await read()).toEqual([]);
    expect(
      decoded(await call("memory_search", { chatStart: true }))
    ).not.toHaveProperty("autoExtract");
    expect(store.status().activeMemories).toBe(1);
  });

  it("完成读原文、幂等提交、概要和来源改版失效的端到端流程", async () => {
    const original = archive("消息甲", "我喝咖啡不加糖。");
    store.upsertMessages([original]);
    const read = decoded<{ messages: SourceView[]; rules: string }>(
      await call("memory_read_sources")
    );
    expect(read.rules).toContain("否定");
    expect(read.rules).toContain("妻子");
    const source = read.messages[0];
    const input = proposal(source.sourceId, original.content);
    const committed = decoded<{
      memory: { id: string; revision: number };
      operationId: string;
    }>(await call("memory_submit", input));
    const repeated = decoded<{ memory: { id: string }; operationId: string }>(
      await call("memory_submit", input)
    );
    expect(repeated.memory.id).toBe(committed.memory.id);
    expect(repeated.operationId).toBe(committed.operationId);
    expect(store.status().memories).toBe(1);
    const different = await call("memory_submit", {
      ...input,
      value: "喜欢咖啡加糖",
    });
    expect(different.isError).toBe(true);
    expect(responseText(different)).toContain("请求标识");

    const summary = await call("memory_save_summary", {
      requestId: "概要稳定请求-0001",
      title: "饮品偏好",
      text: "说话人喝咖啡不加糖。",
      memories: [
        { id: committed.memory.id, revision: committed.memory.revision },
      ],
    });
    expect(summary.isError).not.toBe(true);
    expect(
      decoded<{ summaries: unknown[] }>(await call("memory_read_summaries"))
        .summaries
    ).toHaveLength(1);
    expect(
      (
        await call("memory_finish_sources", {
          sources: [{ messageId: source.sourceId, revision: 1 }],
          reason: "已完整审阅并保存偏好",
        })
      ).isError
    ).not.toBe(true);
    expect(
      decoded<{ messages: unknown[] }>(await call("memory_read_sources"))
        .messages
    ).toHaveLength(0);

    store.upsertMessages([
      {
        ...original,
        content: "我喝咖啡不加奶。",
        raw: { content: "我喝咖啡不加奶。" },
      },
    ]);
    expect(
      decoded<{ memories: unknown[] }>(await call("memory_search")).memories
    ).toHaveLength(0);
    expect(
      decoded<{ summaries: unknown[] }>(await call("memory_read_summaries"))
        .summaries
    ).toHaveLength(0);
    expect(
      (
        await call("memory_submit", {
          ...input,
          requestId: "新请求仍用旧版本-0002",
        })
      ).isError
    ).toBe(true);
    expect(
      (
        await call("memory_read_source", {
          messageId: source.sourceId,
          revision: 1,
        })
      ).isError
    ).toBe(true);
    const current = decoded<{ messages: SourceView[] }>(
      await call("memory_read_sources")
    );
    expect(current.messages[0].revision).toBe(2);
  });

  it("候选暂存不能充当来源且不会混入默认正式记忆", async () => {
    const capture = decoded<{
      capture: { id: string; status: string };
      warning: string;
    }>(
      await call("memory_capture_candidate", {
        text: "用户可能喜欢茶",
        reason: "当前信息未出现在已同步原文中",
      })
    );
    expect(capture.capture.status).toBe("unverified");
    expect(capture.warning).toContain("不能作为");
    expect(
      (
        await call(
          "memory_submit",
          proposal(capture.capture.id, "用户可能喜欢茶")
        )
      ).isError
    ).toBe(true);
    expect(
      (await call("memory_read_source", { messageId: capture.capture.id }))
        .isError
    ).toBe(true);
    expect(
      decoded<{ messages: unknown[] }>(await call("memory_read_sources"))
        .messages
    ).toHaveLength(0);
    expect(
      decoded<{ memories: unknown[] }>(
        await call("memory_search", { includeCandidates: true })
      ).memories
    ).toHaveLength(0);
  });

  it("显式检索可复核未验证暂存并共享返回预算，但仍不能把暂存当来源", async () => {
    const candidateText = "用户可能喜欢茶";
    await call("memory_capture_candidate", {
      text: candidateText,
      reason: "尚未找到已存档的用户原话",
    });
    await call("memory_capture_candidate", {
      text: "用户可能喜欢咖啡",
      reason: "另一个待复核内容",
    });
    const ordinary = await call("memory_search", { query: "茶" });
    expect(decoded<Record<string, unknown>>(ordinary)).not.toHaveProperty(
      "provisionalCaptures"
    );
    expect(responseText(ordinary)).not.toContain(candidateText);

    const explicit = await call("memory_search", {
      query: "茶",
      includeCandidates: true,
      limit: 1,
    });
    expect(explicit.isError).not.toBe(true);
    const review = decoded<{
      memories: unknown[];
      provisionalCaptures: {
        id: string;
        text: string;
        status: string;
        warning: string;
      }[];
    }>(explicit);
    expect(review.memories).toHaveLength(0);
    expect(review.provisionalCaptures).toHaveLength(1);
    expect(review.provisionalCaptures[0]).toMatchObject({
      text: candidateText,
      status: "unverified",
    });
    expect(review.provisionalCaptures[0].warning).toContain("不能作为");
    const candidateId = review.provisionalCaptures[0].id;
    expect(
      (await call("memory_submit", proposal(candidateId, candidateText)))
        .isError
    ).toBe(true);
    expect(
      (await call("memory_read_source", { messageId: candidateId })).isError
    ).toBe(true);

    const original = archive("候选复核来源", "预算测试：我喝咖啡不加糖。");
    store.upsertMessages([original]);
    const source = store.readSources().messages[0];
    expect(
      (
        await call(
          "memory_submit",
          proposal(source.sourceId, original.content, {
            requestId: "候选复核正式记忆-0001",
            value: "预算测试：喝咖啡不加糖",
          })
        )
      ).isError
    ).not.toBe(true);
    for (const label of ["甲", "乙"]) {
      await call("memory_capture_candidate", {
        text: `预算测试${label}${"\0".repeat(1_995)}`,
        reason: "\0".repeat(1_000),
      });
    }
    const bounded = await call("memory_search", {
      query: "预算测试",
      includeCandidates: true,
      limit: 20,
    });
    expect(bounded.isError).not.toBe(true);
    const boundedReview = decoded<{
      memories: unknown[];
      provisionalCaptures: unknown[];
      hasMore: boolean;
    }>(bounded);
    expect(boundedReview.memories).toHaveLength(1);
    expect(boundedReview.provisionalCaptures).toHaveLength(2);
    expect(boundedReview.hasMore).toBe(false);
    const limited = decoded<{
      memories: unknown[];
      provisionalCaptures: unknown[];
    }>(await call("memory_search", { includeCandidates: true, limit: 2 }));
    expect(
      limited.memories.length + limited.provisionalCaptures.length
    ).toBeLessThanOrEqual(2);
  });

  it("每个合法工具调用都重新检查端点绑定并在改绑后拒绝读写", async () => {
    await call("memory_status");
    writeFileSync(
      options.clientConfigPath!,
      JSON.stringify({
        mcpEndpoint: "wss://example.test/mcp?token=another-endpoint",
      })
    );
    const inputs: Record<string, Record<string, unknown>> = {
      memory_status: {},
      memory_read_sources: {},
      memory_read_source: { messageId: "不存在的原文" },
      memory_search: {},
      memory_submit: proposal("不存在的原文", "用户原话"),
      memory_finish_sources: {
        sources: [{ messageId: "不存在的原文", revision: 1 }],
        reason: "测试拒绝",
      },
      memory_save_summary: {
        requestId: "守卫测试概要-0001",
        title: "测试",
        text: "测试",
        memories: [{ id: "不存在的记忆", revision: 1 }],
      },
      memory_read_summaries: {},
      memory_capture_candidate: { text: "不应被保存", reason: "绑定已经改变" },
    };
    for (const [name, args] of Object.entries(inputs)) {
      const response = await call(name, args);
      expect(response.isError).toBe(true);
      expect(responseText(response)).toContain("绑定");
      expect(responseText(response)).not.toContain("another-endpoint");
    }
    expect(guard).toHaveBeenCalledTimes(10);
    expect(store.status().memories).toBe(0);
    expect(store.status().provisionalCaptures).toBe(0);
  });

  it("长消息明确截断并能按版本分片还原全文，单次响应始终有界", async () => {
    const content = "保留原话🙂\n\0\t".repeat(5_000);
    store.upsertMessages([
      archive("超长消息", content, {
        raw: { privateEnvelope: "不应重复返回的信封".repeat(3_000) },
      }),
    ]);
    const firstResponse = await call("memory_read_sources");
    expect(responseText(firstResponse)).not.toContain("privateEnvelope");
    const first = decoded<{ messages: SourceView[] }>(firstResponse)
      .messages[0];
    expect(first.truncated).toBe(true);
    expect(first.warning).toContain("缺失");
    expect(first.contentLength).toBe(content.length);
    let reconstructed = first.content;
    let offset = first.nextOffset;
    while (offset !== null) {
      const response = await call("memory_read_source", {
        messageId: first.sourceId,
        revision: first.revision,
        offset,
        length: 8_000,
      });
      expect(response.isError).not.toBe(true);
      const part = decoded<SourceView>(response);
      expect(part.contentOffset).toBe(offset);
      reconstructed += part.content;
      offset = part.nextOffset;
    }
    expect(reconstructed).toBe(content);
    expect(
      (
        await call("memory_read_source", {
          messageId: first.sourceId,
          offset: 500,
        })
      ).isError
    ).toBe(true);
    expect(store.getSource(first.sourceId)?.content).toBe(content);
  });

  it("批量裁剪保留整页来源与可靠游标，下一页不跳过消息", async () => {
    store.upsertMessages(
      Array.from({ length: 13 }, (_, index) =>
        archive(`原文-${index}`, `第${index}条`.repeat(5_000))
      )
    );
    const response = await call("memory_read_sources", { limit: 12 });
    expect(response.isError).not.toBe(true);
    const page = decoded<{ messages: SourceView[]; nextCursor: string | null }>(
      response
    );
    expect(page.messages).toHaveLength(12);
    expect(page.nextCursor).toBe(page.messages.at(-1)?.sourceId);
    expect(page.messages.every((source) => source.truncated)).toBe(true);
    const next = decoded<{ messages: SourceView[]; nextCursor: string | null }>(
      await call("memory_read_sources", { limit: 12, afterId: page.nextCursor })
    );
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].sourceId).toBe(
      store.readSources({ limit: 20 }).messages[12].sourceId
    );
    expect(next.nextCursor).toBeNull();
  });

  it("状态只返回同步检查点摘要，不返回会话列表或内部指纹", async () => {
    store.setSyncState({
      version: 1,
      phase: "messages",
      page: 2,
      completedScans: 2,
      complete: true,
      lastVerifiedAt: "2026-01-01T12:00:00.000Z",
      chatIds: ["不可回显的会话列表"],
      digest: "不可回显的内部指纹",
    });
    const response = await call("memory_status");
    const status = decoded<{ sync: Record<string, unknown>; syncNote: string }>(
      response
    );
    expect(status.sync.complete).toBe(true);
    expect(status.sync.page).toBe(2);
    expect(status.sync.lastVerifiedAt).toBe("2026-01-01T12:00:00.000Z");
    expect(status.syncNote).toContain("不保证");
    expect(responseText(response)).not.toContain("不可回显");
  });

  it("底层中文解析异常和系统路径不会作为工具错误回显", async () => {
    const secret = "这里是私密原话或中文凭据路径";
    guard.mockImplementationOnce(() => {
      throw new SyntaxError(`无法解析 JSON: ${secret}`);
    });
    const parsing = await call("memory_status");
    expect(parsing.isError).toBe(true);
    expect(responseText(parsing)).not.toContain(secret);
    expect(responseText(parsing)).toContain("本地记忆操作未完成");
    guard.mockImplementationOnce(() => {
      throw Object.assign(new Error(`ENOENT: ${secret}`), { code: "ENOENT" });
    });
    const filesystem = await call("memory_status");
    expect(filesystem.isError).toBe(true);
    expect(responseText(filesystem)).not.toContain(secret);
    expect(responseText(filesystem)).toContain("本地记忆操作未完成");
  });

  it("按绑定身份记录模型自报并拒绝篡改和无效参数", async () => {
    expect(MEMORY_SERVER_INSTRUCTIONS).toContain(
      "memory_search(includeCandidates:true)"
    );
    expect(MEMORY_SERVER_INSTRUCTIONS).toContain("候选只作线索");
    expect(MEMORY_EXTRACTION_RULES).toContain("接收时间不等于发言时间");
    const tool = (await client.listTools()).tools.find(
      (item) => item.name === "memory_read_sources"
    );
    expect(tool?.description).toContain("已保存消息、来源标识");
    const input = {
      requestId: "record-0001",
      conversationId: "dialogue",
      role: "user",
      content: "  原样\n ",
    };
    const first = decoded<{
      sourceId: string;
      chatId: string;
      receiptId: string;
      origin: string;
    }>(await call("memory_record_turn", input));
    expect(first.origin).toBe("model_reported");
    expect(store.listChats({ query: "原样" }).items[0].id).toBe(first.chatId);
    const titled = {
      ...input,
      requestId: "title-request-1",
      conversationId: "new-conversation",
      conversationTitle: "合成标题",
    };
    const titleReceipt = decoded<{ chatId: string }>(
      await call("memory_record_turn", titled)
    );
    expect(store.listChats({ query: "合成标题" }).items[0].id).toBe(
      titleReceipt.chatId
    );
    expect(
      (
        await call("memory_record_turn", {
          ...titled,
          conversationTitle: "变化标题",
        })
      ).isError
    ).toBe(true);
    await call("memory_record_turn", {
      ...titled,
      requestId: "title-request-2",
      conversationTitle: "新标题",
    });
    expect(store.listChats({ query: "合成标题" }).total).toBe(1);
    expect(
      decoded<{ receiptId: string; duplicate: boolean }>(
        await call("memory_record_turn", input)
      )
    ).toMatchObject({ receiptId: first.receiptId, duplicate: true });
    expect(
      (await call("memory_record_turn", { ...input, content: "不同内容" }))
        .isError
    ).toBe(true);
    expect(
      (
        await call("memory_record_turn", {
          ...input,
          requestId: "record-0002",
          role: "system",
        })
      ).isError
    ).toBe(true);
    expect(
      (
        await call("memory_record_turn", {
          ...input,
          requestId: "record-0003",
          content: "x".repeat(8001),
        })
      ).isError
    ).toBe(true);
    expect(
      (
        await call("memory_record_turn", {
          ...input,
          requestId: "record-0004",
          agentId: "other",
        })
      ).isError
    ).toBe(true);
    expect(
      (
        await call("memory_record_turn", {
          ...input,
          requestId: "record-0005",
          sourceId: "official",
        })
      ).isError
    ).toBe(true);
    expect(
      (
        await call("memory_record_turn", {
          ...input,
          requestId: "record-0006",
          assistantStage: "final",
        })
      ).isError
    ).toBe(true);
    expect(
      decoded<{ origin: string; content: string; createdAt: string | null }>(
        await call("memory_read_source", { messageId: first.sourceId })
      )
    ).toMatchObject({
      origin: "model_reported",
      content: input.content,
      createdAt: null,
    });
    const submitted = await call(
      "memory_submit",
      proposal(first.sourceId, "原样", { requestId: "memory-report-0001" })
    );
    expect(
      decoded<{
        memory: {
          status: string;
          category: string;
          facet: string;
          sources: { origin: string }[];
        };
      }>(submitted).memory
    ).toMatchObject({
      status: "candidate",
      category: "user_profile",
      facet: "咖啡偏好",
      sources: [{ origin: "model_reported" }],
    });
    const assistant = decoded<{ sourceId: string; assistantStage: string }>(
      await call("memory_record_turn", {
        ...input,
        requestId: "record-assistant-1",
        role: "assistant",
        assistantStage: "draft",
      })
    );
    expect(assistant.assistantStage).toBe("draft");
    expect(
      decoded<{ assistantStage: string }>(
        await call("memory_read_source", { messageId: assistant.sourceId })
      ).assistantStage
    ).toBe("draft");
    expect(store.listMessages({ chatId: first.chatId }).items[0]).toMatchObject(
      { origin: "model_reported", content: input.content }
    );
    expect(store.exportData().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: first.sourceId,
          origin: "model_reported",
        }),
      ])
    );
    const backup = join(directory, "backup.sqlite");
    store.backup(backup);
    const restored = new MemoryStore(backup, options);
    expect(restored.getSource(first.sourceId)?.content).toBe(input.content);
    expect(
      restored.recordTurn(input as Parameters<MemoryStore["recordTurn"]>[0])
    ).toMatchObject({ receiptId: first.receiptId, duplicate: true });
    restored.close();
    expect(() =>
      store.upsertMessages([archive("same", "伪造", { chatId: first.chatId })])
    ).toThrow();
    const official = archive("same", "官方历史", {
      raw: { origin: "model_reported" },
    });
    store.upsertMessages([official]);
    const officialSource = store.readSources({ chatId: official.chatId })
      .messages[0];
    expect(officialSource.sourceId).not.toBe(first.sourceId);
    expect(
      decoded<{ origin: string }>(
        await call("memory_read_source", { messageId: officialSource.sourceId })
      ).origin
    ).toBe("archive");
  });

  it("分类检索在限制数量前过滤并保留来源", async () => {
    store.upsertMessages([
      archive("旧画像", "我喝咖啡不加糖。", {
        createdAt: "2026-01-01T00:00:00Z",
      }),
      archive("新情境", "我喝咖啡不加糖。", {
        createdAt: "2026-02-01T00:00:00Z",
      }),
    ]);
    const sources = store.readSources({ pendingOnly: false }).messages;
    store.submit(
      proposal(sources[0].sourceId, sources[0].content, {
        requestId: "category-profile-1",
        facet: "interests",
      })
    );
    store.submit(
      proposal(sources[1].sourceId, sources[1].content, {
        requestId: "category-situation-1",
        facet: "recent_event",
        assertion: "event",
      })
    );
    const found = decoded<{
      memories: {
        category: string;
        facet: string;
        sources: { origin: string }[];
      }[];
    }>(
      await call("memory_search", {
        category: "user_profile",
        includeCandidates: true,
        limit: 1,
      })
    );
    expect(found.memories).toMatchObject([
      {
        category: "user_profile",
        facet: "interests",
        sources: [{ origin: "archive" }],
      },
    ]);
  });

  it("自动标题截断不会拆开补充平面字符", async () => {
    const content = `${"甲".repeat(99)}😀后续`;
    const recorded = decoded<{ chatId: string }>(
      await call("memory_record_turn", {
        requestId: "emoji-title-test",
        conversationId: "emoji-conversation",
        role: "user",
        content,
      })
    );
    const chat = store
      .listChats({ query: "甲" })
      .items.find((item) => item.id === recorded.chatId);
    expect(chat?.title).toBe("甲".repeat(99));
    expect(
      store.listMessages({ chatId: recorded.chatId }).items[0].content
    ).toBe(content);
  });

  it("续读验证游标位置、过期和跨进程删除，不能泄露旧快照", async () => {
    const original = archive("分段证据", "证据原文");
    store.upsertMessages([original]);
    const source = store.readSources().messages[0];
    const saved = store.submit(
      proposal(source.sourceId, original.content, {
        requestId: "snapshot-delete-1",
        value: '引用📚\\"\n'.repeat(100),
      })
    );
    const response = await callRaw("memory_search", { limit: 1 });
    const first = decoded<{ cursor: string; nextOffset: number }>(response);
    expect(first.nextOffset).toBeGreaterThan(0);
    expect(
      (
        await callRaw("memory_read_result", {
          cursor: first.cursor,
          offset: first.nextOffset + 1,
        })
      ).isError
    ).toBe(true);
    const again = decoded<{ cursor: string; nextOffset: number }>(
      await callRaw("memory_search", { limit: 1 })
    );
    const other = new MemoryStore(options.databasePath, options);
    other.deleteMemory(saved.memory.id, saved.memory.revision);
    other.close();
    const stale = await callRaw("memory_read_result", {
      cursor: again.cursor,
      offset: again.nextOffset,
    });
    expect(stale.isError).toBe(true);
    expect(responseText(stale)).not.toContain("引用📚");
    const latest = decoded<{ cursor: string; nextOffset: number }>(
      await callRaw("memory_read_sources")
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
    expect(
      (
        await callRaw("memory_read_result", {
          cursor: latest.cursor,
          offset: latest.nextOffset,
        })
      ).isError
    ).toBe(true);
    vi.restoreAllMocks();
  });

  it("SDK 参数校验错误也应保持有界且不回显参数", async () => {
    const extra = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `unknown_${index}`,
        "私密".repeat(400),
      ])
    );
    const invalid = await callRaw("memory_record_turn", {
      ...extra,
      requestId: "invalid-params",
      conversationId: "test",
      role: "invalid",
      content: "私密".repeat(4000),
    });
    expect(invalid.isError).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(invalid))).toBeLessThanOrEqual(768);
    expect(responseText(invalid)).not.toContain("私密");
  });
});
