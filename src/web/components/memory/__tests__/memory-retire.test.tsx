import "@testing-library/jest-dom/vitest";
import { MemoryCategory } from "@/components/memory/memory-categories";
import { MemoryRetire } from "@/components/memory/memory-retire";
import { memoryApi } from "@/services/memoryApi";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { MemoryRecord } from "../../../../types/memory-admin";

const memory: MemoryRecord = {
  id: "synthetic-retire",
  revision: 2,
  scope: "synthetic",
  subject: { kind: "speaker" },
  facet: "interests",
  value: "园艺",
  assertion: "explicit",
  conditions: "",
  status: "active",
  observedAt: null,
  validFrom: null,
  validUntil: null,
  sources: [],
  reason: "测试",
  supersedes: null,
  createdAt: "2026-11-13T00:00:00Z",
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("条目停用在删除左边，取消不调用API且无嵌套按钮", async () => {
  const user = userEvent.setup();
  const retire = vi.spyOn(memoryApi, "retire");
  vi.spyOn(memoryApi, "entries").mockResolvedValue({
    items: [memory],
    page: 1,
    pageSize: 6,
    total: 1,
  });
  render(
    <MemoryCategory
      category="user_profile"
      title="用户画像"
      revision={0}
      onSelect={vi.fn()}
    />
  );
  const stop = await screen.findByRole("button", {
    name: "停用记忆：interests：园艺",
  });
  const remove = screen.getByRole("button", {
    name: "删除记忆：interests：园艺",
  });
  expect(
    stop.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(stop.parentElement?.closest("button")).toBeNull();
  await user.click(stop);
  expect(screen.getByRole("button", { name: "确认停用" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(retire).not.toHaveBeenCalled();
});

it("提交当前版本与理由，失败保留弹窗，重试成功刷新分类和页面", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  const entries = vi
    .spyOn(memoryApi, "entries")
    .mockResolvedValueOnce({
      items: [{ ...memory, status: "candidate" }],
      page: 1,
      pageSize: 6,
      total: 1,
    })
    .mockResolvedValue({ items: [], page: 1, pageSize: 6, total: 0 });
  const retire = vi
    .spyOn(memoryApi, "retire")
    .mockRejectedValueOnce(new Error("暂时无法保存"))
    .mockResolvedValue({
      operationId: "op",
      memory: { ...memory, status: "retracted" },
    });
  render(
    <MemoryCategory
      category="user_profile"
      title="用户画像"
      revision={0}
      onSelect={vi.fn()}
      onChanged={changed}
    />
  );
  await user.click(
    await screen.findByRole("button", { name: "停用记忆：interests：园艺" })
  );
  await user.type(screen.getByLabelText("停用原因（必填）"), "  偏好已改变  ");
  await user.click(screen.getByRole("button", { name: "确认停用" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法保存");
  expect(screen.getByRole("alertdialog")).toBeVisible();
  expect(changed).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "确认停用" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(retire).toHaveBeenLastCalledWith(memory.id, 2, "偏好已改变");
  expect(entries).toHaveBeenCalledTimes(2);
  expect(
    await screen.findByText("暂无用户画像。从对话中提炼后会显示在这里。")
  ).toBeVisible();
});

it.each(["retracted", "historical", "invalidated", "superseded"] as const)(
  "%s状态不显示停用入口",
  (status) => {
    render(<MemoryRetire memory={{ ...memory, status }} onRetired={vi.fn()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  }
);
