import { ChildProcess, type ChildProcessByStdio } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, MCPServerConfig } from "../../../config/index.js";
import { memoryRolePrompt } from "../../../memory/prompts.js";
import {
  MemoryAdminProcessRunner,
  MemoryAdminService,
  type MemoryAdminWorkerRunner,
} from "../MemoryAdminService.js";

describe("记忆管理配置与任务", () => {
  let directory: string;
  let appConfig: AppConfig;
  let config: {
    getConfig: () => Readonly<AppConfig>;
    getConfigDir: () => string;
    getConfigPath: () => string;
    updateMcpServer: (name: string, value: MCPServerConfig) => void;
  };
  let worker: MemoryAdminWorkerRunner;
  const input = {
    agentId: "agent-a",
    ownerId: "",
    syncIntervalSeconds: 0,
    syncMaxRequests: 20,
  };

  function configure(env: Record<string, string> = {}): void {
    appConfig.mcpServers.archive = {
      command: process.execPath,
      args: ["--experimental-sqlite", resolve("dist/memory/stdio.js")],
      env: {
        XIAOZHI_MEMORY_AGENT_ID: "agent-a",
        XIAOZHI_MEMORY_DB: join(directory, "archive.sqlite"),
        XIAOZHI_MEMORY_CLIENT_CONFIG: join(directory, "xiaozhi.config.json"),
        ...env,
      },
    };
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "memory-web-admin-"));
    appConfig = {
      mcpEndpoint: "wss://example.invalid/mcp?token=endpoint-secret",
      mcpServers: {},
    };
    writeFileSync(
      join(directory, "xiaozhi.config.json"),
      JSON.stringify(appConfig)
    );
    config = {
      getConfig: () => appConfig,
      getConfigDir: () => directory,
      getConfigPath: () => join(directory, "xiaozhi.config.json"),
      updateMcpServer: vi.fn((name, value) => {
        appConfig.mcpServers[name] = value;
      }),
    };
    worker = { run: vi.fn().mockResolvedValue({}), close: vi.fn() };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("未配置历史凭据也提供逐轮记录角色规则，不启动同步", async () => {
    const service = new MemoryAdminService({ config, worker });
    const overview = await service.getOverview();
    expect(overview.recordingPrompt).toBe(memoryRolePrompt());
    expect(overview.ready).toBe(false);
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("初始化使用固定入口和数据库，保存后明确需要重启", async () => {
    const service = new MemoryAdminService({ config, worker });
    expect(service.getSettings()).toMatchObject({
      configured: false,
      agentId: "",
      ownerId: "",
      syncIntervalSeconds: 0,
    });
    const settings = await service.saveSettings(input);
    expect(settings).toMatchObject({
      configured: true,
      databasePath: join(directory, "memory/archive.sqlite"),
      restartRequired: true,
    });
    expect(appConfig.mcpServers.memory).toMatchObject({
      command: process.execPath,
      args: ["--experimental-sqlite", resolve("dist/memory/stdio.js")],
      env: {
        XIAOZHI_MEMORY_AGENT_ID: "agent-a",
        XIAOZHI_MEMORY_CLIENT_CONFIG: join(directory, "xiaozhi.config.json"),
      },
    });
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("构造不读取配置，启动快照之后的外部变更仍要求重启", () => {
    configure();
    const read = vi.fn(() => appConfig);
    const service = new MemoryAdminService({
      config: { ...config, getConfig: read },
      worker,
    });
    expect(read).not.toHaveBeenCalled();
    service.captureRuntimeConfiguration(appConfig);
    expect(read).not.toHaveBeenCalled();
    expect(service.getSettings().restartRequired).toBe(false);
    const archive = appConfig.mcpServers.archive;
    if (!("command" in archive)) throw new Error("测试配置必须为本机服务");
    appConfig.mcpServers.archive = {
      ...archive,
      env: { ...archive.env, XIAOZHI_MEMORY_SYNC_INTERVAL_SECONDS: "60" },
    };
    service.captureRuntimeConfiguration(appConfig);
    expect(service.getSettings().restartRequired).toBe(true);
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("设置中的容器标记仅由既有环境变量的 true 值决定", () => {
    const service = new MemoryAdminService({ config, worker });
    vi.stubEnv("XIAOZHI_CONTAINER", undefined);
    expect(service.getSettings().containerMode).toBe(false);
    vi.stubEnv("XIAOZHI_CONTAINER", "true");
    expect(service.getSettings().containerMode).toBe(true);
    vi.stubEnv("XIAOZHI_CONTAINER", "false");
    expect(service.getSettings().containerMode).toBe(false);
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("启动配置失败不能伪报已生效，关闭后不重新初始化工作进程", async () => {
    configure();
    const read = vi.fn(() => appConfig);
    const service = new MemoryAdminService({
      config: { ...config, getConfig: read },
      worker,
    });
    service.captureRuntimeConfiguration(null);
    expect(service.getSettings().restartRequired).toBe(true);
    const stopped = new MemoryAdminService({
      config: { ...config, getConfig: read },
      worker,
    });
    stopped.close();
    read.mockClear();
    stopped.captureRuntimeConfiguration(appConfig);
    expect(read).not.toHaveBeenCalled();
    await expect(stopped.execute({ action: "status" })).rejects.toMatchObject({
      code: "MEMORY_STOPPING",
    });
    expect(worker.run).not.toHaveBeenCalled();
    expect(worker.close).toHaveBeenCalledOnce();
  });

  it("不把无关环境变量识别成记忆服务，也不会覆盖同名其他服务", async () => {
    appConfig.mcpServers.other = {
      command: "python",
      args: [],
      env: { XIAOZHI_MEMORY_UNRELATED: "value" },
    };
    const service = new MemoryAdminService({ config, worker });
    expect(service.getSettings().configured).toBe(false);
    appConfig.mcpServers.memory = { command: "python", args: ["different.py"] };
    await expect(service.saveSettings(input)).rejects.toMatchObject({
      code: "MEMORY_NAME_CONFLICT",
    });
    expect(config.updateMcpServer).not.toHaveBeenCalled();
  });

  it("首次设置的智能体与端点不符时在落盘前拒绝，仍可纠正且不创建数据库", async () => {
    const payload = Buffer.from(
      JSON.stringify({ agentId: "agent-a" })
    ).toString("base64url");
    appConfig.mcpEndpoint = `wss://example.invalid/mcp?token=header.${payload}.signature`;
    const path = join(directory, "xiaozhi.config.json");
    writeFileSync(path, JSON.stringify(appConfig));
    const before = readFileSync(path, "utf8");
    const service = new MemoryAdminService({ config, worker });
    await expect(
      service.saveSettings({ ...input, agentId: "wrong-agent" })
    ).rejects.toMatchObject({ code: "MEMORY_BINDING_REJECTED" });
    expect(config.updateMcpServer).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(join(directory, "memory/archive.sqlite"))).toBe(false);
    expect(service.getSettings()).toMatchObject({
      configured: false,
      identityLocked: false,
    });
    await expect(service.saveSettings(input)).resolves.toMatchObject({
      configured: true,
      agentId: "agent-a",
    });
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("多个记忆服务、多端点和非标准命令均拒绝自动覆盖", async () => {
    configure();
    appConfig.mcpServers.second = { ...appConfig.mcpServers.archive };
    const service = new MemoryAdminService({ config, worker });
    await expect(service.saveSettings(input)).rejects.toMatchObject({
      code: "MEMORY_MULTIPLE_SERVICES",
    });
    appConfig.mcpServers = { archive: appConfig.mcpServers.archive };
    appConfig.mcpEndpoint = ["wss://one.invalid/mcp", "wss://two.invalid/mcp"];
    await expect(service.saveSettings(input)).rejects.toMatchObject({
      code: "MEMORY_SINGLE_ENDPOINT_REQUIRED",
    });
    appConfig.mcpEndpoint = "wss://one.invalid/mcp";
    appConfig.mcpServers.archive = {
      ...appConfig.mcpServers.archive,
      command: "sh",
      args: ["custom.sh"],
    };
    await expect(service.saveSettings(input)).rejects.toMatchObject({
      code: "MEMORY_CUSTOM_COMMAND",
    });
    expect(config.updateMcpServer).not.toHaveBeenCalled();
  });

  it("已有数据库锁定智能体与人物身份，但允许修改同步设置", async () => {
    configure();
    writeFileSync(join(directory, "archive.sqlite"), "数据库占位");
    const service = new MemoryAdminService({ config, worker });
    expect(service.getSettings().identityLocked).toBe(true);
    await expect(
      service.saveSettings({ ...input, agentId: "other-agent" })
    ).rejects.toMatchObject({ code: "MEMORY_IDENTITY_LOCKED" });
    await expect(
      service.saveSettings({ ...input, ownerId: "other-person" })
    ).rejects.toMatchObject({ code: "MEMORY_IDENTITY_LOCKED" });
    await expect(
      service.saveSettings({ ...input, syncIntervalSeconds: 60 })
    ).resolves.toMatchObject({ identityLocked: true, syncIntervalSeconds: 60 });
  });

  it("凭据只写固定私有文件，配置与返回结果均不包含令牌正文", async () => {
    configure();
    const service = new MemoryAdminService({ config, worker });
    const token = "sensitive_token.abC-123==";
    const result = await service.saveCredential(token);
    const tokenPath = join(directory, "secrets/xiaozhi-history-token");
    expect(result).toEqual({ configured: true });
    expect(readFileSync(tokenPath, "utf8")).toBe(token);
    if (process.platform !== "win32") {
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(directory, "secrets")).mode & 0o777).toBe(0o700);
    }
    expect(
      JSON.stringify([result, appConfig, service.getSettings()])
    ).not.toContain(token);
    expect(service.getSettings()).toMatchObject({
      tokenConfigured: true,
      restartRequired: true,
    });
    await expect(
      service.saveCredential("Bearer token with spaces")
    ).rejects.toMatchObject({ code: "MEMORY_INVALID_CREDENTIAL" });
  });

  it("拒绝凭据目录的符号链接或目录联接", async () => {
    configure();
    const service = new MemoryAdminService({ config, worker });
    const outside = join(directory, "outside");
    mkdirSync(outside);
    symlinkSync(
      outside,
      join(directory, "secrets"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await expect(service.saveCredential("token123")).rejects.toMatchObject({
      code: "MEMORY_UNSAFE_DIRECTORY",
    });
  });

  it("拒绝凭据目标文件的符号链接（Windows 需要符号链接权限）", async (context) => {
    configure();
    const service = new MemoryAdminService({ config, worker });
    const outside = join(directory, "outside");
    mkdirSync(outside);
    mkdirSync(join(directory, "secrets"));
    writeFileSync(join(outside, "target"), "unchanged");
    try {
      symlinkSync(
        join(outside, "target"),
        join(directory, "secrets/xiaozhi-history-token"),
        "file"
      );
    } catch (error) {
      if (
        process.platform === "win32" &&
        (error as NodeJS.ErrnoException).code === "EPERM"
      ) {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(service.saveCredential("token123")).rejects.toMatchObject({
      code: "MEMORY_UNSAFE_CREDENTIAL_FILE",
    });
    expect(readFileSync(join(outside, "target"), "utf8")).toBe("unchanged");
  });

  it("手动同步立即返回任务，阻止重复启动并正确映射未完成状态", async () => {
    const tokenPath = join(directory, "token");
    writeFileSync(tokenPath, "placeholder-token");
    configure({ XIAOZHI_MEMORY_TOKEN_FILE: tokenPath });
    let finish: (value: unknown) => void = () => undefined;
    worker.run = vi.fn(
      () =>
        new Promise((resolveResult) => {
          finish = resolveResult;
        })
    );
    const service = new MemoryAdminService({ config, worker });
    expect(service.startSync()).toMatchObject({
      state: "running",
      finishedAt: null,
    });
    expect(() => service.startSync()).toThrow("已有记忆管理任务正在运行");
    await expect(service.saveSettings(input)).rejects.toMatchObject({
      code: "MEMORY_BUSY",
    });
    finish({
      status: "incomplete",
      reason: "request_budget",
      message: "不得原样透出的底层正文",
    });
    await vi.waitFor(() => expect(service.getSyncJob().state).toBe("partial"));
    expect(service.getSyncJob().message).not.toContain("不得原样透出");
    expect(service.getSyncJob().finishedAt).not.toBeNull();
  });

  it("自动同步和待重启配置禁止手动同步，关闭时清理工作进程", async () => {
    const tokenPath = join(directory, "token");
    writeFileSync(tokenPath, "placeholder-token");
    configure({
      XIAOZHI_MEMORY_TOKEN_FILE: tokenPath,
      XIAOZHI_MEMORY_SYNC_INTERVAL_SECONDS: "60",
    });
    const service = new MemoryAdminService({ config, worker });
    expect(() => service.startSync()).toThrow("自动同步已开启");
    await service.saveSettings(input);
    expect(() => service.startSync()).toThrow("请先重启客户端");
    expect(worker.run).not.toHaveBeenCalled();
    service.close();
    expect(worker.close).toHaveBeenCalledOnce();
  });

  it("工作进程只使用所选服务的记忆环境，并移除继承的 Node 注入参数", async () => {
    configure({
      NODE_OPTIONS: "--require=untrusted.js",
      XIAOZHI_MEMORY_OWNER: "owner-a",
    });
    vi.stubEnv("XIAOZHI_MEMORY_AGENT_ID", "wrong-agent");
    vi.stubEnv("XIAOZHI_MEMORY_UNRELATED", "must-not-inherit");
    vi.stubEnv("NODE_OPTIONS", "--require=untrusted.js");
    const service = new MemoryAdminService({ config, worker });
    await service.execute({ action: "chats" });
    const environment = vi.mocked(worker.run).mock.calls[0][1];
    expect(environment.XIAOZHI_MEMORY_AGENT_ID).toBe("agent-a");
    expect(environment.XIAOZHI_MEMORY_OWNER).toBe("owner-a");
    expect(environment.NODE_OPTIONS).toBeUndefined();
    expect(environment.XIAOZHI_MEMORY_UNRELATED).toBeUndefined();
  });

  it("备份只生成固定目录的随机文件，禁止下载任意文件", async () => {
    configure();
    worker.run = vi.fn(async (request) => {
      if (request.action === "backup")
        writeFileSync(request.destination, "SQLite synthetic backup");
      return {};
    });
    const service = new MemoryAdminService({ config, worker });
    const backup = await service.createBackup();
    expect(backup.fileName).toMatch(
      /^memory-backup-\d{14}-[0-9a-f-]{36}\.sqlite$/u
    );
    expect(
      readFileSync(join(directory, "memory/backups", backup.fileName), "utf8")
    ).toBe("SQLite synthetic backup");
    if (process.platform !== "win32") {
      expect(
        statSync(join(directory, "memory/backups", backup.fileName)).mode &
          0o777
      ).toBe(0o600);
    }
    const download = await service.openBackup(backup.fileName);
    expect(await new Response(download.stream).text()).toBe(
      "SQLite synthetic backup"
    );
    await expect(
      service.openBackup("../../archive.sqlite")
    ).rejects.toMatchObject({ code: "MEMORY_BACKUP_NOT_FOUND" });
    await expect(
      service.openBackup(
        "memory-backup-20261113000000-11111111-1111-1111-1111-111111111111.sqlite"
      )
    ).rejects.toMatchObject({ code: "MEMORY_BACKUP_NOT_FOUND" });
  });
});

describe("记忆管理工作进程隔离", () => {
  type Child = ChildProcessByStdio<Writable, Readable, null>;
  function fakeChild(): Child {
    const child = new ChildProcess();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = null;
    vi.spyOn(child, "kill").mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    });
    return child as Child;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("固定执行当前 Node 和管理入口，不调用 shell，也不采集 stderr", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const runner = new MemoryAdminProcessRunner(spawn);
    const result = runner.run(
      { action: "status" },
      { XIAOZHI_MEMORY_AGENT_ID: "a" },
      { timeoutMs: 1000, maxBytes: 1024 }
    );
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["--experimental-sqlite", resolve("dist/memory/admin.js")],
      expect.objectContaining({
        shell: false,
        stdio: ["pipe", "pipe", "ignore"],
      })
    );
    expect((child.stdin as PassThrough).read()?.toString()).toBe(
      '{"action":"status"}'
    );
    child.stdout.emit(
      "data",
      Buffer.from('{"success":true,"data":{"counts":{}}}')
    );
    child.emit("close", 0);
    await expect(result).resolves.toEqual({ counts: {} });
  });

  it.each([
    "记忆不存在或已删除。",
    "目标记忆版本已改变，请刷新后重试。",
    "该请求涉及已删除记忆，不能重试恢复。",
  ])("删除冲突返回可操作的安全提示：%s", async (message) => {
    const child = fakeChild();
    const runner = new MemoryAdminProcessRunner(() => child);
    const result = runner.run(
      { action: "delete", id: "memory-test", revision: 1 },
      {},
      { timeoutMs: 1000, maxBytes: 1024 }
    );
    child.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ success: false, error: message }))
    );
    child.emit("close", 1);
    await expect(result).rejects.toMatchObject({
      code: "MEMORY_CONFLICT",
      message,
      status: 409,
    });
  });

  it("协议失败不会回显工作进程错误中的凭据或正文", async () => {
    const child = fakeChild();
    const runner = new MemoryAdminProcessRunner(() => child);
    const result = runner.run(
      { action: "status" },
      {},
      { timeoutMs: 1000, maxBytes: 1024 }
    );
    child.stdout.emit(
      "data",
      Buffer.from(
        '{"success":false,"error":"token=top-secret-private-content"}'
      )
    );
    child.emit("close", 1);
    await expect(result).rejects.toMatchObject({
      code: "MEMORY_WORKER_FAILED",
      message: "记忆管理操作未完成，请检查本机配置、档案状态与服务构建后重试。",
    });
  });

  it("输出超过上限即终止，完整导出明确提示 64 MiB 限制", async () => {
    const child = fakeChild();
    const runner = new MemoryAdminProcessRunner(() => child);
    const result = runner.run(
      { action: "export" },
      {},
      { timeoutMs: 1000, maxBytes: 10 }
    );
    child.stdout.emit("data", Buffer.alloc(11));
    await expect(result).rejects.toMatchObject({
      code: "MEMORY_RESULT_TOO_LARGE",
      message: "完整导出超过 64 MiB 上限，请改用 SQLite 备份。",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("超时和关闭都会终止仍在运行的工作进程", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const runner = new MemoryAdminProcessRunner(() => child);
    const result = runner.run(
      { action: "status" },
      {},
      { timeoutMs: 50, maxBytes: 1024 }
    );
    const assertion = expect(result).rejects.toMatchObject({
      code: "MEMORY_WORKER_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    const nextChild = fakeChild();
    const nextRunner = new MemoryAdminProcessRunner(() => nextChild);
    const nextResult = nextRunner.run(
      { action: "status" },
      {},
      { timeoutMs: 1000, maxBytes: 1024 }
    );
    const nextAssertion = expect(nextResult).rejects.toMatchObject({
      code: "MEMORY_WORKER_FAILED",
    });
    nextRunner.close();
    await vi.runAllTicks();
    await nextAssertion;
    expect(nextChild.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(
      nextRunner.run(
        { action: "status" },
        {},
        { timeoutMs: 1000, maxBytes: 1024 }
      )
    ).rejects.toMatchObject({ code: "MEMORY_STOPPING" });
  });
});
