// cspell:ignore Noninteractive
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Maximize, Minus, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MemorySelection } from "./memory-detail";
import type { GraphNode, MemoryGraphData } from "./memory-graph-model";

const initialCamera = { x: 0, y: 0, scale: 1 };

export function MemoryGraphCanvas({
  graph,
  onSelect,
}: {
  graph: MemoryGraphData;
  onSelect: (selection: MemorySelection) => void;
}) {
  const descriptionId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [camera, setCamera] = useState(initialCamera);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const byId = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph]
  );
  const active = byId.get(hovered ?? selected ?? "");
  const neighbors = useMemo(() => {
    if (!active) return null;
    const ids = new Set([active.id]);
    for (const edge of graph.edges) {
      if (edge.source.id === active.id) ids.add(edge.target.id);
      if (edge.target.id === active.id) ids.add(edge.source.id);
    }
    return ids;
  }, [active, graph]);
  const zoom = useCallback((factor: number) => {
    setCamera((value) => ({
      ...value,
      scale: Math.max(0.5, Math.min(4, value.scale * factor)),
    }));
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    function wheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12);
    }
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  }, [zoom]);

  function choose(node: GraphNode) {
    setSelected(node.id === selected ? null : node.id);
    if (node.memory) onSelect({ id: node.memory.id });
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-muted/20">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <p className="text-xs text-muted-foreground">
          实心点是记忆 · 空心点是共同字段 · 记忆点颜色区分分类
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="缩小图谱"
            disabled={camera.scale <= 0.5}
            onClick={() => zoom(1 / 1.25)}
          >
            <Minus />
          </Button>
          <output
            className="w-12 text-center text-xs tabular-nums"
            aria-label="图谱缩放比例"
          >
            {Math.round(camera.scale * 100)}%
          </output>
          <Button
            variant="ghost"
            size="icon"
            aria-label="放大图谱"
            disabled={camera.scale >= 4}
            onClick={() => zoom(1.25)}
          >
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="重置图谱视图"
            onClick={() => {
              setCamera(initialCamera);
              setSelected(null);
              setHovered(null);
            }}
          >
            <Maximize />
          </Button>
        </div>
      </div>
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox="-260 -260 520 520"
          // biome-ignore lint/a11y/useSemanticElements: SVG 图谱不能由 HTML fieldset 替代。
          role="group"
          aria-label="记忆关系图"
          aria-describedby={descriptionId}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: 图谱支持方向键平移和快捷键缩放，需要键盘入口。
          tabIndex={0}
          className={cn(
            "h-[360px] w-full touch-none select-none sm:h-[480px]",
            dragging ? "cursor-grabbing" : "cursor-grab"
          )}
          onPointerDown={(event) => {
            if (event.button !== 0 || drag.current) return;
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const previous = drag.current;
            if (!previous || previous.id !== event.pointerId) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const unit = 520 / Math.max(1, Math.min(rect.width, rect.height));
            const x = (event.clientX - previous.x) * unit;
            const y = (event.clientY - previous.y) * unit;
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
            };
            setCamera((value) => ({
              ...value,
              x: value.x + x,
              y: value.y + y,
            }));
          }}
          onPointerUp={(event) => {
            if (drag.current?.id !== event.pointerId) return;
            drag.current = null;
            setDragging(false);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragging(false);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            const offsets: Record<string, [number, number]> = {
              ArrowLeft: [30, 0],
              ArrowRight: [-30, 0],
              ArrowUp: [0, 30],
              ArrowDown: [0, -30],
            };
            if (offsets[event.key]) {
              event.preventDefault();
              const [x, y] = offsets[event.key];
              setCamera((value) => ({
                ...value,
                x: value.x + x,
                y: value.y + y,
              }));
            } else if (event.key === "+" || event.key === "=") {
              event.preventDefault();
              zoom(1.25);
            } else if (event.key === "-") {
              event.preventDefault();
              zoom(1 / 1.25);
            } else if (event.key === "0") {
              setCamera(initialCamera);
            }
          }}
        >
          <title>记忆图谱：选择记忆查看详情，选择共同字段突出关联</title>
          <g
            transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}
          >
            <g>
              {graph.edges.map((edge) => {
                const highlighted =
                  active &&
                  (edge.source.id === active.id ||
                    edge.target.id === active.id);
                return (
                  <line
                    key={edge.id}
                    x1={edge.source.x}
                    y1={edge.source.y}
                    x2={edge.target.x}
                    y2={edge.target.y}
                    stroke={`hsl(var(--chart-${edge.target.color}))`}
                    strokeWidth={highlighted ? 1.4 : 0.75}
                    opacity={active ? (highlighted ? 0.8 : 0.08) : 0.3}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            </g>
            {graph.nodes.map((node) => {
              const focused = active?.id === node.id;
              const color = `hsl(var(--chart-${node.color}))`;
              const label = node.memory
                ? `查看记忆：${node.label}`
                : `突出关联：${node.label}`;
              return (
                <g
                  key={node.id}
                  // biome-ignore lint/a11y/useSemanticElements: SVG 内不能放置 HTML button；节点支持聚焦及回车/空格操作。
                  role="button"
                  tabIndex={0}
                  aria-label={label}
                  aria-pressed={selected === node.id}
                  transform={`translate(${node.x} ${node.y})`}
                  className="cursor-pointer"
                  opacity={neighbors && !neighbors.has(node.id) ? 0.22 : 1}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => choose(node)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      choose(node);
                    }
                  }}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(node.id)}
                  onBlur={() => setHovered(null)}
                >
                  <title>{node.label}</title>
                  <circle r={13} fill="transparent" />
                  <circle
                    r={focused ? 12 : 9}
                    fill={color}
                    opacity={focused ? 0.2 : 0.1}
                  />
                  <circle
                    r={node.memory ? 4.5 : 6}
                    fill={node.memory ? color : "hsl(var(--background))"}
                    stroke={color}
                    strokeWidth={node.memory ? 1 : 1.8}
                    strokeDasharray={
                      node.memory?.status === "candidate" ? "2 2" : undefined
                    }
                  />
                  {focused ? (
                    <circle
                      r={11}
                      fill="none"
                      stroke="hsl(var(--foreground))"
                      strokeWidth={1.2}
                    />
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>
        {active ? (
          <div className="pointer-events-none absolute bottom-3 left-3 right-3 rounded-md border bg-popover/95 px-3 py-2 text-sm text-popover-foreground shadow-sm sm:right-auto sm:max-w-sm">
            <p className="line-clamp-3 break-words">{active.label}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {active.memory
                ? active.memory.status === "candidate"
                  ? "候选记忆 · 选择可查看原文与详情"
                  : "生效中 · 选择可查看原文与详情"
                : "共同字段 · 选择可保持突出显示"}
            </p>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
        <p
          id={descriptionId}
          className="text-xs leading-5 text-muted-foreground"
        >
          拖动空白处平移，使用按钮或 Ctrl /
          ⌘＋滚轮缩放。键盘聚焦图谱后可用方向键、＋、－、0；Tab 选点，回车查看。
        </p>
        {selected ? (
          <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
            清除选中
          </Button>
        ) : null}
      </div>
    </div>
  );
}
