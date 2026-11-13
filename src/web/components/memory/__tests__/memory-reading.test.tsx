import "@testing-library/jest-dom/vitest";
import { MemoryCategory } from "@/components/memory/memory-categories";
import { MemoryChats } from "@/components/memory/memory-chats";
import { memoryApi } from "@/services/memoryApi";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { MemoryRecord } from "../../../../types/memory-admin";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const memory: MemoryRecord = {
  id: "test-memory",
  revision: 1,
  scope: "synthetic",
  subject: { kind: "related_person", label: "家人" },
  facet: "context_preference",
  value: "偏好温暖房间",
  assertion: "explicit",
  conditions: "晚上",
  status: "candidate",
  observedAt: null,
  validFrom: null,
  validUntil: null,
  sources: [],
  reason: "合成测试",
  supersedes: null,
  createdAt: "2026-11-13T00:00:00Z",
};

it("两类记忆使用独立服务端分页，搜索回到第一页并保留人物、条件、候选", async () => {
  const user = userEvent.setup();
  const entries = vi
    .spyOn(memoryApi, "entries")
    .mockImplementation(async (input) => ({
      items: input.category === "situational" ? [memory] : [],
      page: input.page,
      pageSize: input.pageSize,
      total: input.category === "situational" ? 13 : 0,
    }));
  const select = vi.fn();
  render(
    <>
      <MemoryCategory
        category="user_profile"
        title="用户画像"
        revision={0}
        onSelect={select}
      />
      <MemoryCategory
        category="situational"
        title="情境记忆"
        revision={0}
        onSelect={select}
      />
    </>
  );
  const context = screen.getByRole("region", { name: "情境记忆" });
  expect(await screen.findByText("家人 · 晚上")).toBeInTheDocument();
  expect(screen.getByText("待确认")).toBeInTheDocument();
  expect(
    screen.getByText("暂无用户画像。从对话中提炼后会显示在这里。")
  ).toBeInTheDocument();
  await user.click(within(context).getByRole("button", { name: "下一页" }));
  await waitFor(() =>
    expect(entries).toHaveBeenLastCalledWith(
      expect.objectContaining({
        category: "situational",
        status: "current",
        page: 2,
        pageSize: 6,
      }),
      expect.any(AbortSignal)
    )
  );
  await user.type(
    within(context).getByRole("textbox", { name: "搜索情境记忆" }),
    "温暖"
  );
  await user.click(
    within(context).getByRole("button", { name: "搜索情境记忆" })
  );
  await waitFor(() =>
    expect(entries).toHaveBeenLastCalledWith(
      expect.objectContaining({
        category: "situational",
        status: "current",
        page: 1,
        query: "温暖",
      }),
      expect.any(AbortSignal)
    )
  );
  await user.click(
    await screen.findByRole("button", {
      name: "查看记忆：context_preference：偏好温暖房间",
    })
  );
  expect(select).toHaveBeenCalledWith({ id: "test-memory" });
});

it("会话分页和搜索请求真实 API，工具默认折叠且消息按本页时间顺序阅读", async () => {
  const user = userEvent.setup();
  const chats = vi
    .spyOn(memoryApi, "chats")
    .mockImplementation(async (input) => ({
      items: [
        {
          id: `chat-${input.page}`,
          title: `会话 ${input.page}`,
          messageCount: 2,
          pendingCount: 0,
          lastMessageAt: "2026-11-13T10:00:00Z",
          preview: "",
        },
      ],
      page: input.page,
      pageSize: input.pageSize,
      total: 13,
    }));
  const messages = vi
    .spyOn(memoryApi, "messages")
    .mockImplementation(async (input) => ({
      items: [
        {
          id: "tool",
          sourceId: "s2",
          chatId: input.chatId,
          role: "tool",
          content: "工具返回合成结果",
          createdAt: null,
          revision: 1,
          processedRevision: 0,
        },
        {
          id: "user",
          sourceId: "s1",
          chatId: input.chatId,
          role: "user",
          content: "用户先说的话",
          createdAt: null,
          revision: 1,
          processedRevision: 0,
        },
      ],
      page: input.page,
      pageSize: input.pageSize,
      total: 2,
    }));
  render(<MemoryChats revision={0} />);
  await screen.findByText("用户先说的话");
  const tool = screen.getByText("工具内容").closest("details");
  expect(tool).not.toHaveAttribute("open");
  await user.click(screen.getByText("工具内容"));
  expect(tool).toHaveAttribute("open");
  const articles = screen.getAllByRole("article");
  expect(articles[0]).toHaveAccessibleName("用户消息");
  expect(articles[1]).toHaveAccessibleName("工具消息");
  await user.click(
    within(screen.getByRole("complementary", { name: "会话列表" })).getByRole(
      "button",
      { name: "下一页" }
    )
  );
  await waitFor(() =>
    expect(messages).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatId: "chat-2", page: 1 }),
      expect.any(AbortSignal)
    )
  );
  await user.type(screen.getByRole("textbox", { name: "搜索会话" }), "合成");
  await user.click(screen.getByRole("button", { name: "搜索会话" }));
  await waitFor(() =>
    expect(chats).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "合成", page: 1 }),
      expect.any(AbortSignal)
    )
  );
  await user.click(
    await screen.findByRole("button", { name: "查看原文：会话 1" })
  );
  await user.click(screen.getByRole("button", { name: "返回会话列表" }));
  expect(
    screen.getByRole("complementary", { name: "会话列表" })
  ).not.toHaveClass("hidden");
});
