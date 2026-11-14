import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, MCPServerConfig } from "../../../config/index.js";
import { responseEnhancerMiddleware } from "../../middlewares/response-enhancer.middleware.js";
import { memoryRoutes } from "../../routes/domains/memory.route.js";
import type { HandlerDependencies } from "../../routes/types.js";
import {
  MemoryAdminService,
  type MemoryAdminWorkerRunner,
} from "../../services/MemoryAdminService.js";
import type { AppContext } from "../../types/hono.context.js";
import { MemoryApiHandler, memoryAdminMiddleware } from "../memory.handler.js";

describe("记忆管理 HTTP 安全与契约", () => {
  let directory: string;
  let app: Hono<AppContext>;
  let service: MemoryAdminService;
  let worker: MemoryAdminWorkerRunner;
  const origin = "http://localhost:9999";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "memory-web-handler-"));
    writeFileSync(join(directory, "token"), "placeholder-token");
    const state: AppConfig = {
      mcpEndpoint: "wss://example.invalid/mcp?token=private-endpoint",
      mcpServers: {
        archive: {
          command: process.execPath,
          args: ["--experimental-sqlite", resolve("dist/memory/stdio.js")],
          env: {
            XIAOZHI_MEMORY_AGENT_ID: "agent-a",
            XIAOZHI_MEMORY_DB: join(directory, "archive.sqlite"),
            XIAOZHI_MEMORY_CLIENT_CONFIG: join(
              directory,
              "xiaozhi.config.json"
            ),
            XIAOZHI_MEMORY_TOKEN_FILE: join(directory, "token"),
          },
        },
      },
    };
    worker = {
      run: vi
        .fn()
        .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
      close: vi.fn(),
    };
    service = new MemoryAdminService({
      config: {
        getConfig: () => state,
        getConfigDir: () => directory,
        getConfigPath: () => join(directory, "xiaozhi.config.json"),
        updateMcpServer: (name: string, value: MCPServerConfig) => {
          state.mcpServers[name] = value;
        },
      },
      worker,
    });
    const handler = new MemoryApiHandler(service);
    app = new Hono<AppContext>();
    app.use("*", responseEnhancerMiddleware);
    app.use("*", memoryAdminMiddleware);
    app.use("*", async (c, next) => {
      c.set("dependencies", {
        memoryApiHandler: handler,
      } as HandlerDependencies);
      await next();
    });
    for (const route of memoryRoutes) {
      app.on(
        route.method,
        route.path,
        async (c) => (await route.handler(c)) ?? c.notFound()
      );
    }
  });

  afterEach(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("同源查询返回统一格式并禁用缓存，不暴露通配 CORS", async () => {
    const response = await app.request(
      `${origin}/api/memory/chats?query=coffee&page=501&pageSize=10`,
      { headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" } }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toMatchObject({
      success: true,
      data: { items: [] },
    });
    expect(worker.run).toHaveBeenCalledWith(
      { action: "chats", query: "coffee", page: 501, pageSize: 10 },
      expect.any(Object),
      expect.any(Object)
    );
  });

  it("分类和当前记忆筛选传入工作进程后再分页", async () => {
    const response = await app.request(
      `${origin}/api/memory/entries?category=user_profile&status=current&page=2&pageSize=12`
    );
    expect(response.status).toBe(200);
    expect(vi.mocked(worker.run).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        action: "memories",
        category: "user_profile",
        status: "current",
        page: 2,
        pageSize: 12,
      })
    );
  });

  it.each([
    { Origin: "https://attacker.invalid" },
    { Origin: "null" },
    { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-site" },
    {
      Origin: "https://attacker.invalid",
      "X-Forwarded-Host": "attacker.invalid",
      "X-Forwarded-Proto": "https",
    },
    { Origin: origin, Host: "attacker.invalid" },
  ])("跨源或伪造转发头的读取和写入都被拒绝：%j", async (headers) => {
    const read = await app.request(`${origin}/api/memory/chats`, { headers });
    const write = await app.request(`${origin}/api/memory/sync`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
    });
    for (const response of [read, write]) {
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: "MEMORY_ORIGIN_REJECTED" },
      });
    }
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("跨源预检不能被全站宽松规则放行，同源预检不返回 CORS 授权", async () => {
    const blocked = await app.request(`${origin}/api/memory/settings`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.invalid",
        "Access-Control-Request-Method": "PUT",
      },
    });
    expect(blocked.status).toBe(403);
    const sameOrigin = await app.request(`${origin}/api/memory/settings`, {
      method: "OPTIONS",
      headers: { Origin: origin },
    });
    expect(sameOrigin.status).toBe(204);
    expect(sameOrigin.headers.get("access-control-allow-origin")).toBeNull();
  });

  it.each([
    "page=0",
    "page=1x",
    "page=2.5",
    "pageSize=51",
    "page=1&page=2",
    "path=/etc/passwd",
    "status=made-up",
    "category=made-up",
  ])("非法分页和额外参数不进入工作进程：%s", async (query) => {
    const response = await app.request(`${origin}/api/memory/entries?${query}`);
    expect(response.status).toBe(400);
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("自动提炼开关只接受布尔值并通过管理工作进程更新", async () => {
    const url = `${origin}/api/memory/auto-extract`;
    const send = (body: unknown) =>
      app.request(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const body of [{}, { enabled: "true" }, { enabled: true, extra: 1 }]) {
      expect((await send(body)).status).toBe(400);
    }
    expect(worker.run).not.toHaveBeenCalled();
    vi.mocked(worker.run).mockResolvedValue({ enabled: true });
    const response = await send({ enabled: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { enabled: true },
    });
    expect(worker.run).toHaveBeenCalledWith(
      { action: "setAutoExtractEnabled", enabled: true },
      expect.any(Object),
      expect.any(Object)
    );
    expect(service.getSettings().restartRequired).toBe(false);
  });

  it("设置拒绝额外路径字段、错误类型及过短自动同步间隔", async () => {
    const valid = {
      agentId: "agent-a",
      ownerId: "",
      syncIntervalSeconds: 0,
      syncMaxRequests: 20,
    };
    for (const body of [
      { ...valid, databasePath: "/tmp/arbitrary.sqlite" },
      { ...valid, syncMaxRequests: "20" },
      { ...valid, syncIntervalSeconds: 30 },
    ]) {
      const response = await app.request(`${origin}/api/memory/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(service.getSettings().restartRequired).toBe(false);
  });

  it("凭据接口只接受令牌字段，响应不回显令牌或任意路径", async () => {
    const token = "sensitive.test-token_123==";
    const rejected = await app.request(`${origin}/api/memory/credential`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, path: "/tmp/arbitrary" }),
    });
    expect(rejected.status).toBe(400);
    const response = await app.request(`${origin}/api/memory/credential`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain(directory);
    expect(JSON.parse(text)).toEqual({
      success: true,
      data: { configured: true },
    });
  });

  it("正文超过 20 KiB 或写入不使用 JSON 时在执行前拒绝", async () => {
    const tooLarge = await app.request(`${origin}/api/memory/credential`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "a".repeat(21 * 1024) }),
    });
    expect(tooLarge.status).toBe(413);
    const form = await app.request(`${origin}/api/memory/sync`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(form.status).toBe(415);
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("删除限定单条记忆与版本，拒绝跨源和额外字段", async () => {
    const url = `${origin}/api/memory/entries/entry-123`;
    const send = (body: unknown, headers = {}) =>
      app.request(url, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    expect(
      (await send({ revision: 3 }, { Origin: "https://attacker.invalid" }))
        .status
    ).toBe(403);
    expect((await send({ revision: 3, all: true })).status).toBe(400);
    expect((await send({ revision: 0 })).status).toBe(400);
    expect(worker.run).not.toHaveBeenCalled();
    expect((await send({ revision: 3 })).status).toBe(200);
    expect(vi.mocked(worker.run).mock.calls[0]?.[0]).toEqual({
      action: "delete",
      id: "entry-123",
      revision: 3,
    });
  });

  it("停用保留版本检查和多行理由，撤销只接受固定操作 ID", async () => {
    const reason = "用户已确认失效\n保留历史来源供核对。";
    const retire = await app.request(
      `${origin}/api/memory/entries/entry-123/retire`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: 3, reason }),
      }
    );
    expect(retire.status).toBe(200);
    expect(worker.run).toHaveBeenLastCalledWith(
      { action: "retire", id: "entry-123", revision: 3, reason },
      expect.any(Object),
      expect.any(Object)
    );
    const undo = await app.request(
      `${origin}/api/memory/operations/operation-123/undo`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }
    );
    expect(undo.status).toBe(200);
    expect(worker.run).toHaveBeenLastCalledWith(
      { action: "undo", operationId: "operation-123" },
      expect.any(Object),
      expect.any(Object)
    );
  });

  it("后台同步返回 202，运行期间重复请求返回冲突", async () => {
    worker.run = vi.fn(() => new Promise(() => undefined));
    const first = await app.request(`${origin}/api/memory/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({
      success: true,
      data: { state: "running" },
    });
    const second = await app.request(`${origin}/api/memory/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(second.status).toBe(409);
  });

  it("底层异常不回显正文、文件路径或凭据", async () => {
    worker.run = vi
      .fn()
      .mockRejectedValue(
        new Error("secret-token /private/path confidential-user-content")
      );
    const response = await app.request(`${origin}/api/memory/messages`);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toMatch(
      /secret-token|private\/path|confidential-user-content/u
    );
    expect(JSON.parse(text)).toMatchObject({
      success: false,
      error: { code: "MEMORY_OPERATION_FAILED" },
    });
  });

  it("完整导出直接下载 JSON 附件，任意备份文件名不能读取", async () => {
    worker.run = vi
      .fn()
      .mockResolvedValue({ schema: 1, messages: [{ content: "合成档案" }] });
    const response = await app.request(`${origin}/api/memory/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="memory-export-/u
    );
    expect(await response.json()).toEqual({
      schema: 1,
      messages: [{ content: "合成档案" }],
    });
    const arbitrary = await app.request(
      `${origin}/api/memory/backups/archive.sqlite`
    );
    expect(arbitrary.status).toBe(404);
  });
});
