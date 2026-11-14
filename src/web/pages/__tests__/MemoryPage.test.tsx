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
  MemoryCategory: ({
    title,
    revision,
  }: { title: string; revision: number }) => (
    <p data-revision={revision}>{title}</p>
  ),
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

  it("等待开聊时也能暂停，重进页面保持暂停，空队列可以继续", async () => {
    let enabled = true;
    vi.spyOn(memoryApi, "overview").mockImplementation(async () => ({
      ...overview,
      status: { autoExtractEnabled: enabled, bulkExtract: idleBulkExtract },
    }));
    const fetchMock = vi.fn<typeof fetch>(async (_url, options) => {
      enabled = JSON.parse(String(options?.body)).enabled;
      return new Response(
        JSON.stringify({ success: true, data: idleBulkExtract })
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => {
      render(<MemoryPage />);
    });
    expect(screen.getByText("等待下次开聊")).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "暂停整理" }));
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/memory/bulk-extract",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      })
    );
    cleanup();
    await act(async () => {
      render(<MemoryPage />);
    });
    expect(screen.getByText("已暂停")).toBeVisible();
    expect(screen.getByRole("button", { name: "复制整理提示" })).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "继续整理" }));
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/memory/bulk-extract",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      })
    );
    expect(screen.getByText("等待下次开聊")).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "更新角色介绍" }));
    });
    expect(screen.getByRole("button", { name: "复制提示词" })).toBeEnabled();
  });

  it("自动发现开聊任务，暂停保留进度，继续后刷新直至完成", async () => {
    let enabled = true;
    let bulkExtract = idleBulkExtract;
    const getOverview = vi
      .spyOn(memoryApi, "overview")
      .mockImplementation(async () => ({
        ...overview,
        status: {
          autoExtractEnabled: enabled,
          bulkExtract: { ...bulkExtract },
        },
      }));
    vi.spyOn(memoryApi, "setBulkExtract").mockImplementation(async (next) => {
      enabled = next;
      bulkExtract = {
        ...bulkExtract,
        active: next && bulkExtract.remaining > 0,
      };
      return bulkExtract;
    });
    await act(async () => {
      render(<MemoryPage />);
    });
    async function advancePoll(interval: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(interval);
      });
    }
    bulkExtract = { active: true, total: 7, remaining: 7 };
    await advancePoll(30000);
    expect(screen.getByText("已整理 0 / 7 条，剩余 7 条")).toBeVisible();
    bulkExtract = { ...bulkExtract, remaining: 4 };
    await advancePoll(5000);
    expect(screen.getByText("已整理 3 / 7 条，剩余 4 条")).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "暂停整理" }));
    });
    expect(
      screen.getByText("已暂停，已整理 3 / 7 条，剩余 4 条")
    ).toBeVisible();
    const callsAfterPause = getOverview.mock.calls.length;
    await advancePoll(30000);
    expect(getOverview).toHaveBeenCalledTimes(callsAfterPause);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "继续整理" }));
    });
    bulkExtract = { ...bulkExtract, active: false, remaining: 0 };
    await advancePoll(5000);
    expect(screen.getByText(/已整理 7 \/ 7 条，剩余 0 条/)).toBeVisible();
    expect(screen.getByRole("button", { name: "暂停整理" })).toBeEnabled();
  });

  it("两次轮询之间完成开聊任务也会刷新记忆列表", async () => {
    const counts = overview.counts!;
    vi.spyOn(memoryApi, "overview")
      .mockResolvedValueOnce({
        ...overview,
        status: { autoExtractEnabled: true, bulkExtract: idleBulkExtract },
      })
      .mockResolvedValue({
        ...overview,
        counts: { ...counts, memories: counts.memories + 1 },
        status: {
          autoExtractEnabled: true,
          bulkExtract: { ...idleBulkExtract, total: 2 },
        },
      });
    await act(async () => {
      render(<MemoryPage />);
    });
    expect(screen.getByText("用户画像")).toHaveAttribute("data-revision", "0");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(screen.getByText("用户画像")).toHaveAttribute("data-revision", "1");
  });

  it("暂停失败后显示原因，保留当前状态并允许重试", async () => {
    let enabled = true;
    vi.spyOn(memoryApi, "overview").mockImplementation(async () => ({
      ...overview,
      status: { autoExtractEnabled: enabled, bulkExtract: idleBulkExtract },
    }));
    vi.spyOn(memoryApi, "setBulkExtract")
      .mockRejectedValueOnce(new Error("数据库暂时不可写"))
      .mockImplementationOnce(async (next) => {
        enabled = next;
        return idleBulkExtract;
      });
    await act(async () => {
      render(<MemoryPage />);
    });
    const button = screen.getByRole("button", { name: "暂停整理" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("数据库暂时不可写");
    expect(button).toBeEnabled();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("已暂停")).toBeVisible();
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
    expect(screen.getByRole("button", { name: "正在读取状态" })).toBeDisabled();
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
