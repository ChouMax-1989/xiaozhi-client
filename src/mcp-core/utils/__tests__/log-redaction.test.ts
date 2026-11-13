import { describe, expect, it } from "vitest";
import {
  MEMORY_LOG_REDACTION,
  isMemoryToolName,
  redactToolLogValue,
} from "../log-redaction.js";

describe("记忆工具日志脱敏", () => {
  it("识别原名与聚合名，并保留其它工具的日志行为", () => {
    for (const name of [
      "memory_search",
      "home__memory_commit",
      "a__b__memory_get",
    ]) {
      expect(isMemoryToolName(name)).toBe(true);
    }
    for (const name of [
      "memory",
      "remember_fact",
      "check_memory_usage",
      null,
      7,
    ]) {
      expect(isMemoryToolName(name)).toBe(false);
    }
  });

  it("不遍历记忆正文，不修改普通值或实际工具返回对象", () => {
    const result = { content: [{ text: "不会进入日志的家庭原话" }] };
    const before = structuredClone(result);
    expect(redactToolLogValue(result, true)).toBe(MEMORY_LOG_REDACTION);
    expect(redactToolLogValue(result, false)).toBe(result);
    expect(result).toEqual(before);
    expect(redactToolLogValue(new Error("私密异常"), true)).toBe(
      MEMORY_LOG_REDACTION
    );
  });
});
