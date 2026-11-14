import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readMemoryResult } from "./memory-smoke-helpers.mjs";

// 使用合成对话验证实际构建产物；不连接官方服务，不调用聊天模型。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(tmpdir(), "xiaozhi-memory-smoke-"));
const runtime = process.env.MEMORY_NODE_BINARY || process.execPath;
const configFile = join(directory, "xiaozhi.config.json");
const database = join(directory, "archive.sqlite");
const cliPath = join(root, "dist/memory/cli.js");
const env = {
  ...process.env,
  XIAOZHI_MEMORY_AGENT_ID: "smoke-agent",
  XIAOZHI_MCP_SERVICE_NAME: "memory",
  XIAOZHI_MEMORY_DB: database,
  XIAOZHI_MEMORY_CLIENT_CONFIG: configFile,
  XIAOZHI_MEMORY_SYNC_INTERVAL_SECONDS: "0",
};
delete env.XIAOZHI_MEMORY_OWNER;
delete env.XIAOZHI_MEMORY_TOKEN_FILE;
delete env.XIAOZHI_MEMORY_CHAT_START_CLAIM;
let client;
let transport;
let diagnostics = "";

function cli(args) {
  const response = spawnSync(runtime, ["--experimental-sqlite", cliPath, ...args], {
    env, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(response.status, 0, "构建后的管理命令应成功退出");
  return JSON.parse(response.stdout);
}

async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, `工具 ${name} 应调用成功`);
  return readMemoryResult(
    (arguments_) => client.callTool({ name: "memory_read_result", arguments: arguments_ }),
    response
  );
}

function admin(input) {
  const response = spawnSync(runtime, ["--experimental-sqlite", join(root, "dist/memory/admin.js")], {
    env, encoding: "utf8", timeout: 20_000, input: JSON.stringify(input),
  });
  assert.equal(response.status, 0, `管理操作 ${input.action} 应成功退出`);
  const envelope = JSON.parse(response.stdout);
  assert.equal(envelope.success, true);
  return envelope.data;
}

try {
  writeFileSync(configFile, JSON.stringify({ mcpEndpoint: "wss://api.xiaozhi.me/mcp/?token=synthetic-smoke-token" }), { mode: 0o600 });
  const content = "烟测合成对话：我希望卧室夜间保持26度。";
  const archive = join(directory, "import.json");
  writeFileSync(archive, JSON.stringify({ messages: [{
    id: "message-1", chatId: "chat-1", role: "user", content,
    createdAt: new Date(Date.now() - 60_000).toISOString(), raw: { synthetic: true },
  }] }), { mode: 0o600 });
  assert.equal(cli(["import", archive]).messages.inserted, 1);
  assert.equal(cli(["status"]).messages, 1);

  client = new Client({ name: "memory-smoke", version: "1.0.0" });
  transport = new StdioClientTransport({
    command: runtime,
    args: ["--experimental-sqlite", join(root, "dist/memory/stdio.js")],
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 11);
  const opening = await call("memory_search", {chatStart: true});
  assert.equal(opening.autoExtract, undefined);
  assert.equal(opening.source, undefined);
  assert.equal(cli(["status"]).bulkExtract.remaining, 0);
  admin({ action: "setBulkExtractEnabled", enabled: true });
  const { messages: [source] } = await call("memory_read_sources", {bulk: true});
  assert.equal(cli(["status"]).bulkExtract.remaining, 1);
  assert.equal(source.content, content);
  const input = {
    requestId: "smoke-memory-1", operation: "add", subject: { kind: "speaker" },
    facet: "卧室温度", value: "26度", conditions: "夜间", assertion: "explicit",
    sources: [{ messageId: source.sourceId, revision: source.revision, quote: content }],
    reason: "合成测试中的明确设置",
  };
  const submitted = await call("memory_submit", input);
  const retried = await call("memory_submit", input);
  assert.equal(submitted.operationId, retried.operationId);
  await call("memory_finish_sources", { sources: [{ messageId: source.sourceId, revision: source.revision }], reason: "已读完并保存合成记忆" });
  assert.equal(cli(["status"]).bulkExtract.remaining, 0);
  assert.equal(cli(["status"]).activeMemories, 1);
  const situational = await call("memory_search", { category: "situational" });
  assert.equal(situational.memories.length, 1);
  assert.equal(situational.memories[0].category, "situational");
  assert.equal((await call("memory_search", { category: "user_profile" })).memories.length, 0);
  await call("memory_save_summary", {
    requestId: "smoke-summary-1", title: "夜间温度", text: "该会话的说话人明确希望卧室夜间26度。",
    memories: [{ id: submitted.memory.id, revision: submitted.memory.revision }],
  });
  assert.equal((await call("memory_read_summaries")).summaries.length, 1);

  const turn = {
    requestId: "smoke-record-1", conversationId: "smoke-live-chat",
    role: "user", content: "  合成逐轮记录：请保留换行。\n第二行。  ",
  };
  const receipt = await call("memory_record_turn", turn);
  const duplicate = await call("memory_record_turn", turn);
  assert.equal(receipt.receiptId, duplicate.receiptId);
  assert.equal(duplicate.duplicate, true);
  assert.equal(receipt.origin, "model_reported");
  assert.equal(cli(["status"]).messages, 2);

  const backup = join(directory, "backup.sqlite");
  const exported = join(directory, "export.json");
  cli(["backup", backup]);
  cli(["export", exported]);
  const exportData = JSON.parse(readFileSync(exported, "utf8"));
  assert.equal(exportData.messages.length, 2);
  assert.ok(exportData.messages.some((message) => message.content === turn.content));
  if (process.platform !== "win32") {
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.equal(statSync(exported).mode & 0o777, 0o600);
  }
  assert.ok(!diagnostics.includes(content), "子进程日志不能包含原话");
  assert.ok(!diagnostics.includes(turn.content), "子进程日志不能包含模型提交正文");
  const retired = admin({ action: "retire", id: submitted.memory.id, revision: submitted.memory.revision, reason: "合成验收停用" });
  assert.equal((await call("memory_search", { category: "situational" })).memories.length, 0);
  admin({ action: "undo", operationId: retired.operationId });
  const restored = (await call("memory_search", { category: "situational" })).memories;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, submitted.memory.id);
  assert.equal(admin({ action: "delete", id: restored[0].id, revision: restored[0].revision }).deleted, true);
  assert.equal(cli(["status"]).memories, 0);
  assert.equal(cli(["status"]).messages, 2);
  assert.equal((await call("memory_read_summaries")).summaries.length, 0);
  assert.equal((await client.callTool({ name: "memory_submit", arguments: input })).isError, true);
  process.stdout.write("构建产物烟测通过：11个工具、字节分段续读与校验、逐轮记录与幂等回执、原文、概要、停用/撤销/删除闭环和一致性备份。\n");
} finally {
  await client?.close();
  await transport?.close();
  rmSync(directory, { recursive: true, force: true });
}
