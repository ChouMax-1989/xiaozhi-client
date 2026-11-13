// biome-ignore lint/nursery/useImportRestrictions: 只依赖记忆领域类型，不引入运行时依赖。
import type { MemoryRecord } from "../memory/types.js";

/** 本地展示分类，并非小智官方接口字段。 */
export function getMemoryCategory(
  memory: Pick<MemoryRecord, "subject" | "assertion" | "conditions" | "facet">
): "user_profile" | "situational" {
  if (
    memory.subject.kind === "entity" ||
    memory.assertion === "event" ||
    memory.assertion === "plan" ||
    memory.conditions.trim().length > 0 ||
    ["recent_event", "plan", "context_preference"].includes(memory.facet)
  ) {
    return "situational";
  }
  return "user_profile";
}
