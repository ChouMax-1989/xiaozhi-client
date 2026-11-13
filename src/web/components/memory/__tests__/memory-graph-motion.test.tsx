import "@testing-library/jest-dom/vitest";
import { MemoryGraphExplorer } from "@/components/memory/memory-graph";
import { MemoryGraphCanvas } from "@/components/memory/memory-graph-canvas";
import { buildMemoryGraph } from "@/components/memory/memory-graph-model";
import { memoryApi } from "@/services/memoryApi";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MemoryRecord } from "../../../../types/memory-admin";

const records: MemoryRecord[] = ["甲", "乙"].map((id) => ({
  id,
  revision: 1,
  scope: "motion-test",
  subject: { kind: "speaker" },
  facet: "偏好",
  value: id,
  assertion: "explicit",
  conditions: "",
  status: "active",
  observedAt: null,
  validFrom: null,
  validUntil: null,
  sources: [],
  reason: "合成动效测试",
  supersedes: null,
  createdAt: "2026-11-14T00:00:00Z",
}));
const graph = buildMemoryGraph(records, "all");
const pending = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let timestamp = 0;
let hidden = false;
let reduced = false;
let intersect: IntersectionObserverCallback;
const disconnect = vi.fn();
const context = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  scale: vi.fn(),
  translate: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  quadraticCurveTo: vi.fn(),
  stroke: vi.fn(),
  globalAlpha: 1,
  lineWidth: 1,
  strokeStyle: "",
};

beforeEach(() => {
  pending.clear();
  nextFrame = 0;
  timestamp = 0;
  hidden = false;
  reduced = false;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    pending.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => pending.delete(id));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe() {}
      disconnect = disconnect;
    }
  );
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: reduced,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function frames(count = 12) {
  act(() => {
    for (let index = 0; index < count; index++) {
      timestamp += 40;
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(timestamp);
    }
  });
}

function node(id = "甲") {
  return screen.getByRole("button", { name: `查看记忆：偏好：${id}` });
}
function position(id = "甲") {
  return node(id).getAttribute("transform");
}

it("光点和连线使用相同运动位置，逐帧绘制不触发React重渲染，暂停后完全稳定", () => {
  const rendered = vi.fn();
  render(
    <Profiler id="graph" onRender={rendered}>
      <MemoryGraphCanvas graph={graph} onSelect={vi.fn()} />
    </Profiler>
  );
  const initial = position();
  const initialHalo = node()
    .querySelector("[data-graph-halo]")!
    .getAttribute("opacity");
  const renderCount = rendered.mock.calls.length;
  frames();
  expect(position()).not.toBe(initial);
  expect(node().querySelector("[data-graph-halo]")).not.toHaveAttribute(
    "opacity",
    initialHalo
  );
  expect(rendered).toHaveBeenCalledTimes(renderCount);
  const source = node(graph.edges[0].source.memory.id).getAttribute(
    "transform"
  )!;
  const coordinates = source.match(/translate\(([^ ]+) ([^)]+)\)/)!;
  const lineStart = context.moveTo.mock.lastCall!;
  expect(lineStart[0]).toBeCloseTo(Number(coordinates[1]), 3);
  expect(lineStart[1]).toBeCloseTo(Number(coordinates[2]), 3);
  fireEvent.click(screen.getByRole("button", { name: "暂停图谱动画" }));
  const paused = position();
  expect(pending.size).toBe(0);
  frames(30);
  expect(position()).toBe(paused);
  fireEvent.click(screen.getByRole("button", { name: "播放图谱动画" }));
  frames();
  expect(position()).not.toBe(paused);
});

it("悬停节点保持稳定，其他节点继续运动，仍可打开详情", () => {
  const select = vi.fn();
  render(<MemoryGraphCanvas graph={graph} onSelect={select} />);
  frames();
  fireEvent.mouseEnter(node());
  const held = position();
  const other = position("乙");
  frames(20);
  expect(position()).toBe(held);
  expect(position("乙")).not.toBe(other);
  fireEvent.keyDown(node(), { key: "Enter" });
  expect(select).toHaveBeenCalledWith({ id: "甲" });
});

it("系统减少动态时默认暂停，用户可明确播放，卸载取消剩余帧", () => {
  reduced = true;
  const view = render(<MemoryGraphCanvas graph={graph} onSelect={vi.fn()} />);
  expect(
    screen.getByRole("button", { name: "播放图谱动画" })
  ).toBeInTheDocument();
  expect(pending.size).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "播放图谱动画" }));
  expect(pending.size).toBe(1);
  frames();
  view.unmount();
  expect(pending.size).toBe(0);
  expect(disconnect).toHaveBeenCalled();
});

it("后台和离屏都停止申请帧，重新可见恢复，卸载释放观察器", () => {
  const view = render(<MemoryGraphCanvas graph={graph} onSelect={vi.fn()} />);
  expect(pending.size).toBe(1);
  act(() => {
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(pending.size).toBe(0);
  act(() => {
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(pending.size).toBe(1);
  act(() =>
    intersect(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver
    )
  );
  expect(pending.size).toBe(0);
  act(() =>
    intersect(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    )
  );
  expect(pending.size).toBe(1);
  view.unmount();
  expect(pending.size).toBe(0);
  expect(disconnect).toHaveBeenCalled();
});

it("扩大和收起视图保留用户暂停选择，并且只有一个画布", async () => {
  vi.spyOn(memoryApi, "entries").mockResolvedValue({
    items: records,
    total: 2,
    page: 1,
    pageSize: 50,
  });
  render(<MemoryGraphExplorer revision={0} onSelect={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "暂停图谱动画" }));
  fireEvent.click(screen.getByRole("button", { name: "扩大图谱视图" }));
  expect(
    screen.getByRole("button", { name: "播放图谱动画" })
  ).toBeInTheDocument();
  expect(screen.getAllByRole("group", { name: "记忆关系图" })).toHaveLength(1);
  expect(pending.size).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "收起扩大视图" }));
  expect(
    screen.getByRole("button", { name: "播放图谱动画" })
  ).toBeInTheDocument();
  expect(screen.getAllByRole("group", { name: "记忆关系图" })).toHaveLength(1);
  expect(pending.size).toBe(0);
});

it("拖动画布后弹性位移收敛，最终保留平移且不打开详情", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const select = vi.fn();
  render(<MemoryGraphCanvas graph={graph} onSelect={select} />);
  const svg = screen.getByRole("group", { name: "记忆关系图" });
  Object.defineProperty(svg, "setPointerCapture", { value: vi.fn() });
  Object.defineProperty(svg, "releasePointerCapture", { value: vi.fn() });
  fireEvent.pointerDown(svg, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(svg, { clientX: 120, clientY: 110 });
  fireEvent.pointerUp(svg, { clientX: 120, clientY: 110 });
  const scene = svg.querySelector("g")!;
  const released = scene.getAttribute("transform");
  frames(30);
  const settled = scene.getAttribute("transform")!;
  expect(settled).not.toBe(released);
  const translation = settled.match(/translate\(([^ ]+) ([^)]+)\)/)!;
  expect(Number(translation[1])).toBeCloseTo(420, 1);
  expect(Number(translation[2])).toBeCloseTo(320, 1);
  expect(select).not.toHaveBeenCalled();
});
