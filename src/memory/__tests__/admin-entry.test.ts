import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PROCESS_TIMEOUT_MS = 15_000;
// 真实子进程逐个执行，单测预算需覆盖各进程上限和断言、清理时间。
const TEST_OVERHEAD_MS = 5_000;

describe("记忆管理独立进程协议", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "xiaozhi-admin-entry-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function run(
    input: string,
    env: NodeJS.ProcessEnv = {},
    entry: "admin" | "stdio" = "admin"
  ) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", `src/memory/${entry}.ts`],
      {
        cwd: resolve(import.meta.dirname, "../../.."),
        env: {
          ...process.env,
          XIAOZHI_MEMORY_AGENT_ID: "",
          XIAOZHI_MEMORY_DB: join(directory, "memory.sqlite"),
          XIAOZHI_MEMORY_OWNER: "",
          XIAOZHI_MEMORY_TOKEN_FILE: "",
          XIAOZHI_MEMORY_CLIENT_CONFIG: "",
          XIAOZHI_MEMORY_SYNC_INTERVAL_SECONDS: "0",
          ...env,
        },
        input,
        encoding: "utf8",
        timeout: PROCESS_TIMEOUT_MS,
      }
    );
  }

  it(
    "未配置身份时只输出一份安全失败结果，不自动创建数据库",
    () => {
      const result = run(JSON.stringify({ action: "status" }));
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toEqual({
        success: false,
        error: "请配置 XIAOZHI_MEMORY_AGENT_ID，不能自动推断记忆库的身份。",
      });
      expect(existsSync(join(directory, "memory.sqlite"))).toBe(false);
    },
    PROCESS_TIMEOUT_MS + TEST_OVERHEAD_MS
  );

  it(
    "请求体超过上限在打开数据库前拒绝，错误不回显私密内容",
    () => {
      const secret = "不应在错误或日志中出现的正文";
      const result = run(
        JSON.stringify({
          action: "chats",
          query: secret + "x".repeat(128 * 1024),
        })
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        success: false,
        error: "记忆管理请求不能超过 128 KiB。",
      });
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect(existsSync(join(directory, "memory.sqlite"))).toBe(false);
    },
    PROCESS_TIMEOUT_MS + TEST_OVERHEAD_MS
  );

  it(
    "管理和模型入口的错误智能体配置都不会锁住空库，改正后可以正常初始化",
    () => {
      const configPath = join(directory, "xiaozhi.config.json");
      const payload = Buffer.from(
        JSON.stringify({ agentId: "correct-agent" })
      ).toString("base64url");
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpEndpoint: `wss://example.invalid/mcp?token=e30.${payload}.synthetic`,
        })
      );
      const request = JSON.stringify({ action: "status" });
      const wrong = run(request, {
        XIAOZHI_MEMORY_AGENT_ID: "typo-agent",
        XIAOZHI_MEMORY_CLIENT_CONFIG: configPath,
      });
      expect(wrong.error).toBeUndefined();
      expect(wrong.status).toBe(1);
      expect(JSON.parse(wrong.stdout)).toEqual({
        success: false,
        error: "客户端端点的智能体与记忆库配置不一致，已拒绝访问。",
      });
      expect(existsSync(join(directory, "memory.sqlite"))).toBe(false);
      const wrongMcp = run(
        "",
        {
          XIAOZHI_MEMORY_AGENT_ID: "typo-agent",
          XIAOZHI_MEMORY_CLIENT_CONFIG: configPath,
        },
        "stdio"
      );
      expect(wrongMcp.error).toBeUndefined();
      expect(wrongMcp.status).toBe(1);
      expect(wrongMcp.stdout).toBe("");
      expect(wrongMcp.stderr).toContain(
        "客户端端点的智能体与记忆库配置不一致，已拒绝访问。"
      );
      expect(existsSync(join(directory, "memory.sqlite"))).toBe(false);
      const corrected = run(request, {
        XIAOZHI_MEMORY_AGENT_ID: "correct-agent",
        XIAOZHI_MEMORY_CLIENT_CONFIG: configPath,
      });
      expect(corrected.error).toBeUndefined();
      expect(corrected.status).toBe(0);
      expect(JSON.parse(corrected.stdout)).toMatchObject({
        success: true,
        data: { counts: { chats: 0, messages: 0, memories: 0 } },
      });
      expect(existsSync(join(directory, "memory.sqlite"))).toBe(true);
    },
    PROCESS_TIMEOUT_MS * 3 + TEST_OVERHEAD_MS
  );

  it(
    "损坏的或包含多条指令的输入均作为单条失败处理，不输出输入片段",
    () => {
      const secret = "不应被回显的官方令牌";
      for (const input of [
        `{"action":"status","token":"${secret}"`,
        '{"action":"status"}\n{"action":"export"}',
        JSON.stringify({ action: secret }),
      ]) {
        const result = run(input);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout.trim().split("\n")).toHaveLength(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ success: false });
        expect(result.stdout + result.stderr).not.toContain(secret);
      }
    },
    PROCESS_TIMEOUT_MS * 3 + TEST_OVERHEAD_MS
  );
});
