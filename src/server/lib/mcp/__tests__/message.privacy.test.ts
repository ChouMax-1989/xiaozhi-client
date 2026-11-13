import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../Logger.js";
import type { MCPServiceManager } from "../manager.js";
import { MCPMessageHandler } from "../message.js";

vi.mock("../../../Logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe("MCP 消息入口的记忆日志", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["family__memory_search", "recall_family"])(
    "隐藏工具 %s 的请求正文并保留实际响应",
    async (name) => {
      const secret = "只返回调用者的完整记忆";
      const rawResult = { content: [{ type: "text", text: secret }] };
      const manager = {
        callTool: vi.fn().mockResolvedValue(rawResult),
        isSensitiveToolCall: vi.fn((tool: string) => tool === "recall_family"),
      };
      const handler = new MCPMessageHandler(
        manager as unknown as MCPServiceManager
      );
      const response = await handler.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { query: secret } },
      });

      expect(manager.callTool).toHaveBeenCalledWith(name, { query: secret });
      expect(response?.result).toMatchObject(rawResult);
      expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(
        secret
      );
    }
  );

  it("隐藏错误日志中的记忆正文，同时保留原错误响应", async () => {
    const secret = "异常携带的私密引文";
    const handler = new MCPMessageHandler({
      callTool: vi.fn().mockRejectedValue(new Error(secret)),
    } as unknown as MCPServiceManager);
    const response = await handler.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "memory_commit", arguments: { quote: secret } },
    });

    expect(response?.error?.message).toContain(secret);
    expect(logger.error).toHaveBeenCalledWith(
      "工具调用失败: memory_commit",
      "[记忆正文已隐藏]"
    );
    expect(logger.error).toHaveBeenCalledWith(
      "处理消息时出错: tools/call",
      "[记忆正文已隐藏]"
    );
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
      secret
    );
  });

  it("普通工具的请求日志保持原样", async () => {
    const handler = new MCPMessageHandler({
      callTool: vi.fn().mockResolvedValue({ content: [] }),
    } as unknown as MCPServiceManager);
    const message = {
      jsonrpc: "2.0" as const,
      id: 3,
      method: "tools/call",
      params: { name: "calculator_add", arguments: { a: 3, b: 5 } },
    };
    await handler.handleMessage(message);
    expect(logger.debug).toHaveBeenCalledWith(
      "处理 MCP 消息: tools/call",
      message
    );
  });
});
