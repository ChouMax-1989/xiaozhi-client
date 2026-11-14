import {
  type ChildProcessByStdio,
  type SpawnOptionsWithStdioTuple,
  spawn,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  type AppConfig,
  type MCPServerConfig,
  configManager,
} from "../../config/index.js";
import { checkClientBinding } from "../../memory/config.js";
import {
  MEMORY_EXTRACTION_RULES,
  memoryRolePrompt,
} from "../../memory/prompts.js";
import type {
  MemoryAdminCounts,
  MemoryAdminOverview,
  MemoryAdminRequest,
  MemoryAdminSettings,
  MemorySettingsInput,
  MemorySyncJob,
} from "../../types/memory-admin.js";

const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MEMORY_ENV_KEYS = [
  "XIAOZHI_MEMORY_AGENT_ID",
  "XIAOZHI_MEMORY_OWNER",
  "XIAOZHI_MEMORY_DB",
  "XIAOZHI_MEMORY_TOKEN_FILE",
  "XIAOZHI_MEMORY_CLIENT_CONFIG",
  "XIAOZHI_MEMORY_SYNC_INTERVAL_SECONDS",
  "XIAOZHI_MEMORY_SYNC_MAX_REQUESTS",
] as const;
const BACKUP_NAME = /^memory-backup-\d{14}-[0-9a-f-]{36}\.sqlite$/u;
const WORKER_FAILURE =
  "记忆管理操作未完成，请检查本机配置、档案状态与服务构建后重试。";

const identifier = z
  .string()
  .trim()
  .max(200)
  .refine((v) => !/\p{Cc}/u.test(v));
export const memorySettingsSchema = z
  .object({
    agentId: identifier.min(1),
    ownerId: identifier,
    syncIntervalSeconds: z
      .number()
      .int()
      .min(0)
      .max(2_147_483)
      .refine((v) => v === 0 || v >= 60),
    syncMaxRequests: z.number().int().min(1).max(1_000),
  })
  .strict();

export const memoryCredentialSchema = z
  .object({
    token: z
      .string()
      .trim()
      .min(1)
      .max(16_384)
      .regex(/^[A-Za-z0-9._~+/-]+=*$/u),
  })
  .strict();

/** 仅这个错误类型允许携带已审核的中文提示；底层错误不会直接发送给网页。 */
export class MemoryAdminError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "MemoryAdminError";
  }
}

interface MemoryConfigAccess {
  getConfig(): Readonly<AppConfig>;
  getConfigDir(): string;
  getConfigPath(): string;
  updateMcpServer(name: string, config: MCPServerConfig): void;
}

interface WorkerLimits {
  timeoutMs: number;
  maxBytes: number;
}

export interface MemoryAdminWorkerRunner {
  run(
    request: MemoryAdminRequest,
    env: NodeJS.ProcessEnv,
    limits: WorkerLimits
  ): Promise<unknown>;
  close(): void;
}

type WorkerChild = ChildProcessByStdio<Writable, Readable, null>;
type SpawnWorker = (
  command: string,
  args: string[],
  options: SpawnOptionsWithStdioTuple<"pipe", "pipe", "ignore">
) => WorkerChild;

/** 从当前程序位置定位固定入口，不使用请求、配置命令或当前工作目录作为入口。 */
function memoryEntry(file: "admin.js" | "stdio.js"): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 7; depth++) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8")
      ) as { name?: unknown };
      if (manifest.name === "xiaozhi-client") {
        return join(directory, "dist", "memory", file);
      }
    } catch {
      // 只检查程序所在目录的祖先，不向用户返回文件内容或解析错误。
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new MemoryAdminError("MEMORY_ENTRY_MISSING", WORKER_FAILURE, 503);
}

const SAFE_WORKER_ERRORS = new Set([
  "记忆不存在或已删除。",
  "目标记忆版本已改变，请刷新后重试。",
  "该请求涉及已删除记忆，不能重试恢复。",
  "目标记忆不存在或版本已改变，请刷新后重试。",
  "这条记忆已不再生效，无需重复停用。",
  "该操作不存在或不支持撤销",
  "记忆已有后续修改，不能覆盖后续操作",
  "来源不存在或已经修改，请重新读取原文",
  "来源版本已改变，请重新提炼",
  "页码超出有效范围，请重新选择页码。",
  "客户端端点的智能体与记忆库配置不一致，已拒绝访问。",
  "无法核对记忆库的端点绑定，请由本机管理员检查；更换端点后需要重新绑定。",
]);

/** 普通 WebServer 不导入 SQLite；每次管理操作由受限的短进程完成。 */
export class MemoryAdminProcessRunner implements MemoryAdminWorkerRunner {
  private children = new Set<WorkerChild>();
  private closed = false;

  constructor(
    private readonly spawnWorker: SpawnWorker = (command, args, options) =>
      spawn(command, args, options)
  ) {}

  async run(
    request: MemoryAdminRequest,
    env: NodeJS.ProcessEnv,
    limits: WorkerLimits
  ): Promise<unknown> {
    if (this.closed) {
      throw new MemoryAdminError(
        "MEMORY_STOPPING",
        "记忆管理服务正在关闭。",
        503
      );
    }
    if (this.children.size >= 8) {
      throw new MemoryAdminError(
        "MEMORY_BUSY",
        "记忆管理请求较多，请稍后重试。",
        429
      );
    }
    const entry = memoryEntry("admin.js");
    return new Promise((resolveResult, reject) => {
      let child: WorkerChild;
      try {
        child = this.spawnWorker(
          process.execPath,
          ["--experimental-sqlite", entry],
          { env, shell: false, stdio: ["pipe", "pipe", "ignore"] }
        );
      } catch {
        reject(
          new MemoryAdminError("MEMORY_WORKER_FAILED", WORKER_FAILURE, 503)
        );
        return;
      }
      this.children.add(child);
      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;
      const fail = (error: MemoryAdminError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(
          new MemoryAdminError(
            "MEMORY_WORKER_TIMEOUT",
            "记忆管理操作超时，已停止本次任务；已保存的数据仍保留。",
            504
          )
        );
      }, limits.timeoutMs);
      timer.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        received += chunk.length;
        if (received > limits.maxBytes) {
          fail(
            new MemoryAdminError(
              "MEMORY_RESULT_TOO_LARGE",
              request.action === "export"
                ? "完整导出超过 64 MiB 上限，请改用 SQLite 备份。"
                : "查询结果超过 8 MiB 上限，请缩小分页或查询范围。",
              413
            )
          );
          return;
        }
        chunks.push(chunk);
      });
      child.on("error", () => {
        this.children.delete(child);
        fail(new MemoryAdminError("MEMORY_WORKER_FAILED", WORKER_FAILURE, 503));
      });
      child.stdin.on("error", () => {
        fail(new MemoryAdminError("MEMORY_WORKER_FAILED", WORKER_FAILURE, 503));
      });
      child.on("close", (code) => {
        this.children.delete(child);
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        try {
          const result: unknown = JSON.parse(
            Buffer.concat(chunks).toString("utf8")
          );
          if (!result || typeof result !== "object" || Array.isArray(result))
            throw new Error();
          const envelope = result as Record<string, unknown>;
          if (
            code === 0 &&
            envelope.success === true &&
            Object.hasOwn(envelope, "data")
          ) {
            resolveResult(envelope.data);
            return;
          }
          if (
            envelope.success === false &&
            typeof envelope.error === "string" &&
            SAFE_WORKER_ERRORS.has(envelope.error)
          ) {
            reject(
              new MemoryAdminError("MEMORY_CONFLICT", envelope.error, 409)
            );
            return;
          }
        } catch {
          // stdout、stderr 和异常对象均可能含正文或凭据，不记录或回显。
        }
        reject(
          new MemoryAdminError("MEMORY_WORKER_FAILED", WORKER_FAILURE, 503)
        );
      });
      child.stdin.end(JSON.stringify(request));
    });
  }

  close(): void {
    this.closed = true;
    for (const child of this.children) child.kill("SIGKILL");
  }
}

interface MemoryServiceConfiguration {
  name: string;
  existing?: MCPServerConfig;
  env: Record<string, string>;
}

interface MemoryAdminServiceOptions {
  config?: MemoryConfigAccess;
  worker?: MemoryAdminWorkerRunner;
}

type RuntimeMemoryConfiguration = Readonly<
  Pick<AppConfig, "mcpServers" | "mcpEndpoint">
>;

/** 配置和凭据由管理控制台处理，模型可用的 MCP 工具不注册这些管理操作。 */
export class MemoryAdminService {
  private readonly config: MemoryConfigAccess;
  private readonly worker: MemoryAdminWorkerRunner;
  private initialSignature: string | null | undefined;
  private changed = false;
  private mutationRunning = false;
  private closed = false;
  private backupFiles = new Set<string>();
  private syncJob: MemorySyncJob = {
    state: "idle",
    startedAt: null,
    finishedAt: null,
    message: null,
  };

  constructor(options: MemoryAdminServiceOptions = {}) {
    this.config = options.config ?? configManager;
    this.worker = options.worker ?? new MemoryAdminProcessRunner();
  }

  /** 启动配置清理并加载后记录实际快照；后续调用不能抹掉待重启状态。 */
  captureRuntimeConfiguration(
    configuration: RuntimeMemoryConfiguration | null
  ): void {
    if (this.closed || this.initialSignature !== undefined) return;
    try {
      this.initialSignature = configuration
        ? this.configurationSignature(configuration)
        : null;
    } catch {
      this.initialSignature = null;
    }
  }

  private readConfiguration(
    configuration: RuntimeMemoryConfiguration = this.config.getConfig()
  ): MemoryServiceConfiguration {
    const servers = configuration.mcpServers;
    const candidates = Object.entries(servers).filter(
      ([, value]) =>
        "env" in value &&
        value.env &&
        MEMORY_ENV_KEYS.some((key) => Object.hasOwn(value.env!, key))
    );
    if (candidates.length > 1) {
      throw new MemoryAdminError(
        "MEMORY_MULTIPLE_SERVICES",
        "检测到多个记忆服务，请在本机配置中只保留一个。",
        409
      );
    }
    if (candidates.length === 1) {
      const [name, existing] = candidates[0];
      return {
        name,
        existing,
        env: "env" in existing ? { ...existing.env } : {},
      };
    }
    if (Object.hasOwn(servers, "memory")) {
      throw new MemoryAdminError(
        "MEMORY_NAME_CONFLICT",
        "memory 服务名已被其他配置占用，请先在本机处理，网页不会覆盖。",
        409
      );
    }
    return { name: "memory", env: {} };
  }

  private configurationSignature(
    configuration: RuntimeMemoryConfiguration
  ): string {
    const config = this.readConfiguration(configuration);
    return createHash("sha256")
      .update(
        JSON.stringify({
          ...config,
          endpoint: configuration.mcpEndpoint,
        })
      )
      .digest("hex");
  }

  private assertSingleEndpoint(): void {
    const value = this.config.getConfig().mcpEndpoint;
    const endpoints = (Array.isArray(value) ? value : [value]).filter(
      (endpoint) => endpoint?.trim()
    );
    if (endpoints.length !== 1) {
      throw new MemoryAdminError(
        "MEMORY_SINGLE_ENDPOINT_REQUIRED",
        "记忆库仅支持单智能体独立实例，请先配置恰好一个小智接入点。",
        409
      );
    }
    try {
      const endpoint = new URL(endpoints[0]);
      if (
        endpoint.protocol !== "wss:" ||
        !endpoint.hostname ||
        endpoint.username ||
        endpoint.password ||
        endpoint.hash ||
        endpoint.searchParams.getAll("token").length > 1
      )
        throw new Error();
    } catch {
      throw new MemoryAdminError(
        "MEMORY_INVALID_ENDPOINT",
        "请先配置有效且无歧义的 WSS 小智接入点。",
        409
      );
    }
  }

  private assertStandardCommand(
    configuration: MemoryServiceConfiguration
  ): void {
    const existing = configuration.existing;
    if (!existing) return;
    let standard = false;
    if ("command" in existing && Array.isArray(existing.args)) {
      let validNode =
        existing.command === "node" || existing.command === process.execPath;
      if (!validNode && isAbsolute(existing.command)) {
        try {
          validNode =
            realpathSync(existing.command) === realpathSync(process.execPath);
        } catch {
          /* 只接受已确认的当前 Node 可执行文件。 */
        }
      }
      standard =
        validNode &&
        existing.args.length === 2 &&
        existing.args[0] === "--experimental-sqlite" &&
        isAbsolute(existing.args[1]) &&
        resolve(existing.args[1]) === memoryEntry("stdio.js");
    }
    if (!standard) {
      throw new MemoryAdminError(
        "MEMORY_CUSTOM_COMMAND",
        "现有记忆服务使用自定义启动命令，请在本机配置中调整，网页不会覆盖。",
        409
      );
    }
  }

  getSettings(): MemoryAdminSettings {
    const loaded = this.config.getConfig();
    const configuration = this.readConfiguration(loaded);
    const currentSignature = this.configurationSignature(loaded);
    // 独立注入使用时可在首次读取建立基线；WebServer 已在加载配置后显式记录。
    if (!this.closed && this.initialSignature === undefined) {
      this.initialSignature = currentSignature;
    }
    const env = configuration.env;
    const databasePath =
      env.XIAOZHI_MEMORY_DB?.trim() ||
      join(resolve(this.config.getConfigDir()), "memory", "archive.sqlite");
    if (!isAbsolute(databasePath) || databasePath.includes("\0")) {
      throw new MemoryAdminError(
        "MEMORY_INVALID_CONFIGURATION",
        "记忆数据库必须在本机配置中使用有效的绝对路径。",
        409
      );
    }
    const input = memorySettingsSchema.safeParse({
      agentId: env.XIAOZHI_MEMORY_AGENT_ID?.trim() || "",
      ownerId: env.XIAOZHI_MEMORY_OWNER?.trim() || "",
      syncIntervalSeconds: Number(
        env.XIAOZHI_MEMORY_SYNC_INTERVAL_SECONDS?.trim() || "0"
      ),
      syncMaxRequests: Number(
        env.XIAOZHI_MEMORY_SYNC_MAX_REQUESTS?.trim() || "20"
      ),
    });
    if (configuration.existing && !input.success) {
      throw new MemoryAdminError(
        "MEMORY_INVALID_CONFIGURATION",
        "现有记忆服务配置不完整或格式无效，请先检查本机配置。",
        409
      );
    }
    let tokenConfigured = false;
    const tokenFile = env.XIAOZHI_MEMORY_TOKEN_FILE;
    if (tokenFile && isAbsolute(tokenFile) && !tokenFile.includes("\0")) {
      try {
        const file = statSync(tokenFile);
        tokenConfigured = file.isFile() && file.size > 0;
      } catch {
        /* 只报告配置状态，不读取或泄露凭据。 */
      }
    }
    return {
      configured: Boolean(configuration.existing),
      serviceName: configuration.name,
      ...(input.success
        ? input.data
        : {
            agentId: "",
            ownerId: "",
            syncIntervalSeconds: 0,
            syncMaxRequests: 20,
          }),
      databasePath: resolve(databasePath),
      tokenConfigured,
      identityLocked: existsSync(databasePath),
      restartRequired:
        this.changed || this.initialSignature !== currentSignature,
      containerMode: process.env.XIAOZHI_CONTAINER === "true",
    };
  }

  async getOverview(): Promise<MemoryAdminOverview> {
    const settings = this.getSettings();
    const overview: MemoryAdminOverview = {
      settings,
      ready: false,
      error: null,
      counts: null,
      status: null,
      sync: null,
      syncJob: this.getSyncJob(),
      extractionPrompt: MEMORY_EXTRACTION_RULES,
      recordingPrompt: memoryRolePrompt(settings.serviceName),
    };
    if (!overview.settings.configured) return overview;
    try {
      const status = (await this.execute({ action: "status" })) as {
        counts: MemoryAdminCounts;
        autoExtractEnabled: boolean;
        bulkExtract?: { active: boolean; total: number; remaining: number };
        sync: Record<string, unknown> | null;
      };
      overview.counts = status.counts;
      overview.status = {
        autoExtractEnabled: status.autoExtractEnabled,
        bulkExtract: status.bulkExtract ?? {
          active: false,
          total: 0,
          remaining: 0,
        },
      };
      overview.sync = status.sync;
      overview.ready = true;
      overview.settings = this.getSettings();
    } catch (error) {
      overview.error =
        error instanceof MemoryAdminError ? error.message : WORKER_FAILURE;
    }
    overview.syncJob = this.getSyncJob();
    return overview;
  }

  private async mutate<T>(work: () => Promise<T> | T): Promise<T> {
    if (this.closed)
      throw new MemoryAdminError(
        "MEMORY_STOPPING",
        "记忆管理服务正在关闭。",
        503
      );
    if (this.mutationRunning || this.syncJob.state === "running") {
      throw new MemoryAdminError(
        "MEMORY_BUSY",
        "记忆管理任务正在运行，请完成后重试。",
        409
      );
    }
    this.mutationRunning = true;
    try {
      return await work();
    } finally {
      this.mutationRunning = false;
    }
  }

  async saveSettings(input: MemorySettingsInput): Promise<MemoryAdminSettings> {
    return this.mutate(() => {
      const parsed = memorySettingsSchema.safeParse(input);
      if (!parsed.success)
        throw new MemoryAdminError(
          "MEMORY_INVALID_SETTINGS",
          "记忆设置格式无效，请检查身份、同步间隔和请求预算。"
        );
      this.assertSingleEndpoint();
      const configuration = this.readConfiguration();
      this.assertStandardCommand(configuration);
      const current = this.getSettings();
      if (
        current.identityLocked &&
        (parsed.data.agentId !== current.agentId ||
          parsed.data.ownerId !== current.ownerId)
      ) {
        throw new MemoryAdminError(
          "MEMORY_IDENTITY_LOCKED",
          "已有数据库的智能体与人物身份已锁定，网页不能修改。",
          409
        );
      }
      const env = {
        ...configuration.env,
        XIAOZHI_MEMORY_AGENT_ID: parsed.data.agentId,
        XIAOZHI_MEMORY_OWNER: parsed.data.ownerId,
        XIAOZHI_MEMORY_DB: current.databasePath,
        XIAOZHI_MEMORY_CLIENT_CONFIG:
          configuration.env.XIAOZHI_MEMORY_CLIENT_CONFIG ||
          resolve(this.config.getConfigPath()),
        XIAOZHI_MEMORY_SYNC_INTERVAL_SECONDS: String(
          parsed.data.syncIntervalSeconds
        ),
        XIAOZHI_MEMORY_SYNC_MAX_REQUESTS: String(parsed.data.syncMaxRequests),
      };
      // 首次保存前先校验候选身份，避免错误身份触发空库创建后被永久锁定。
      try {
        checkClientBinding(
          {
            agentId: parsed.data.agentId,
            ownerId: parsed.data.ownerId || undefined,
            databasePath: current.databasePath,
            clientConfigPath: env.XIAOZHI_MEMORY_CLIENT_CONFIG,
            syncIntervalSeconds: parsed.data.syncIntervalSeconds,
          },
          () => undefined
        );
      } catch (error) {
        throw new MemoryAdminError(
          "MEMORY_BINDING_REJECTED",
          error instanceof Error &&
            error.message ===
              "客户端端点的智能体与记忆库配置不一致，已拒绝访问。"
            ? "客户端端点的智能体与记忆库配置不一致，已拒绝访问。"
            : "无法核对记忆库身份与客户端配置文件，请在本机检查单端点配置后重试。",
          409
        );
      }
      this.config.updateMcpServer(configuration.name, {
        ...(configuration.existing && "command" in configuration.existing
          ? configuration.existing
          : {
              command: process.execPath,
              args: ["--experimental-sqlite", memoryEntry("stdio.js")],
            }),
        env,
      });
      this.changed = true;
      return this.getSettings();
    });
  }

  /** 私有目录逐级创建并拒绝符号链接，HTTP 请求不能选择路径。 */
  private async privateDirectory(parts: string[]): Promise<string> {
    let directory = realpathSync(resolve(this.config.getConfigDir()));
    for (const part of parts) {
      directory = join(directory, part);
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
      }
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new MemoryAdminError(
          "MEMORY_UNSAFE_DIRECTORY",
          "记忆管理目录必须是本机普通目录，不能使用符号链接。",
          409
        );
      }
      await chmod(directory, 0o700);
    }
    return directory;
  }

  async saveCredential(token: string): Promise<{ configured: true }> {
    return this.mutate(async () => {
      const parsed = memoryCredentialSchema.safeParse({ token });
      if (!parsed.success)
        throw new MemoryAdminError(
          "MEMORY_INVALID_CREDENTIAL",
          "凭据格式无效，请使用官方历史接口允许的令牌，长度不能超过 16384 个字符。"
        );
      this.assertSingleEndpoint();
      const configuration = this.readConfiguration();
      if (!configuration.existing)
        throw new MemoryAdminError(
          "MEMORY_NOT_CONFIGURED",
          "请先保存记忆库设置。",
          409
        );
      this.assertStandardCommand(configuration);
      const directory = await this.privateDirectory(["secrets"]);
      const destination = join(directory, "xiaozhi-history-token");
      if (existsSync(destination)) {
        const file = lstatSync(destination);
        if (!file.isFile() || file.isSymbolicLink())
          throw new MemoryAdminError(
            "MEMORY_UNSAFE_CREDENTIAL_FILE",
            "凭据目标必须是普通文件，不能使用符号链接。",
            409
          );
      }
      const temporary = join(directory, `.history-token-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(parsed.data.token, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, destination);
        this.config.updateMcpServer(configuration.name, {
          ...(configuration.existing as Extract<
            MCPServerConfig,
            { command: string }
          >),
          env: { ...configuration.env, XIAOZHI_MEMORY_TOKEN_FILE: destination },
        });
        this.changed = true;
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
      return { configured: true };
    });
  }

  private workerEnvironment(): NodeJS.ProcessEnv {
    this.assertSingleEndpoint();
    const settings = this.getSettings();
    if (!settings.configured)
      throw new MemoryAdminError(
        "MEMORY_NOT_CONFIGURED",
        "请先保存记忆库设置。",
        409
      );
    const configuration = this.readConfiguration();
    const env = { ...process.env };
    // 防止继承另一实例的记忆环境或 Node 注入参数；仅接受所选服务的固定字段。
    for (const key of Object.keys(env)) {
      if (key.startsWith("XIAOZHI_MEMORY_") || key === "NODE_OPTIONS")
        delete env[key];
    }
    for (const key of MEMORY_ENV_KEYS) {
      if (configuration.env[key] !== undefined)
        env[key] = configuration.env[key];
    }
    return env;
  }

  async execute(request: MemoryAdminRequest): Promise<unknown> {
    if (this.closed)
      throw new MemoryAdminError(
        "MEMORY_STOPPING",
        "记忆管理服务正在关闭。",
        503
      );
    return this.worker.run(request, this.workerEnvironment(), {
      timeoutMs:
        request.action === "sync"
          ? Math.min(600_000, 30_000 + request.maxRequests * 15_000)
          : 30_000,
      maxBytes:
        request.action === "export" ? MAX_EXPORT_BYTES : MAX_RESULT_BYTES,
    });
  }

  getSyncJob(): MemorySyncJob {
    return { ...this.syncJob };
  }

  startSync(): MemorySyncJob {
    if (
      this.closed ||
      this.mutationRunning ||
      this.syncJob.state === "running"
    ) {
      throw new MemoryAdminError(
        "MEMORY_BUSY",
        "已有记忆管理任务正在运行，请勿重复启动。",
        409
      );
    }
    const settings = this.getSettings();
    if (!settings.configured)
      throw new MemoryAdminError(
        "MEMORY_NOT_CONFIGURED",
        "请先保存记忆库设置。",
        409
      );
    if (settings.restartRequired)
      throw new MemoryAdminError(
        "MEMORY_RESTART_REQUIRED",
        "配置已保存，请先重启客户端使配置生效，再手动同步。",
        409
      );
    if (settings.syncIntervalSeconds > 0)
      throw new MemoryAdminError(
        "MEMORY_AUTOMATIC_SYNC_ENABLED",
        "自动同步已开启，为避免重复任务，网页手动同步暂不可用；关闭自动同步并重启后可手动同步。",
        409
      );
    if (!settings.tokenConfigured)
      throw new MemoryAdminError(
        "MEMORY_CREDENTIAL_REQUIRED",
        "请先配置官方历史接口凭据。",
        409
      );
    this.assertSingleEndpoint();
    this.syncJob = {
      state: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      message: "正在同步官方历史；记忆提炼仍需小智现有聊天模型调用工具。",
    };
    void this.execute({ action: "sync", maxRequests: settings.syncMaxRequests })
      .then((value) => {
        if (this.closed) return;
        const result =
          value && typeof value === "object"
            ? (value as Record<string, unknown>)
            : {};
        const state =
          result.status === "complete"
            ? "complete"
            : result.status === "incomplete"
              ? "partial"
              : "error";
        let message =
          state === "complete"
            ? "历史同步已完成分页一致性核对；记忆提炼仍需小智现有聊天模型调用工具。"
            : state === "partial"
              ? "本轮同步未完成，已保存进度，可以继续同步；已存档内容仍可查看。"
              : "历史同步未完成，请检查凭据、网络和接口状态；已保存的档案仍保留。";
        if (result.reason === "authentication_failed")
          message = "官方历史接口认证失败，请更新凭据并重启客户端后重试。";
        if (result.reason === "rate_limited")
          message = "官方历史接口限制了请求频率，进度已保存，请稍后重试。";
        this.syncJob = {
          ...this.syncJob,
          state,
          message,
          finishedAt: new Date().toISOString(),
        };
      })
      .catch(() => {
        if (!this.closed)
          this.syncJob = {
            ...this.syncJob,
            state: "error",
            finishedAt: new Date().toISOString(),
            message:
              "本次同步未完成，已停止任务；请检查本机配置、凭据与存储状态。",
          };
      });
    return this.getSyncJob();
  }

  async createBackup(): Promise<{ fileName: string; bytes: number }> {
    return this.mutate(async () => {
      const directory = await this.privateDirectory(["memory", "backups"]);
      const stamp = new Date().toISOString().replace(/\D/gu, "").slice(0, 14);
      const fileName = `memory-backup-${stamp}-${randomUUID()}.sqlite`;
      const destination = join(directory, fileName);
      try {
        await this.execute({ action: "backup", destination });
        const file = await lstat(destination);
        if (!file.isFile() || file.isSymbolicLink()) throw new Error();
        await chmod(destination, 0o600);
        this.backupFiles.add(fileName);
        return { fileName, bytes: file.size };
      } catch (error) {
        await rm(destination, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async openBackup(
    fileName: string
  ): Promise<{ stream: ReadableStream<Uint8Array>; bytes: number }> {
    if (!BACKUP_NAME.test(fileName) || !this.backupFiles.has(fileName)) {
      throw new MemoryAdminError(
        "MEMORY_BACKUP_NOT_FOUND",
        "备份不存在，请重新创建备份。",
        404
      );
    }
    const directory = await this.privateDirectory(["memory", "backups"]);
    const file = await open(
      join(directory, fileName),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) throw new Error();
      return {
        stream: Readable.toWeb(
          file.createReadStream()
        ) as ReadableStream<Uint8Array>,
        bytes: metadata.size,
      };
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    this.worker.close();
    if (this.syncJob.state === "running") {
      this.syncJob = {
        ...this.syncJob,
        state: "error",
        finishedAt: new Date().toISOString(),
        message: "服务已关闭，本次同步已停止；已保存的数据仍保留。",
      };
    }
  }
}
