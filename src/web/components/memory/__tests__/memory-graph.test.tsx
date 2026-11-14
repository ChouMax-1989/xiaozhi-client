import "@testing-library/jest-dom/vitest";
import { MemoryGraphExplorer } from "@/components/memory/memory-graph";
import { MemoryGraphCanvas } from "@/components/memory/memory-graph-canvas";
import {
  buildMemoryGraph,
  loadGraphMemories,
} from "@/components/memory/memory-graph-model";
import { memoryApi } from "@/services/memoryApi";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "../../../../types/memory-admin";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  // 真实画布绘制由浏览器验收；组件测试只验证交互及数据边界。
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

function record(
  id: string,
  overrides: Partial<MemoryRecord> = {}
): MemoryRecord {
  return {
    id,
    revision: 1,
    scope: "synthetic",
    subject: { kind: "speaker" },
    facet: "喜好",
    value: `记忆 ${id}`,
    assertion: "explicit",
    conditions: "",
    status: "active",
    observedAt: null,
    validFrom: null,
    validUntil: null,
    sources: [],
    reason: "合成图谱测试",
    supersedes: null,
    createdAt: "2026-11-14T00:00:00Z",
    ...overrides,
  };
}

describe("图谱真实关联", () => {
  it("主体按档案、类型和名称隔离，未知人物不合并", () => {
    const memories = [
      record("a", { subject: { kind: "related_person", label: "小明" } }),
      record("b", { subject: { kind: "related_person", label: "小明" } }),
      record("c", {
        scope: "另一档案",
        subject: { kind: "related_person", label: "小明" },
      }),
      record("d", { subject: { kind: "entity", label: "小明" } }),
      record("e", { subject: { kind: "related_person" } }),
      record("f", { subject: { kind: "related_person" } }),
    ];
    const graph = buildMemoryGraph(memories, "subject");
    expect(
      graph.edges.map((edge) => [edge.source.memory.id, edge.target.memory.id])
    ).toEqual([["a", "b"]]);
    expect(graph.edges[0].evidence[0].kind).toBe("subject");
    expect(graph.isolated).toBe(4);
    expect(graph.nodes.filter((node) => node.memory)).toHaveLength(6);
  });

  it("只合并相同来源消息及版本，重复引文不增加连线", () => {
    const source = { messageId: "message-1", revision: 1, quote: "相同证据" };
    const graph = buildMemoryGraph(
      [
        record("a", { sources: [source, source] }),
        record("b", { sources: [source] }),
        record("c", { sources: [{ ...source, revision: 2 }] }),
        record("d", { scope: "另一档案", sources: [source] }),
      ],
      "source"
    );
    expect(graph.edges).toHaveLength(1);
    expect([
      graph.edges[0].source.memory.id,
      graph.edges[0].target.memory.id,
    ]).toEqual(["a", "b"]);
    expect(graph.edges[0].evidence).toHaveLength(1);
    expect(graph.isolated).toBe(2);
  });

  it("分类只按真实字段连线，布局稳定且保留孤立点", () => {
    const memories = [
      record("a"),
      record("b"),
      record("c", { facet: "另一分类" }),
    ];
    const snapshot = structuredClone(memories);
    const graph = buildMemoryGraph(memories, "facet");
    expect(graph.isolated).toBe(1);
    expect(buildMemoryGraph([...memories].reverse(), "facet")).toEqual(graph);
    expect(memories).toEqual(snapshot);
    expect(
      graph.nodes.every(
        (node) => Number.isFinite(node.x) && Number.isFinite(node.y)
      )
    ).toBe(true);
    expect(buildMemoryGraph([], "source")).toEqual({
      nodes: [],
      edges: [],
      isolated: 0,
    });
  });

  it("综合视角合并共同字段证据，只保留真实记忆节点", () => {
    const source = { messageId: "source-a", revision: 1, quote: "证据" };
    const graph = buildMemoryGraph(
      [
        record("a", { sources: [source] }),
        record("b", { sources: [source] }),
        record("c", { facet: "无共同字段", subject: { kind: "entity" } }),
      ],
      "all"
    );
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].evidence.map((item) => item.kind)).toEqual([
      "facet",
      "subject",
      "source",
    ]);
    expect(graph.isolated).toBe(1);
    expect(graph.nodes.every((node) => node.memory.id)).toBe(true);
  });

  it("200条完整共同分类网络布局有界、不丢记录且不改输入", () => {
    const memories = Array.from({ length: 200 }, (_, index) =>
      record(`dense-${index}`)
    );
    const snapshot = structuredClone(memories);
    const graph = buildMemoryGraph(memories, "all");
    expect(graph.nodes).toHaveLength(200);
    expect(graph.edges).toHaveLength(19900);
    expect(
      graph.nodes.every(
        (node) =>
          Number.isFinite(node.x) &&
          Number.isFinite(node.y) &&
          Math.hypot(node.x, node.y) <= 300
      )
    ).toBe(true);
    expect(
      new Set(
        graph.nodes.map((node) => `${node.x.toFixed(2)},${node.y.toFixed(2)}`)
      ).size
    ).toBe(200);
    expect(graph.edges.every((edge) => edge.evidence.length === 2)).toBe(true);
    expect(memories).toEqual(snapshot);
  });
});

describe("图谱有限分页", () => {
  it("同一对记忆的多条来源合并为一条边并完整保留依据", () => {
    const sources = [
      { messageId: "source-a", revision: 1, quote: "证据甲" },
      { messageId: "source-b", revision: 1, quote: "证据乙" },
    ];
    const graph = buildMemoryGraph(
      [record("a", { sources }), record("b", { sources })],
      "source"
    );
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].evidence).toHaveLength(2);
  });

  it("最多读取四页共200条，并将取消信号传给每页", async () => {
    const entries = vi
      .spyOn(memoryApi, "entries")
      .mockImplementation(async (input) => ({
        items: Array.from({ length: 50 }, (_, index) =>
          record(String((input.page - 1) * 50 + index))
        ),
        total: 600,
        page: input.page,
        pageSize: 50,
      }));
    const controller = new AbortController();
    const result = await loadGraphMemories(controller.signal);
    expect(result.items).toHaveLength(200);
    expect(result.total).toBe(600);
    expect(entries).toHaveBeenCalledTimes(4);
    for (const [input, signal] of entries.mock.calls) {
      expect(input).toMatchObject({ status: "current", pageSize: 50 });
      expect(signal).toBe(controller.signal);
    }
  });

  it("取消后不请求后续分页", async () => {
    const controller = new AbortController();
    const entries = vi
      .spyOn(memoryApi, "entries")
      .mockImplementation(async () => {
        controller.abort();
        return { items: [record("a")], total: 200, page: 1, pageSize: 50 };
      });
    await expect(loadGraphMemories(controller.signal)).rejects.toThrow();
    expect(entries).toHaveBeenCalledTimes(1);
  });
});

describe("图谱交互", () => {
  it("稀疏和密集数据都适配舞台，初始光点保持屏幕像素大小", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 1300, 500)
    );
    const onSelect = vi.fn();
    const view = render(
      <MemoryGraphCanvas
        graph={buildMemoryGraph([record("single")], "all")}
        onSelect={onSelect}
      />
    );
    for (const count of [31, 200]) {
      const graph = buildMemoryGraph(
        Array.from({ length: count }, (_, index) => record(`fit-${index}`)),
        "all"
      );
      view.rerender(<MemoryGraphCanvas graph={graph} onSelect={onSelect} />);
      const svg = screen.getByRole("group", { name: "记忆关系图" });
      await waitFor(() =>
        expect(svg).toHaveAttribute("viewBox", "0 0 1300 500")
      );
      const transform = svg.querySelector("g")!.getAttribute("transform")!;
      const scale = Number(transform.match(/scale\(([^)]+)\)/)![1]);
      const height =
        Math.max(...graph.nodes.map((node) => node.y)) -
        Math.min(...graph.nodes.map((node) => node.y));
      expect(height * scale).toBeCloseTo(400, 4);
      const radius = Number(
        svg
          .querySelector("g[role='button'] circle:nth-of-type(3)")!
          .getAttribute("r")
      );
      expect(radius * scale).toBeGreaterThanOrEqual(3);
      expect(radius * scale).toBeLessThanOrEqual(3.61);
      expect(transform).not.toMatch(/NaN|Infinity/);
    }
  });

  it("打开图谱即读取记忆，离开后取消未完成的请求", async () => {
    const entries = vi
      .spyOn(memoryApi, "entries")
      .mockReturnValue(new Promise(() => {}));
    const view = render(
      <MemoryGraphExplorer revision={0} onSelect={vi.fn()} />
    );
    await waitFor(() => expect(entries).toHaveBeenCalledOnce());
    const signal = entries.mock.calls[0][1];
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText("正在连接记忆图谱…")).not.toBeInTheDocument();
  });

  it("搜索和关系切换使用真实集合，键盘选点打开原有详情并支持缩放复位", async () => {
    const user = userEvent.setup();
    vi.spyOn(memoryApi, "entries").mockResolvedValue({
      items: [
        record("a", { value: "偏好温暖房间" }),
        record("b", { value: "喜欢自然光", status: "candidate" }),
      ],
      total: 2,
      page: 1,
      pageSize: 50,
    });
    const onSelect = vi.fn();
    render(<MemoryGraphExplorer revision={0} onSelect={onSelect} />);
    const node = await screen.findByRole("button", {
      name: "查看记忆：喜好：偏好温暖房间",
    });
    fireEvent.focus(node);
    fireEvent.keyDown(node, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({ id: "a" });
    await user.click(screen.getByRole("button", { name: "放大图谱" }));
    expect(screen.getByLabelText("图谱缩放比例")).toHaveTextContent("125%");
    await user.click(screen.getByRole("button", { name: "重置图谱视图" }));
    expect(screen.getByLabelText("图谱缩放比例")).toHaveTextContent("100%");
    await user.click(screen.getByRole("combobox", { name: "图谱关联方式" }));
    await user.click(screen.getByRole("option", { name: "相同来源消息" }));
    expect(screen.getByText(/2 条记忆 · 0 条共同字段关联/)).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "筛选已载入记忆" }),
      "温暖"
    );
    expect(
      await screen.findByText(/1 条记忆 · 0 条共同字段关联/)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "查看记忆：喜好：喜欢自然光" })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "列表浏览" }));
    expect(
      screen.getByRole("list", { name: "图谱记忆列表" })
    ).toHaveTextContent("偏好温暖房间");
    await user.click(screen.getByRole("button", { name: "清除图谱筛选" }));
    expect(
      await screen.findByText(/2 条记忆 · 0 条共同字段关联/)
    ).toBeInTheDocument();
  });

  it("刷新标记变化后移除停用记忆，并展示空态", async () => {
    const entries = vi
      .spyOn(memoryApi, "entries")
      .mockResolvedValueOnce({
        items: [record("a")],
        total: 1,
        page: 1,
        pageSize: 50,
      })
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
    const onSelect = vi.fn();
    const view = render(
      <MemoryGraphExplorer revision={0} onSelect={onSelect} />
    );
    expect(
      await screen.findByRole("button", { name: "查看记忆：喜好：记忆 a" })
    ).toBeInTheDocument();
    view.rerender(<MemoryGraphExplorer revision={1} onSelect={onSelect} />);
    expect(await screen.findByText("还没有可展示的记忆")).toBeInTheDocument();
    expect(entries).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole("button", { name: "查看记忆：喜好：记忆 a" })
    ).not.toBeInTheDocument();
  });

  it("读取失败可重试，筛选无命中有可恢复空态", async () => {
    const user = userEvent.setup();
    vi.spyOn(memoryApi, "entries")
      .mockRejectedValueOnce(new Error("图谱读取失败"))
      .mockResolvedValue({
        items: [record("a")],
        total: 1,
        page: 1,
        pageSize: 50,
      });
    render(<MemoryGraphExplorer revision={0} onSelect={vi.fn()} />);
    expect(await screen.findByText("图谱读取失败")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await user.type(
      await screen.findByRole("textbox", { name: "筛选已载入记忆" }),
      "不存在"
    );
    expect(await screen.findByText("没有匹配的记忆")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除图谱筛选" }));
    expect(
      await screen.findByRole("button", { name: "查看记忆：喜好：记忆 a" })
    ).toBeInTheDocument();
  });
});
