/** 记忆工具正文不进入运行日志，操作名称和统计信息仍可记录。 */
export const MEMORY_LOG_REDACTION = "[记忆正文已隐藏]";

/** 同时识别原始工具名和经过服务名聚合后的工具名。 */
export function isMemoryToolName(name: unknown): boolean {
  return typeof name === "string" && /(?:^|__)memory_/u.test(name);
}

/** 只生成日志值，不修改实际工具参数、结果或异常。 */
export function redactToolLogValue<T>(
  value: T,
  sensitive: boolean
): T | string {
  return sensitive ? MEMORY_LOG_REDACTION : value;
}
