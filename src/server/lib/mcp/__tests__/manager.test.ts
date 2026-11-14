/**
 * MCPServiceManager 功能测试
 * 测试 hasCustomMCPTool、getCustomMCPTools、callTool 重构后的子方法
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configManager } from "../../../../config/index.js";
import { SharedMCPAdapter } from "../../../../endpoint/shared-mcp-adapter.js";
import { logger } from "../../../Logger.js";
import { MCPServiceManager } from "../../../lib/mcp";
import type { ToolCallResult, ToolInfo } from "../../../lib/mcp/types";
import type { CustomMCPHandler } from "../custom.js";

interface PrivacyTestInternals {
  services: Map<
    string,
    {
      isConnected(): boolean;
      callTool(
        name: string,
        args: Record<string, unknown>
      ): Promise<ToolCallResult>;
      disconnect(): Promise<void>;
    }
  >;
  tools: Map<string, ToolInfo>;
  toolCallLogger: { recordToolCall: ReturnType<typeof vi.fn> };
  updateToolStatsSafe(): Promise<void>;
}

// Mock dependencies
vi.mock("../../../Logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withTag: vi.fn().mockReturnValue({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

vi.mock("../../../../config/index.js", () => ({
  configManager: {
    getCustomMCPTools: vi.fn(),
    getMcpServers: vi.fn(),
    getToolCallLogConfig: vi.fn().mockReturnValue({
      maxRecords: 100,
    }),
    getConfigDir: vi.fn().mockReturnValue("/tmp"),
    isToolEnabled: vi.fn().mockReturnValue(true),
  },
}));

vi.mock("../custom.js", () => ({
  CustomMCPHandler: vi.fn().mockImplementation(() => ({
    // 基础方法
    initialize: vi.fn(),
    reinitialize: vi.fn(),
    hasTool: vi.fn(),
    getTools: vi.fn(),
    getToolCount: vi.fn(),
    getToolNames: vi.fn(),
    getToolInfo: vi.fn(),

    // 工具调用方法
    callTool: vi.fn(),

    // 资源管理方法
    cleanup: vi.fn(),
    stopCleanupTimer: vi.fn(),
  })),
}));

vi.mock("../../../lib/mcp/cache.js", () => ({
  MCPCacheManager: vi.fn().mockImplementation(() => ({
    loadCache: vi.fn(),
    saveCache: vi.fn(),
  })),
}));

vi.mock("../../../lib/mcp/log.js", () => ({
  ToolCallLogger: vi.fn().mockImplementation(() => ({
    recordToolCall: vi.fn().mockResolvedValue(undefined),
    getLogFilePath: vi.fn().mockReturnValue("/tmp/tool-calls.jsonl"),
    getMaxRecords: vi.fn().mockReturnValue(100),
  })),
}));

describe("MCPServiceManager - customMCP 支持", () => {
  let serviceManager: MCPServiceManager;
  let mockCustomMCPHandler: ReturnType<typeof vi.mocked<CustomMCPHandler>>;

  beforeEach(() => {
    // Reset all mocks first
    vi.clearAllMocks();

    // Create service manager instance
    serviceManager = new MCPServiceManager();

    // 直接获取 mock 实例并确保其存在
    mockCustomMCPHandler = vi.mocked(serviceManager.getCustomMCPHandler());

    // 确保 mock 方法存在
    if (!mockCustomMCPHandler.hasTool) {
      mockCustomMCPHandler.hasTool = vi.fn();
    }
    if (!mockCustomMCPHandler.getTools) {
      mockCustomMCPHandler.getTools = vi.fn();
    }
    if (!mockCustomMCPHandler.getToolCount) {
      mockCustomMCPHandler.getToolCount = vi.fn();
    }
    if (!mockCustomMCPHandler.getToolNames) {
      mockCustomMCPHandler.getToolNames = vi.fn();
    }
    if (!mockCustomMCPHandler.getToolInfo) {
      mockCustomMCPHandler.getToolInfo = vi.fn();
    }
    if (!mockCustomMCPHandler.callTool) {
      mockCustomMCPHandler.callTool = vi.fn();
    }

    // 设置默认返回值
    mockCustomMCPHandler.hasTool.mockReturnValue(false);
    mockCustomMCPHandler.getTools.mockReturnValue([]);
    mockCustomMCPHandler.getToolCount.mockReturnValue(0);
    mockCustomMCPHandler.getToolNames.mockReturnValue([]);
    mockCustomMCPHandler.getToolInfo.mockReturnValue(undefined);
    mockCustomMCPHandler.callTool.mockResolvedValue({
      content: [{ type: "text", text: "Mock response" }],
      isError: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("hasCustomMCPTool", () => {
    it("应该正确检查 customMCP 工具是否存在", () => {
      // Arrange
      const toolName = "test_coze_workflow";
      mockCustomMCPHandler.hasTool.mockReturnValue(true);

      // Act
      const result = serviceManager.hasCustomMCPTool(toolName);

      // Assert
      expect(result).toBe(true);
      expect(mockCustomMCPHandler.hasTool).toHaveBeenCalledWith(toolName);
    });

    it("应该正确返回工具不存在的情况", () => {
      // Arrange
      const toolName = "nonexistent_tool";
      mockCustomMCPHandler.hasTool.mockReturnValue(false);

      // Act
      const result = serviceManager.hasCustomMCPTool(toolName);

      // Assert
      expect(result).toBe(false);
      expect(mockCustomMCPHandler.hasTool).toHaveBeenCalledWith(toolName);
    });
  });

  describe("getCustomMCPTools", () => {
    it("应该正确返回 customMCP 工具列表", () => {
      // Arrange
      const expectedTools = [
        {
          name: "test_coze_workflow",
          description: "测试coze工作流是否正常可用",
          inputSchema: {
            type: "object" as const,
            properties: {
              input: {
                type: "string",
                description: "用户说话的内容",
              },
            },
            required: ["input"],
          },
        },
        {
          name: "another_tool",
          description: "另一个测试工具",
          inputSchema: {
            type: "object" as const,
            properties: {
              param: {
                type: "string",
                description: "参数",
              },
            },
          },
        },
      ];

      mockCustomMCPHandler.getTools.mockReturnValue(
        expectedTools as unknown as Tool[]
      );

      // Act
      const result = serviceManager.getCustomMCPTools();

      // Assert
      expect(result).toEqual(expectedTools);
      expect(mockCustomMCPHandler.getTools).toHaveBeenCalled();
    });

    it("应该正确处理空的工具列表", () => {
      // Arrange
      mockCustomMCPHandler.getTools.mockReturnValue([]);

      // Act
      const result = serviceManager.getCustomMCPTools();

      // Assert
      expect(result).toEqual([]);
      expect(mockCustomMCPHandler.getTools).toHaveBeenCalled();
    });
  });

  describe("集成测试", () => {
    it("应该正确集成 customMCP 工具到整体工具管理中", () => {
      // Arrange
      const customTools = [
        {
          name: "custom_tool_1",
          description: "自定义工具1",
          inputSchema: { type: "object" as const },
        },
        {
          name: "custom_tool_2",
          description: "自定义工具2",
          inputSchema: { type: "object" as const },
        },
      ];

      mockCustomMCPHandler.hasTool.mockImplementation((toolName: string) => {
        return customTools.some((tool) => tool.name === toolName);
      });
      mockCustomMCPHandler.getTools.mockReturnValue(
        customTools as unknown as Tool[]
      );

      // Act & Assert - 测试工具存在检查
      expect(serviceManager.hasCustomMCPTool("custom_tool_1")).toBe(true);
      expect(serviceManager.hasCustomMCPTool("custom_tool_2")).toBe(true);
      expect(serviceManager.hasCustomMCPTool("nonexistent_tool")).toBe(false);

      // Act & Assert - 测试工具列表获取
      const tools = serviceManager.getCustomMCPTools();
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe("custom_tool_1");
      expect(tools[1].name).toBe("custom_tool_2");
    });

    it("应该正确处理 CustomMCPHandler 初始化失败的情况", () => {
      // Arrange
      mockCustomMCPHandler.hasTool.mockImplementation(() => {
        throw new Error("CustomMCPHandler 未初始化");
      });

      // Act
      const result = serviceManager.hasCustomMCPTool("test_tool");

      // Assert - 应该返回 false 而不是抛出异常
      expect(result).toBe(false);
      expect(mockCustomMCPHandler.hasTool).toHaveBeenCalledWith("test_tool");
    });
  });

  describe("边界情况测试", () => {
    it("应该正确处理特殊字符的工具名称", () => {
      // Arrange
      const specialToolName = "tool-with_special.chars@123";
      mockCustomMCPHandler.hasTool.mockReturnValue(true);

      // Act
      const result = serviceManager.hasCustomMCPTool(specialToolName);

      // Assert
      expect(result).toBe(true);
      expect(mockCustomMCPHandler.hasTool).toHaveBeenCalledWith(
        specialToolName
      );
    });

    it("应该正确处理空字符串工具名称", () => {
      // Arrange
      const emptyToolName = "";
      mockCustomMCPHandler.hasTool.mockReturnValue(false);

      // Act
      const result = serviceManager.hasCustomMCPTool(emptyToolName);

      // Assert
      expect(result).toBe(false);
      expect(mockCustomMCPHandler.hasTool).toHaveBeenCalledWith(emptyToolName);
    });

    it("应该正确处理工具列表中包含不完整数据的情况", () => {
      // Arrange
      const incompleteTools = [
        {
          name: "complete_tool",
          description: "完整的工具",
          inputSchema: { type: "object" as const },
        },
        {
          name: "incomplete_tool",
          // 缺少 description
          inputSchema: { type: "object" as const },
        } as Tool,
      ];

      mockCustomMCPHandler.getTools.mockReturnValue(
        incompleteTools as unknown as Tool[]
      );

      // Act
      const result = serviceManager.getCustomMCPTools();

      // Assert
      expect(result).toEqual(incompleteTools);
      expect(result).toHaveLength(2);
    });
  });

  describe("错误处理和边界情况", () => {
    it("应该正确处理 CustomMCPHandler 完全未初始化的情况", () => {
      // Arrange - 使用 vi.spyOn 模拟 getCustomMCPHandler 返回 null
      const spy = vi
        .spyOn(serviceManager, "getCustomMCPHandler")
        .mockReturnValue(null as unknown as CustomMCPHandler);

      // Act & Assert - 应该优雅地处理而不是抛出异常
      expect(() => {
        serviceManager.hasCustomMCPTool("test_tool");
      }).not.toThrow();

      expect(() => {
        serviceManager.getCustomMCPTools();
      }).not.toThrow();

      // Cleanup
      spy.mockRestore();
    });

    it("应该正确处理方法调用抛出异常的情况", () => {
      // Arrange
      mockCustomMCPHandler.hasTool.mockImplementation(() => {
        throw new Error("Handler 内部错误");
      });

      // Act
      const result = serviceManager.hasCustomMCPTool("test_tool");

      // Assert - 应该返回 false 而不是抛出异常
      expect(result).toBe(false);
    });

    it("应该正确处理 getTools 方法抛出异常的情况", () => {
      // Arrange
      mockCustomMCPHandler.getTools.mockImplementation(() => {
        throw new Error("获取工具列表失败");
      });

      // Act
      const result = serviceManager.getCustomMCPTools();

      // Assert - 应该返回空数组而不是抛出异常
      expect(result).toEqual([]);
    });
  });
});

describe("MCPServiceManager - resolveToolTarget 工具目标解析", () => {
  let serviceManager: MCPServiceManager;
  let mockCustomMCPHandler: ReturnType<typeof vi.mocked<CustomMCPHandler>>;

  beforeEach(() => {
    vi.clearAllMocks();
    serviceManager = new MCPServiceManager();
    mockCustomMCPHandler = vi.mocked(serviceManager.getCustomMCPHandler());

    // 确保基础 mock 方法存在
    if (!mockCustomMCPHandler.hasTool) {
      mockCustomMCPHandler.hasTool = vi.fn();
    }
    if (!mockCustomMCPHandler.getToolInfo) {
      mockCustomMCPHandler.getToolInfo = vi.fn();
    }

    // 默认：不是 customMCP 工具
    mockCustomMCPHandler.hasTool.mockReturnValue(false);
    mockCustomMCPHandler.getToolInfo.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * 通过 spyOn 访问私有方法 resolveToolTarget
   */
  function spyResolveToolTarget() {
    return vi.spyOn(
      serviceManager,
      "resolveToolTarget" as keyof MCPServiceManager
    ) as unknown as ReturnType<typeof vi.spyOn>;
  }

  describe("custom-mcp 类型工具", () => {
    it("应该正确解析 handler.type === 'mcp' 的 customMCP 工具", () => {
      // Arrange
      const toolName = "mcp_sync_tool";
      const mcpCustomTool = {
        name: toolName,
        description: "MCP 同步工具",
        inputSchema: { type: "object" as const },
        handler: {
          type: "mcp" as const,
          config: {
            serviceName: "mcp-server-1",
            toolName: "original_mcp_tool",
          },
        },
      };

      mockCustomMCPHandler.hasTool.mockReturnValue(true);
      mockCustomMCPHandler.getToolInfo.mockReturnValue(
        mcpCustomTool as unknown as (typeof mockCustomMCPHandler)["getToolInfo"] extends (
          ...args: any
        ) => infer R
          ? R
          : never
      );

      const spy = spyResolveToolTarget();

      // Act
      const result = (serviceManager as any).resolveToolTarget(toolName);

      // Assert
      expect(result.type).toBe("custom-mcp");
      expect(result.toolName).toBe(toolName);
      expect(result.statsServiceName).toBe("mcp-server-1");
      expect(result.statsOriginalName).toBe("original_mcp_tool");
      expect(result.customTool).toBe(mcpCustomTool);
      expect(spy).toHaveBeenCalledWith(toolName);
    });
  });

  describe("custom-other 类型工具", () => {
    it("应该正确解析非 mcp 类型的 customMCP 工具（如 coze）", () => {
      // Arrange
      const toolName = "coze_workflow";
      const cozeCustomTool = {
        name: toolName,
        description: "Coze 工作流",
        inputSchema: { type: "object" as const },
        handler: {
          type: "coze" as const,
          config: { workflowId: "wf_123" },
        },
      };

      mockCustomMCPHandler.hasTool.mockReturnValue(true);
      mockCustomMCPHandler.getToolInfo.mockReturnValue(
        cozeCustomTool as unknown as (typeof mockCustomMCPHandler)["getToolInfo"] extends (
          ...args: any
        ) => infer R
          ? R
          : never
      );

      // Act
      const result = (serviceManager as any).resolveToolTarget(toolName);

      // Assert
      expect(result.type).toBe("custom-other");
      expect(result.toolName).toBe(toolName);
      expect(result.statsServiceName).toBe("customMCP");
      expect(result.statsOriginalName).toBe(toolName);
      expect(result.customTool).toBe(cozeCustomTool);
    });
  });

  describe("standard 标准类型工具", () => {
    it("应该正确解析标准 MCP 工具", () => {
      // Arrange
      const toolName = "standard_tool";
      const toolInfo: ToolInfo = {
        serviceName: "server-a",
        originalName: "original_standard_tool",
        tool: {
          name: toolName,
          description: "标准工具",
          inputSchema: { type: "object" as const },
        } as Tool,
      };

      // 注入 tools Map — 通过设置内部状态模拟已注册的工具
      (serviceManager as any).tools = new Map<string, ToolInfo>([
        [toolName, toolInfo],
      ]);

      mockCustomMCPHandler.hasTool.mockReturnValue(false);

      // Act
      const result = (serviceManager as any).resolveToolTarget(toolName);

      // Assert
      expect(result.type).toBe("standard");
      expect(result.toolName).toBe(toolName);
      expect(result.logServerName).toBe("server-a");
      expect(result.originalName).toBe("original_standard_tool");
      expect(result.statsServiceName).toBe("server-a");
      expect(result.statsOriginalName).toBe("original_standard_tool");
      expect(result.toolInfo).toBe(toolInfo);
    });
  });

  describe("工具不存在", () => {
    it("当标准 MCP 工具不存在时应该抛出错误", () => {
      // Arrange - 既不是 customMCP，也不在标准工具中
      mockCustomMCPHandler.hasTool.mockReturnValue(false);
      (serviceManager as any).tools = new Map<string, ToolInfo>();

      // Act & Assert
      expect(() => {
        (serviceManager as any).resolveToolTarget("nonexistent_tool");
      }).toThrow("未找到工具: nonexistent_tool");
    });
  });
});

describe("MCPServiceManager - recordToolCallStats 统计记录", () => {
  let serviceManager: MCPServiceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    serviceManager = new MCPServiceManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("成功调用时应该以 isSuccess=true 调用 updateToolStatsSafe", () => {
    // Arrange
    const spy = vi.spyOn(serviceManager, "updateToolStatsSafe" as any);
    const target = {
      type: "standard" as const,
      toolName: "test_tool",
      logServerName: "server-1",
      originalName: "original_test",
      statsServiceName: "server-1",
      statsOriginalName: "original_test",
    };

    // Act
    (serviceManager as any).recordToolCallStats(target, true);

    // Assert
    expect(spy).toHaveBeenCalledWith(
      "test_tool",
      "server-1",
      "original_test",
      true
    );
  });

  it("失败调用时应该以 isSuccess=false 调用 updateToolStatsSafe", () => {
    // Arrange
    const spy = vi.spyOn(serviceManager, "updateToolStatsSafe" as any);
    const target = {
      type: "custom-other" as const,
      toolName: "coze_tool",
      logServerName: "coze",
      originalName: "coze_tool",
      statsServiceName: "customMCP",
      statsOriginalName: "coze_tool",
    };

    // Act
    (serviceManager as any).recordToolCallStats(target, false);

    // Assert
    expect(spy).toHaveBeenCalledWith(
      "coze_tool",
      "customMCP",
      "coze_tool",
      false
    );
  });

  it("custom-mcp 类型工具应该使用正确的统计字段", () => {
    // Arrange
    const spy = vi.spyOn(serviceManager, "updateToolStatsSafe" as any);
    const target = {
      type: "custom-mcp" as const,
      toolName: "sync_tool",
      logServerName: "mcp-server-1",
      originalName: "real_tool",
      statsServiceName: "mcp-server-1",
      statsOriginalName: "real_tool",
    };

    // Act
    (serviceManager as any).recordToolCallStats(target, true);

    // Assert
    expect(spy).toHaveBeenCalledWith(
      "sync_tool",
      "mcp-server-1",
      "real_tool",
      true
    );
  });
});

describe("MCPServiceManager - callTool 编排流程", () => {
  let serviceManager: MCPServiceManager;
  let mockCustomMCPHandler: ReturnType<typeof vi.mocked<CustomMCPHandler>>;

  beforeEach(() => {
    vi.clearAllMocks();
    serviceManager = new MCPServiceManager();
    mockCustomMCPHandler = vi.mocked(serviceManager.getCustomMCPHandler());

    if (!mockCustomMCPHandler.hasTool) {
      mockCustomMCPHandler.hasTool = vi.fn();
    }
    if (!mockCustomMCPHandler.getToolInfo) {
      mockCustomMCPHandler.getToolInfo = vi.fn();
    }
    if (!mockCustomMCPHandler.callTool) {
      mockCustomMCPHandler.callTool = vi.fn();
    }

    mockCustomMCPHandler.hasTool.mockReturnValue(false);
    mockCustomMCPHandler.callTool.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });

    // 替换内部 toolCallLogger 为 mock，避免依赖真实 ToolCallLogger
    (serviceManager as any).toolCallLogger = {
      recordToolCall: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("custom-other 类型工具调用成功时应返回结果并更新统计", async () => {
    // Arrange
    const toolName = "coze_test";
    mockCustomMCPHandler.hasTool.mockReturnValue(true);
    mockCustomMCPHandler.getToolInfo.mockReturnValue({
      name: toolName,
      description: "测试 coze 工具",
      inputSchema: { type: "object" as const },
      handler: { type: "coze" as const, config: {} },
    });

    const statsSpy = vi.spyOn(serviceManager, "updateToolStatsSafe" as any);

    // Act
    const result = await serviceManager.callTool(
      toolName,
      { input: "hello" },
      { timeout: 5000 }
    );

    // Assert
    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    expect(mockCustomMCPHandler.callTool).toHaveBeenCalledWith(
      toolName,
      { input: "hello" },
      { timeout: 5000 }
    );
    // 验证成功统计被调用
    expect(statsSpy).toHaveBeenCalledWith(
      toolName,
      "customMCP",
      toolName,
      true
    );
  });

  it("工具调用失败时应记录失败统计并重新抛出错误", async () => {
    // Arrange
    const toolName = "failing_tool";
    const error = new Error("服务不可用");

    mockCustomMCPHandler.hasTool.mockReturnValue(true);
    mockCustomMCPHandler.getToolInfo.mockReturnValue({
      name: toolName,
      description: "会失败的工具",
      inputSchema: { type: "object" as const },
      handler: { type: "coze" as const, config: {} },
    });
    mockCustomMCPHandler.callTool.mockRejectedValue(error);

    const statsSpy = vi.spyOn(serviceManager, "updateToolStatsSafe" as any);

    // Act & Assert
    await expect(serviceManager.callTool(toolName, {})).rejects.toThrow(
      "服务不可用"
    );

    // 验证失败统计被调用
    expect(statsSpy).toHaveBeenCalledWith(
      toolName,
      "customMCP",
      toolName,
      false
    );
  });

  it("标准 MCP 工具不存在时应抛出未找到错误", async () => {
    // Arrange
    const toolName = "missing_standard";
    mockCustomMCPHandler.hasTool.mockReturnValue(false);
    (serviceManager as any).tools = new Map();

    // Act & Assert
    await expect(serviceManager.callTool(toolName, {})).rejects.toThrow(
      `未找到工具: ${toolName}`
    );
  });

  it("停用的标准工具不能通过直接调用绕过列表", async () => {
    const internals = serviceManager as unknown as PrivacyTestInternals;
    const call = vi.fn().mockResolvedValue({ content: [] });
    internals.services.set("svc", {
      isConnected: () => true,
      callTool: call,
      disconnect: async () => {},
    });
    internals.tools.set("svc__tool", {
      serviceName: "svc",
      originalName: "tool",
      tool: { name: "tool", inputSchema: { type: "object" } },
    });
    vi.mocked(configManager.isToolEnabled).mockReturnValueOnce(false);
    await expect(serviceManager.callTool("svc__tool", {})).rejects.toThrow(
      /停用|禁用/
    );
    expect(call).not.toHaveBeenCalled();
  });

  it("工具返回 isError 时记录失败统计", async () => {
    mockCustomMCPHandler.hasTool.mockReturnValue(true);
    mockCustomMCPHandler.getToolInfo.mockReturnValue({
      name: "custom",
      description: "",
      inputSchema: { type: "object" },
      handler: { type: "coze", config: {} },
    });
    mockCustomMCPHandler.callTool.mockResolvedValue({
      content: [],
      isError: true,
    });
    const stats = vi.spyOn(serviceManager, "updateToolStatsSafe" as any);
    await serviceManager.callTool("custom", {});
    expect(stats).toHaveBeenCalledWith("custom", "customMCP", "custom", false);
  });
});

describe("SharedMCPAdapter 工具发现", () => {
  it("只暴露已启用工具，原管理列表仍保留全部工具", () => {
    const tools = [
      { name: "on", enabled: true },
      { name: "off", enabled: false },
    ];
    const manager = { getAllTools: () => tools };
    const adapter = new SharedMCPAdapter(manager as any);
    expect(adapter.getAllTools().map((tool) => tool.name)).toEqual(["on"]);
    expect(manager.getAllTools()).toHaveLength(2);
  });
});

describe("MCPServiceManager - 记忆工具别名的日志隔离", () => {
  let manager: MCPServiceManager;
  let internals: PrivacyTestInternals;
  let custom: ReturnType<typeof vi.mocked<CustomMCPHandler>>;
  let call: ReturnType<typeof vi.fn>;
  let record: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MCPServiceManager();
    vi.mocked(configManager.isToolEnabled).mockReturnValue(true);
    internals = manager as unknown as PrivacyTestInternals;
    custom = vi.mocked(manager.getCustomMCPHandler());
    custom.hasTool = vi.fn();
    custom.getToolInfo = vi.fn();
    custom.cleanup = vi.fn();
    custom.hasTool.mockReturnValue(true);
    custom.getToolInfo.mockReturnValue({
      name: "family_recall",
      description: "家庭查询别名",
      inputSchema: { type: "object" },
      handler: {
        type: "mcp",
        config: { serviceName: "family", toolName: "memory_search" },
      },
    });
    call = vi.fn();
    record = vi.fn();
    internals.services.set("family", {
      isConnected: () => true,
      callTool: call,
      disconnect: async () => {},
    });
    internals.toolCallLogger = { recordToolCall: record };
    vi.spyOn(internals, "updateToolStatsSafe").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await manager.cleanup();
    vi.restoreAllMocks();
  });

  it("别名解析到记忆原名后隐藏日志，而实际调用保留完整正文", async () => {
    const secret = "别名工具读取的家庭原话";
    const rawResult = { content: [{ type: "text", text: secret }] };
    call.mockResolvedValue(rawResult);

    expect(manager.isSensitiveToolCall("family_recall")).toBe(true);
    const result = await manager.callTool("family_recall", { query: secret });

    expect(result).toBe(rawResult);
    expect(call).toHaveBeenCalledWith("memory_search", { query: secret });
    expect(JSON.stringify(record.mock.calls)).not.toContain(secret);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "memory_search",
        success: true,
        duration: expect.any(Number),
      })
    );
  });

  it("标准工具路由也按原始记忆名称隐藏完整结果调试日志", async () => {
    const secret = "标准路由的私密原话";
    custom.hasTool.mockReturnValue(false);
    internals.tools.set("renamed_tool", {
      serviceName: "family",
      originalName: "memory_get",
      tool: { name: "memory_get", inputSchema: { type: "object" } },
    });
    const rawResult = { content: [{ type: "text", text: secret }] };
    call.mockResolvedValue(rawResult);

    expect(manager.isSensitiveToolCall("renamed_tool")).toBe(true);
    expect(await manager.callTool("renamed_tool", { query: secret })).toBe(
      rawResult
    );
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(
      secret
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain(secret);
  });

  it("别名错误的日志全部隐藏正文，同时继续抛出原异常", async () => {
    const rawError = new Error("别名异常中的私密引文");
    call.mockRejectedValue(rawError);

    await expect(manager.callTool("family_recall", {})).rejects.toBe(rawError);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "memory_search",
        success: false,
        arguments: { redacted: "[记忆正文已隐藏]", chatStart: "omitted" },
        error: "[记忆正文已隐藏]",
      })
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[MCPManager] MCP 同步工具 family_recall 调用失败",
      { error: "[记忆正文已隐藏]" }
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[MCPManager] 工具 family_recall 调用失败",
      { error: "[记忆正文已隐藏]" }
    );
  });

  it.each([
    [
      { chatStart: true },
      { autoExtract: "私密指令", memories: [] },
      true,
      "present",
    ],
    [
      { chatStart: false },
      { memories: [{ autoExtract: "私密引文" }] },
      false,
      "absent",
    ],
    [
      {},
      { segmented: true, chunk: "私密指令", autoExtract: "私密指令" },
      "omitted",
      "present",
    ],
    [
      {},
      { segmented: true, chunk: '{"autoExtract":"私密引文"}' },
      "omitted",
      "unknown",
    ],
    [{ chatStart: "私密参数" }, {}, "invalid", "unknown"],
  ] as const)(
    "检索只记录传参状态与顶层任务标记 %#",
    async (args, response, chatStart, autoExtract) => {
      const rawResult = {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
      call.mockResolvedValue(rawResult);
      expect(
        await manager.callTool("family_recall", { ...args, query: "私密查询" })
      ).toBe(rawResult);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          arguments: { redacted: "[记忆正文已隐藏]", chatStart },
          result: { redacted: "[记忆正文已隐藏]", autoExtract },
        })
      );
      expect(JSON.stringify(record.mock.calls)).not.toContain("私密");
    }
  );

  it("普通工具别名保留参数、返回值和原日志", async () => {
    custom.getToolInfo.mockReturnValue({
      name: "family_recall",
      description: "普通工具别名",
      inputSchema: { type: "object" },
      handler: {
        type: "mcp",
        config: { serviceName: "family", toolName: "calculator_add" },
      },
    });
    const rawResult = { content: [{ type: "text", text: "8" }] };
    call.mockResolvedValue(rawResult);

    expect(manager.isSensitiveToolCall("family_recall")).toBe(false);
    await manager.callTool("family_recall", { a: 3, b: 5 });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "calculator_add",
        arguments: { a: 3, b: 5 },
        result: rawResult,
      })
    );
  });
});

describe("MCPServiceManager - Logger 注入功能", () => {
  let serviceManager: MCPServiceManager;
  let mockCustomMCPHandler: ReturnType<typeof vi.mocked<CustomMCPHandler>>;

  beforeEach(() => {
    // Reset all mocks first
    vi.clearAllMocks();

    // Create service manager instance
    serviceManager = new MCPServiceManager();

    // 直接获取 mock 实例
    mockCustomMCPHandler = vi.mocked(serviceManager.getCustomMCPHandler());

    // 确保 mock 方法存在
    if (!mockCustomMCPHandler.hasTool) {
      mockCustomMCPHandler.hasTool = vi.fn();
    }
    if (!mockCustomMCPHandler.getTools) {
      mockCustomMCPHandler.getTools = vi.fn();
    }
    if (!mockCustomMCPHandler.getToolCount) {
      mockCustomMCPHandler.getToolCount = vi.fn();
    }
    if (!mockCustomMCPHandler.getToolNames) {
      mockCustomMCPHandler.getToolNames = vi.fn();
    }

    // 设置默认返回值
    mockCustomMCPHandler.hasTool.mockReturnValue(false);
    mockCustomMCPHandler.getTools.mockReturnValue([]);
    mockCustomMCPHandler.getToolCount.mockReturnValue(0);
    mockCustomMCPHandler.getToolNames.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("基本功能测试", () => {
    it("应该支持构造函数注入 logger", () => {
      // Act & Assert - 不应该抛出异常
      expect(() => {
        serviceManager = new MCPServiceManager();
      }).not.toThrow();
    });

    it("应该支持不传 logger 的构造函数调用", () => {
      // Act & Assert - 不应该抛出异常
      expect(() => {
        serviceManager = new MCPServiceManager();
      }).not.toThrow();
    });

    // Logger 相关方法已移除，不再需要测试
  });

  describe("向后兼容性测试", () => {
    it("应该与现有的 API 完全兼容", () => {
      // Arrange - 设置完整的 Mock 响应（使用当前实例的 customMCPHandler）
      mockCustomMCPHandler.hasTool.mockReturnValue(true);
      mockCustomMCPHandler.getTools.mockReturnValue([
        {
          name: "test_custom_tool",
          description: "测试自定义工具",
          inputSchema: { type: "object" as const },
        },
      ]);

      // 使用当前的 serviceManager 实例，不重新创建
      // serviceManager 已经在 beforeEach 中创建了

      // Assert - 所有现有方法应该正常工作
      expect(() => {
        // 这些方法可能会内部调用 customMCPHandler 的各种方法
        serviceManager.getAllTools();
        serviceManager.hasTool("test_tool");
        serviceManager.hasCustomMCPTool("test_custom_tool");
        serviceManager.getCustomMCPTools();
        serviceManager.getServiceManagerStatus();
      }).not.toThrow();

      // 验证具体的方法调用结果
      expect(serviceManager.hasCustomMCPTool("test_custom_tool")).toBe(true);
      expect(serviceManager.getCustomMCPTools()).toHaveLength(1);
    });
  });
});
