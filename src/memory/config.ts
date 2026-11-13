import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { MemoryError, type MemoryOptions } from "./types.js";

function readIdentifier(
  env: NodeJS.ProcessEnv,
  name: string,
  required = false
): string | undefined {
  const value = env[name]?.trim();
  if (!value) {
    if (required) {
      throw new MemoryError(`请配置 ${name}，不能自动推断记忆库的身份。`);
    }
    return undefined;
  }
  if (value.length > 200 || /\p{Cc}/u.test(value)) {
    throw new MemoryError(`${name} 必须是不含控制字符的有效标识。`);
  }
  return value;
}

function readAbsolutePath(
  env: NodeJS.ProcessEnv,
  name: string,
  required = false
): string | undefined {
  const value = env[name]?.trim();
  if (!value) {
    if (required) {
      throw new MemoryError(`请配置 ${name}，必须使用绝对路径。`);
    }
    return undefined;
  }
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new MemoryError(`${name} 必须使用有效的绝对路径。`);
  }
  return resolve(value);
}

/** 只解析本机配置，不读取凭据内容，也不自动创建身份或路径。 */
export function loadMemoryOptions(
  env: NodeJS.ProcessEnv = process.env
): MemoryOptions {
  const agentId = readIdentifier(env, "XIAOZHI_MEMORY_AGENT_ID", true)!;
  const databasePath = readAbsolutePath(env, "XIAOZHI_MEMORY_DB", true)!;
  const ownerId = readIdentifier(env, "XIAOZHI_MEMORY_OWNER");
  const tokenFile = readAbsolutePath(env, "XIAOZHI_MEMORY_TOKEN_FILE");
  const clientConfigPath = readAbsolutePath(
    env,
    "XIAOZHI_MEMORY_CLIENT_CONFIG"
  );
  const intervalValue = env.XIAOZHI_MEMORY_SYNC_INTERVAL_SECONDS?.trim() || "0";
  const syncIntervalSeconds = Number(intervalValue);
  if (
    !/^\d+$/u.test(intervalValue) ||
    !Number.isSafeInteger(syncIntervalSeconds) ||
    syncIntervalSeconds > 2_147_483 ||
    (syncIntervalSeconds !== 0 && syncIntervalSeconds < 60)
  ) {
    throw new MemoryError(
      "XIAOZHI_MEMORY_SYNC_INTERVAL_SECONDS 必须为 0 或至少 60 且不超过 2147483 的整数。"
    );
  }

  return {
    agentId,
    databasePath,
    ownerId,
    tokenFile,
    clientConfigPath,
    syncIntervalSeconds,
  };
}

function readSingleEndpoint(clientConfigPath: string | undefined): URL {
  if (
    !clientConfigPath ||
    !isAbsolute(clientConfigPath) ||
    clientConfigPath.includes("\0")
  ) {
    throw new MemoryError("记忆 MCP 服务必须配置客户端配置文件的绝对路径。");
  }

  let config: unknown;
  try {
    if (!statSync(clientConfigPath).isFile()) {
      throw new Error("不是普通文件");
    }
    config = JSON.parse(
      readFileSync(clientConfigPath, "utf8").replace(/^\uFEFF/u, "")
    ) as unknown;
  } catch {
    // 文件路径和解析错误都可能含有凭据，不能直接返回底层错误。
    throw new MemoryError(
      "无法读取有效的客户端 JSON 配置文件，请在本机检查配置。"
    );
  }

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new MemoryError("客户端配置必须是 JSON 对象。");
  }
  const configuredEndpoints = (config as Record<string, unknown>).mcpEndpoint;
  let endpoints: string[];
  if (typeof configuredEndpoints === "string") {
    endpoints = [configuredEndpoints];
  } else if (
    Array.isArray(configuredEndpoints) &&
    configuredEndpoints.every((endpoint) => typeof endpoint === "string")
  ) {
    endpoints = configuredEndpoints;
  } else {
    throw new MemoryError("客户端 mcpEndpoint 必须是字符串或字符串数组。");
  }

  const nonemptyEndpoints = endpoints
    .map((endpoint) => endpoint.trim())
    .filter(Boolean);
  if (nonemptyEndpoints.length !== 1) {
    throw new MemoryError("记忆 MCP 服务只支持配置恰好一个端点的独立实例。");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(nonemptyEndpoints[0]);
  } catch {
    throw new MemoryError("客户端 MCP 端点地址无效，请在本机检查配置。");
  }
  if (
    endpoint.protocol !== "wss:" ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.searchParams.getAll("token").length > 1
  ) {
    throw new MemoryError("客户端 MCP 端点必须使用有效且无歧义的 WSS 地址。");
  }
  return endpoint;
}

function checkEndpointAgent(endpoint: URL, agentId: string): void {
  const token = endpoint.searchParams.get("token");
  const parts = token?.split(".");
  if (!parts || parts.length !== 3) {
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return;
  }
  if (!Object.hasOwn(payload, "agentId")) {
    return;
  }

  const endpointAgentId = (payload as Record<string, unknown>).agentId;
  if (
    (typeof endpointAgentId !== "string" &&
      typeof endpointAgentId !== "number") ||
    (typeof endpointAgentId === "number" &&
      (!Number.isSafeInteger(endpointAgentId) || endpointAgentId <= 0)) ||
    String(endpointAgentId) !== agentId
  ) {
    throw new MemoryError("客户端端点的智能体与记忆库配置不一致，已拒绝访问。");
  }
}

/** 每次调用都读固定文件；指纹绑定由数据库原子地建立或核对。 */
export function checkClientBinding(
  options: MemoryOptions,
  bind: (key: string, value: string) => void
): void {
  const endpoint = readSingleEndpoint(options.clientConfigPath);
  // 只核对配置一致性，不验证令牌签名，也不把令牌当作人物身份。
  checkEndpointAgent(endpoint, options.agentId);
  const fingerprint = createHash("sha256").update(endpoint.href).digest("hex");
  try {
    bind("endpoint", fingerprint);
  } catch {
    throw new MemoryError(
      "无法核对记忆库的端点绑定，请由本机管理员检查；更换端点后需要重新绑定。"
    );
  }
}
