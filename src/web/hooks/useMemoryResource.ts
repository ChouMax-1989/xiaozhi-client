import { useCallback, useEffect, useState } from "react";

export function memoryError(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}

/** 页面切换或筛选变化时取消旧请求，防止旧结果覆盖当前选择。 */
export function useMemoryResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  enabled = true,
  refreshKey = 0
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 刷新标记变化时必须重新发起请求。
  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let current = true;
    setLoading(true);
    setError(null);
    void load(controller.signal)
      .then((result) => {
        if (current) setData(result);
      })
      .catch((failure: unknown) => {
        if (current && !controller.signal.aborted) {
          setError(memoryError(failure));
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [load, enabled, version, refreshKey]);

  return { data, loading, error, refresh, setData };
}
