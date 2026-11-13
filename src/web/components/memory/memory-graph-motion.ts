import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

type PaintFrame = (elapsed: number, delta: number, enabled: boolean) => void;

/** 限制绘制帧率，并在不可见时停止申请帧；画面更新不经过 React 状态。 */
export function useMemoryGraphMotion(
  surface: RefObject<HTMLElement | null>,
  paint: PaintFrame,
  preference?: boolean | null,
  onPreference?: (enabled: boolean) => void
) {
  const [reduced, setReduced] = useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false
  );
  const [localPreference, setLocalPreference] = useState<boolean | null>(null);
  const enabled = preference ?? localPreference ?? !reduced;
  const elapsed = useRef(0);
  const painter = useRef(paint);
  const enabledRef = useRef(enabled);

  useLayoutEffect(() => {
    painter.current = paint;
    enabledRef.current = enabled;
    paint(elapsed.current, 0, enabled);
  }, [paint, enabled]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const changed = () => setReduced(media?.matches ?? false);
    media?.addEventListener("change", changed);
    return () => media?.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    let request: number | null = null;
    let previous: number | null = null;
    let intersecting = true;
    let disposed = false;
    function frame(timestamp: number) {
      request = null;
      if (disposed || !enabled || document.hidden || !intersecting) return;
      const delta = previous === null ? 0 : timestamp - previous;
      if (previous === null || delta >= 1000 / 30 - 1) {
        previous = timestamp;
        const step = Math.min(80, delta);
        elapsed.current += step;
        painter.current(elapsed.current, step, enabledRef.current);
      }
      request = window.requestAnimationFrame(frame);
    }
    function update() {
      const running = enabled && !document.hidden && intersecting;
      surface.current?.setAttribute(
        "data-motion",
        running ? "running" : "paused"
      );
      if (request !== null) window.cancelAnimationFrame(request);
      request = null;
      previous = null;
      if (running) request = window.requestAnimationFrame(frame);
    }
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            intersecting = entries.some((entry) => entry.isIntersecting);
            update();
          });
    if (surface.current) observer?.observe(surface.current);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      disposed = true;
      if (request !== null) window.cancelAnimationFrame(request);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [enabled, surface]);

  function toggle() {
    if (onPreference) onPreference(!enabled);
    else setLocalPreference(!enabled);
  }
  return { enabled, toggle };
}
