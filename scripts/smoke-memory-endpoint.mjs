// cspell:words keyout addext taskkill
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { readMemoryResult } from "./memory-smoke-helpers.mjs";

// 假云只监听回环地址；真实 WebServer、聚合器、stdio 和 SQLite，不读用户配置。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(tmpdir(), "xiaozhi-endpoint-smoke-"));
assert.ok(directory.startsWith(resolve(tmpdir()) + sep + "xiaozhi-endpoint-smoke-"));
const cert = join(directory, "test-cert.pem");
const key = join(directory, "test-key.pem");
const openssl = process.env.OPENSSL_BINARY || (process.platform === "win32" && existsSync("C:/Program Files/Git/usr/bin/openssl.exe") ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl");
let child;
let server;
let sockets;
let diagnostics = "";
const peers = [];
const sizes = {};
const responseCounts = {};
const unwanted = [];
let sequence = 0;

async function until(predicate, label, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    if (child?.exitCode != null) throw new Error(`WebServer 已退出：${child.exitCode}`);
    await delay(50);
  }
  throw new Error(`等待超时：${label}`);
}

function rpc(peer, method, params = {}) {
  const id = ++sequence;
  return new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => { peer.pending.delete(id); reject(new Error(`请求超时：${method}`)); }, 15_000);
    peer.pending.set(id, (message) => { clearTimeout(timer); resolveResponse(message); });
    peer.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

async function call(peer, name, args = {}) {
  const response = await rpc(peer, "tools/call", { name: `memory__${name}`, arguments: args });
  const bytes = Buffer.byteLength(JSON.stringify(response));
  assert.ok(bytes <= 1024, `${name}完整JSON-RPC帧超过1024字节：${bytes}`);
  sizes[name] = Math.max(sizes[name] || 0, bytes);
  responseCounts[name] = (responseCounts[name] || 0) + 1;
  return response;
}

async function value(peer, response) {
  assert.equal(response.error, undefined);
  return readMemoryResult(async (args) => {
    const next = await call(peer, "memory_read_result", args);
    assert.equal(next.error, undefined);
    return next.result;
  }, response.result);
}

const invoke = async (peer, name, args) => value(peer, await call(peer, name, args));
const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");

async function handshake(peer) {
  const response = await rpc(peer, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "synthetic-cloud", version: "1" } });
  assert.equal(response.result.protocolVersion, "2024-11-05");
  assert.equal(response.result.capabilities.tools.listChanged, false);
  peer.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  await rpc(peer, "ping");
  assert.equal(unwanted.length, 0, "通知不得产生无 id 响应");
}

try {
  const generated = spawnSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { encoding: "utf8" });
  assert.equal(generated.status, 0, "需要 OpenSSL 生成临时回环测试证书");
  server = createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key) });
  sockets = new WebSocketServer({ server });
  sockets.on("connection", (ws) => {
    const peer = { ws, pending: new Map() };
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== undefined && peer.pending.has(message.id)) {
        const receive = peer.pending.get(message.id);
        peer.pending.delete(message.id);
        receive(message);
      } else if (!message.method) unwanted.push(message);
    });
    peers.push(peer);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `wss://127.0.0.1:${server.address().port}/mcp/?token=synthetic-endpoint-secret`;
  const reservation = createNetServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const configPath = join(directory, "xiaozhi.config.json");
  const memoryEnv = {
    XIAOZHI_MEMORY_AGENT_ID: "synthetic-endpoint-agent", XIAOZHI_MEMORY_DB: join(directory, "archive.sqlite"),
    XIAOZHI_MEMORY_CLIENT_CONFIG: configPath, XIAOZHI_MEMORY_SYNC_INTERVAL_SECONDS: "0",
  };
  writeFileSync(configPath, JSON.stringify({
    mcpEndpoint: endpoint,
    mcpServers: { memory: { command: process.execPath, args: ["--experimental-sqlite", join(root, "dist/memory/stdio.js")], env: memoryEnv } }, webUI: { port }, logging: { level: "debug" },
  }));
  const archiveText = '  存档中文😀 "原文" \\\n\t e\u0301\r\n'.repeat(700);
  const archivePath = join(directory, "synthetic-import.json");
  writeFileSync(archivePath, JSON.stringify({ messages: [{ id: "archive-source", chatId: "archive-chat", role: "user", content: archiveText, createdAt: new Date(Date.now() - 60_000).toISOString(), raw: { synthetic: true } }] }));
  const imported = spawnSync(process.execPath, ["--experimental-sqlite", join(root, "dist/memory/cli.js"), "import", archivePath], { env: { ...process.env, ...memoryEnv }, encoding: "utf8" });
  assert.equal(imported.status, 0);
  child = spawn(process.execPath, [join(root, "dist/backend/WebServerLauncher.js")], { cwd: root, env: { ...process.env, XIAOZHI_CONFIG_DIR: directory, NODE_EXTRA_CA_CERTS: cert }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (chunk) => { diagnostics += chunk; });
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const peer = await until(() => peers[0], "真实应用连接回环 WSS");
  await handshake(peer);
  const listed = await rpc(peer, "tools/list");
  const names = listed.result.tools.map((tool) => tool.name);
  assert.equal(names.length, 11);
  assert.ok(names.includes("memory__memory_record_turn"));
  assert.ok(names.includes("memory__memory_read_result"));
  sizes.tools_list = Buffer.byteLength(JSON.stringify(listed));
  const api = `http://127.0.0.1:${port}`;
  async function setAutoExtract(enabled) {
    const response = await fetch(`${api}/api/memory/auto-extract`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { enabled });
  }
  const opening = () => invoke(peer, "memory_search", { chatStart: true });
  assert.ok((await opening()).source, "默认开启，新对话直接收到原文");
  await setAutoExtract(false);
  assert.equal((await opening()).autoExtract, undefined);
  await setAutoExtract(true);
  assert.ok((await opening()).autoExtract);
  assert.equal((await invoke(peer, "memory_read_sources", { automatic: true })).messages.length, 1);
  await setAutoExtract(false);
  assert.equal((await invoke(peer, "memory_read_sources", { automatic: true })).messages.length, 0);
  const bulkResponse = await fetch(`${api}/api/memory/bulk-extract`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
  assert.equal(bulkResponse.status, 200);
  assert.deepEqual((await bulkResponse.json()).data, { active: true, total: 1, remaining: 1 });
  const task = await opening();
  assert.match(task.autoExtract, /memory__memory_finish_sources/u);
  assert.equal(task.source.content, archiveText.slice(0, task.source.nextOffset));
  assert.equal(task.source.continueWith, "memory__memory_read_source");
  assert.equal((await invoke(peer, "memory_read_sources", { bulk: true })).messages.length, 1);
  await setAutoExtract(true);
  const record = { requestId: "endpoint-smoke-turn-1", conversationId: "synthetic-chat", role: "user", content: '  中文😀 e\u0301 "引号" \\ \n\t尾\r\n'.repeat(270) };
  assert.ok(record.content.length <= 8000);
  const receipt = await invoke(peer, "memory_record_turn", record);
  assert.equal((await invoke(peer, "memory_record_turn", record)).duplicate, true);
  const assistantText = '助手的合成最终回复😀\n保留 "引号" 与 \\ 路径。';
  const toolText = '{"synthetic":true,"value":"工具原始结果😀"}\n';
  await invoke(peer, "memory_record_turn", { ...record, requestId: "endpoint-smoke-assistant", role: "assistant", content: assistantText, assistantStage: "final" });
  await invoke(peer, "memory_record_turn", { ...record, requestId: "endpoint-smoke-tool", role: "tool", content: toolText });
  const conflict = await call(peer, "memory_record_turn", { ...record, content: "冲突合成文本" });
  assert.equal(conflict.result.isError, true);
  const malformed = await call(peer, "memory_record_turn", { ...record, ...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`unexpected_${i}`, "坏参数".repeat(20)])) });
  assert.ok(malformed.error || malformed.result?.isError, "非法参数必须被拒绝");
  assert.equal((await invoke(peer, "memory_status")).messages, 4);
  const expectedContents = [archiveText, record.content, assistantText, toolText];
  const sourceRows = [];
  let afterId;
  do {
    const page = await invoke(peer, "memory_read_sources", { limit: 1, ...(afterId ? { afterId } : {}) });
    assert.equal(page.messages.length, 1);
    const row = page.messages[0];
    sourceRows.push(row);
    let original = "";
    let offset = 0;
    do {
      const part = await invoke(peer, "memory_read_source", { messageId: row.sourceId, revision: row.revision, offset, length: 6000 });
      assert.equal(part.contentOffset, original.length);
      original += part.content;
      offset = part.nextOffset;
      if (offset !== null) assert.equal(offset, original.length);
      else assert.equal(original.length, part.contentLength);
    } while (offset !== null);
    assert.ok(expectedContents.includes(original), "原文须逐字还原，含空白与Unicode");
    expectedContents.splice(expectedContents.indexOf(original), 1);
    afterId = page.nextCursor;
  } while (afterId);
  assert.equal(expectedContents.length, 0);
  const source = sourceRows.find((row) => row.origin === "archive");
  assert.ok(source);
  const proposal = { requestId: "endpoint-proposal-1", operation: "add", subject: { kind: "speaker" }, facet: "preferred_name", value: "合成偏好😀".repeat(100), assertion: "explicit", sources: [{ messageId: source.sourceId, revision: source.revision, quote: archiveText.slice(0, 100) }], reason: "合成完整链路验证" };
  const submitted = await invoke(peer, "memory_submit", proposal);
  assert.equal((await invoke(peer, "memory_submit", proposal)).operationId, submitted.operationId);
  const found = await invoke(peer, "memory_search", { category: "user_profile" });
  assert.ok(found.memories.some((memory) => memory.id === submitted.memory.id && memory.value === proposal.value));
  const summaryText = "合成概要保留全部原文语义与版本。😀".repeat(100);
  await invoke(peer, "memory_save_summary", { requestId: "endpoint-summary-1", title: "合成概要", text: summaryText, memories: [{ id: submitted.memory.id, revision: submitted.memory.revision }] });
  assert.equal((await invoke(peer, "memory_read_summaries")).summaries[0].text, summaryText);
  const candidateText = "未验证合成候选😀".repeat(120);
  const captured = await invoke(peer, "memory_capture_candidate", { text: candidateText, reason: "合成候选验证" });
  assert.equal(captured.capture.text, candidateText);
  assert.equal((await invoke(peer, "memory_finish_sources", { sources: sourceRows.map((row) => ({ messageId: row.sourceId, revision: row.revision })), reason: "合成原文均已完整读取" })).processed, 4);
  assert.ok(receipt.receiptId);
  assert.deepEqual((await invoke(peer, "memory_status")).bulkExtract, { active: false, total: 1, remaining: 0 });
  assert.equal((await opening()).autoExtract, undefined);
  async function toggle(action) {
    const response = await fetch(`${api}/api/tools/mcp/manage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, serverName: "memory", toolName: "memory_record_turn" }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).success, true);
  }
  await toggle("disable");
  assert.ok(!(await rpc(peer, "tools/list")).result.tools.some((tool) => tool.name === "memory__memory_record_turn"));
  const denied = await call(peer, "memory_record_turn", { ...record, requestId: "endpoint-smoke-denied" });
  assert.ok(denied.error || denied.result?.isError, "停用后绕过列表直接调用也必须拒绝");
  await toggle("enable");
  assert.ok((await rpc(peer, "tools/list")).result.tools.some((tool) => tool.name === "memory__memory_record_turn"));
  const pending = await call(peer, "memory_read_source", { messageId: source.sourceId, revision: source.revision, length: 6000 });
  assert.equal(JSON.parse(pending.result.content[0].text).segmented, true);
  peer.ws.close(1012, "synthetic reconnect test");
  const second = await until(() => peers[1], "服务端断线后自动恢复");
  await handshake(second);
  assert.equal((await value(second, pending)).content, archiveText.slice(0, 6000));
  assert.equal((await invoke(second, "memory_record_turn", record)).duplicate, true);
  assert.equal((await invoke(second, "memory_status")).messages, 4);
  const invalidated = await call(second, "memory_read_source", { messageId: source.sourceId, revision: source.revision });
  const oldPage = JSON.parse(invalidated.result.content[0].text);
  await invoke(second, "memory_status");
  assert.equal((await call(second, "memory_read_result", { cursor: oldPage.cursor, offset: oldPage.nextOffset })).result.isError, true);
  const recovered = await invoke(second, "memory_read_source", { messageId: source.sourceId, revision: source.revision });
  assert.equal(recovered.content, archiveText.slice(0, recovered.content.length));
  assert.ok(!diagnostics.includes(record.content), "应用日志不能包含原话");
  assert.ok(!diagnostics.includes(endpoint), "应用日志不能包含完整接入点凭据");
  process.stdout.write(JSON.stringify({ passed: true, checks: ["WSS证书校验与11工具发现", "全部工具结果逐帧不超1024字节", "双层分页/逐字重建/长度与SHA256校验", "重复片段/写入幂等/冲突/超长非法参数", "提炼提交/分类检索/概要/候选/完成标记", "停用隐藏与直接调用拒绝", "断线中途续读/失效后重读"], responseBytes: sizes, responseCounts, originals: { archivedUtf16: archiveText.length, archivedSha256: digest(archiveText), recordedUtf16: record.content.length, recordedSha256: digest(record.content) }, note: "仅回环模拟云端，未连接官方或部署NAS；tools/list有独立token上限，不属于工具结果1024字节上限。" }, null, 2) + "\n");
} finally {
  if (child?.pid) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else { child.kill("SIGTERM"); await Promise.race([once(child, "exit"), delay(5000)]); }
  }
  for (const peer of peers) peer.ws.terminate();
  sockets?.close();
  await new Promise((done) => server?.listening ? server.close(done) : done());
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
