#!/usr/bin/env node

/**
 * 保留原有版本检查命令。
 * Docker 镜像现已直接构建当前源码，版本由根 package.json 决定。
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function updateDockerfileVersion() {
  const packageJson = JSON.parse(
    readFileSync(resolve(projectRoot, "package.json"), "utf8")
  );
  console.log(`当前源码版本：${packageJson.version}`);
  console.log("Docker 镜像直接构建当前源码，无需修改 Dockerfile 中的版本号。");
  console.log(
    "重新构建：docker compose -f docker/docker-compose.yml up -d --build"
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  updateDockerfileVersion();
}

export { updateDockerfileVersion };
