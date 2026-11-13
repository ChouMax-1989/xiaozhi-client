import { MemoryEntries } from "@/components/memory/memory-entries";
import "@testing-library/jest-dom/vitest";
import { MemoryCategory } from "@/components/memory/memory-categories";
import { MemoryDelete } from "@/components/memory/memory-delete";
import { MemoryDetailSheet } from "@/components/memory/memory-detail";
import { memoryApi } from "@/services/memoryApi";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { MemoryRecord } from "../../../../types/memory-admin";

const memory: MemoryRecord = {
  id: "test/id",
  revision: 3,
  scope: "synthetic",
  subject: { kind: "speaker" },
  facet: "interests",
  value: "合成园艺偏好",
  assertion: "explicit",
  conditions: "",
  status: "retracted",
  observedAt: null,
  validFrom: null,
  validUntil: null,
  sources: [],
  reason: "测试",
  supersedes: null,
  createdAt: "2026-11-13T00:00:00Z",
};
function ok() {
  return new Response(
    JSON.stringify({ success: true, data: { deleted: true, id: memory.id } }),
    { status: 200 }
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("取消删除不发送请求", async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<MemoryDelete memory={memory} onDeleted={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "删除记忆" }));
  expect(
    screen.getByText(
      "删除该记忆和历史版本，不能撤销；原始对话保留。引用它的摘要也会删除。"
    )
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

it("确认使用DELETE及精确当前版本，失败保留弹窗并可重试", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: "版本已更新" }), {
        status: 409,
      })
    )
    .mockImplementationOnce(async () => ok());
  vi.stubGlobal("fetch", fetcher);
  render(<MemoryDelete memory={memory} onDeleted={changed} />);
  await user.click(screen.getByRole("button", { name: "删除记忆" }));
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("版本已更新");
  expect(screen.getByRole("alertdialog")).toBeVisible();
  expect(changed).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledWith(
    "/api/memory/entries/test%2Fid",
    expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ revision: 3 }),
    })
  );
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

it("停用记忆及历史版本视图仍可删除整条记录，成功关闭详情并刷新", async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  const changed = vi.fn();
  vi.spyOn(memoryApi, "detail").mockResolvedValue({
    memory,
    versions: [memory, { ...memory, revision: 1, status: "active" }],
    sources: [],
  });
  const remove = vi
    .spyOn(memoryApi, "delete")
    .mockResolvedValue({ deleted: true, id: memory.id });
  render(
    <MemoryDetailSheet
      selection={{ id: memory.id, revision: 1 }}
      onClose={close}
      onChanged={changed}
    />
  );
  await user.click(await screen.findByRole("button", { name: "删除记忆" }));
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith(memory.id, 3));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

it("条目垃圾桶没有嵌套按钮，删除成功刷新分类并通知页面刷新", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  const entries = vi
    .spyOn(memoryApi, "entries")
    .mockResolvedValueOnce({
      items: [{ ...memory, status: "active" }],
      page: 1,
      pageSize: 6,
      total: 1,
    })
    .mockResolvedValue({ items: [], page: 1, pageSize: 6, total: 0 });
  vi.spyOn(memoryApi, "delete").mockResolvedValue({
    deleted: true,
    id: memory.id,
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
  const trigger = await screen.findByRole("button", {
    name: "删除记忆：interests：合成园艺偏好",
  });
  expect(trigger.parentElement?.closest("button")).toBeNull();
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  expect(
    await screen.findByText("暂无用户画像。从对话中提炼后会显示在这里。")
  ).toBeVisible();
  expect(entries).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledTimes(1);
});

it("全部状态列表显示各状态删除，仅生效候选可停用，删除后刷新", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  const entries = vi
    .spyOn(memoryApi, "entries")
    .mockResolvedValueOnce({
      items: [
        memory,
        {
          ...memory,
          id: "candidate-id",
          value: "候选偏好",
          status: "candidate",
        },
      ],
      page: 1,
      pageSize: 12,
      total: 2,
    })
    .mockResolvedValue({
      items: [
        {
          ...memory,
          id: "candidate-id",
          value: "候选偏好",
          status: "candidate",
        },
      ],
      page: 1,
      pageSize: 12,
      total: 1,
    });
  const remove = vi
    .spyOn(memoryApi, "delete")
    .mockResolvedValue({ deleted: true, id: memory.id });
  render(<MemoryEntries revision={0} onSelect={vi.fn()} onChanged={changed} />);
  await screen.findByText("候选偏好");
  expect(entries).toHaveBeenCalledWith(
    expect.objectContaining({ status: "all" }),
    expect.any(AbortSignal)
  );
  expect(
    screen.queryByRole("button", { name: "停用记忆：interests：合成园艺偏好" })
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "停用记忆：interests：候选偏好" })
  ).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "删除记忆：interests：合成园艺偏好" })
  );
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(remove).toHaveBeenCalledWith(memory.id, memory.revision);
  expect(entries).toHaveBeenCalledTimes(2);
});

it("删除末页唯一条目后仍可返回上一页", async () => {
  const user = userEvent.setup();
  let deleted = false;
  vi.spyOn(memoryApi, "entries").mockImplementation(async (input) => ({
    items: deleted && input.page === 2 ? [] : [memory],
    page: input.page,
    pageSize: 12,
    total: deleted ? 12 : 13,
  }));
  vi.spyOn(memoryApi, "delete").mockImplementation(async () => {
    deleted = true;
    return { deleted: true, id: memory.id };
  });
  render(<MemoryEntries revision={0} onSelect={vi.fn()} />);
  await screen.findByText("合成园艺偏好");
  await user.click(screen.getByRole("button", { name: "下一页" }));
  await user.click(
    await screen.findByRole("button", {
      name: "删除记忆：interests：合成园艺偏好",
    })
  );
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  expect(await screen.findByText("本页已无记忆")).toBeVisible();
  expect(screen.getByRole("button", { name: "上一页" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "上一页" }));
  expect(await screen.findByText("合成园艺偏好")).toBeVisible();
});
