import App from "@/App";
import { memoryApi } from "@/services/memoryApi";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { memoryRolePrompt } from "../../../memory/prompts";
import type {
  MemoryAdminOverview,
  MemoryRecord,
} from "../../../types/memory-admin";

vi.mock("@/providers/NetworkServiceProvider", () => ({
  NetworkServiceProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/hooks/useRestartNotifications", () => ({
  RestartNotificationProvider: () => null,
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/version-display", () => ({ VersionDisplay: () => null }));
vi.mock("@/components/dashboard-status-card", () => ({
  DashboardStatusCard: () => null,
}));
vi.mock("@/components/mcp-tool/mcp-tool-table", () => ({
  McpToolTable: () => null,
}));
vi.mock("@/components/memory/memory-chats", () => ({
  MemoryChats: () => null,
}));
vi.mock("@/components/memory/memory-categories", () => ({
  MemoryCategory: () => null,
}));

const overview: MemoryAdminOverview = {
  ready: true,
  status: {
    autoExtractEnabled: false,
    bulkExtract: { active: false, total: 0, remaining: 0 },
  },
  error: null,
  counts: null,
  sync: null,
  settings: {
    configured: true,
    serviceName: "memory",
    agentId: "test-agent",
    ownerId: "",
    databasePath: "",
    tokenConfigured: false,
    syncIntervalSeconds: 0,
    syncMaxRequests: 100,
    identityLocked: true,
    restartRequired: false,
  },
  syncJob: { state: "idle", startedAt: null, finishedAt: null, message: null },
  extractionPrompt: "",
  recordingPrompt: memoryRolePrompt(),
};
const reference = { messageId: "message-a", revision: 1, quote: "我喜欢温水" };
const memory: MemoryRecord = {
  id: "memory-a",
  revision: 1,
  scope: "sample",
  subject: { kind: "speaker" },
  facet: "喜好",
  value: "喜欢温水",
  assertion: "explicit",
  conditions: "",
  status: "active",
  observedAt: null,
  validFrom: null,
  validUntil: null,
  sources: [reference],
  reason: "合成记录",
  supersedes: null,
  createdAt: "2026-11-14T00:00:00Z",
};

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(memoryApi, "settings").mockResolvedValue({
    ...overview.settings,
    serviceName: "archive",
  });
  vi.spyOn(memoryApi, "overview").mockResolvedValue(overview);
  vi.spyOn(memoryApi, "entries").mockResolvedValue({
    items: [memory],
    total: 1,
    page: 1,
    pageSize: 50,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("三个导航入口平级，图谱节点可打开引用版本的完整原文", async () => {
  const user = userEvent.setup();
  vi.spyOn(memoryApi, "detail").mockResolvedValue({
    memory,
    versions: [memory],
    sources: [
      {
        ...reference,
        currentRevision: 1,
        message: {
          id: "message-a",
          sourceId: "source-a",
          chatId: "chat-a",
          role: "user",
          content: "我喜欢温水，尤其在早晨。",
          createdAt: memory.createdAt,
          revision: 1,
          processedRevision: 1,
        },
      },
    ],
  });
  render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <App />
    </MemoryRouter>
  );
  const mainNav = () =>
    within(screen.getByRole("navigation", { name: "主导航" }));
  expect(
    mainNav()
      .getAllByRole("link")
      .map((link) => link.textContent)
  ).toEqual(["看板", "记忆库", "记忆图谱"]);
  await user.click(mainNav().getByRole("link", { name: "记忆图谱" }));
  await user.click(
    await screen.findByRole("button", { name: "查看记忆：喜好：喜欢温水" })
  );
  const sheet = within(await screen.findByRole("dialog"));
  await user.click(
    await sheet.findByRole("button", { name: "查看本版完整原文" })
  );
  expect(sheet.getByText("我喜欢温水，尤其在早晨。")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(mainNav().getByRole("link", { name: "记忆图谱" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  await user.click(mainNav().getByRole("link", { name: "记忆库" }));
  expect(
    await screen.findByRole("region", { name: "提炼记忆" })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "记忆图谱" })
  ).not.toBeInTheDocument();
  expect(mainNav().getByRole("link", { name: "记忆库" })).toHaveAttribute(
    "aria-current",
    "page"
  );
});

it("看板无需连接记忆服务即可复制完整的正式角色提示词", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <App />
    </MemoryRouter>
  );
  const instructions = within(
    screen.getByRole("region", { name: "小智角色提示词" })
  );
  expect(instructions.getByText(/小智 AI 控制台/)).toBeInTheDocument();
  expect(
    await instructions.findByText(memoryRolePrompt("archive"), {
      normalizer: (value) => value.trim(),
    })
  ).toBeVisible();
  await user.click(instructions.getByRole("button", { name: "复制提示词" }));
  expect(write).toHaveBeenCalledWith(
    expect.stringContaining("archive__memory_search")
  );
  expect(write).toHaveBeenCalledWith(memoryRolePrompt("archive"));
  const copied = write.mock.calls.at(-1)?.[0];
  expect(copied).toContain("开聊、普通聊天和自然告别都不触发");
  expect(copied).toContain("archive__memory_capture_candidate");
  expect(copied).not.toContain("archive__memory_record_turn");
  expect(copied).not.toContain("archive__memory_read_sources");
  expect(copied).not.toContain("archive__memory_finish_sources");
  expect(memoryApi.overview).not.toHaveBeenCalled();
});

it("未配置时直接打开图谱链接可前往记忆库完成设置", async () => {
  vi.mocked(memoryApi.overview).mockResolvedValue({
    ...overview,
    ready: false,
    settings: { ...overview.settings, configured: false },
  });
  render(
    <MemoryRouter initialEntries={["/memory-graph"]}>
      <App />
    </MemoryRouter>
  );
  expect(await screen.findByText("先完成记忆服务设置")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "前往记忆库" })).toHaveAttribute(
    "href",
    "/memory"
  );
  expect(memoryApi.entries).not.toHaveBeenCalled();
});
