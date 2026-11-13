#!/usr/bin/env node

/**
 * WebServer 独立启动脚本
 * 用于后台模式启动，替代原有的 adaptiveMCPPipe 启动方式
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 动态导入避免 CLI 代码执行
async function importModules() {
  const webServerModule = await import("./WebServer.js");
  const loggerModule = await import("./Logger.js");
  return {
    WebServer: webServerModule.WebServer,
    logger: loggerModule.logger,
  };
}

async function main() {
  try {
    // 动态导入模块
    const { WebServer, logger } = await importModules();

    // 初始化日志
    if (process.env.XIAOZHI_CONFIG_DIR) {
      logger.initLogFile(process.env.XIAOZHI_CONFIG_DIR);
      logger.enableFileLogging(true);
    }

    // 启动 WebServer
    const webServer = new WebServer();
    await webServer.start();

    logger.info("[WEBSERVER_STANDALONE] WebServer 启动成功");

    // 处理退出信号
    const cleanup = async () => {
      logger.info("[WEBSERVER_STANDALONE] 正在停止 WebServer...");
      await webServer.stop();
      process.exit(0);
    };

    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  } catch (error) {
    console.error("WebServer 启动失败:", error);
    process.exit(1);
  }
}

// 检查是否为直接执行
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
