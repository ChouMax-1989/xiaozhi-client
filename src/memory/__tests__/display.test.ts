import { describe, expect, it } from "vitest";
// biome-ignore lint/nursery/useImportRestrictions: 验证共享的纯展示分类。
import { getMemoryCategory } from "../../types/memory-display.js";
import type { MemoryRecord } from "../types.js";

describe("本地记忆展示分类", () => {
  const base: Pick<
    MemoryRecord,
    "subject" | "assertion" | "conditions" | "facet"
  > = {
    subject: { kind: "speaker" },
    assertion: "explicit",
    conditions: "",
    facet: "interests",
  };
  it("人物稳定信息与自定义属性属于画像", () => {
    expect(getMemoryCategory(base)).toBe("user_profile");
    expect(
      getMemoryCategory({
        ...base,
        subject: { kind: "related_person", label: "妻子" },
        facet: "自定义",
      })
    ).toBe("user_profile");
  });
  it("事件、计划、条件与实体属于情境", () => {
    for (const changes of [
      { assertion: "event" as const },
      { assertion: "plan" as const },
      { conditions: "晚上" },
      { subject: { kind: "entity" as const, label: "房间" } },
      { facet: "recent_event" },
      { facet: "plan" },
      { facet: "context_preference" },
    ])
      expect(getMemoryCategory({ ...base, ...changes })).toBe("situational");
  });
});
