import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncHistory } from "../history.js";
import { MemoryStore } from "../store.js";
import type {
  ArchiveChat,
  ArchiveMessage,
  HistorySink,
  ImportCounts,
} from "../types.js";

const TOKEN = "test-only.private-token.never-log";
const AGENT = "configured-agent";

class TestSink implements HistorySink {
  chats = new Map<string, ArchiveChat>();
  messages = new Map<string, ArchiveMessage>();
  state: Record<string, unknown> | null = null;

  upsertChat(chat: ArchiveChat): void {
    this.chats.set(chat.id, structuredClone(chat));
  }

  upsertMessages(messages: ArchiveMessage[]): ImportCounts {
    const counts = { inserted: 0, updated: 0, unchanged: 0 };
    for (const message of messages) {
      const key = `${message.chatId}/${message.id}`;
      const previous = this.messages.get(key);
      if (!previous) counts.inserted++;
      else if (JSON.stringify(previous) !== JSON.stringify(message)) {
        counts.updated++;
      } else counts.unchanged++;
      this.messages.set(key, structuredClone(message));
    }
    return counts;
  }

  getSyncState(): Record<string, unknown> | null {
    return structuredClone(this.state);
  }

  setSyncState(state: Record<string, unknown>): void {
    this.state = structuredClone(state);
  }

  async restart(path: string): Promise<TestSink> {
    await writeFile(
      path,
      JSON.stringify({
        chats: [...this.chats],
        messages: [...this.messages],
        state: this.state,
      })
    );
    const saved = JSON.parse(await readFile(path, "utf8")) as {
      chats: [string, ArchiveChat][];
      messages: [string, ArchiveMessage][];
      state: Record<string, unknown> | null;
    };
    const reopened = new TestSink();
    reopened.chats = new Map(saved.chats);
    reopened.messages = new Map(saved.messages);
    reopened.state = saved.state;
    return reopened;
  }
}

function response(list: unknown[], page = 1, totalPages = 1): Response {
  return Response.json({ data: { list, pagination: { page, totalPages } } });
}

describe("官方历史只读同步", () => {
  let directory: string;
  let tokenFile: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "xiaozhi-history-"));
    tokenFile = join(directory, "token.txt");
    await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it("近期检查使用独立预算，保留工具结果并推进完整扫描断点", async () => {
    const sink = new TestSink();
    const calls: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      if (url.pathname.endsWith("/list")) {
        calls.push(`list:${page}`);
        return response([{ id: "new" }, { id: "old" }], page, 1);
      }
      const chat = url.searchParams.get("chatId");
      calls.push(`${chat}:${page}`);
      expect(url.searchParams.get("includeTools")).toBe("1");
      return response(
        [{ id: `${chat}-${page}`, role: "tool", content: "result" }],
        page,
        chat === "new" ? 3 : 1
      );
    });
    const options = {
      agentId: AGENT,
      tokenFile,
      fetchImpl: fetcher,
      maxRequests: 1,
      recentMaxRequests: 4,
    };
    const first = await syncHistory(sink, options);
    expect(first).toMatchObject({ reason: "request_budget", requests: 5 });
    expect(calls).toEqual(["list:1", "new:1", "new:3", "old:1", "list:1"]);
    expect(sink.messages.get("new/new-3")).toMatchObject({
      role: "tool",
      content: "result",
    });
    expect(sink.state).toMatchObject({
      phase: "messages",
      chatIndex: 0,
      page: 1,
    });
    calls.length = 0;
    const second = await syncHistory(sink, options);
    expect(second.requests).toBe(5);
    expect(calls.at(-1)).toBe("new:1");
    expect(sink.state).toMatchObject({
      phase: "messages",
      chatIndex: 0,
      page: 2,
    });
    expect(second.messages.unchanged).toBeGreaterThan(0);
  });

  it("近期请求失败后保留全量检查点，下次重试", async () => {
    const sink = new TestSink();
    let fail = true;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/list")) return response([{ id: "new" }]);
      if (fail) return new Response(null, { status: 503 });
      return response([{ id: "m", role: "tool", content: "ok" }]);
    });
    const options = {
      agentId: AGENT,
      tokenFile,
      fetchImpl: fetcher,
      maxRequests: 1,
      recentMaxRequests: 2,
    };
    expect(await syncHistory(sink, options)).toMatchObject({
      reason: "server_error",
      requests: 2,
    });
    expect(sink.state).toMatchObject({ phase: "chats", page: 1, chatIds: [] });
    fail = false;
    expect(await syncHistory(sink, options)).toMatchObject({
      reason: "request_budget",
      requests: 3,
    });
    expect(sink.messages.has("new/m")).toBe(true);
    expect(sink.state).toMatchObject({ phase: "messages", page: 1 });
  });

  it("逐页保存所有角色与原始字段，只有两轮一致后才完成", async () => {
    const sink = new TestSink();
    const first = {
      id: "m1",
      role: "user",
      content: "我喜欢安静",
      created_at: "2026-11-13 14:30:00",
      url: "https://example.invalid/audio",
      voice_embedding_id: "speaker-vector",
      total_ms: 2400,
      extra: { futureField: [1, 2] },
    };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://xiaozhi.me");
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(init?.body).toBeUndefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        `Bearer ${TOKEN}`
      );
      const page = Number(url.searchParams.get("page"));
      if (url.pathname === "/api/chats/list") {
        expect(url.searchParams.get("agentId")).toBe(AGENT);
        expect(url.searchParams.get("pageSize")).toBe("20");
        return response([{ id: `c${page}`, agent_id: AGENT }], page, 2);
      }
      expect(url.pathname).toBe("/api/chats/messages");
      expect(url.searchParams.get("pageSize")).toBe("50");
      expect(url.searchParams.get("includeTools")).toBe("1");
      expect(url.searchParams.get("order")).toBe("asc");
      if (url.searchParams.get("chatId") === "c2") {
        return response([{ id: 7, role: "unknown", content: null }]);
      }
      return page === 1
        ? response([first], 1, 2)
        : response(
            [
              {
                id: "m2",
                role: "assistant",
                content: "好的",
                created_at: "2026-11-13T14:30:01+08:00",
                chatId: "c1",
              },
              { id: "m3", role: "tool", content: { result: ["完整", "保留"] } },
              { id: "m4", role: "future-role", content: ["原始", "结构"] },
              { id: "m5", content: "未知角色也应归档" },
            ],
            2,
            2
          );
    });

    const result = await syncHistory(sink, {
      agentId: AGENT,
      tokenFile,
      fetchImpl: fetcher,
    });

    expect(result).toMatchObject({
      status: "complete",
      reason: "verified",
      requests: 10,
      completedScans: 2,
      chatsVisited: 4,
      messages: { inserted: 6, updated: 0, unchanged: 6 },
    });
    expect(result.lastVerifiedAt).toEqual(expect.any(String));
    expect(sink.messages.get("c1/m1")).toMatchObject({
      createdAt: null,
      raw: first,
    });
    expect(sink.messages.get("c1/m2")?.createdAt).toBe(
      "2026-11-13T06:30:01.000Z"
    );
    expect(sink.messages.get("c1/m3")).toMatchObject({
      role: "tool",
      content: JSON.stringify({ result: ["完整", "保留"] }),
    });
    expect(sink.messages.get("c1/m4")?.role).toBe("future-role");
    expect(sink.messages.get("c1/m5")?.role).toBe("unknown");
    expect(sink.messages.get("c2/7")?.content).toBe("");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(sink.state)).not.toContain(first.content);
    expect(JSON.stringify(sink.state)).not.toContain(TOKEN);
  });

  it("请求预算与服务失败均保留分页位置，重启后从失败页恢复并按消息标识去重", async () => {
    let sink = new TestSink();
    let fail = false;
    const requested: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/list")) {
        requested.push("列表");
        return response([{ id: "c1" }]);
      }
      const page = Number(url.searchParams.get("page"));
      requested.push(`消息${page}`);
      if (fail && page === 2) return new Response(TOKEN, { status: 503 });
      return response(
        [{ id: `m${page}`, role: "user", content: `第${page}页` }],
        page,
        3
      );
    });
    const options = { agentId: AGENT, tokenFile, fetchImpl: fetcher };
    const first = await syncHistory(sink, { ...options, maxRequests: 2 });
    expect(first).toMatchObject({
      status: "incomplete",
      reason: "request_budget",
      requests: 2,
    });
    expect(sink.state).toMatchObject({
      phase: "messages",
      page: 2,
      expectedPages: 3,
    });
    sink = await sink.restart(join(directory, "checkpoint.json"));

    fail = true;
    const failed = await syncHistory(sink, options);
    expect(failed).toMatchObject({
      status: "incomplete",
      reason: "server_error",
      requests: 1,
    });
    expect(sink.messages.size).toBe(1);
    expect(sink.state?.page).toBe(2);
    sink = await sink.restart(join(directory, "checkpoint.json"));

    fail = false;
    const resumed = await syncHistory(sink, options);
    expect(resumed).toMatchObject({
      status: "complete",
      requests: 6,
      completedScans: 2,
    });
    expect(requested.slice(0, 4)).toEqual(["列表", "消息1", "消息2", "消息2"]);
    expect(sink.messages.size).toBe(3);
    const repeated = await syncHistory(sink, options);
    expect(repeated).toMatchObject({
      status: "complete",
      requests: 8,
      messages: { inserted: 0, updated: 0, unchanged: 6 },
    });
    expect(sink.messages.size).toBe(3);
  });

  it("与真实数据库对接后可以关闭重开续扫，复查更新保留来源修订", async () => {
    const databasePath = join(directory, "archive.sqlite");
    let store = new MemoryStore(databasePath, { agentId: AGENT });
    let content = "原始工具内容";
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      new URL(String(input)).pathname.endsWith("/list")
        ? response([{ id: "chat-persisted" }])
        : response([
            {
              id: "message-persisted",
              role: "tool",
              content,
              created_at: "2026-11-13 11:00:00",
              url: "保留原始地址",
            },
          ])
    );
    const options = { agentId: AGENT, tokenFile, fetchImpl: fetcher };
    try {
      const first = await syncHistory(store, { ...options, maxRequests: 2 });
      expect(first).toMatchObject({ status: "incomplete", completedScans: 1 });
      const sourceId = store.readSources({ pendingOnly: false }).messages[0]
        .sourceId;
      store.close();
      store = new MemoryStore(databasePath, { agentId: AGENT });

      const resumed = await syncHistory(store, { ...options, maxRequests: 2 });
      expect(resumed).toMatchObject({
        status: "complete",
        messages: { inserted: 0, updated: 0, unchanged: 1 },
      });
      expect(store.getSource(sourceId)).toMatchObject({
        revision: 1,
        role: "tool",
        createdAt: null,
      });

      content = "经过修改的工具内容";
      const changed = await syncHistory(store, options);
      expect(changed).toMatchObject({
        status: "complete",
        messages: { inserted: 0, updated: 1, unchanged: 1 },
      });
      expect(store.getSource(sourceId)).toMatchObject({
        revision: 2,
        content,
        raw: { url: "保留原始地址" },
      });
      expect(store.exportData().messageVersions).toHaveLength(2);
      expect(store.status().messages).toBe(1);
    } finally {
      store.close();
    }
  });

  it("原文写入后检查点失败时重读该页，不重复创建消息", async () => {
    let sink = new TestSink();
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      new URL(String(input)).pathname.endsWith("/list")
        ? response([{ id: "c1" }])
        : response([{ id: "m1", role: "user", content: "已写入的原文" }])
    );
    const save = sink.setSyncState.bind(sink);
    let saves = 0;
    vi.spyOn(sink, "setSyncState").mockImplementation((state) => {
      if (++saves === 3) throw new Error("模拟检查点写入失败");
      save(state);
    });
    const options = { agentId: AGENT, tokenFile, fetchImpl: fetcher };

    const interrupted = await syncHistory(sink, options);
    expect(interrupted.reason).toBe("storage_error");
    expect(sink.messages.size).toBe(1);
    expect(sink.state).toMatchObject({ phase: "messages", page: 1 });

    sink = await sink.restart(join(directory, "interrupted.json"));
    const resumed = await syncHistory(sink, options);
    expect(resumed).toMatchObject({
      status: "complete",
      requests: 3,
      messages: { inserted: 0, updated: 0, unchanged: 2 },
    });
    expect(sink.messages.size).toBe(1);
  });

  it.each([401, 403])(
    "认证失败 %i 立即停止且不读取可能回显令牌的正文",
    async (status) => {
      const sink = new TestSink();
      const rejected = new Response(`敏感响应：${TOKEN}`, { status });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response([{ id: "c1" }]))
        .mockResolvedValueOnce(
          response([{ id: "m1", role: "user", content: "已归档" }], 1, 2)
        )
        .mockResolvedValueOnce(rejected);

      const result = await syncHistory(sink, {
        agentId: AGENT,
        tokenFile,
        fetchImpl: fetcher,
      });

      expect(result).toMatchObject({
        status: "error",
        reason: "authentication_failed",
        httpStatus: status,
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(rejected.bodyUsed).toBe(false);
      expect(sink.messages.size).toBe(1);
      expect(sink.state).toMatchObject({
        phase: "messages",
        page: 2,
        complete: false,
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  );

  it.each([429, 502])(
    "临时失败 %i 不自动无限重试，保留检查点",
    async (status) => {
      const sink = new TestSink();
      const failed = new Response(TOKEN, { status });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(failed);
      const result = await syncHistory(sink, {
        agentId: AGENT,
        tokenFile,
        fetchImpl: fetcher,
      });
      expect(result.status).toBe("incomplete");
      expect(result.reason).toBe(
        status === 429 ? "rate_limited" : "server_error"
      );
      expect(result.requests).toBe(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(failed.bodyUsed).toBe(false);
      expect(sink.state).toMatchObject({
        phase: "chats",
        page: 1,
        complete: false,
      });
    }
  );

  it("复查发现会话和消息变化时保持未完成，后续完整一轮一致才确认", async () => {
    const sink = new TestSink();
    let scan = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/list")) {
        scan++;
        return response(
          scan === 1 ? [{ id: "c1" }] : [{ id: "c1" }, { id: "c2" }]
        );
      }
      return response([
        {
          id: "m1",
          role: "user",
          content: scan === 1 ? "旧内容" : "新内容",
        },
      ]);
    });
    const options = { agentId: AGENT, tokenFile, fetchImpl: fetcher };

    const changing = await syncHistory(sink, { ...options, maxRequests: 5 });
    expect(changing).toMatchObject({
      status: "incomplete",
      completedScans: 2,
      lastVerifiedAt: null,
    });
    expect(sink.state?.complete).toBe(false);
    expect(sink.messages.get("c1/m1")?.content).toBe("新内容");

    const stable = await syncHistory(sink, { ...options, maxRequests: 3 });
    expect(stable).toMatchObject({ status: "complete", completedScans: 3 });
    expect(sink.chats.size).toBe(2);
  });

  it("整段分页的总页数变化时重启本轮核对，保留先前已存档内容", async () => {
    const sink = new TestSink();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([{ id: "c1" }], 1, 2))
      .mockResolvedValueOnce(response([{ id: "c2" }], 2, 3));
    const result = await syncHistory(sink, {
      agentId: AGENT,
      tokenFile,
      fetchImpl: fetcher,
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "remote_changed",
      requests: 2,
    });
    expect(sink.state).toMatchObject({
      phase: "chats",
      page: 1,
      chatIds: [],
      completedScans: 0,
    });
    expect(sink.chats.has("c1")).toBe(true);
  });

  it("空历史同样需要明确分页信息和两次完整核对", async () => {
    const sink = new TestSink();
    const fetcher = vi.fn<typeof fetch>(async () => response([], 1, 0));
    const result = await syncHistory(sink, {
      agentId: AGENT,
      tokenFile,
      fetchImpl: fetcher,
    });
    expect(result).toMatchObject({
      status: "complete",
      requests: 2,
      completedScans: 2,
    });
    expect(sink.messages.size).toBe(0);
  });

  it.each([
    { list: [] },
    { list: [], pagination: { page: "1", totalPages: 1 } },
    { list: [], pagination: { page: 1, totalPages: "1" } },
    { list: [], pagination: { page: 1.5, totalPages: 1 } },
    { list: [], pagination: { page: 1, totalPages: 1.5 } },
    {
      list: [],
      pagination: { page: 1, totalPages: Number.MAX_SAFE_INTEGER + 1 },
    },
    { list: [], pagination: { page: 2, totalPages: 2 } },
    { list: [], pagination: { page: 1, totalPages: -1 } },
    { list: [], pagination: { page: 1, totalPages: 2 } },
    { list: "unexpected", pagination: { page: 1, totalPages: 1 } },
  ])("拒绝缺失或非法分页信息，不根据短页猜测同步完成：%j", async (data) => {
    const sink = new TestSink();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data }));
    const result = await syncHistory(sink, {
      agentId: AGENT,
      tokenFile,
      fetchImpl: fetcher,
    });
    expect(result).toMatchObject({
      status: "error",
      reason: "invalid_response",
      requests: 1,
    });
    expect(sink.state).toMatchObject({ page: 1, complete: false });
    expect(sink.chats.size).toBe(0);
  });

  it.each([undefined, "", Number.MAX_SAFE_INTEGER + 1, { id: "嵌套字段" }])(
    "会话标识缺失或不安全时拒绝整页，不能编造标识：%j",
    async (id) => {
      const sink = new TestSink();
      const fetcher = vi.fn<typeof fetch>(async () =>
        response([{ id: "c1" }, { id }])
      );
      const result = await syncHistory(sink, {
        agentId: AGENT,
        tokenFile,
        fetchImpl: fetcher,
      });
      expect(result.reason).toBe("invalid_response");
      expect(sink.chats.size).toBe(0);
      expect(sink.state?.page).toBe(1);
    }
  );

  it.each([undefined, Number.MAX_SAFE_INTEGER + 1])(
    "消息标识无效时保留当前页以便修复后重试：%j",
    async (id) => {
      const sink = new TestSink();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response([{ id: "c1" }]))
        .mockResolvedValueOnce(
          response([
            { id: "m1", role: "user", content: "有效" },
            { id, content: "无效" },
          ])
        );
      const result = await syncHistory(sink, {
        agentId: AGENT,
        tokenFile,
        fetchImpl: fetcher,
      });
      expect(result.reason).toBe("invalid_response");
      expect(sink.messages.size).toBe(0);
      expect(sink.state).toMatchObject({ phase: "messages", page: 1 });
    }
  );

  it.each([
    { phase: "chat", extra: { agentId: "other-agent" } },
    { phase: "chat", extra: { chat_id: "other-chat" } },
    { phase: "message", extra: { agent_id: "other-agent" } },
    { phase: "message", extra: { chatId: "other-chat" } },
  ])("拒绝原始数据里明显冲突的作用域：%j", async ({ phase, extra }) => {
    const sink = new TestSink();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const list = new URL(String(input)).pathname.endsWith("/list");
      return response([
        list
          ? { id: "c1", ...(phase === "chat" ? extra : {}) }
          : { id: "m1", role: "user", content: "不能串库", ...extra },
      ]);
    });
    const result = await syncHistory(sink, {
      agentId: AGENT,
      tokenFile,
      fetchImpl: fetcher,
    });
    expect(result).toMatchObject({
      status: "error",
      reason: "invalid_response",
    });
    expect(sink.messages.size).toBe(0);
  });

  it("检查点不能被另一智能体续用，也不能忽略损坏的检查点", async () => {
    const sink = new TestSink();
    const fetcher = vi.fn<typeof fetch>(async () => response([], 1, 0));
    await syncHistory(sink, {
      agentId: AGENT,
      tokenFile,
      maxRequests: 0,
      fetchImpl: fetcher,
    });
    const mismatch = await syncHistory(sink, {
      agentId: "other-agent",
      tokenFile,
      fetchImpl: fetcher,
    });
    expect(mismatch.reason).toBe("invalid_checkpoint");
    sink.state = { page: 1 };
    const malformed = await syncHistory(sink, {
      agentId: AGENT,
      tokenFile,
      fetchImpl: fetcher,
    });
    expect(malformed.reason).toBe("invalid_checkpoint");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("底层请求、解析、存储和凭据错误不泄漏敏感错误正文或日志", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`凭据 ${TOKEN}`));
    const request = await syncHistory(new TestSink(), {
      agentId: AGENT,
      tokenFile,
      fetchImpl: failingFetch,
    });
    const parse = await syncHistory(new TestSink(), {
      agentId: AGENT,
      tokenFile,
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(TOKEN)),
    });
    const sink = new TestSink();
    vi.spyOn(sink, "setSyncState").mockImplementation(() => {
      throw new Error(TOKEN);
    });
    const storage = await syncHistory(sink, {
      agentId: AGENT,
      tokenFile,
      fetchImpl: failingFetch,
    });
    const token = await syncHistory(new TestSink(), {
      agentId: AGENT,
      tokenFile: join(directory, TOKEN),
      fetchImpl: failingFetch,
    });
    expect([
      request.reason,
      parse.reason,
      storage.reason,
      token.reason,
    ]).toEqual([
      "request_failed",
      "invalid_response",
      "storage_error",
      "token_file_error",
    ]);
    expect(JSON.stringify([request, parse, storage, token])).not.toContain(
      TOKEN
    );
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("调用前取消不读凭据或发请求，请求中取消可立即结束并保留当前页", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const unusedFetch = vi.fn<typeof fetch>();
    const early = await syncHistory(new TestSink(), {
      agentId: AGENT,
      tokenFile: join(directory, "不存在的文件"),
      signal: cancelled.signal,
      fetchImpl: unusedFetch,
    });
    expect(early).toMatchObject({
      status: "incomplete",
      reason: "cancelled",
      requests: 0,
    });
    expect(unusedFetch).not.toHaveBeenCalled();

    const controller = new AbortController();
    const sink = new TestSink();
    let started: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error(TOKEN)),
            { once: true }
          );
          started();
        })
    );
    const running = syncHistory(sink, {
      agentId: AGENT,
      tokenFile,
      signal: controller.signal,
      fetchImpl: fetcher,
    });
    await waiting;
    controller.abort();
    const result = await running;
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "cancelled",
      requests: 1,
    });
    expect(sink.state).toMatchObject({
      phase: "chats",
      page: 1,
      complete: false,
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
