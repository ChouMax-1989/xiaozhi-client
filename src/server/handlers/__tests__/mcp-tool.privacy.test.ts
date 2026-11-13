import { inspect } from "node:util";
import type { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../Logger.js";
import type { AppContext } from "../../types/hono.context.js";
import { MCPToolHandler } from "../mcp-tool.handler.js";

vi.mock("../../Logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe("网页工具测试入口的记忆日志", () => {
  beforeEach(() => vi.clearAllMocks());

  function createContext(name: string, serviceName = "customMCP") {
    const secret = "网页工具请求中的私密原话";
    const rawResult = { content: [{ type: "text", text: secret }] };
    const manager = {
      isSensitiveToolCall: vi.fn(
        (toolName: string) => toolName === "family_recall"
      ),
      hasCustomMCPTool: vi.fn(() => true),
      getCustomMCPTools: vi.fn(() => [
        {
          name,
          description: "测试工具",
          inputSchema: { type: "object" },
        },
      ]),
      callTool: vi.fn().mockResolvedValue(rawResult),
    };
    const context = {
      req: {
        json: async () => ({
          serviceName,
          toolName: name,
          args: { query: secret },
        }),
      },
      get: (key: string) => (key === "logger" ? logger : manager),
      success: (data: unknown) => new Response(JSON.stringify({ data })),
      fail: (_code: string, message: string) =>
        new Response(JSON.stringify({ error: message })),
    } as unknown as Context<AppContext>;
    return { context, manager, secret, rawResult };
  }

  it.each(["memory_search", "family_recall"])(
    "工具 %s 的原话只返回调用者，不进入网页操作日志",
    async (name) => {
      const { context, manager, secret, rawResult } = createContext(name);
      const response = await new MCPToolHandler().callTool(context);

      expect(await response.json()).toEqual({ data: rawResult });
      expect(manager.callTool).toHaveBeenCalledWith(
        name,
        { query: secret },
        expect.any(Object)
      );
      expect(
        inspect(vi.mocked(logger.info).mock.calls, { depth: null })
      ).not.toContain(secret);
      if (name === "family_recall") {
        expect(manager.isSensitiveToolCall).toHaveBeenCalledWith(name);
      }
    }
  );

  it("记忆别名的异常只隐藏日志，错误响应保持原样", async () => {
    const { context, manager, secret } = createContext("family_recall");
    manager.callTool.mockRejectedValue(new Error(secret));
    const response = await new MCPToolHandler().callTool(context);

    expect(await response.json()).toEqual({ error: secret });
    expect(
      inspect(vi.mocked(logger.error).mock.calls, { depth: null })
    ).not.toContain(secret);
  });

  it("普通工具继续记录原参数", async () => {
    const { context, secret } = createContext("add", "calculator");
    await new MCPToolHandler().callTool(context);
    expect(
      inspect(vi.mocked(logger.info).mock.calls, { depth: null })
    ).toContain(secret);
  });
});
