import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkClientBinding, loadMemoryOptions } from "../config.js";
import type { MemoryOptions } from "../types.js";

function createEndpoint(agentId: unknown = 42, signature = "example-secret") {
  const payload = Buffer.from(JSON.stringify({ agentId })).toString(
    "base64url"
  );
  return `wss://api.xiaozhi.me/mcp/?token=e30.${payload}.${signature}`;
}

describe("记忆服务配置和端点隔离", () => {
  let directory: string;
  let options: MemoryOptions;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "xiaozhi-memory-config-"));
    options = {
      agentId: "42",
      databasePath: join(directory, "memory.sqlite"),
      clientConfigPath: join(directory, "xiaozhi.config.json"),
      syncIntervalSeconds: 0,
    };
    env = {
      XIAOZHI_MEMORY_AGENT_ID: options.agentId,
      XIAOZHI_MEMORY_DB: options.databasePath,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function writeEndpoints(endpoints: unknown, bom = false): void {
    writeFileSync(
      options.clientConfigPath!,
      `${bom ? "\uFEFF" : ""}${JSON.stringify({ mcpEndpoint: endpoints })}`
    );
  }

  function createBinding(initial?: string) {
    const stored = new Map<string, string>();
    if (initial !== undefined) {
      stored.set("endpoint", initial);
    }
    const bind = vi.fn((key: string, value: string) => {
      if (stored.has(key) && stored.get(key) !== value) {
        throw new Error("绑定不一致");
      }
      stored.set(key, value);
    });
    return { bind, stored };
  }

  it("默认只加载固定智能体和数据库，关闭同步且不推断户主", () => {
    expect(loadMemoryOptions(env)).toEqual({
      agentId: "42",
      databasePath: options.databasePath,
      ownerId: undefined,
      tokenFile: undefined,
      clientConfigPath: undefined,
      syncIntervalSeconds: 0,
    });
  });

  it("加载显式单人配置和绝对路径时不要求凭据文件已经存在", () => {
    const tokenFile = join(directory, "credentials.json");
    const result = loadMemoryOptions({
      ...env,
      XIAOZHI_MEMORY_OWNER: "  owner-explicit  ",
      XIAOZHI_MEMORY_TOKEN_FILE: tokenFile,
      XIAOZHI_MEMORY_CLIENT_CONFIG: options.clientConfigPath,
      XIAOZHI_MEMORY_SYNC_INTERVAL_SECONDS: "60",
    });
    expect(result).toEqual({
      ...options,
      ownerId: "owner-explicit",
      tokenFile,
      syncIntervalSeconds: 60,
    });
  });

  it("拒绝缺失或空白的智能体和数据库配置", () => {
    expect(() => loadMemoryOptions({})).toThrow("XIAOZHI_MEMORY_AGENT_ID");
    expect(() =>
      loadMemoryOptions({ ...env, XIAOZHI_MEMORY_AGENT_ID: "  " })
    ).toThrow("XIAOZHI_MEMORY_AGENT_ID");
    expect(() => loadMemoryOptions({ XIAOZHI_MEMORY_AGENT_ID: "42" })).toThrow(
      "XIAOZHI_MEMORY_DB"
    );
  });

  it("拒绝标识中的控制字符并保留显式字符串智能体标识", () => {
    expect(() =>
      loadMemoryOptions({ ...env, XIAOZHI_MEMORY_OWNER: "owner\0invalid" })
    ).toThrow("有效标识");
    expect(
      loadMemoryOptions({ ...env, XIAOZHI_MEMORY_AGENT_ID: "agent-a" }).agentId
    ).toBe("agent-a");
  });

  it.each([
    "XIAOZHI_MEMORY_DB",
    "XIAOZHI_MEMORY_TOKEN_FILE",
    "XIAOZHI_MEMORY_CLIENT_CONFIG",
  ])("拒绝 %s 中的相对路径", (name) => {
    expect(() =>
      loadMemoryOptions({ ...env, [name]: "./private.json" })
    ).toThrow("绝对路径");
  });

  it.each([
    "-1",
    "1",
    "59",
    "60.5",
    "Infinity",
    "abc",
    "2147484",
    "9007199254740992",
  ])("拒绝无效同步间隔 %s", (interval) => {
    expect(() =>
      loadMemoryOptions({
        ...env,
        XIAOZHI_MEMORY_SYNC_INTERVAL_SECONDS: interval,
      })
    ).toThrow("至少 60");
  });

  it("接受不会溢出定时器的最大同步间隔", () => {
    expect(
      loadMemoryOptions({
        ...env,
        XIAOZHI_MEMORY_SYNC_INTERVAL_SECONDS: "2147483",
      }).syncIntervalSeconds
    ).toBe(2_147_483);
  });

  it("将空白的可选配置视为关闭，并接受显式关闭同步", () => {
    const result = loadMemoryOptions({
      ...env,
      XIAOZHI_MEMORY_OWNER: " ",
      XIAOZHI_MEMORY_TOKEN_FILE: " ",
      XIAOZHI_MEMORY_CLIENT_CONFIG: " ",
      XIAOZHI_MEMORY_SYNC_INTERVAL_SECONDS: "0",
    });
    expect(result.ownerId).toBeUndefined();
    expect(result.tokenFile).toBeUndefined();
    expect(result.clientConfigPath).toBeUndefined();
    expect(result.syncIntervalSeconds).toBe(0);
  });

  it("从含 BOM 的文件建立非空指纹并允许相同绑定重复校验", () => {
    const endpoint = createEndpoint();
    const { bind, stored } = createBinding();
    writeEndpoints(endpoint, true);

    checkClientBinding(options, bind);
    checkClientBinding(options, bind);

    const fingerprint = createHash("sha256").update(endpoint).digest("hex");
    expect(bind).toHaveBeenCalledTimes(2);
    expect(bind).toHaveBeenCalledWith("endpoint", fingerprint);
    expect(stored.get("endpoint")).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored.get("endpoint")).not.toContain("example-secret");
  });

  it("每次读盘，拒绝同一智能体的令牌被替换后复用旧绑定", () => {
    const { bind, stored } = createBinding();
    writeEndpoints(createEndpoint());
    checkClientBinding(options, bind);
    const original = stored.get("endpoint");

    writeEndpoints(createEndpoint(42, "rotated-secret"));
    expect(() => checkClientBinding(options, bind)).toThrow("重新绑定");
    expect(stored.get("endpoint")).toBe(original);
  });

  it("没有智能体声明的已有端点也只能固定到首次绑定的地址", () => {
    const { bind } = createBinding();
    writeEndpoints("wss://private.example/mcp?token=opaque-first");
    checkClientBinding(options, bind);

    writeEndpoints("wss://another.example/mcp?token=opaque-second");
    expect(() => checkClientBinding(options, bind)).toThrow("重新绑定");
  });

  it("配置动态增加第二个端点时在调用绑定前拒绝", () => {
    const { bind } = createBinding();
    writeEndpoints(createEndpoint());
    checkClientBinding(options, bind);

    writeEndpoints([createEndpoint(), createEndpoint(43)]);
    expect(() => checkClientBinding(options, bind)).toThrow("恰好一个端点");
    expect(bind).toHaveBeenCalledTimes(1);
  });

  it("允许数组中的唯一非空端点", () => {
    const { bind } = createBinding();
    writeEndpoints([" ", createEndpoint(), ""]);
    expect(() => checkClientBinding(options, bind)).not.toThrow();
    expect(bind).toHaveBeenCalledTimes(1);
  });

  it.each(["", "  ", [], ["", " "]])("拒绝没有有效端点的配置 %#", (value) => {
    const { bind } = createBinding();
    writeEndpoints(value);
    expect(() => checkClientBinding(options, bind)).toThrow("恰好一个端点");
    expect(bind).not.toHaveBeenCalled();
  });

  it.each([null, 42, {}, [createEndpoint(), null]])(
    "拒绝端点字段类型错误的配置 %#",
    (value) => {
      const { bind } = createBinding();
      writeEndpoints(value);
      expect(() => checkClientBinding(options, bind)).toThrow("字符串");
      expect(bind).not.toHaveBeenCalled();
    }
  );

  it.each([43, "43", null, {}, 1.5])(
    "拒绝令牌中的智能体不匹配或标识无效 %#",
    (agentId) => {
      const { bind } = createBinding();
      writeEndpoints(createEndpoint(agentId));
      expect(() => checkClientBinding(options, bind)).toThrow("智能体");
      expect(bind).not.toHaveBeenCalled();
    }
  );

  it("接受令牌中与配置一致的字符串智能体标识", () => {
    const { bind } = createBinding();
    writeEndpoints(createEndpoint("42"));
    expect(() => checkClientBinding(options, bind)).not.toThrow();
  });

  it.each([
    "ws://api.xiaozhi.me/mcp",
    "https://api.xiaozhi.me/mcp",
    "wss://user:private-password@api.xiaozhi.me/mcp",
    "wss://api.xiaozhi.me/mcp#private-fragment",
    "wss://api.xiaozhi.me/mcp?token=first&token=second",
    "invalid-private-address",
  ])("拒绝不安全或有歧义的端点地址 %#", (endpoint) => {
    const { bind } = createBinding();
    writeEndpoints(endpoint);
    expect(() => checkClientBinding(options, bind)).toThrow();
    expect(bind).not.toHaveBeenCalled();
  });

  it("拒绝缺失、相对或不存在的客户端配置路径", () => {
    const { bind } = createBinding();
    expect(() =>
      checkClientBinding({ ...options, clientConfigPath: undefined }, bind)
    ).toThrow("绝对路径");
    expect(() =>
      checkClientBinding(
        { ...options, clientConfigPath: "./config.json" },
        bind
      )
    ).toThrow("绝对路径");
    expect(() => checkClientBinding(options, bind)).toThrow("无法读取");
    expect(bind).not.toHaveBeenCalled();
  });

  it("配置删除后不回退到其它配置或旧缓存", () => {
    const { bind } = createBinding();
    writeEndpoints(createEndpoint());
    checkClientBinding(options, bind);
    rmSync(options.clientConfigPath!);

    expect(() => checkClientBinding(options, bind)).toThrow("无法读取");
    expect(bind).toHaveBeenCalledTimes(1);
  });

  it("拒绝非文件路径和非对象的 JSON 配置", () => {
    const { bind } = createBinding();
    expect(() =>
      checkClientBinding({ ...options, clientConfigPath: directory }, bind)
    ).toThrow("无法读取");
    writeFileSync(options.clientConfigPath!, "[]");
    expect(() => checkClientBinding(options, bind)).toThrow("JSON 对象");
    expect(bind).not.toHaveBeenCalled();
  });

  it("已存在的空指纹必须拒绝，不能当作首次绑定", () => {
    const { bind, stored } = createBinding("");
    writeEndpoints(createEndpoint());
    expect(() => checkClientBinding(options, bind)).toThrow("重新绑定");
    expect(stored.get("endpoint")).toBe("");
  });

  it("加载配置和错误处理不会输出凭据或底层异常内容", () => {
    const secret = "private-credential-never-print";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bind } = createBinding();

    expect(() =>
      loadMemoryOptions({ ...env, XIAOZHI_MEMORY_TOKEN_FILE: secret })
    ).toThrow("绝对路径");
    writeFileSync(options.clientConfigPath!, `{ "token": "${secret}"`);
    expect(() => checkClientBinding(options, bind)).toThrow(
      "无法读取有效的客户端 JSON 配置文件，请在本机检查配置。"
    );
    writeEndpoints(createEndpoint(42, secret));
    expect(() =>
      checkClientBinding(options, () => {
        throw new Error(secret);
      })
    ).toThrow(
      "无法核对记忆库的端点绑定，请由本机管理员检查；更换端点后需要重新绑定。"
    );
    for (const spy of [log, debug, warn, error]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
