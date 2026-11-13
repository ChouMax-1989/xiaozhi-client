// cspell:ignore Noninteractive
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Maximize, Minus, Pause, Play, Plus, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MemorySelection } from "./memory-detail";
import {
  type GraphEdge,
  type GraphNode,
  type MemoryGraphData,
  graphSeed,
} from "./memory-graph-model";
import { useMemoryGraphMotion } from "./memory-graph-motion";

const initialCamera = { x: 0, y: 0, scale: 1 };
const darkColors = ["#79b8c4", "#a99ad3", "#83baa8", "#d59b6b", "#bd8faa"];
const lightColors = ["#397f8d", "#7763a9", "#3e826a", "#a76835", "#945e7f"];

export function MemoryGraphCanvas({
  graph,
  onSelect,
  expanded = false,
  light = false,
  animationPreference,
  onAnimationPreference,
}: {
  graph: MemoryGraphData;
  onSelect: (selection: MemorySelection) => void;
  expanded?: boolean;
  light?: boolean;
  animationPreference?: boolean | null;
  onAnimationPreference?: (enabled: boolean) => void;
}) {
  const descriptionId = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<SVGGElement>(null);
  const nodeElements = useRef(
    new Map<string, { group: SVGGElement; halo: SVGCircleElement | null }>()
  );
  const elastic = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [size, setSize] = useState({ width: 800, height: 620 });
  const [camera, setCamera] = useState(initialCamera);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const byId = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph]
  );
  const poses = useMemo(
    () =>
      new Map(
        graph.nodes.map((node) => [
          node.id,
          {
            x: node.x,
            y: node.y,
            phase: graphSeed(node.id) * Math.PI * 2,
            halo: 0.12,
            haloRadius: 7,
          },
        ])
      ),
    [graph]
  );
  const active = byId.get(hovered ?? selected ?? "");
  const tooltip = byId.get(hovered ?? "");
  const colors = light ? lightColors : darkColors;
  const bounds = useMemo(() => {
    if (!graph.nodes.length) return { x: 0, y: 0, width: 160, height: 160 };
    const left = Math.min(...graph.nodes.map((node) => node.x));
    const right = Math.max(...graph.nodes.map((node) => node.x));
    const top = Math.min(...graph.nodes.map((node) => node.y));
    const bottom = Math.max(...graph.nodes.map((node) => node.y));
    return {
      x: (left + right) / 2,
      y: (top + bottom) / 2,
      width: Math.max(160, right - left),
      height: Math.max(160, bottom - top),
    };
  }, [graph]);
  // 按实际构图适配舞台；窄屏减小留白，光点半径仍以屏幕像素保持细小。
  const padding = Math.min(
    60,
    Math.max(32, Math.min(size.width, size.height) * 0.1)
  );
  const baseScale = Math.max(
    0.01,
    Math.min(
      (size.width - padding * 2) / bounds.width,
      (size.height - padding * 2) / bounds.height
    )
  );
  const scale = baseScale * camera.scale;
  const neighbors = useMemo(() => {
    if (!active) return null;
    const ids = new Set([active.id]);
    for (const edge of graph.edges) {
      if (edge.source.id === active.id) ids.add(edge.target.id);
      if (edge.target.id === active.id) ids.add(edge.source.id);
    }
    return ids;
  }, [active, graph]);
  const zoom = useCallback((factor: number, anchor = { x: 0, y: 0 }) => {
    setCamera((value) => {
      const next = Math.max(0.45, Math.min(5, value.scale * factor));
      const ratio = next / value.scale;
      return {
        scale: next,
        x: anchor.x - (anchor.x - value.x) * ratio,
        y: anchor.y - (anchor.y - value.y) * ratio,
      };
    });
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    function measure() {
      const bounds = host!.getBoundingClientRect();
      if (bounds.width && bounds.height)
        setSize({ width: bounds.width, height: bounds.height });
    }
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    function wheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const bounds = svg!.getBoundingClientRect();
      zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, {
        x: event.clientX - bounds.left - bounds.width / 2,
        y: event.clientY - bounds.top - bounds.height / 2,
      });
    }
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  }, [zoom]);

  const paintGroups = useMemo(() => {
    const background = colors.map(() => [] as GraphEdge[]);
    const foreground = colors.map(() => [] as GraphEdge[]);
    for (const edge of graph.edges) {
      const highlighted =
        active &&
        (edge.source.id === active.id || edge.target.id === active.id);
      (highlighted ? foreground : background)[edge.source.color].push(edge);
    }
    return { background, foreground };
  }, [graph, active, colors]);

  const paint = useCallback(
    (elapsed: number, delta: number, enabled: boolean) => {
      const spring = elastic.current;
      if (enabled && delta > 0 && !drag.current) {
        const step = Math.min(1.6, delta / (1000 / 30));
        spring.vx = (spring.vx - spring.x * 0.22 * step) * 0.62;
        spring.vy = (spring.vy - spring.y * 0.22 * step) * 0.62;
        spring.x += spring.vx * step;
        spring.y += spring.vy * step;
        if (
          Math.abs(spring.x) +
            Math.abs(spring.y) +
            Math.abs(spring.vx) +
            Math.abs(spring.vy) <
          0.04
        ) {
          spring.x = 0;
          spring.y = 0;
          spring.vx = 0;
          spring.vy = 0;
        }
      }
      const translateX = size.width / 2 + camera.x + spring.x;
      const translateY = size.height / 2 + camera.y + spring.y;
      sceneRef.current?.setAttribute(
        "transform",
        `translate(${translateX} ${translateY}) scale(${scale}) translate(${-bounds.x} ${-bounds.y})`
      );
      const amplitude = (graph.nodes.length > 120 ? 6.5 : 9) / scale;
      const blend = 1 - Math.exp(-delta / 160);
      for (const node of graph.nodes) {
        const pose = poses.get(node.id)!;
        const focused = node.id === active?.id;
        if (enabled && delta > 0 && !focused) {
          const x =
            node.x +
            amplitude *
              (Math.sin(elapsed * 0.0007 + pose.phase) * 0.76 +
                Math.sin(elapsed * 0.00031 + pose.phase * 1.7) * 0.24);
          const y =
            node.y +
            amplitude *
              (Math.cos(elapsed * 0.00063 + pose.phase) * 0.76 +
                Math.sin(elapsed * 0.00027 + pose.phase * 1.3) * 0.24);
          pose.x += (x - pose.x) * blend;
          pose.y += (y - pose.y) * blend;
          const breath = (Math.sin(elapsed * 0.0014 + pose.phase) + 1) / 2;
          pose.halo = 0.09 + breath * 0.13;
          pose.haloRadius = 6.5 + breath * 3;
        }
        const elements = nodeElements.current.get(node.id);
        elements?.group.setAttribute(
          "transform",
          `translate(${pose.x.toFixed(3)} ${pose.y.toFixed(3)})`
        );
        elements?.halo?.setAttribute(
          "r",
          String((focused ? 11 : pose.haloRadius) / baseScale)
        );
        elements?.halo?.setAttribute(
          "opacity",
          String(focused ? 0.2 : pose.halo)
        );
      }
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.round(size.width * ratio);
      const height = Math.round(size.height * ratio);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.scale(ratio, ratio);
      context.translate(translateX, translateY);
      context.scale(scale, scale);
      context.translate(-bounds.x, -bounds.y);
      // 连线使用与 SVG 光点完全相同的位置快照，每帧不更新 React 状态。
      function stroke(groups: GraphEdge[][], opacity: number, width: number) {
        if (!context) return;
        context.globalAlpha = opacity;
        context.lineWidth = width / scale;
        for (const [index, edges] of groups.entries()) {
          context.beginPath();
          context.strokeStyle = colors[index];
          for (const edge of edges) {
            const source = poses.get(edge.source.id)!;
            const target = poses.get(edge.target.id)!;
            const bend = edge.bend;
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            context.moveTo(source.x, source.y);
            context.quadraticCurveTo(
              (source.x + target.x) / 2 - dy * bend,
              (source.y + target.y) / 2 + dx * bend,
              target.x,
              target.y
            );
          }
          context.stroke();
        }
      }
      const density = Math.min(
        0.24,
        4.5 / Math.sqrt(Math.max(1, graph.edges.length))
      );
      stroke(paintGroups.background, active ? density * 0.17 : density, 0.65);
      stroke(paintGroups.foreground, light ? 0.5 : 0.6, 0.9);
    },
    [
      graph,
      camera,
      size,
      scale,
      bounds,
      active,
      colors,
      light,
      baseScale,
      poses,
      paintGroups,
    ]
  );
  const motion = useMemoryGraphMotion(
    hostRef,
    paint,
    animationPreference,
    onAnimationPreference
  );

  function choose(node: GraphNode) {
    setSelected(node.id);
    onSelect({ id: node.memory.id });
  }
  const tooltipX = tooltip
    ? size.width / 2 +
      camera.x +
      ((poses.get(tooltip.id)?.x ?? tooltip.x) - bounds.x) * scale
    : 0;
  const tooltipY = tooltip
    ? size.height / 2 +
      camera.y +
      ((poses.get(tooltip.id)?.y ?? tooltip.y) - bounds.y) * scale
    : 0;

  return (
    <div
      ref={hostRef}
      className={cn(
        "relative min-w-0 overflow-hidden motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500",
        expanded ? "min-h-64 flex-1" : "h-[460px] sm:h-[620px]"
      )}
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <canvas ref={canvasRef} className="size-full" />
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${size.width} ${size.height}`}
        // biome-ignore lint/a11y/useSemanticElements: SVG 图谱不能由 HTML fieldset 替代。
        role="group"
        aria-label="记忆关系图"
        aria-describedby={descriptionId}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 图谱支持键盘平移与缩放，需要独立键盘入口。
        tabIndex={0}
        className={cn(
          "absolute inset-0 size-full touch-none select-none",
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
          event.currentTarget.focus();
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const previous = drag.current;
          if (!previous || previous.id !== event.pointerId) return;
          const x = event.clientX - previous.x;
          const y = event.clientY - previous.y;
          elastic.current = {
            x: motion.enabled ? Math.max(-12, Math.min(12, x * 0.9)) : 0,
            y: motion.enabled ? Math.max(-12, Math.min(12, y * 0.9)) : 0,
            vx: 0,
            vy: 0,
          };
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          };
          setCamera((value) => ({ ...value, x: value.x + x, y: value.y + y }));
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
            event.preventDefault();
            setCamera(initialCamera);
          } else if (event.key === "Escape") {
            setSelected(null);
            setHovered(null);
          }
        }}
      >
        <title>记忆星群：彩色点是记忆，细线表示真实共同字段</title>
        <g
          ref={sceneRef}
          transform={`translate(${size.width / 2 + camera.x} ${size.height / 2 + camera.y}) scale(${scale}) translate(${-bounds.x} ${-bounds.y})`}
        >
          {graph.nodes.map((node) => {
            const focused = active?.id === node.id;
            const color = colors[node.color];
            const radius = (3 + Math.min(0.6, node.degree / 120)) / baseScale;
            return (
              <g
                key={node.id}
                ref={(element) => {
                  if (element)
                    nodeElements.current.set(node.id, {
                      group: element,
                      halo: element.querySelector("[data-graph-halo]"),
                    });
                  else nodeElements.current.delete(node.id);
                }}
                // biome-ignore lint/a11y/useSemanticElements: SVG 节点已支持键盘、名称和选中状态。
                role="button"
                tabIndex={0}
                aria-label={`查看记忆：${node.label}`}
                aria-pressed={selected === node.id}
                transform={`translate(${node.x} ${node.y})`}
                className="cursor-pointer motion-safe:transition-opacity motion-safe:duration-150"
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
                onFocus={() => {
                  setHovered(node.id);
                  const x =
                    size.width / 2 + camera.x + (node.x - bounds.x) * scale;
                  const y =
                    size.height / 2 + camera.y + (node.y - bounds.y) * scale;
                  if (
                    x < 16 ||
                    x > size.width - 16 ||
                    y < 16 ||
                    y > size.height - 16
                  )
                    setCamera((value) => ({
                      ...value,
                      x: -(node.x - bounds.x) * scale,
                      y: -(node.y - bounds.y) * scale,
                    }));
                }}
                onBlur={() => setHovered(null)}
              >
                <title>{node.label}</title>
                <circle
                  r={(size.width < 640 ? 12 : 8) / scale}
                  fill="transparent"
                />
                <circle
                  data-graph-halo="true"
                  r={(focused ? 11 : 7) / baseScale}
                  fill={color}
                  opacity={focused ? 0.2 : 0.12}
                />
                <circle
                  r={radius}
                  fill={color}
                  opacity={node.memory.status === "candidate" ? 0.78 : 1}
                />
                {focused ? (
                  <circle
                    r={7.5 / baseScale}
                    fill="none"
                    stroke={color}
                    strokeWidth={0.8 / baseScale}
                    opacity={0.8}
                  />
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
      {tooltip ? (
        <div
          className="pointer-events-none absolute rounded-md border bg-popover/95 px-3 py-2 text-sm text-popover-foreground shadow-sm"
          style={{
            left: Math.max(
              12,
              Math.min(
                size.width - Math.min(300, size.width - 24) - 12,
                tooltipX + 14
              )
            ),
            top: Math.max(12, Math.min(size.height - 100, tooltipY - 72)),
            width: Math.min(300, size.width - 24),
          }}
        >
          <p className="line-clamp-3 break-words leading-5">{tooltip.label}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {tooltip.memory.status === "candidate" ? "候选" : "生效中"} · 与{" "}
            {tooltip.degree} 条记忆共享字段
          </p>
        </div>
      ) : null}
      <div className="absolute bottom-4 right-4 flex items-center gap-1 rounded-full border bg-background/90 p-1 shadow-sm">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full"
          aria-label={motion.enabled ? "暂停图谱动画" : "播放图谱动画"}
          title={motion.enabled ? "暂停动画" : "播放动画"}
          aria-pressed={motion.enabled}
          onClick={motion.toggle}
        >
          {motion.enabled ? <Pause /> : <Play />}
        </Button>
        {selected ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            aria-label="清除选中记忆"
            onClick={() => {
              setSelected(null);
              setHovered(null);
            }}
          >
            <X />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full"
          aria-label="缩小图谱"
          disabled={camera.scale <= 0.45}
          onClick={() => zoom(1 / 1.25)}
        >
          <Minus />
        </Button>
        <output
          className="w-10 text-center text-xs tabular-nums text-muted-foreground"
          aria-label="图谱缩放比例"
        >
          {Math.round(camera.scale * 100)}%
        </output>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full"
          aria-label="放大图谱"
          disabled={camera.scale >= 5}
          onClick={() => zoom(1.25)}
        >
          <Plus />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full"
          aria-label="重置图谱视图"
          onClick={() => {
            elastic.current = { x: 0, y: 0, vx: 0, vy: 0 };
            setCamera(initialCamera);
            setSelected(null);
            setHovered(null);
          }}
        >
          <Maximize />
        </Button>
      </div>
      <p id={descriptionId} className="sr-only">
        拖动空白处平移，使用按钮或 Ctrl /
        ⌘＋滚轮缩放。聚焦图谱后可用方向键、＋、－、0；Tab
        选点，回车查看详情。颜色按记忆分类分配；线只表示真实共同字段，不代表因果。
        可随时暂停动画，悬停或聚焦的点会保持稳定。
      </p>
    </div>
  );
}
