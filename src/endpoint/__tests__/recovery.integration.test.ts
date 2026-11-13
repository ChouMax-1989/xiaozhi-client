import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { EndpointManager } from "../manager.js";
import type { IMCPServiceManager } from "../types.js";

async function waitFor(condition: () => boolean, timeout = 800) {
  const end = Date.now() + timeout;
  while (!condition() && Date.now() < end) await delay(10);
  expect(condition()).toBe(true);
}

describe("端点真实 WebSocket 恢复", () => {
  let server: WebSocketServer | undefined;
  let manager: EndpointManager | undefined;
  afterEach(async () => {
    await manager?.cleanup();
    for (const client of server?.clients ?? []) client.terminate();
    if (server)
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    manager = undefined;
    server = undefined;
  });
  const adapter: IMCPServiceManager = {
    initialize: async () => {},
    cleanup: async () => {},
    getAllTools: () => [],
    callTool: async () => ({ content: [] }),
  };

  it("无 id 初始化通知不产生响应，远端断开后重连且主动停止后不重连", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("没有监听地址");
    let connections = 0;
    let socket: WebSocket | undefined;
    const messages: string[] = [];
    server.on("connection", (client) => {
      connections++;
      socket = client;
      client.on("message", (data) => messages.push(data.toString()));
    });
    manager = new EndpointManager({ defaultReconnectDelay: 30 });
    manager.setMcpManager(adapter);
    manager.addEndpoint(`ws://127.0.0.1:${address.port}`);
    await manager.connect();
    await waitFor(() => !!socket);
    socket?.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })
    );
    await waitFor(() => messages.length === 1);
    expect(JSON.parse(messages[0]).result.capabilities.tools.listChanged).toBe(
      false
    );
    socket?.send(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    );
    await delay(60);
    socket?.terminate();
    await waitFor(() => manager?.getConnectionStatus()[0].connected === false);
    await waitFor(() => connections >= 2);
    expect(messages).toHaveLength(1);
    expect(manager.getConnectionStatus()[0].connected).toBe(true);
    await manager.disconnect();
    const stoppedAt = connections;
    await delay(100);
    expect(connections).toBe(stoppedAt);
  });

  it("首次连接失败后服务恢复时自动连接", async () => {
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, "127.0.0.1", resolve)
    );
    const address = reservation.address();
    if (!address || typeof address === "string")
      throw new Error("没有保留端口");
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    manager = new EndpointManager({ defaultReconnectDelay: 30 });
    manager.setMcpManager(adapter);
    manager.addEndpoint(`ws://127.0.0.1:${port}`);
    await manager.connect();
    expect(manager.getConnectionStatus()[0].connected).toBe(false);
    server = new WebSocketServer({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    await waitFor(() => manager?.getConnectionStatus()[0].connected === true);
  });

  it("手动重连失败不会报告已连接，服务恢复后继续重试", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("没有监听地址");
    const port = address.port;
    const url = `ws://127.0.0.1:${port}`;
    manager = new EndpointManager({ defaultReconnectDelay: 30 });
    manager.setMcpManager(adapter);
    manager.addEndpoint(url);
    await manager.connect();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    await expect(manager.reconnectEndpoint(url)).rejects.toThrow();
    expect(manager.getConnectionStatus()[0]).toMatchObject({
      connected: false,
      initialized: false,
    });
    server = new WebSocketServer({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    await waitFor(() => manager?.getConnectionStatus()[0].connected === true);
  });
});
