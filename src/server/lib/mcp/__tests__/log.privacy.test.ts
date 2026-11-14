import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../Logger.js";
import {
  ToolCallLogService,
  ToolCallLogger,
  type ToolCallRecord,
} from "../log.js";

vi.mock("../../../Logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe("记忆日志的真实文件写入与查询", () => {
  let directory: string;
  let filePath: string;
  let writer: ToolCallLogger;
  let reader: ToolCallLogService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    directory = mkdtempSync(join(tmpdir(), "xiaozhi-log-privacy-"));
    filePath = join(directory, "tool-calls.jsonl");
    writer = new ToolCallLogger({}, directory);
    reader = new ToolCallLogService(directory);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("记忆原话和异常不落盘，名称、成功状态和耗时仍可查询", async () => {
    const secret = "家人明确说过的私密原话";
    const record: ToolCallRecord = {
      toolName: "family__memory_commit",
      serverName: "family",
      arguments: { sources: [{ quote: secret }] },
      result: { content: [{ text: secret }] },
      error: `${secret}引起的异常`,
      success: false,
      duration: 24,
    };
    const original = structuredClone(record);
    await writer.recordToolCall(record);

    const content = readFileSync(filePath, "utf8");
    expect(content).not.toContain(secret);
    expect(content).toContain("记忆正文已隐藏");
    expect(record).toEqual(original);
    const result = await reader.getToolCallLogs();
    expect(result.total).toBe(1);
    expect(result.records[0]).toMatchObject({
      toolName: record.toolName,
      serverName: "family",
      success: false,
      duration: 24,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("按原始名称隐藏别名工具，普通工具仍保存完整参数和结果", async () => {
    await writer.recordToolCall({
      toolName: "recall_family",
      originalToolName: "memory_search",
      arguments: { query: "私密查询词" },
      result: { text: "私密查询结果" },
      success: true,
    });
    const ordinary: ToolCallRecord = {
      toolName: "calculator_add",
      arguments: { a: 3, b: 5 },
      result: { sum: 8 },
      error: "普通工具原始错误",
      success: true,
      duration: 5,
    };
    await writer.recordToolCall(ordinary);

    const content = readFileSync(filePath, "utf8");
    expect(content).not.toContain("私密查询");
    const result = await reader.getToolCallLogs({ toolName: "calculator" });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject(ordinary);
  });

  it("查询旧记忆记录时也隐藏正文，损坏行只记录位置和长度", async () => {
    const secret = "旧日志中的敏感短语";
    const oldRecord = JSON.stringify({
      toolName: "memory_get",
      arguments: { value: secret },
      result: { text: secret },
      success: true,
    });
    const invalidLine = `损坏的记录${secret}`;
    writeFileSync(filePath, `${oldRecord}\n\n${invalidLine}\n`);

    const result = await reader.getToolCallLogs();
    expect(result.total).toBe(1);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(logger.warn).toHaveBeenCalledWith("日志记录缺少时间戳", {
      lineNumber: 1,
      length: oldRecord.length,
    });
    expect(logger.warn).toHaveBeenCalledWith("跳过无效的日志行", {
      lineNumber: 3,
      length: invalidLine.length,
    });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
      secret
    );
  });

  it("检索诊断落盘并可查询，伪造字段和旧脱敏记录不产生诊断", async () => {
    const redacted = "[记忆正文已隐藏]";
    const secret = "合成私密指令与游标";
    for (const value of [true, false]) {
      await writer.recordToolCall({
        toolName: "family__memory_search",
        arguments: { redacted, chatStart: value, query: secret },
        result: {
          redacted,
          autoExtract: value ? "present" : "absent",
          cursor: secret,
        },
        success: true,
      });
    }
    await writer.recordToolCall({
      toolName: "memory_search",
      arguments: { redacted, chatStart: secret },
      result: { redacted, autoExtract: secret },
      success: true,
    });
    await writer.recordToolCall({
      toolName: "memory_search",
      arguments: { redacted },
      result: redacted,
      success: true,
    });
    const disk = readFileSync(filePath, "utf8");
    expect(disk).not.toContain(secret);
    const { records } = await reader.getToolCallLogs();
    for (const value of [true, false]) {
      expect(records).toContainEqual(
        expect.objectContaining({
          arguments: { redacted, chatStart: value },
          result: { redacted, autoExtract: value ? "present" : "absent" },
        })
      );
    }
    expect(
      records.filter((record) => record.toolName === "memory_search")
    ).toEqual([
      expect.objectContaining({ arguments: { redacted }, result: redacted }),
      expect.objectContaining({ arguments: { redacted }, result: redacted }),
    ]);
  });
});
