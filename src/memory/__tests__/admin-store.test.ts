import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAdminRequest } from "../admin.js";
import { MemoryStore } from "../store.js";
import type {
  ArchiveMessage,
  MemoryOptions,
  MemoryProposal,
  SourceMessage,
} from "../types.js";

describe("本机记忆管理查询与审计", () => {
  let directory: string;
  let store: MemoryStore;
  let options: MemoryOptions;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));
    directory = mkdtempSync(join(tmpdir(), "xiaozhi-admin-"));
    options = {
      agentId: "admin-test-agent",
      databasePath: join(directory, "memory.sqlite"),
      clientConfigPath: join(directory, "xiaozhi.config.json"),
      syncIntervalSeconds: 0,
    };
    writeFileSync(
      options.clientConfigPath!,
      JSON.stringify({ mcpEndpoint: "wss://example.test/mcp?token=local" })
    );
    store = new MemoryStore(options.databasePath, options);
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function source(overrides: Partial<ArchiveMessage> = {}): SourceMessage {
    const message: ArchiveMessage = {
      id: randomUUID(),
      chatId: "chat-1",
      role: "user",
      content: "我希望卧室夜间保持26度。",
      createdAt: "2026-11-10T12:00:00Z",
      raw: { privatePayload: "禁止通过管理列表返回的原始载荷" },
      ...overrides,
    };
    store.upsertMessages([message]);
    const saved = store
      .readSources({ chatId: message.chatId, pendingOnly: false, limit: 50 })
      .messages.find((item) => item.id === message.id);
    if (!saved) throw new Error("测试消息未写入");
    return saved;
  }

  function proposal(
    message: SourceMessage,
    overrides: Partial<MemoryProposal> = {}
  ): MemoryProposal {
    return {
      requestId: randomUUID(),
      operation: "add",
      subject: { kind: "speaker" },
      facet: "卧室温度",
      value: "26度",
      assertion: "explicit",
      conditions: "夜间",
      sources: [
        {
          messageId: message.sourceId,
          revision: message.revision,
          quote: message.content,
        },
      ],
      reason: "用户明确表达长期设置",
      ...overrides,
    };
  }

  it("管理开关通过绑定检查写入并在状态中读取", async () => {
    expect(
      await executeAdminRequest(store, { action: "status" }, options)
    ).toMatchObject({
      success: true,
      data: { autoExtractEnabled: false },
    });
    expect(
      await executeAdminRequest(
        store,
        { action: "setAutoExtractEnabled", enabled: true },
        options
      )
    ).toEqual({
      success: true,
      data: { enabled: true },
    });
    expect(
      await executeAdminRequest(store, { action: "status" }, options)
    ).toMatchObject({
      success: true,
      data: { autoExtractEnabled: true },
    });
    expect(
      await executeAdminRequest(
        store,
        { action: "setAutoExtractEnabled", enabled: false },
        options
      )
    ).toEqual({
      success: true,
      data: { enabled: false },
    });
  });

  it("永久删除仅目标记忆、版本和派生概要，并拒绝旧请求与撤销恢复", async () => {
    const message = source();
    const input = proposal(message, {
      facet: "待删除属性",
      value: "独有提炼正文",
    });
    const saved = store.submit(input);
    const other = store.submit(
      proposal(message, { facet: "保留属性", value: "保留记忆" })
    );
    const summaryInput = {
      requestId: "delete-summary-request",
      title: "目标摘要",
      text: "独有派生正文",
      memories: [{ id: saved.memory.id, revision: 1 }],
    };
    const summary = store.saveSummary(summaryInput);
    const otherSummary = store.saveSummary({
      requestId: "keep-summary-request",
      title: "保留摘要",
      text: "保留派生",
      memories: [{ id: other.memory.id, revision: 1 }],
    });
    const reinforced = store.retire(saved.memory.id, 1, "测试停用");
    expect(reinforced.memory.revision).toBe(2);
    const priorBackup = join(directory, "before-delete.sqlite");
    store.backup(priorBackup);
    const before = store.exportData();
    expect(
      await executeAdminRequest(
        store,
        { action: "delete", id: saved.memory.id, revision: 1 },
        options
      )
    ).toMatchObject({ success: false });
    expect(store.exportData().memoryVersions).toEqual(before.memoryVersions);
    expect(
      await executeAdminRequest(
        store,
        { action: "delete", id: saved.memory.id, revision: 2 },
        options
      )
    ).toMatchObject({
      success: true,
      data: { deleted: true, id: saved.memory.id },
    });
    expect(store.getMemory(saved.memory.id)).toBeNull();
    expect(store.getSource(message.sourceId)?.content).toBe(message.content);
    expect(store.getMemory(other.memory.id)).not.toBeNull();
    expect(store.listAdminSummaries().map((item) => item.id)).toEqual([
      otherSummary.id,
    ]);
    const exported = store.exportData();
    expect(JSON.stringify(exported.memoryVersions)).not.toContain(
      "独有提炼正文"
    );
    expect(JSON.stringify(exported.summaries)).not.toContain("独有派生正文");
    expect(JSON.stringify(exported.operations)).not.toContain("独有提炼正文");
    expect(exported.summaries).not.toContainEqual(summary);
    expect(() => store.submit(input)).toThrow("已删除");
    expect(() => store.saveSummary(summaryInput)).toThrow("已删除");
    expect(() => store.undo(saved.operationId)).toThrow();
    expect(() => store.undo(reinforced.operationId)).toThrow();
    const oldBackup = new MemoryStore(priorBackup, options);
    expect(oldBackup.getMemory(saved.memory.id)).not.toBeNull();
    oldBackup.close();
    const newBackup = join(directory, "after-delete.sqlite");
    store.backup(newBackup);
    const restored = new MemoryStore(newBackup, options);
    expect(restored.getMemory(saved.memory.id)).toBeNull();
    expect(() => restored.submit(input)).toThrow("已删除");
    restored.close();
    expect(
      await executeAdminRequest(
        store,
        { action: "delete", id: saved.memory.id, revision: 2 },
        options
      )
    ).toMatchObject({ success: false });
  });

  it("指定来源版本读取时返回当前审阅进度和该版本原文", async () => {
    const message = source();
    store.finishSources(
      [{ messageId: message.sourceId, revision: 1 }],
      "已阅读"
    );
    const result = await executeAdminRequest(
      store,
      { action: "source", id: message.sourceId, revision: 1 },
      options
    );
    expect(result).toMatchObject({
      success: true,
      data: { content: message.content, revision: 1, processedRevision: 1 },
    });
  });

  it("读取官方会话摘要标题并支持标题搜索，异常摘要回退到已有标题", () => {
    store.upsertChat({
      id: "official-chat",
      raw: { chat_summary: { title: "官方合成标题" } },
    });
    store.upsertChat({
      id: "fallback-chat",
      raw: { chat_summary: { title: 123 }, title: "导入标题" },
    });
    store.upsertChat({
      id: "empty-chat",
      raw: { chat_summary: { title: "" }, name: "会话名称" },
    });
    expect(store.listChats({ query: "官方合成" }).items).toMatchObject([
      { id: "official-chat", title: "官方合成标题" },
    ]);
    expect(store.listChats({ query: "导入标题" }).items[0].title).toBe(
      "导入标题"
    );
    expect(store.listChats({ query: "会话名称" }).items[0].title).toBe(
      "会话名称"
    );
  });

  it("会话与消息分页覆盖首批以后的记录，查询把百分号和下划线当作原文", () => {
    const messages: ArchiveMessage[] = [];
    for (let index = 0; index < 57; index++) {
      const id = `chat-${String(index).padStart(3, "0")}`;
      if (index < 56) {
        store.upsertChat({
          id,
          raw: { title: index === 55 ? "包含%_的会话" : `会话${index}` },
        });
      }
      messages.push({
        id: `message-${index}`,
        chatId: id,
        role: "user",
        content: index === 55 ? "保留100%_字面内容" : `普通正文${index}`,
        createdAt: "2026-11-10T12:00:00Z",
        raw: { privatePayload: "这段原始载荷不应离开存储层" },
      });
    }
    store.upsertMessages(messages);
    const firstChats = store.listChats({ page: 1, pageSize: 50 });
    const secondChats = store.listChats({ page: 2, pageSize: 50 });
    expect(store.status().chats).toBe(57);
    expect(firstChats).toMatchObject({ page: 1, pageSize: 50, total: 57 });
    expect(firstChats.items).toHaveLength(50);
    expect(secondChats.items).toHaveLength(7);
    expect(
      new Set(
        [...firstChats.items, ...secondChats.items].map((item) => item.id)
      ).size
    ).toBe(57);
    expect(store.listChats({ query: "%_" }).items).toMatchObject([
      {
        id: "chat-055",
        title: "包含%_的会话",
        messageCount: 1,
        pendingCount: 1,
      },
    ]);
    expect(store.listChats({ query: "普通正文56" }).items[0].id).toBe(
      "chat-056"
    );

    const firstMessages = store.listMessages({ pageSize: 50 });
    const secondMessages = store.listMessages({ page: 2, pageSize: 50 });
    expect(firstMessages.total).toBe(57);
    expect(firstMessages.items).toHaveLength(50);
    expect(secondMessages.items).toHaveLength(7);
    expect(
      new Set(
        [...firstMessages.items, ...secondMessages.items].map((item) => item.id)
      ).size
    ).toBe(57);
    const literal = store.listMessages({ query: "%_" });
    expect(literal.total).toBe(1);
    expect(literal.items[0]).not.toHaveProperty("raw");
    expect(JSON.stringify(literal)).not.toContain("privatePayload");
    store.finishSources(
      [{ messageId: literal.items[0].sourceId, revision: 1 }],
      "已核对原文"
    );
    expect(store.listChats({ query: "%_" }).items[0].pendingCount).toBe(0);
    expect(
      store.listMessages({ chatId: "chat-055" }).items[0].processedRevision
    ).toBe(1);
  });

  it("记忆列表分页和状态筛选均基于完整档案，过期记忆不会列为当前生效", () => {
    const message = source();
    const activeIds: string[] = [];
    for (let index = 0; index < 55; index++) {
      const saved = store.submit(
        proposal(message, {
          facet: `属性${index}`,
          value: index === 54 ? "含100%_字面值" : `值${index}`,
        })
      );
      activeIds.push(saved.memory.id);
    }
    const candidate = store.submit(
      proposal(message, { facet: "待核实", assertion: "inferred" })
    ).memory;
    const expiring = store.submit(
      proposal(message, {
        facet: "限时设置",
        validUntil: "2026-11-14T00:00:00Z",
      })
    ).memory;
    const retired = store.getMemory(activeIds[0])!;
    store.retire(retired.id, retired.revision, "这项设置不再需要");
    vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));
    expect(store.listMemories({ pageSize: 50 }).items).toHaveLength(50);
    expect(store.listMemories({ page: 2, pageSize: 50 })).toMatchObject({
      total: 57,
      items: expect.any(Array),
    });
    expect(store.listMemories({ page: 2, pageSize: 50 }).items).toHaveLength(7);
    expect(
      store.listMemories({ status: "candidate" }).items.map((item) => item.id)
    ).toEqual([candidate.id]);
    expect(store.listMemories({ status: "active" }).total).toBe(54);
    expect(store.listMemories({ status: "current" }).total).toBe(55);
    expect(
      store
        .listMemories({ status: "inactive" })
        .items.map((item) => item.id)
        .sort()
    ).toEqual([retired.id, expiring.id].sort());
    expect(store.listMemories({ query: "%_" }).total).toBe(1);
    expect(store.listMemories({ query: "%_" }).items[0].value).toBe(
      "含100%_字面值"
    );
  });

  it("分类先过滤再分页统计，并通过管理协议透传", async () => {
    const message = source();
    for (let index = 0; index < 3; index++) {
      store.submit(
        proposal(message, {
          facet: `画像${index}`,
          conditions: "",
          value: `值${index}`,
        })
      );
    }
    store.submit(proposal(message, { facet: "情境", conditions: "夜间" }));
    const first = store.listMemories({
      status: "current",
      category: "user_profile",
      pageSize: 2,
    });
    const second = store.listMemories({
      status: "current",
      category: "user_profile",
      pageSize: 2,
      page: 2,
    });
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(second).toMatchObject({ total: 3, items: [expect.any(Object)] });
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size
    ).toBe(3);
    expect(
      await executeAdminRequest(
        store,
        {
          action: "memories",
          status: "current",
          category: "situational",
          pageSize: 2,
        },
        options
      )
    ).toMatchObject({ success: true, data: { total: 1 } });
  });

  it("拒绝非法页码和页大小，越过末页返回空列表和真实总数", () => {
    source();
    for (const page of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      expect(() => store.listMessages({ page, pageSize: 50 })).toThrow();
      expect(() => store.listChats({ page, pageSize: 50 })).toThrow();
      expect(() => store.listMemories({ page, pageSize: 50 })).toThrow();
    }
    for (const pageSize of [0, -1, 1.5, 51, Number.NaN]) {
      expect(() => store.listMessages({ pageSize })).toThrow();
    }
    expect(store.listMessages({ page: 20 })).toEqual({
      items: [],
      page: 20,
      pageSize: 20,
      total: 1,
    });
  });

  it("记忆详情保留历史版本并回查精确原话，不拿当前消息替换旧证据", async () => {
    const message = source({ id: "mutable", content: "我喜欢26度。" });
    const saved = store.submit(proposal(message));
    source({ id: "mutable", content: "原文更正为25度。" });
    const detail = store.getMemoryDetail(saved.memory.id);
    expect(detail?.memory).toMatchObject({
      status: "invalidated",
      revision: 2,
    });
    expect(detail?.versions.map((version) => version.revision)).toEqual([2, 1]);
    expect(detail?.sources).toMatchObject([
      {
        revision: 1,
        currentRevision: 2,
        quote: "我喜欢26度。",
        message: { content: "我喜欢26度。", revision: 1 },
      },
    ]);
    expect(detail?.sources[0].message).not.toHaveProperty("raw");
    expect(
      await executeAdminRequest(
        store,
        { action: "source", id: message.sourceId, revision: 1 },
        options
      )
    ).toMatchObject({
      success: true,
      data: { content: "我喜欢26度。", revision: 1 },
    });
    expect(store.getSource(message.sourceId, 2)?.content).toBe(
      "原文更正为25度。"
    );
    expect(store.getSource(message.sourceId, 3)).toBeNull();
  });

  it("管理员停用写入新版本与审计并使概要失效，撤销恢复记忆但不复活旧概要", () => {
    const saved = store.submit(proposal(source()));
    store.saveSummary({
      requestId: randomUUID(),
      title: "卧室设置",
      text: "夜间温度为26度。",
      memories: [{ id: saved.memory.id, revision: 1 }],
    });
    const result = store.retire(saved.memory.id, 1, "  管理员确认不再适用  ");
    expect(result.memory).toMatchObject({
      revision: 2,
      status: "retracted",
      reason: "管理员确认不再适用",
    });
    expect(result.memory.sources).toEqual(saved.memory.sources);
    expect(store.listSummaries()).toHaveLength(0);
    expect(store.exportData().summaries[0]).toMatchObject({
      status: "invalidated",
    });
    const operations = store.listAdminOperations();
    expect(operations[0]).toMatchObject({
      id: result.operationId,
      kind: "retire",
      reason: "管理员确认不再适用",
      canUndo: true,
      memoryIds: [saved.memory.id],
    });
    expect(operations[0]).not.toHaveProperty("snapshots");
    expect(
      operations.find((item) => item.id === saved.operationId)?.canUndo
    ).toBe(false);
    expect(store.undo(result.operationId)).toMatchObject({
      restored: 1,
      alreadyUndone: false,
    });
    expect(store.getMemory(saved.memory.id)).toMatchObject({
      status: "active",
      revision: 3,
    });
    expect(store.listSummaries()).toHaveLength(0);
    expect(
      store.listAdminOperations().find((item) => item.id === result.operationId)
        ?.canUndo
    ).toBe(false);
    expect(store.undo(result.operationId)).toMatchObject({
      alreadyUndone: true,
    });
    expect(
      store
        .getMemoryDetail(saved.memory.id)
        ?.versions.map((item) => item.revision)
    ).toEqual([3, 2, 1]);
  });

  it("管理页保留停用和到期的概要供回查，撤销不会让旧概要重新进入模型查询", async () => {
    const message = source();
    const original = store.submit(proposal(message)).memory;
    const firstSummary = store.saveSummary({
      requestId: randomUUID(),
      title: "原有设置概要",
      text: "记录用户原有设置。",
      memories: [{ id: original.id, revision: original.revision }],
    });
    const expiring = store.submit(
      proposal(message, {
        facet: "限时设置",
        validUntil: "2026-11-14T00:00:00Z",
      })
    ).memory;
    const lastSummary = store.saveSummary({
      requestId: randomUUID(),
      title: "限时设置概要",
      text: "记录用户的限时设置。",
      memories: [{ id: expiring.id, revision: expiring.revision }],
    });
    const retired = store.retire(
      original.id,
      original.revision,
      "设置不再适用"
    );
    expect(
      await executeAdminRequest(store, { action: "summaries" }, options)
    ).toMatchObject({
      success: true,
      data: [
        { id: lastSummary.id, status: "active" },
        { id: firstSummary.id, status: "invalidated" },
      ],
    });
    store.undo(retired.operationId);
    expect(store.listSummaries().map((summary) => summary.id)).toEqual([
      lastSummary.id,
    ]);
    vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));
    expect(
      await executeAdminRequest(store, { action: "summaries" }, options)
    ).toMatchObject({
      success: true,
      data: [
        { id: lastSummary.id, status: "invalidated" },
        { id: firstSummary.id, status: "invalidated" },
      ],
    });
    expect(store.listAdminSummaries(1).map((summary) => summary.id)).toEqual([
      lastSummary.id,
    ]);
    expect(store.listSummaries()).toHaveLength(0);
    expect(store.exportData().summaries).toContainEqual(lastSummary);
  });

  it("并行连接的过期版本不能停用或撤销后续变更，失败不留下审计或额外版本", () => {
    const message = source();
    const saved = store.submit(proposal(message));
    const other = new MemoryStore(options.databasePath, options);
    try {
      const retired = other.retire(saved.memory.id, 1, "先完成的管理员操作");
      const before = store.exportData();
      expect(() => store.retire(saved.memory.id, 1, "过期页面操作")).toThrow(
        "版本已改变"
      );
      expect(() => store.undo(saved.operationId)).toThrow("后续修改");
      expect(store.exportData().operations).toEqual(before.operations);
      expect(store.exportData().memoryVersions).toEqual(before.memoryVersions);
      source({ id: message.id, content: "官方原文已被更正。" });
      expect(
        store
          .listAdminOperations()
          .find((item) => item.id === retired.operationId)?.canUndo
      ).toBe(false);
      expect(() => store.undo(retired.operationId)).toThrow("来源版本已改变");
      expect(store.getMemory(saved.memory.id)?.status).toBe("retracted");
    } finally {
      other.close();
    }
  });

  it("每项管理请求重新核对配置和单端点，失败不会泄露载荷或发起网络请求", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    source();
    expect(
      await executeAdminRequest(store, { action: "status" }, options)
    ).toMatchObject({
      success: true,
      data: { counts: { messages: 1 }, sync: null },
    });
    expect(
      await executeAdminRequest(
        store,
        { action: "messages" },
        { ...options, clientConfigPath: undefined }
      )
    ).toMatchObject({
      success: false,
      error: expect.stringContaining("配置文件"),
    });
    writeFileSync(
      options.clientConfigPath!,
      JSON.stringify({
        mcpEndpoint: [
          "wss://one.test/?token=private-one",
          "wss://two.test/?token=private-two",
        ],
      })
    );
    const rejected = await executeAdminRequest(
      store,
      { action: "messages" },
      options
    );
    expect(rejected).toMatchObject({
      success: false,
      error: expect.stringContaining("恰好一个端点"),
    });
    expect(JSON.stringify(rejected)).not.toContain("private-");
    writeFileSync(
      options.clientConfigPath!,
      JSON.stringify({ mcpEndpoint: "wss://other.test/?token=private-change" })
    );
    expect(
      await executeAdminRequest(store, { action: "export" }, options)
    ).toMatchObject({ success: false, error: expect.stringContaining("绑定") });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("同步预算严格限制为整数且无凭据时保持离线，未知操作和原文写入字段被拒绝", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    for (const maxRequests of [0, -1, 1.5, 1001, Number.NaN]) {
      expect(
        await executeAdminRequest(
          store,
          { action: "sync", maxRequests },
          options
        )
      ).toMatchObject({ success: false });
    }
    expect(
      await executeAdminRequest(
        store,
        { action: "sync", maxRequests: 1 },
        options
      )
    ).toMatchObject({ success: false, error: expect.stringContaining("凭据") });
    const request = {
      action: "messages" as const,
      raw: { content: "禁止写入的私密原文" },
    };
    const rejected = await executeAdminRequest(store, request, options);
    expect(rejected).toMatchObject({ success: false });
    expect(JSON.stringify(rejected)).not.toContain("私密原文");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
