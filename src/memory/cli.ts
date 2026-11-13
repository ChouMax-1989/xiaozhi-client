#!/usr/bin/env node

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { z } from "zod";
import { checkClientBinding, loadMemoryOptions } from "./config.js";
import { syncHistory } from "./history.js";
import { safeMemoryError } from "./mcp.js";
import { MemoryStore } from "./store.js";
import {
  type ArchiveChat,
  type ArchiveMessage,
  MemoryError,
  type MemoryOptions,
} from "./types.js";

const importEnvelopeSchema = z
  .object({
    chats: z.array(z.unknown()).max(10_000).optional(),
    messages: z.array(z.unknown()).max(10_000),
  })
  .strict();

function integerOption(value: string): number {
  const parsed = Number(value);
  if (
    !/^\d+$/u.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > 1_000
  ) {
    throw new InvalidArgumentError("必须为 1 到 1000 的整数。");
  }
  return parsed;
}

function readImport(file: string) {
  let data: unknown;
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) {
      throw new MemoryError("档案不是普通文件或超过读取上限");
    }
    data = JSON.parse(
      readFileSync(file, "utf8").replace(/^\uFEFF/u, "")
    ) as unknown;
  } catch {
    throw new MemoryError(
      "无法读取导入档案，请使用不超过 64 MiB 的有效 JSON 文件。"
    );
  }
  const parsed = importEnvelopeSchema.safeParse(data);
  if (!parsed.success) {
    throw new MemoryError(
      "导入文件必须只包含 messages 数组及可选的 chats 数组，每个数组最多 10000 项。"
    );
  }
  return parsed.data;
}

function writePrivateFile(file: string, content: string): void {
  let descriptor: number | undefined;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    descriptor = openSync(file, "wx", 0o600);
    writeFileSync(descriptor, content, { encoding: "utf8" });
  } catch {
    throw new MemoryError(
      "无法写入输出文件；请使用尚不存在的文件名并检查目录权限。"
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** 管理命令由本机操作者执行，不向 MCP 暴露路径、导入和撤销权限。 */
export function createMemoryCli(env: NodeJS.ProcessEnv = process.env) {
  const program = new Command();
  const print = (value: unknown) =>
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const withStore = async (
    work: (store: MemoryStore, options: MemoryOptions) => void | Promise<void>
  ) => {
    const options = loadMemoryOptions(env);
    const store = new MemoryStore(options.databasePath, options);
    try {
      await work(store, options);
    } finally {
      store.close();
    }
  };

  program
    .name("xiaozhi-memory")
    .description(
      "管理本机的小智原始档案与记忆；身份、数据库和凭据文件通过本机环境配置"
    )
    .helpOption("-h, --help", "显示帮助信息")
    .helpCommand("help [command]", "显示指定命令的帮助信息")
    .exitOverride();

  program
    .command("status")
    .description("查看数量和同步进度，不输出原始对话")
    .action(() =>
      withStore((store, options) => {
        const { sync, ...status } = store.status();
        print({
          ...status,
          syncConfigured: Boolean(options.tokenFile),
          lastScanVerified: sync?.complete ?? false,
          syncPhase: sync?.phase ?? null,
          syncPage: sync?.page ?? null,
          completedScans: sync?.completedScans ?? 0,
          lastVerifiedAt: sync?.lastVerifiedAt ?? null,
          note: "核对状态只代表上次完整遍历，不保证远端此刻没有新对话。",
        });
      })
    );

  program
    .command("sync")
    .description("使用本机凭据文件分页同步官方历史；达到预算后保留检查点")
    .option(
      "--max-requests <count>",
      "本次请求预算（1 到 1000）",
      integerOption,
      100
    )
    .action((commandOptions: { maxRequests: number }) =>
      withStore(async (store, options) => {
        if (!options.tokenFile) {
          throw new MemoryError(
            "请在本机配置 XIAOZHI_MEMORY_TOKEN_FILE 后再同步，不要把令牌发送到聊天中。"
          );
        }
        const outcome = await syncHistory(store, {
          agentId: options.agentId,
          tokenFile: options.tokenFile,
          maxRequests: commandOptions.maxRequests,
        });
        print(outcome);
        if (outcome.status === "error") process.exitCode = 1;
        if (outcome.status === "incomplete") {
          process.stderr.write(
            "同步尚未完成，已保存检查点；再次运行 sync 可继续。\n"
          );
        }
      })
    );

  program
    .command("import <file>")
    .description(
      "导入本机 JSON 原始档案（{chats?, messages[]}），逐条格式由存储层校验"
    )
    .action((file: string) =>
      withStore((store) => {
        const archive = readImport(resolve(file));
        try {
          for (const chat of archive.chats ?? [])
            store.upsertChat(chat as ArchiveChat);
          const messages = store.upsertMessages(
            archive.messages as ArchiveMessage[]
          );
          print({
            message: "导入完成；重复档案不会增加证据数量。",
            chats: archive.chats?.length ?? 0,
            messages,
          });
        } catch {
          throw new MemoryError(
            "导入未完成，请检查原始消息和会话格式。已写入的档案会保留，修正后可重复导入。"
          );
        }
      })
    );

  program
    .command("export <file>")
    .description(
      "将完整档案、版本和审计记录导出到权限 0600 的新文件，不在终端显示原话"
    )
    .action((file: string) =>
      withStore((store) => {
        writePrivateFile(
          resolve(file),
          `${JSON.stringify(store.exportData(), null, 2)}\n`
        );
        print({
          message:
            "完整导出已保存到指定文件。导出不是 import 的原始档案格式；整库恢复请使用备份。",
        });
      })
    );

  program
    .command("backup <file>")
    .description("生成包含 WAL 内容的一致 SQLite 备份，目标必须是新文件")
    .action((file: string) =>
      withStore((store) => {
        store.backup(resolve(file));
        print({ message: "一致性备份已保存到指定文件，文件权限为 0600。" });
      })
    );

  program
    .command("operations")
    .description("列出最近的操作标识和类型，不输出记忆原话")
    .option(
      "--limit <count>",
      "最多显示的操作数（存储层最多返回 100 项）",
      integerOption,
      20
    )
    .action((commandOptions: { limit: number }) =>
      withStore((store) => {
        print(
          store.operations(commandOptions.limit).map((operation) => ({
            id: operation.id,
            kind: operation.kind,
            createdAt: operation.createdAt,
            undoneBy: operation.undoneBy ?? null,
          }))
        );
      })
    );

  program
    .command("undo <operationId>")
    .description("撤销一项可恢复的记忆操作；存在后续更新时拒绝覆盖")
    .action((operationId: string) =>
      withStore((store) => {
        if (!operationId || operationId.length > 100)
          throw new MemoryError("操作标识无效。");
        print(store.undo(operationId));
      })
    );

  program
    .command("rebind-endpoint")
    .description(
      "本机确认同一智能体轮换端点令牌后，核对当前配置并重建绑定，保留审计记录"
    )
    .action(() =>
      withStore((store, options) => {
        let fingerprint: string | undefined;
        checkClientBinding(options, (key, value) => {
          if (key === "endpoint") fingerprint = value;
        });
        if (!fingerprint)
          throw new MemoryError("未能确认新的端点绑定，请检查本机配置。");
        print(store.rebindEndpoint(fingerprint));
      })
    );

  return program;
}

export async function runMemoryCli(
  argv = process.argv,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  try {
    await createMemoryCli(env).parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    process.stderr.write(`[本地记忆] ${safeMemoryError(error)}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runMemoryCli();
}
