import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

describe("独立 Web 服务启动入口", () => {
  let directory = "";

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("能从包含中文和空格的路径直接启动，导入时不启动", () => {
    directory = mkdtempSync(join(tmpdir(), "启动 测试-"));
    const server = join(directory, "server");
    mkdirSync(server);
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../WebServerLauncher.ts"
      ),
      "utf8"
    );
    const launcher = join(server, "WebServerLauncher.js");
    writeFileSync(
      launcher,
      ts.transpile(source, { module: ts.ModuleKind.ESNext })
    );
    writeFileSync(
      join(server, "WebServer.js"),
      'export class WebServer { async start() { console.log("STARTED"); } }'
    );
    writeFileSync(
      join(server, "Logger.js"),
      "export const logger = { info() {} };"
    );

    const options = {
      encoding: "utf8" as const,
      env: { ...process.env, XIAOZHI_CONFIG_DIR: "" },
    };
    expect(execFileSync(process.execPath, [launcher], options)).toContain(
      "STARTED"
    );
    expect(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(pathToFileURL(launcher).href)})`,
        ],
        options
      )
    ).not.toContain("STARTED");
  });
});
