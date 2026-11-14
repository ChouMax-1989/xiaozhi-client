#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { checkClientBinding, loadMemoryOptions } from "./config.js";
import { syncHistory } from "./history.js";
import { createMemoryServer, safeMemoryError } from "./mcp.js";
import { MemoryStore } from "./store.js";
import { MemoryError } from "./types.js";

function syncBudget(env: NodeJS.ProcessEnv): number {
  const input = env.XIAOZHI_MEMORY_SYNC_MAX_REQUESTS?.trim() || "20";
  const value = Number(input);
  if (
    !/^\d+$/u.test(input) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 1_000
  ) {
    throw new MemoryError(
      "XIAOZHI_MEMORY_SYNC_MAX_REQUESTS 必须为 1 到 1000 的整数。"
    );
  }
  return value;
}

function log(message: string): void {
  process.stderr.write(`[本地记忆] ${message}\n`);
}

/** stdout 只承载 MCP；同步和错误日志不输出原话、令牌或底层响应。 */
export async function startMemoryStdio(env: NodeJS.ProcessEnv = process.env) {
  const options = loadMemoryOptions(env);
  const maxRequests = syncBudget(env);
  // 首次启动先验证端点和身份，避免错误配置提前创建并绑定空库。
  checkClientBinding(options, () => undefined);
  const store = new MemoryStore(options.databasePath, options);
  const guard = () =>
    checkClientBinding(options, (key, value) => store.bindMetadata(key, value));
  try {
    guard();
  } catch (error) {
    store.close();
    throw error;
  }

  const server = createMemoryServer(store, guard, env.XIAOZHI_MCP_SERVICE_NAME);
  const transport = new StdioServerTransport();
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let stopped = false;
  let automaticSync =
    options.syncIntervalSeconds > 0 && Boolean(options.tokenFile);

  const schedule = () => {
    if (!stopped && automaticSync) {
      timer = setTimeout(
        () => void synchronize(),
        options.syncIntervalSeconds * 1_000
      );
      timer.unref();
    }
  };
  const synchronize = async (): Promise<void> => {
    if (stopped || inFlight || !automaticSync || !options.tokenFile) return;
    inFlight = (async () => {
      try {
        guard();
        const outcome = await syncHistory(store, {
          agentId: options.agentId,
          tokenFile: options.tokenFile!,
          maxRequests,
          signal: abort.signal,
        });
        if (!stopped) {
          if (outcome.status === "complete") {
            log(`${outcome.message}记忆提炼仍由现有聊天模型通过工具进行。`);
          } else {
            log(outcome.message);
            if (outcome.status === "error") {
              automaticSync = false;
              log(
                "自动同步已暂停，请在本机修正配置或接口问题后重启服务；本地记忆仍可读取。"
              );
            }
          }
        }
      } catch {
        automaticSync = false;
        if (!stopped) {
          log("本轮同步未完成，已保留本地档案；请在本机检查配置和连接。");
          log("自动同步已暂停，请在本机处理后重启服务。");
        }
      }
    })();
    try {
      await inFlight;
    } finally {
      inFlight = undefined;
      schedule();
    }
  };

  const close = (): Promise<void> => {
    if (closing) return closing;
    stopped = true;
    if (timer) clearTimeout(timer);
    abort.abort();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.stdin.off("end", onInputEnd);
    closing = (async () => {
      try {
        await server.close();
      } finally {
        await inFlight;
        store.close();
      }
    })();
    return closing;
  };
  const onSignal = () => {
    void close().catch(() => {
      log("本地记忆关闭未完成，请在本机检查存储状态。");
      process.exitCode = 1;
    });
  };
  const onInputEnd = () => onSignal();
  server.server.onclose = () => {
    if (!stopped) onSignal();
  };
  server.server.onerror = () =>
    log("收到无效或中断的 MCP 消息，正文未写入日志。");
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.stdin.once("end", onInputEnd);

  try {
    await server.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }
  log("本地记忆 MCP 已启动。");
  if (automaticSync) {
    void synchronize();
  } else if (options.syncIntervalSeconds > 0) {
    log(
      "未配置本机凭据文件，自动同步未启动；请在本机配置 XIAOZHI_MEMORY_TOKEN_FILE。"
    );
  }
  return { close };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void startMemoryStdio().catch((error: unknown) => {
    log(safeMemoryError(error));
    process.exitCode = 1;
  });
}
