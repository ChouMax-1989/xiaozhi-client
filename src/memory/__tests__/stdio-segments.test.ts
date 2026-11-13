import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";

it("真实 stdio 分段按 UTF-8 预算传递并完整重建", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xiaozhi-segments-"));
  const config = join(directory, "config.json");
  writeFileSync(
    config,
    JSON.stringify({ mcpEndpoint: "wss://example.test/mcp?token=synthetic" })
  );
  const client = new Client({ name: "stdio-segments", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve("src/memory/stdio.ts")],
    env: {
      ...process.env,
      XIAOZHI_MEMORY_AGENT_ID: "synthetic",
      XIAOZHI_MEMORY_DB: join(directory, "db.sqlite"),
      XIAOZHI_MEMORY_CLIENT_CONFIG: config,
      XIAOZHI_MEMORY_SYNC_INTERVAL_SECONDS: "0",
      XIAOZHI_MEMORY_OWNER: "",
      XIAOZHI_MEMORY_TOKEN_FILE: "",
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = (await client.callTool({
        name,
        arguments: args,
      })) as CallToolResult;
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(
        768
      );
      return response;
    };
    const parse = <T>(response: CallToolResult): T => {
      const content = response.content[0];
      if (content.type !== "text") throw new Error("不是文本");
      return JSON.parse(content.text) as T;
    };
    const content = '中文😀"\\\n'.repeat(180);
    const receipt = parse<{ sourceId: string }>(
      await call("memory_record_turn", {
        requestId: "stdio-record-1",
        conversationId: "stdio-test",
        role: "user",
        content,
      })
    );
    let part = parse<{
      segmented: boolean;
      cursor: string;
      offset: number;
      nextOffset: number | null;
      totalLength: number;
      sha256: string;
      chunk: string;
    }>(await call("memory_read_source", { messageId: receipt.sourceId }));
    expect(part.segmented).toBe(true);
    const { cursor, totalLength, sha256 } = part;
    let reconstructed = "";
    for (;;) {
      expect(part.offset).toBe(reconstructed.length);
      reconstructed += part.chunk;
      if (part.nextOffset === null) break;
      part = parse(
        await call("memory_read_result", { cursor, offset: part.nextOffset })
      );
    }
    expect(reconstructed.length).toBe(totalLength);
    expect(createHash("sha256").update(reconstructed).digest("hex")).toBe(
      sha256
    );
    expect(JSON.parse(reconstructed).content).toBe(content);
    const invalid = await call("memory_record_turn", {
      ...Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`unknown_${index}`, "私密"])
      ),
      role: "invalid",
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain("私密");
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
