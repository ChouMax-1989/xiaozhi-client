import "@testing-library/jest-dom/vitest";
import { MemoryChats } from "@/components/memory/memory-chats";
import { MemoryRecordingRules } from "@/components/memory/memory-recording-rules";
import { memoryApi } from "@/services/memoryApi";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemorySourceView } from "../../../../types/memory-admin";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("角色记录规则", () => {
  const prompt =
    "保留角色人设。每轮调用 memory_memory_record_turn，记录本轮内容。";

  it("原样复制服务器给出的规则并提示追加角色介绍", async () => {
    const user = userEvent.setup();
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();
    const success = vi.spyOn(toast, "success");
    render(<MemoryRecordingRules prompt={prompt} />);
    await user.click(screen.getByRole("button", { name: "复制角色记录规则" }));
    expect(write).toHaveBeenCalledWith(prompt);
    expect(success).toHaveBeenCalledWith(
      "角色记录规则已复制，请追加到小智角色介绍，保留原有人设。"
    );
    expect(screen.queryByLabelText("角色记录规则全文")).not.toBeInTheDocument();
  });

  it("剪贴板失败时展示可选全文，重试成功后收起", async () => {
    const user = userEvent.setup();
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("拒绝访问剪贴板"))
      .mockResolvedValue();
    render(<MemoryRecordingRules prompt={prompt} />);
    await user.click(screen.getByRole("button", { name: "复制角色记录规则" }));
    const fullText = screen.getByLabelText("角色记录规则全文");
    expect(fullText).toHaveValue(prompt);
    expect(fullText).toHaveAttribute("readonly");
    await user.click(fullText);
    expect((fullText as HTMLTextAreaElement).selectionEnd).toBe(prompt.length);
    await user.click(screen.getByRole("button", { name: "复制角色记录规则" }));
    expect(write).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(
        screen.queryByLabelText("角色记录规则全文")
      ).not.toBeInTheDocument()
    );
  });

  it("旧接口未返回规则时禁用复制且提供刷新说明", () => {
    render(<MemoryRecordingRules />);
    expect(
      screen.getByRole("button", { name: "复制角色记录规则" })
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("暂未提供记录规则");
  });
});

it("会话原文区分历史档案、模型提交和助手自报阶段", async () => {
  const base: MemorySourceView = {
    id: "legacy",
    sourceId: "source-legacy",
    chatId: "chat-test",
    role: "user",
    content: "旧档案正文",
    createdAt: null,
    revision: 1,
    processedRevision: 0,
  };
  const items: MemorySourceView[] = [
    base,
    {
      ...base,
      id: "user-model",
      content: "本轮用户正文",
      origin: "model_reported",
    },
    {
      ...base,
      id: "draft",
      content: "准备回答的正文",
      role: "assistant",
      origin: "model_reported",
      assistantStage: "draft",
      recordedAt: "2026-11-13T10:00:00Z",
    },
    {
      ...base,
      id: "final",
      content: "模型标为最终的正文",
      role: "assistant",
      origin: "model_reported",
      assistantStage: "final",
    },
    {
      ...base,
      id: "unknown",
      content: "未标阶段的正文",
      role: "assistant",
      origin: "model_reported",
    },
  ];
  vi.spyOn(memoryApi, "chats").mockResolvedValue({
    items: [
      {
        id: "chat-test",
        title: "合成会话",
        messageCount: 5,
        pendingCount: 5,
        lastMessageAt: null,
        preview: "合成原文",
      },
    ],
    page: 1,
    pageSize: 12,
    total: 1,
  });
  vi.spyOn(memoryApi, "messages").mockResolvedValue({
    items,
    page: 1,
    pageSize: 12,
    total: 5,
  });
  const user = userEvent.setup();
  render(<MemoryChats revision={0} />);
  await user.click(
    await screen.findByRole("button", { name: "查看原文：合成会话" })
  );
  await screen.findByText("旧档案正文");
  for (const detail of screen.getAllByText("详情")) await user.click(detail);
  expect(await screen.findByText("历史档案")).toBeInTheDocument();
  expect(screen.getByText("模型提交", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("模型提交 · 拟回复")).toBeInTheDocument();
  expect(screen.getByText(/^记录于 /)).toBeInTheDocument();
  expect(screen.getByText("模型提交 · 最终回复")).toHaveAttribute(
    "title",
    "回复阶段由模型提交，不代表实际播放状态。"
  );
  expect(screen.getByText("模型提交 · 阶段未注明")).toBeInTheDocument();
});
