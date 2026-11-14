import "@testing-library/jest-dom/vitest";
import MemoryPage from "@/pages/MemoryPage";
import { memoryApi } from "@/services/memoryApi";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryAdminOverview } from "../../../types/memory-admin";

vi.mock("@/components/site-header", () => ({
  SiteHeader: () => <header>记忆库</header>,
}));
vi.mock("@/components/restart-button", () => ({
  RestartButton: () => <button type="button">重启服务</button>,
}));
vi.mock("@/components/memory/memory-entries", () => ({
  MemoryEntries: () => <p>记忆列表</p>,
}));

vi.mock("@/components/memory/memory-chats", () => ({
  MemoryChats: () => <p>对话记录列表</p>,
}));
vi.mock("@/components/memory/memory-categories", () => ({
  MemoryCategory: ({ title }: { title: string }) => <p>{title}</p>,
}));

const overview: MemoryAdminOverview = {
  settings: {
    configured: true,
    serviceName: "local-memory",
    agentId: "agent-example",
    ownerId: "",
    databasePath: "/data/memory.sqlite",
    tokenConfigured: true,
    syncIntervalSeconds: 0,
    syncMaxRequests: 100,
    identityLocked: true,
    restartRequired: false,
  },
  ready: true,
  status: null,
  error: null,
  counts: {
    chats: 1,
    messages: 10,
    pendingMessages: 2,
    memories: 3,
    activeMemories: 2,
    candidates: 1,
    provisionalCaptures: 0,
    summaries: 1,
  },
  sync: null,
  syncJob: { state: "idle", startedAt: null, finishedAt: null, message: null },
  extractionPrompt: "请依据原话整理记忆。",
  recordingPrompt: "追加角色规则：调用当前工具记录每轮对话。",
};

describe("记忆页面同步状态", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(memoryApi, "settings").mockResolvedValue(overview.settings);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("自动提炼独立保存并可关闭，手动整理始终可用", async () => {
    let enabled = false;
    vi.spyOn(memoryApi, "overview").mockImplementation(async () => ({
      ...overview,
      settings: { ...overview.settings, tokenConfigured: false },
      status: { autoExtractEnabled: enabled },
    }));
    const saveSettings = vi.spyOn(memoryApi, "saveSettings");
    const sync = vi.spyOn(memoryApi, "sync");
    const fetchMock = vi.fn<typeof fetch>(async (_url, options) => {
      enabled = JSON.parse(String(options?.body)).enabled;
      return new Response(JSON.stringify({ success: true, data: { enabled } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => {
      render(<MemoryPage />);
    });
    const toggle = screen.getByRole("switch", { name: "自动提炼" });
    expect(toggle).not.toBeChecked();
    for (const next of [true, false]) {
      await act(async () => {
        fireEvent.click(toggle);
      });
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/memory/auto-extract",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ enabled: next }),
        })
      );
      expect(toggle).toHaveAttribute("aria-checked", String(next));
      expect(
        screen.getByRole("button", { name: "复制整理提示" })
      ).toBeEnabled();
    }
    expect(saveSettings).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "更新角色介绍" }));
    });
    expect(screen.getByRole("button", { name: "复制提示词" })).toBeEnabled();
  });

  it("保存失败显示原因，保留当前状态并允许重试", async () => {
    vi.spyOn(memoryApi, "overview").mockResolvedValue({
      ...overview,
      status: { autoExtractEnabled: true },
    });
    vi.spyOn(memoryApi, "setAutoExtract").mockRejectedValue(
      new Error("数据库暂时不可写")
    );
    await act(async () => {
      render(<MemoryPage />);
    });
    const toggle = screen.getByRole("switch", { name: "自动提炼" });
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("数据库暂时不可写");
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
  });

  it("只在任务运行时轮询，完成后停止并在离开时取消请求", async () => {
    const running = { ...overview.syncJob, state: "running" as const };
    const complete = {
      ...overview.syncJob,
      state: "complete" as const,
      finishedAt: "2026-11-13T10:00:00Z",
    };
    const getOverview = vi
      .spyOn(memoryApi, "overview")
      .mockResolvedValueOnce(overview)
      .mockResolvedValueOnce({ ...overview, syncJob: running })
      .mockResolvedValue({ ...overview, syncJob: complete });
    vi.spyOn(memoryApi, "sync").mockResolvedValue(running);
    let unmount: () => void = () => undefined;
    await act(async () => {
      unmount = render(<MemoryPage />).unmount;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(getOverview).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "设置" }));
    });
    fireEvent.click(screen.getByText("高级设置"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导入旧对话" }));
    });
    expect(getOverview).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "正在同步…" })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getOverview).toHaveBeenCalledTimes(3);
    expect(screen.getByText("同步完成")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(getOverview).toHaveBeenCalledTimes(3);
    unmount();
    expect(getOverview.mock.calls[2][0]?.aborted).toBe(true);
  });

  it("自动同步开启时禁用手动同步，并保留真实的整理提示入口", async () => {
    vi.spyOn(memoryApi, "overview").mockResolvedValue({
      ...overview,
      settings: { ...overview.settings, syncIntervalSeconds: 300 },
    });
    const sync = vi.spyOn(memoryApi, "sync");
    await act(async () => {
      render(<MemoryPage />);
    });
    expect(screen.getByRole("button", { name: "复制整理提示" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "自动提炼" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "导入旧对话" })
    ).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "设置" }));
    });
    expect(screen.getByText("高级设置").closest("details")).not.toHaveAttribute(
      "open"
    );
    fireEvent.click(screen.getByText("高级设置"));
    expect(screen.getByRole("button", { name: "导入旧对话" })).toBeDisabled();
    expect(
      screen.getByText(/自动同步已开启，由服务按间隔同步/)
    ).toBeInTheDocument();
    expect(sync).not.toHaveBeenCalled();
  });
});
