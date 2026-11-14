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
const idleBulkExtract = { active: false, total: 0, remaining: 0 };

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
      status: { autoExtractEnabled: enabled, bulkExtract: idleBulkExtract },
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
      status: { autoExtractEnabled: true, bulkExtract: idleBulkExtract },
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

  it("自动提炼关闭时也可整理全部，暂停保留进度，继续后按服务端进度刷新直至完成", async () => {
    let bulkExtract = idleBulkExtract;
    const getOverview = vi
      .spyOn(memoryApi, "overview")
      .mockImplementation(async () => ({
        ...overview,
        status: { autoExtractEnabled: false, bulkExtract: { ...bulkExtract } },
      }));
    const fetchMock = vi.fn<typeof fetch>(async (_url, options) => {
      const { enabled } = JSON.parse(String(options?.body));
      bulkExtract = bulkExtract.total
        ? { ...bulkExtract, active: enabled }
        : { active: enabled, total: 7, remaining: 7 };
      return new Response(JSON.stringify({ success: true, data: bulkExtract }));
    });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => {
      render(<MemoryPage />);
    });
    async function clickAction(name: string, enabled: boolean) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name }));
      });
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/memory/bulk-extract",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ enabled }),
        })
      );
      expect(
        screen.getByRole("switch", { name: "自动提炼" })
      ).not.toBeChecked();
    }
    async function advancePoll() {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    }
    await clickAction("整理全部", true);
    expect(screen.getByText("已整理 0 / 7 条，剩余 7 条")).toBeVisible();
    bulkExtract = { ...bulkExtract, remaining: 4 };
    await advancePoll();
    expect(screen.getByText("已整理 3 / 7 条，剩余 4 条")).toBeVisible();
    await clickAction("暂停整理", false);
    expect(
      screen.getByText("已暂停，已整理 3 / 7 条，剩余 4 条")
    ).toBeVisible();
    const callsAfterPause = getOverview.mock.calls.length;
    await advancePoll();
    expect(getOverview).toHaveBeenCalledTimes(callsAfterPause);
    await clickAction("继续整理", true);
    bulkExtract = { ...bulkExtract, active: false, remaining: 0 };
    await advancePoll();
    expect(screen.getByText("已整理 7 / 7 条，剩余 0 条")).toBeVisible();
    expect(screen.getByRole("button", { name: "整理全部" })).toBeEnabled();
    const callsAfterCompletion = getOverview.mock.calls.length;
    await advancePoll();
    expect(getOverview).toHaveBeenCalledTimes(callsAfterCompletion);
  });

  it.each([0, 7])(
    "整理全部失败后可重试，上次整理 %i 条后空队列有提示",
    async (total) => {
      const emptyQueue = { ...idleBulkExtract, total };
      vi.spyOn(memoryApi, "overview").mockResolvedValue({
        ...overview,
        status: { autoExtractEnabled: true, bulkExtract: emptyQueue },
      });
      vi.spyOn(memoryApi, "setBulkExtract")
        .mockRejectedValueOnce(new Error("请稍后重试"))
        .mockResolvedValue(emptyQueue);
      await act(async () => {
        render(<MemoryPage />);
      });
      const button = screen.getByRole("button", { name: "整理全部" });
      await act(async () => {
        fireEvent.click(button);
      });
      expect(screen.getByRole("alert")).toHaveTextContent("请稍后重试");
      await act(async () => {
        fireEvent.click(button);
      });
      expect(screen.getByText("暂无待整理的对话。")).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
  );

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
