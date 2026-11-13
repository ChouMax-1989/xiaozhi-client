import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../store.js";
import type {
  ArchiveMessage,
  MemoryProposal,
  SourceMessage,
} from "../types.js";

describe("有来源的本地记忆存储", () => {
  let directory: string;
  let store: MemoryStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));
    directory = mkdtempSync(join(tmpdir(), "xiaozhi-memory-"));
    store = new MemoryStore(join(directory, "memory.sqlite"), {
      agentId: "test-agent",
    });
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function source(overrides: Partial<ArchiveMessage> = {}): SourceMessage {
    const message: ArchiveMessage = {
      id: randomUUID(),
      chatId: "chat-1",
      role: "user",
      content: "我希望卧室夜间保持26度。",
      createdAt: "2026-11-10T12:00:00Z",
      raw: { device_id: "device-1" },
      ...overrides,
    };
    store.upsertMessages([message]);
    const result = store
      .readSources({ chatId: message.chatId, pendingOnly: false, limit: 50 })
      .messages.find((item) => item.id === message.id);
    if (!result) throw new Error("测试消息未写入");
    return result;
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

  function replacement(
    target: ReturnType<MemoryStore["submit"]>,
    overrides: Partial<MemoryProposal> = {}
  ) {
    const correction = source({
      content: "更正，以后卧室夜间改为25度。",
      createdAt: "2026-11-12T12:00:00Z",
    });
    return proposal(correction, {
      operation: "replace",
      targetId: target.memory.id,
      targetRevision: target.memory.revision,
      correctionQuote: correction.content,
      value: "25度",
      ...overrides,
    });
  }

  it("完整存档工具原文，重复导入不产生新消息或修订", () => {
    const input: ArchiveMessage = {
      id: "tool-1",
      chatId: "chat-1",
      role: "tool",
      content: '[{"name":"控制","result":"成功"}]',
      createdAt: null,
      raw: {
        total_ms: 16,
        content: [{ name: "控制", result: "成功" }],
        voice_embedding_id: "voice-1",
        url: "private-audio",
      },
    };
    store.upsertChat({ id: "chat-1", raw: { title: "完整档案" } });
    expect(store.upsertMessages([input])).toEqual({
      inserted: 1,
      updated: 0,
      unchanged: 0,
    });
    expect(
      store.upsertMessages([
        {
          ...input,
          raw: {
            url: "private-audio",
            voice_embedding_id: "voice-1",
            content: input.raw.content,
            total_ms: 16,
          },
        },
      ])
    ).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(store.exportData().messageVersions).toHaveLength(1);
    expect(store.readSources().messages[0].raw).toEqual(input.raw);
  });

  it("游标分页不遗漏，已处理消息修改后重新进入待提炼队列", () => {
    const first = source({ id: "first" });
    const second = source({ id: "second" });
    const page = store.readSources({ limit: 1 });
    expect(page.messages[0].sourceId).toBe(first.sourceId);
    expect(
      store.readSources({ afterId: page.nextCursor ?? undefined }).messages[0]
        .sourceId
    ).toBe(second.sourceId);
    expect(() => store.readSources({ afterId: "fake" })).toThrow("游标");
    const refs = [{ messageId: first.sourceId, revision: 1 }];
    expect(store.finishSources(refs, "已提炼")).toEqual(
      store.finishSources(refs, "已提炼")
    );
    expect(store.readSources().messages).toHaveLength(1);
    source({ id: "first", content: "更正原始内容" });
    expect(store.readSources().messages).toHaveLength(2);
    expect(() =>
      store.finishSources(
        [{ messageId: first.sourceId, revision: 1 }],
        "再次处理"
      )
    ).toThrow("修改");
  });

  it("未知说话人归属会话，不能由模型命名为户主", () => {
    const input = proposal(source());
    expect(store.submit(input).memory.scope).toBe("chat:chat-1:unknown");
    expect(() =>
      store.submit({
        ...input,
        requestId: randomUUID(),
        subject: { kind: "speaker", label: "户主" },
      })
    ).toThrow("身份");
    const other = source({ chatId: "chat-2" });
    expect(() =>
      store.submit({
        ...input,
        requestId: randomUUID(),
        sources: [
          ...input.sources,
          { messageId: other.sourceId, revision: 1, quote: other.content },
        ],
      })
    ).toThrow("跨会话");
  });

  it("显式单人配置才允许跨会话合并，不能事后换身份复用同库", () => {
    const path = join(directory, "owner.sqlite");
    const owned = new MemoryStore(path, {
      agentId: "test-agent",
      ownerId: "max",
    });
    expect(owned.scopeForChat("chat-1")).toBe(owned.scopeForChat("chat-2"));
    owned.close();
    expect(
      () => new MemoryStore(path, { agentId: "other-agent", ownerId: "max" })
    ).toThrow("绑定");
    expect(
      () => new MemoryStore(path, { agentId: "test-agent", ownerId: "another" })
    ).toThrow("绑定");
  });

  it("妻子的偏好保存为关联人物的转述，和说话人偏好并存", () => {
    const message = source({ content: "我老婆不喜欢香菜，我喜欢香菜。" });
    const wife = store.submit(
      proposal(message, {
        subject: { kind: "related_person", label: "妻子" },
        facet: "饮食",
        conditions: "",
        value: "不喜欢香菜",
      })
    );
    const speaker = store.submit(
      proposal(message, { facet: "饮食", conditions: "", value: "喜欢香菜" })
    );
    expect(wife.memory.assertion).toBe("reported");
    expect(speaker.memory.status).toBe("active");
    expect(store.searchMemories()).toHaveLength(2);
    expect(() =>
      store.submit(proposal(message, { subject: { kind: "related_person" } }))
    ).toThrow("名称");
  });

  it.each(["tool", "unknown", "system"])(
    "拒绝%s角色当作人物事实证据",
    (role) => {
      expect(() => store.submit(proposal(source({ role })))).toThrow("角色");
    }
  );

  it("助手建议只能成为候选，不能冒充用户确认", () => {
    const assistant = source({ role: "assistant", content: "建议夜间26度" });
    expect(() => store.submit(proposal(assistant))).toThrow("助手建议");
    expect(
      store.submit(proposal(assistant, { assertion: "assistant_suggestion" }))
        .memory.status
    ).toBe("candidate");
    expect(() =>
      store.submit(proposal(source(), { assertion: "assistant_suggestion" }))
    ).toThrow("助手原话");
    expect(store.searchMemories()).toHaveLength(0);
  });

  it("拒绝不存在的证据、伪造引文、错误修订和跨智能体ID", () => {
    const message = source();
    const input = proposal(message);
    for (const ref of [
      { messageId: "nonexistent", revision: 1, quote: message.content },
      { messageId: message.sourceId, revision: 2, quote: message.content },
      { messageId: message.sourceId, revision: 1, quote: "原文没有这句话" },
    ])
      expect(() => store.submit({ ...input, sources: [ref] })).toThrow();
    const foreign = new MemoryStore(":memory:", { agentId: "foreign" });
    expect(() => foreign.submit(input)).toThrow("尚未同步");
    foreign.close();
    expect(store.status().memories).toBe(0);
  });

  it("暂存候选不能自证成原始消息", () => {
    const capture = store.captureCandidate("今天聊天还没同步", "等待官方历史");
    expect(store.captureCandidate("今天聊天还没同步", "重试")).toEqual(capture);
    const input = proposal(source());
    expect(() =>
      store.submit({
        ...input,
        sources: [
          {
            messageId: String(capture.id),
            revision: 1,
            quote: "今天聊天还没同步",
          },
        ],
      })
    ).toThrow("尚未同步");
    expect(store.listCaptures()).toHaveLength(1);
  });

  it("同一请求重试无重复操作；相同请求标识不能换内容", () => {
    const input = proposal(source());
    const result = store.submit(input);
    expect(store.submit(input)).toEqual(result);
    expect(store.operations()).toHaveLength(1);
    expect(() => store.submit({ ...input, value: "25度" })).toThrow("不同内容");
  });

  it("相同证据重复提交不虚增证据；新来源只补证一次", () => {
    const first = source();
    const saved = store.submit(proposal(first));
    expect(store.submit(proposal(first)).outcome).toBe("duplicate");
    const second = source({ createdAt: "2026-11-12T12:00:00Z" });
    const added = store.submit(proposal(second));
    expect(added.memory.id).toBe(saved.memory.id);
    expect(added.memory.sources).toHaveLength(2);
    expect(added.memory.observedAt).toBe("2026-11-12T12:00:00.000Z");
    expect(store.submit(proposal(second)).memory.sources).toHaveLength(2);
  });

  it("显式补证要求相同内容和目标版本", () => {
    const first = source();
    const saved = store.submit(proposal(first));
    const repeated = proposal(first, {
      operation: "reinforce",
      targetId: saved.memory.id,
      targetRevision: 1,
    });
    expect(store.submit(repeated).outcome).toBe("duplicate");
    const second = source({ createdAt: "2026-11-12T12:00:00Z" });
    expect(
      store.submit({
        ...repeated,
        requestId: randomUUID(),
        sources: proposal(second).sources,
      }).outcome
    ).toBe("reinforced");
    expect(() =>
      store.submit({ ...repeated, requestId: randomUUID() })
    ).toThrow("已改变");
  });

  it("不同条件共存；同条件内容冲突先存候选", () => {
    store.submit(proposal(source()));
    expect(
      store.submit(
        proposal(source({ content: "白天28度" }), {
          value: "28度",
          conditions: "白天",
        })
      ).memory.status
    ).toBe("active");
    expect(
      store.submit(proposal(source({ content: "夜间25度" }), { value: "25度" }))
        .memory.status
    ).toBe("candidate");
    expect(store.searchMemories()).toHaveLength(2);
    expect(store.searchMemories({ includeCandidates: true })).toHaveLength(3);
    expect(store.searchMemories({ query: "白天" })).toHaveLength(1);
    expect(store.searchMemories({ scope: "chat:other:unknown" })).toHaveLength(
      0
    );
  });

  it.each(["inferred", "event", "plan"] as const)(
    "%s不能自动成为长期正式偏好",
    (assertion) => {
      expect(
        store.submit(proposal(source(), { assertion })).memory.status
      ).toBe("candidate");
      expect(store.searchMemories()).toHaveLength(0);
    }
  );

  it("缺时间或未来时间为候选，过期内容不进入当前检索", () => {
    expect(
      store.submit(proposal(source({ createdAt: null }))).memory.status
    ).toBe("candidate");
    expect(
      store.submit(
        proposal(
          source({ chatId: "future", createdAt: "2027-01-01T00:00:00Z" })
        )
      ).memory.status
    ).toBe("candidate");
    expect(
      store.submit(
        proposal(source({ chatId: "expired" }), {
          validUntil: "2026-11-11T00:00:00Z",
        })
      ).memory.status
    ).toBe("historical");
    expect(() =>
      store.submit(
        proposal(source(), {
          validFrom: "2026-11-12T00:00:00Z",
          validUntil: "2026-11-11T00:00:00Z",
        })
      )
    ).toThrow("结束时间");
    expect(store.searchMemories()).toHaveLength(0);
  });

  it("明确纠正保留旧版本并自动使概要失效", () => {
    const original = store.submit(proposal(source()));
    const summaryInput = {
      requestId: randomUUID(),
      title: "卧室偏好",
      text: "夜间26度",
      memories: [{ id: original.memory.id, revision: 1 }],
    };
    store.saveSummary(summaryInput);
    const change = replacement(original);
    const corrected = store.submit(change);
    expect(corrected.outcome).toBe("replaced");
    expect(store.getMemory(original.memory.id)?.status).toBe("superseded");
    expect(store.searchMemories()[0].value).toBe("25度");
    expect(store.listSummaries()).toHaveLength(0);
    expect(store.saveSummary(summaryInput).status).toBe("invalidated");
    expect(store.exportData().memoryVersions).toHaveLength(3);
    expect(store.submit(change).memory.id).toBe(corrected.memory.id);
  });

  it("纠正必须有原话、同一主体属性条件和当前目标版本", () => {
    const original = store.submit(proposal(source()));
    expect(() =>
      store.submit(replacement(original, { correctionQuote: undefined }))
    ).toThrow("纠正原话");
    expect(() =>
      store.submit(replacement(original, { correctionQuote: "伪造纠正" }))
    ).toThrow("纠正原话");
    expect(() =>
      store.submit(replacement(original, { conditions: "白天" }))
    ).toThrow("不能互相覆盖");
    expect(() =>
      store.submit(replacement(original, { targetRevision: 99 }))
    ).toThrow("已改变");
    expect(() =>
      store.submit(replacement(original, { operation: "add" }))
    ).toThrow("覆盖目标");
  });

  it("晚到旧历史和相同陈述时间不能回滚新状态", () => {
    const current = store.submit(
      proposal(source({ createdAt: "2026-11-12T12:00:00Z" }))
    );
    const old = source({
      content: "当时夜间25度",
      createdAt: "2026-11-09T12:00:00Z",
    });
    const oldChange = proposal(old, {
      operation: "replace",
      targetId: current.memory.id,
      targetRevision: 1,
      correctionQuote: old.content,
      value: "25度",
    });
    expect(store.submit(oldChange).outcome).toBe("historical");
    expect(store.submit(replacement(current)).outcome).toBe("candidate");
    expect(store.searchMemories()[0].value).toBe("26度");
  });

  it("计划在未来才生效的变更不能提前覆盖当前状态", () => {
    const current = store.submit(proposal(source()));
    expect(
      store.submit(replacement(current, { validFrom: "2027-01-01T00:00:00Z" }))
        .outcome
    ).toBe("candidate");
    expect(store.searchMemories()[0].value).toBe("26度");
  });

  it("来源修订使记忆及概要失效，旧请求重试也不能复活", () => {
    const input = proposal(source({ id: "mutable" }));
    const memory = store.submit(input).memory;
    store.saveSummary({
      requestId: randomUUID(),
      title: "温度",
      text: "26度",
      memories: [{ id: memory.id, revision: 1 }],
    });
    source({ id: "mutable", content: "原话有误，重新记录" });
    expect(store.getMemory(memory.id)?.status).toBe("invalidated");
    expect(store.searchMemories()).toHaveLength(0);
    expect(store.listSummaries()).toHaveLength(0);
    expect(store.submit(input).memory.status).toBe("invalidated");
    expect(store.exportData().messageVersions).toHaveLength(2);
  });

  it("概要不能引用过期版本或混合未知身份", () => {
    const first = store.submit(proposal(source())).memory;
    const second = store.submit(proposal(source({ chatId: "chat-2" }))).memory;
    const input = {
      requestId: randomUUID(),
      title: "摘要",
      text: "温度",
      memories: [
        { id: first.id, revision: 1 },
        { id: second.id, revision: 1 },
      ],
    };
    expect(() => store.saveSummary(input)).toThrow("不同会话");
    expect(() =>
      store.saveSummary({
        ...input,
        memories: [{ id: first.id, revision: 99 }],
      })
    ).toThrow("无效记忆");
  });

  it("撤销纠正恢复旧事实并撤销新事实，重复撤销幂等", () => {
    const first = store.submit(proposal(source()));
    const changed = store.submit(replacement(first));
    expect(store.undo(changed.operationId)).toMatchObject({
      restored: 2,
      alreadyUndone: false,
    });
    expect(store.searchMemories()[0].value).toBe("26度");
    expect(store.getMemory(changed.memory.id)?.status).toBe("retracted");
    expect(store.undo(changed.operationId)).toMatchObject({
      alreadyUndone: true,
    });
    expect(() => store.undo("unknown")).toThrow("不存在");
  });

  it("撤销不能覆盖后续修改或复活已变更的来源", () => {
    const first = store.submit(proposal(source({ id: "first" })));
    const changed = store.submit(replacement(first));
    source({ id: "first", content: "旧证据已经变更" });
    expect(() => store.undo(changed.operationId)).toThrow("后续修改");
    expect(store.searchMemories()[0].value).toBe("25度");
  });

  it("备份包含已提交的WAL消息、绑定和审计，可重新打开", () => {
    const result = store.submit(proposal(source()));
    store.setSyncState({ phase: "scanning", page: 2 });
    const path = join(directory, "backup.sqlite");
    store.backup(path);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const restored = new MemoryStore(path, { agentId: "test-agent" });
    expect(restored.status()).toMatchObject({ messages: 1, activeMemories: 1 });
    expect(restored.getSyncState()).toEqual({ phase: "scanning", page: 2 });
    expect(restored.getMemory(result.memory.id)?.value).toBe("26度");
    restored.close();
    expect(() => store.backup(path)).toThrow("不能覆盖");
    expect(() => store.backup("relative.sqlite")).toThrow("绝对路径");
    expect(
      () => new MemoryStore("relative.sqlite", { agentId: "test" })
    ).toThrow("绝对路径");
  });

  it("未来或缺失时间的补证不能抬高当前事实的观察时间", () => {
    const current = store.submit(proposal(source()));
    for (const createdAt of [null, "2027-01-01T00:00:00Z"]) {
      const uncertain = source({ createdAt });
      expect(store.submit(proposal(uncertain)).memory.status).toBe("candidate");
      expect(() =>
        store.submit(
          proposal(uncertain, {
            operation: "reinforce",
            targetId: current.memory.id,
            targetRevision: 1,
          })
        )
      ).toThrow("独立候选");
    }
    expect(store.getMemory(current.memory.id)?.observedAt).toBe(
      "2026-11-10T12:00:00.000Z"
    );
    expect(store.submit(replacement(current)).outcome).toBe("replaced");
  });

  it("附加较新但无关的来源不能把旧纠正伪装成新纠正", () => {
    const current = store.submit(
      proposal(source({ createdAt: "2026-11-11T12:00:00Z" }))
    );
    const old = source({
      content: "更正夜间25度",
      createdAt: "2026-11-09T12:00:00Z",
    });
    const unrelated = source({
      content: "今天天气很好",
      createdAt: "2026-11-12T12:00:00Z",
    });
    const input = proposal(old, {
      operation: "replace",
      targetId: current.memory.id,
      targetRevision: 1,
      correctionQuote: old.content,
      value: "25度",
    });
    input.sources.push(...proposal(unrelated).sources);
    expect(store.submit(input).outcome).toBe("historical");
    expect(store.searchMemories()[0].value).toBe("26度");
  });

  it("本机重新绑定端点留下审计，但不允许修改智能体绑定", () => {
    store.bindMetadata("endpoint", "a".repeat(64));
    expect(store.rebindEndpoint("b".repeat(64)).rebound).toBe(true);
    expect(() => store.bindMetadata("endpoint", "b".repeat(64))).not.toThrow();
    expect(() => store.rebindEndpoint("bad")).toThrow("指纹");
    expect(() => store.bindMetadata("agent", "other")).toThrow("绑定");
    expect(store.operations()[0].kind).toBe("rebind_endpoint");
  });

  it("数据库误指向目录时拒绝打开，并保留目录原权限", () => {
    const originalMode = statSync(directory).mode;
    expect(() => new MemoryStore(directory, { agentId: "test-agent" })).toThrow(
      "普通文件"
    );
    expect(statSync(directory).mode).toBe(originalMode);
  });
});
