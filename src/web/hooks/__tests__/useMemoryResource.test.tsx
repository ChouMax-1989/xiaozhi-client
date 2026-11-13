import { useMemoryResource } from "@/hooks/useMemoryResource";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

describe("记忆数据请求", () => {
  it("筛选变化时取消旧请求，即使旧结果迟到也不覆盖新结果", async () => {
    let oldResolve: (value: string) => void = () => undefined;
    let oldSignal: AbortSignal | undefined;
    const first = vi.fn((signal: AbortSignal) => {
      oldSignal = signal;
      return new Promise<string>((resolve) => {
        oldResolve = resolve;
      });
    });
    const second = vi.fn(async (_signal: AbortSignal) => "当前筛选结果");
    const { result, rerender, unmount } = renderHook(
      ({ load }) => useMemoryResource(load),
      {
        initialProps: {
          load: first as (signal: AbortSignal) => Promise<string>,
        },
      }
    );
    rerender({ load: second });
    await waitFor(() => expect(result.current.data).toBe("当前筛选结果"));
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      oldResolve("旧筛选结果");
    });
    expect(result.current.data).toBe("当前筛选结果");
    unmount();
    expect(second.mock.calls[0][0].aborted).toBe(true);
  });
});
