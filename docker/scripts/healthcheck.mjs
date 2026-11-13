import { readFileSync } from "node:fs";
import { join } from "node:path";

try {
  const configDir = process.env.XIAOZHI_CONFIG_DIR || "/workspaces";
  const contents = readFileSync(join(configDir, "xiaozhi.config.json"), "utf8");
  const config = JSON.parse(contents.replace(/^\uFEFF/, ""));
  const port = config.webUI?.port ?? 9999;
  const response = await fetch(`http://127.0.0.1:${port}/api/services/health`, {
    signal: AbortSignal.timeout(5000),
  });
  const health = await response.json();

  // 只检查本地服务；尚未填写官方接入点时，WebUI 仍应可用。
  if (!response.ok || !health.success || health.data?.status !== "healthy") {
    throw new Error(`服务返回异常健康状态（HTTP ${response.status}）`);
  }
} catch (error) {
  console.error("小智服务健康检查失败：", error.message);
  process.exit(1);
}
