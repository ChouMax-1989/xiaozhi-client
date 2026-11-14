import type { ToolCallResult } from "@/mcp-core";

export function isMemorySearch(name: unknown): boolean {
  return typeof name === "string" && /(?:^|__)memory_search$/u.test(name);
}

export function loggedChatStart(
  args: Record<string, unknown> | undefined
): boolean | "omitted" | "invalid" {
  if (!args || !Object.hasOwn(args, "chatStart")) return "omitted";
  return typeof args.chatStart === "boolean" ? args.chatStart : "invalid";
}

export function loggedAutoExtract(
  result: ToolCallResult
): "present" | "absent" | "unknown" {
  const content = result.content;
  if (result.isError || !Array.isArray(content) || content.length !== 1)
    return "unknown";
  const item = content[0];
  if (item?.type !== "text" || typeof item.text !== "string") return "unknown";
  try {
    const response = JSON.parse(item.text);
    if (!response || typeof response !== "object") return "unknown";
    if (typeof response.autoExtract === "string" && response.autoExtract.length)
      return "present";
    // 旧版分段信封没有任务字段，不能从 chunk 中的原话推断。
    if (
      response.segmented === true ||
      Object.hasOwn(response, "autoExtract") ||
      !Array.isArray(response.memories)
    )
      return "unknown";
    return "absent";
  } catch {
    return "unknown";
  }
}
