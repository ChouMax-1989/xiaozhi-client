import { DashboardStatusCard } from "@/components/dashboard-status-card";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock stores with hoisted mocks
const mockUseMcpEndpoint = vi.hoisted(() =>
  vi.fn(() => ["http://localhost:3000"])
);
const mockUseMcpServers = vi.hoisted(() =>
  vi.fn(() => ({ server1: { command: "test" } }))
);
const mockUseMcpServersWithStatus = vi.hoisted(() =>
  vi.fn(() => ({
    servers: [
      {
        name: "server1",
        connected: true,
        status: "connected",
        tools: [],
        config: { command: "test" },
      },
    ],
    loading: false,
    refresh: vi.fn(),
    lastUpdate: Date.now(),
  }))
);
const useConfig = vi.hoisted(() =>
  vi.fn(() => ({
    modelscope: { apiKey: "test-key" },
    platforms: { coze: { token: "test-token" } },
    connection: {
      heartbeatInterval: 30000,
      heartbeatTimeout: 5000,
      reconnectInterval: 5000,
    },
  }))
);
const mockUseVoiceInteractionConfig = vi.hoisted(() =>
  vi.fn(() => ({
    asr: { appid: "test-appid", accessToken: "test-token" },
    llm: {
      model: "gpt-4",
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
    },
    tts: {
      appid: "test-appid",
      accessToken: "test-token",
      voice_type: "test-voice",
    },
  }))
);

vi.mock("@/stores/config", () => ({
  useMcpEndpoint: mockUseMcpEndpoint,
  useMcpServers: mockUseMcpServers,
  useMcpServersWithStatus: mockUseMcpServersWithStatus,
  useConfig,
  useVoiceInteractionConfig: mockUseVoiceInteractionConfig,
}));

vi.mock("@/stores/status", () => ({
  useStatusStore: vi.fn(() => ({
    clientStatus: { status: "connected" as const },
    loading: { isLoading: false, isRestarting: false },
    polling: { enabled: true },
    lastSource: "http",
  })),
  useRestartPollingStatus: vi.fn(() => null),
}));

// Mock child components
vi.mock("@/components/mcp-endpoint-setting-button", () => ({
  McpEndpointSettingButton: () => (
    <div data-testid="mcp-endpoint-setting-button" />
  ),
}));
vi.mock("@/components/tool-call-logs-dialog", () => ({
  ToolCallLogsDialog: () => <div data-testid="tool-call-logs-dialog" />,
}));
vi.mock("@/components/system-setting-dialog", () => ({
  SystemSettingDialog: () => <div data-testid="system-setting-dialog" />,
}));
vi.mock("@/components/voice-interaction-setting-dialog", () => ({
  VoiceInteractionSettingDialog: () => (
    <div data-testid="voice-interaction-setting-dialog" />
  ),
}));

describe("DashboardStatusCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 恢复默认mock值
    mockUseMcpEndpoint.mockReturnValue(["http://localhost:3000"]);
    mockUseMcpServers.mockReturnValue({ server1: { command: "test" } });
    mockUseMcpServersWithStatus.mockReturnValue({
      servers: [
        {
          name: "server1",
          connected: true,
          status: "connected",
          tools: [],
          config: { command: "test" },
        },
      ],
      loading: false,
      refresh: vi.fn(),
      lastUpdate: Date.now(),
    });
    useConfig.mockReturnValue({
      modelscope: { apiKey: "test-key" },
      platforms: { coze: { token: "test-token" } },
      connection: {
        heartbeatInterval: 30000,
        heartbeatTimeout: 5000,
        reconnectInterval: 5000,
      },
    });
    mockUseVoiceInteractionConfig.mockReturnValue({
      asr: { appid: "test-appid", accessToken: "test-token" },
      llm: {
        model: "gpt-4",
        apiKey: "test-key",
        baseURL: "https://api.openai.com/v1",
      },
      tts: {
        appid: "test-appid",
        accessToken: "test-token",
        voice_type: "test-voice",
      },
    });
  });

  it("应该正确渲染所有状态卡片", () => {
    render(<DashboardStatusCard />);

    // 检查小智接入点卡片
    expect(screen.getByText("小智接入点")).toBeInTheDocument();
    // 检查端点数量显示
    expect(screen.getByText("1")).toBeInTheDocument(); // 小智接入点: 1

    // 检查MCP服务卡片 - 新格式为 "已连接 X 个，共 Y 个服务"
    expect(screen.getByText("MCP服务")).toBeInTheDocument();
    expect(screen.getByText("已连接 1 个，共 1 个服务")).toBeInTheDocument();
    // 检查服务数量显示格式为 "1/1"
    expect(screen.getByText("1/1")).toBeInTheDocument();
  });

  it("应该正确渲染设置按钮", () => {
    render(<DashboardStatusCard />);

    expect(
      screen.getByTestId("mcp-endpoint-setting-button")
    ).toBeInTheDocument();
    expect(screen.getByTestId("tool-call-logs-dialog")).toBeInTheDocument();
  });

  it("应该正确渲染多个MCP端点", () => {
    // Mock多个端点
    mockUseMcpEndpoint.mockReturnValue([
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:3002",
    ]);

    render(<DashboardStatusCard />);

    // 使用getAllByText来获取所有的"3"，确保至少存在一个
    const endpointCounts = screen.getAllByText("3");
    expect(endpointCounts.length).toBeGreaterThanOrEqual(1);
  });

  it("应该正确处理空MCP服务器", () => {
    // Mock空服务器
    mockUseMcpServersWithStatus.mockReturnValue({
      servers: [],
      loading: false,
      refresh: vi.fn(),
      lastUpdate: Date.now(),
    });

    render(<DashboardStatusCard />);

    expect(screen.getByText("0/0")).toBeInTheDocument();
    expect(screen.getByText("已连接 0 个，共 0 个服务")).toBeInTheDocument();
  });

  it("应该正确处理空MCP端点", () => {
    // Mock空端点
    mockUseMcpEndpoint.mockReturnValue([]);

    render(<DashboardStatusCard />);

    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("四类配置有明确命名区域", () => {
    render(<DashboardStatusCard />);
    for (const name of ["小智接入点", "MCP服务", "实时语音", "系统设置"]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
  });

  it("显示真实配置完成度与待补配置数量", () => {
    useConfig.mockReturnValue({
      modelscope: { apiKey: "" },
      platforms: { coze: { token: "" } },
      connection: {
        heartbeatInterval: 30000,
        heartbeatTimeout: 5000,
        reconnectInterval: 5000,
      },
    });
    render(<DashboardStatusCard />);
    expect(screen.getByText("已配置 3/5")).toBeInTheDocument();
    expect(screen.getByText("还差 2 项配置")).toBeInTheDocument();
  });
});
