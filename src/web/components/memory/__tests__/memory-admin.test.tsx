import "@testing-library/jest-dom/vitest";
import { MemoryDetailSheet } from "@/components/memory/memory-detail";
import { MemoryEntries } from "@/components/memory/memory-entries";
import { MemoryOperations } from "@/components/memory/memory-history";
import { MemorySettingsForm } from "@/components/memory/memory-settings";
import { memoryApi } from "@/services/memoryApi";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MemoryAdminSettings,
  MemoryDetailView,
  MemoryRecord,
} from "../../../../types/memory-admin";

vi.mock("@/components/restart-button", () => ({
  RestartButton: () => <button type="button">重启服务</button>,
}));

const settings: MemoryAdminSettings = {
  configured: true,
  serviceName: "local-memory",
  agentId: "agent-example",
  ownerId: "owner-example",
  databasePath: "/data/memory.sqlite",
  tokenConfigured: true,
  syncIntervalSeconds: 0,
  syncMaxRequests: 100,
  identityLocked: true,
  restartRequired: false,
};

const memory: MemoryRecord = {
  id: "memory-example",
  revision: 3,
  scope: "owner-example",
  subject: { kind: "speaker" },
  facet: "饮食偏好",
  value: "喜欢无糖绿茶",
  assertion: "explicit",
  conditions: "平时",
  status: "active",
  observedAt: null,
  validFrom: null,
  validUntil: null,
  sources: [
    { messageId: "message-example", revision: 1, quote: "我喜欢喝无糖绿茶。" },
  ],
  reason: "用户明确表达",
  supersedes: null,
  createdAt: "2026-11-13T08:00:00Z",
};

const detail: MemoryDetailView = {
  memory,
  versions: [memory],
  sources: [
    {
      ...memory.sources[0],
      currentRevision: 2,
      message: {
        id: "message-example",
        sourceId: "official-example",
        chatId: "chat-example",
        role: "user",
        content: "我喜欢喝无糖绿茶。晚上一般不喝。",
        createdAt: "2026-11-13T07:00:00Z",
        revision: 1,
        processedRevision: 1,
      },
    },
  ],
};

function ok(data: unknown) {
  return new Response(JSON.stringify({ success: true, data }), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("记忆库管理交互", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("翻页后搜索和状态筛选均从第一页重新请求", async () => {
    const requests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = new URL(String(input), "http://localhost");
        requests.push(url);
        if (url.pathname.endsWith("/captures")) return ok([]);
        return ok({
          items: [memory],
          page: Number(url.searchParams.get("page")),
          pageSize: 12,
          total: 25,
        });
      })
    );
    const user = userEvent.setup();
    render(<MemoryEntries revision={0} onSelect={vi.fn()} />);
    await screen.findByText("喜欢无糖绿茶");
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(requests[requests.length - 1]?.searchParams.get("page")).toBe("2")
    );
    await user.type(screen.getByLabelText("搜索记忆"), "绿茶");
    await user.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => {
      expect(requests[requests.length - 1]?.searchParams.get("page")).toBe("1");
      expect(requests[requests.length - 1]?.searchParams.get("query")).toBe(
        "绿茶"
      );
    });
    await user.click(screen.getByLabelText("记忆状态"));
    await user.click(screen.getByRole("option", { name: "候选" }));
    await waitFor(() => {
      const matches = requests.filter((url) =>
        url.pathname.endsWith("/entries")
      );
      const latest = matches[matches.length - 1];
      expect(latest?.searchParams.get("status")).toBe("candidate");
      expect(latest?.searchParams.get("page")).toBe("1");
    });
    expect(await screen.findByText("没有待核验的暂存内容")).toBeInTheDocument();
  });

  it("凭据只提交到专用接口并立即清空，不写浏览器存储", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(ok({ configured: true }));
    vi.stubGlobal("fetch", fetchMock);
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const onCredentialSaved = vi.fn();
    const user = userEvent.setup();
    render(
      <MemorySettingsForm
        settings={settings}
        ready
        onSaved={vi.fn()}
        onCredentialSaved={onCredentialSaved}
      />
    );
    const input = screen.getByLabelText("替换访问 Token");
    expect(input).toHaveAttribute("type", "password");
    await user.type(input, "example-test-token");
    await user.click(screen.getByRole("button", { name: "保存凭据" }));
    expect(input).toHaveValue("");
    await waitFor(() => expect(onCredentialSaved).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/credential",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "example-test-token" }),
        cache: "no-store",
      })
    );
    expect(storage).not.toHaveBeenCalled();
    expect(screen.getByLabelText("小智智能体 ID（必填）")).toHaveAttribute(
      "readonly"
    );
    expect(screen.getByLabelText("记忆归属标识（选填）")).toHaveAttribute(
      "readonly"
    );
  });

  it("关闭自动同步保存为零，保存响应明确要求重启", async () => {
    const saved = { ...settings, restartRequired: true };
    const save = vi.spyOn(memoryApi, "saveSettings").mockResolvedValue(saved);
    const onSaved = vi.fn();
    const user = userEvent.setup();
    const props = {
      settings,
      ready: true,
      onSaved,
      onCredentialSaved: vi.fn(),
    };
    const { rerender } = render(<MemorySettingsForm {...props} />);
    await user.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        agentId: settings.agentId,
        ownerId: settings.ownerId,
        syncIntervalSeconds: 0,
        syncMaxRequests: 100,
      })
    );
    expect(onSaved).toHaveBeenCalledWith(saved);
    rerender(<MemorySettingsForm {...props} settings={saved} />);
    expect(screen.getByText("设置已保存，等待重启")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重启服务" })
    ).toBeInTheDocument();
  });

  it("容器部署显示 NAS 和 Compose 重启指引，不提供本机重启按钮", () => {
    render(
      <MemorySettingsForm
        settings={{ ...settings, restartRequired: true, containerMode: true }}
        ready
        onSaved={vi.fn()}
        onCredentialSaved={vi.fn()}
      />
    );
    expect(
      screen.getByText(/请在 NAS 容器管理界面重启此容器/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "docker compose -f docker/docker-compose.yml restart xiaozhi-client"
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重启服务" })
    ).not.toBeInTheDocument();
  });

  it("拒绝小于一分钟的自动同步与越界请求上限", async () => {
    const save = vi.spyOn(memoryApi, "saveSettings");
    const user = userEvent.setup();
    render(
      <MemorySettingsForm
        settings={settings}
        ready
        onSaved={vi.fn()}
        onCredentialSaved={vi.fn()}
      />
    );
    await user.click(screen.getByLabelText("自动同步对话历史"));
    fireEvent.change(screen.getByLabelText("同步间隔（秒）"), {
      target: { value: "30" },
    });
    const form = screen
      .getByRole("button", { name: "保存设置" })
      .closest("form");
    if (!form) throw new Error("找不到设置表单");
    fireEvent.submit(form);
    expect(
      screen.getByText("自动同步间隔应为 60 到 2147483 秒之间的整数。")
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("同步间隔（秒）"), {
      target: { value: "60" },
    });
    fireEvent.change(screen.getByLabelText("每轮请求上限"), {
      target: { value: "1001" },
    });
    fireEvent.submit(form);
    expect(
      screen.getByText("每轮请求上限应为 1 到 1000 之间的整数。")
    ).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it("展示精确原话与来源变更提示，停用必须带理由和当前版本", async () => {
    vi.spyOn(memoryApi, "detail").mockResolvedValue(detail);
    const retire = vi.spyOn(memoryApi, "retire").mockResolvedValue({
      operationId: "operation-retire",
      memory: { ...memory, revision: 4, status: "retracted" },
    });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryDetailSheet
        selection={{ id: memory.id }}
        onClose={vi.fn()}
        onChanged={onChanged}
      />
    );
    expect(await screen.findByText("我喜欢喝无糖绿茶。")).toBeInTheDocument();
    expect(screen.getByText("原文已有新版本 2")).toBeInTheDocument();
    expect(screen.getByText("消息 ID：message-example")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看本版完整原文" }));
    expect(
      screen.getByText("我喜欢喝无糖绿茶。晚上一般不喝。")
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "停用这条记忆" }));
    const confirmation = screen.getByRole("alertdialog");
    expect(
      within(confirmation).getByRole("button", { name: "确认停用" })
    ).toBeDisabled();
    await user.type(
      within(confirmation).getByLabelText("停用原因（必填）"),
      "最近已经改变偏好"
    );
    await user.click(
      within(confirmation).getByRole("button", { name: "确认停用" })
    );
    await waitFor(() =>
      expect(retire).toHaveBeenCalledWith(memory.id, 3, "最近已经改变偏好")
    );
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("当前和历史版本只展示各自引用的原话，不混用历史证据", async () => {
    const historicalSource = {
      messageId: "message-historical",
      revision: 1,
      quote: "以前我喜欢喝加糖咖啡。",
    };
    const historicalMemory = {
      ...memory,
      revision: 1,
      value: "以前喜欢加糖咖啡",
      sources: [historicalSource],
    };
    vi.spyOn(memoryApi, "detail").mockResolvedValue({
      ...detail,
      versions: [historicalMemory, memory],
      sources: [
        ...detail.sources,
        { ...historicalSource, currentRevision: 1, message: null },
      ],
    });
    const user = userEvent.setup();
    render(
      <MemoryDetailSheet
        selection={{ id: memory.id }}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />
    );
    expect(await screen.findByText("我喜欢喝无糖绿茶。")).toBeInTheDocument();
    expect(screen.queryByText(historicalSource.quote)).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("查看版本"));
    await user.click(screen.getByRole("option", { name: /版本 1 · 历史版本/ }));
    expect(screen.getByText(historicalSource.quote)).toBeInTheDocument();
    expect(screen.queryByText("我喜欢喝无糖绿茶。")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "停用这条记忆" })
    ).not.toBeInTheDocument();
  });

  it("只为可撤销的操作提供确认入口，并在成功后刷新", async () => {
    const record = {
      id: "operation-allowed",
      kind: "retire",
      createdAt: "2026-11-13T08:00:00Z",
      canUndo: true,
      memoryIds: [memory.id],
      reason: "偏好改变",
    };
    const operations = vi
      .spyOn(memoryApi, "operations")
      .mockResolvedValue([
        record,
        { ...record, id: "operation-blocked", canUndo: false },
      ]);
    const undo = vi
      .spyOn(memoryApi, "undo")
      .mockResolvedValue({ operationId: "operation-undo" });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryOperations revision={0} onChanged={onChanged} onSelect={vi.fn()} />
    );
    await screen.findByText("操作 ID：operation-allowed");
    expect(screen.getAllByRole("button", { name: "撤销此操作" })).toHaveLength(
      1
    );
    await user.click(screen.getByRole("button", { name: "撤销此操作" }));
    expect(undo).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认撤销" }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith("operation-allowed"));
    expect(onChanged).toHaveBeenCalledOnce();
    await waitFor(() => expect(operations).toHaveBeenCalledTimes(2));
  });
});
