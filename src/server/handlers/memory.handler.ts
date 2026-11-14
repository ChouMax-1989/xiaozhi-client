import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { MemoryAdminRequest } from "../../types/memory-admin.js";
import {
  MemoryAdminError,
  MemoryAdminService,
  memoryCredentialSchema,
  memorySettingsSchema,
} from "../services/MemoryAdminService.js";
import type { AppContext } from "../types/hono.context.js";

const MAX_BODY_BYTES = 20 * 1024;
const invalidRequest = () =>
  new MemoryAdminError(
    "MEMORY_INVALID_REQUEST",
    "请求格式无效，请检查字段、长度、页码与版本后重试。"
  );
const identifierSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/\p{Cc}/u.test(value));
const queryInteger = (maximum: number) =>
  z
    .string()
    .regex(/^[1-9]\d*$/u)
    .transform(Number)
    .pipe(z.number().int().max(maximum));
const pagingSchema = z
  .object({
    query: z.string().max(500).optional(),
    page: queryInteger(Number.MAX_SAFE_INTEGER).optional(),
    pageSize: queryInteger(50).optional(),
  })
  .strict();
const messagesSchema = pagingSchema
  .extend({ chatId: identifierSchema.optional() })
  .strict();
const entriesSchema = pagingSchema
  .extend({
    status: z
      .enum(["all", "active", "candidate", "inactive", "current"])
      .optional(),
    category: z.enum(["user_profile", "situational"]).optional(),
  })
  .strict();
const emptySchema = z.object({}).strict();
const autoExtractSchema = z.object({ enabled: z.boolean() }).strict();
const sourceSchema = z
  .object({ revision: queryInteger(Number.MAX_SAFE_INTEGER).optional() })
  .strict();
const retireSchema = z
  .object({
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
const deleteSchema = z
  .object({
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** 记忆接口独立于全站宽松 CORS；只比较真实请求地址和 Host，不信任转发头。 */
export const memoryAdminMiddleware: MiddlewareHandler<AppContext> = async (
  c,
  next
) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  const reject = () =>
    c.fail(
      "MEMORY_ORIGIN_REJECTED",
      "记忆管理仅允许从当前管理页面同源访问。",
      undefined,
      403
    );
  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
    return reject();
  try {
    const request = new URL(c.req.url);
    const host = c.req.header("host") ?? request.host;
    if (
      (request.protocol !== "http:" && request.protocol !== "https:") ||
      !host ||
      host !== request.host ||
      /[\s\\/#?@]/u.test(host)
    )
      return reject();
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      const parsed = new URL(origin);
      if (
        parsed.origin !== origin ||
        parsed.origin !== request.origin ||
        parsed.host !== host
      )
        return reject();
    }
  } catch {
    return reject();
  }
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  if (
    !["GET", "HEAD"].includes(c.req.method) &&
    c.req.header("content-type")?.split(";", 1)[0].trim().toLowerCase() !==
      "application/json"
  ) {
    return c.fail(
      "MEMORY_JSON_REQUIRED",
      "记忆管理写入请求必须使用 JSON。",
      undefined,
      415
    );
  }
  await next();
  // 即使外层意外套用了通用 CORS，也不允许其暴露记忆响应。
  c.res.headers.delete("Access-Control-Allow-Origin");
  c.res.headers.delete("Access-Control-Allow-Credentials");
  return undefined;
};

/** 管理 HTTP 层只接受受限请求，不接受可执行命令或任意本机路径。 */
export class MemoryApiHandler {
  constructor(readonly service = new MemoryAdminService()) {}

  private async respond(
    c: Context<AppContext>,
    work: () => unknown | Promise<unknown>,
    status = 200
  ): Promise<Response> {
    try {
      return c.success(await work(), undefined, status);
    } catch (error) {
      return this.failure(c, error);
    }
  }

  private failure(c: Context<AppContext>, error: unknown): Response {
    if (error instanceof MemoryAdminError)
      return c.fail(error.code, error.message, undefined, error.status);
    // 不调用 BaseHandler.handleError，避免日志或响应泄露正文、路径和凭据。
    return c.fail(
      "MEMORY_OPERATION_FAILED",
      "记忆管理操作未完成，请检查本机配置与存储状态后重试。",
      undefined,
      500
    );
  }

  private query<T>(c: Context<AppContext>, schema: z.ZodType<T>): T {
    if (
      c.req.url.length > 4096 ||
      Object.values(c.req.queries()).some((values) => values.length !== 1)
    )
      throw invalidRequest();
    const result = schema.safeParse(c.req.query());
    if (!result.success) throw invalidRequest();
    return result.data;
  }

  private id(c: Context<AppContext>, name = "id"): string {
    const result = identifierSchema.safeParse(c.req.param(name));
    if (!result.success) throw invalidRequest();
    return result.data;
  }

  private async body<T>(
    c: Context<AppContext>,
    schema: z.ZodType<T>,
    optional = false
  ): Promise<T> {
    this.query(c, emptySchema);
    const declared = c.req.header("content-length");
    if (
      declared &&
      (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)
    ) {
      throw new MemoryAdminError(
        "MEMORY_BODY_TOO_LARGE",
        "请求体超过 20 KiB 上限。",
        413
      );
    }
    if (
      c.req.header("content-encoding") &&
      c.req.header("content-encoding") !== "identity"
    )
      throw invalidRequest();
    const reader = c.req.raw.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BODY_BYTES) {
            await reader.cancel();
            throw new MemoryAdminError(
              "MEMORY_BODY_TOO_LARGE",
              "请求体超过 20 KiB 上限。",
              413
            );
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    let value: unknown;
    try {
      value =
        bytes === 0 && optional
          ? {}
          : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw invalidRequest();
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw invalidRequest();
    return parsed.data;
  }

  getOverview(c: Context<AppContext>): Promise<Response> {
    return this.respond(c, () => {
      this.query(c, emptySchema);
      return this.service.getOverview();
    });
  }

  getSettings(c: Context<AppContext>): Promise<Response> {
    return this.respond(c, () => {
      this.query(c, emptySchema);
      return this.service.getSettings();
    });
  }

  saveSettings(c: Context<AppContext>): Promise<Response> {
    return this.respond(c, async () =>
      this.service.saveSettings(await this.body(c, memorySettingsSchema))
    );
  }

  setAutoExtract(c: Context<AppContext>): Promise<Response> {
    return this.respond(c, async () => {
      const { enabled } = await this.body(c, autoExtractSchema);
      return this.service.execute({ action: "setAutoExtractEnabled", enabled });
    });
  }

  setBulkExtract(c: Context<AppContext>): Promise<Response> {
    return this.respond(c, async () => {
      const { enabled } = await this.body(c, autoExtractSchema);
      return this.service.execute({ action: "setBulkExtractEnabled", enabled });
    });
  }

  saveCredential(c: Context<AppContext>): Promise<Response> {
    return this.respond(c, async () =>
      this.service.saveCredential(
        (await this.body(c, memoryCredentialSchema)).token
      )
    );
  }

  getChats(c: Context<AppContext>): Promise<Response> {
    return this.respond(c, () =>
      this.service.execute({ action: "chats", ...this.query(c, pagingSchema) })
    );
  }

  getMessages(c: Context<AppContext>): Promise<Response> {
    return this.respond(c, () =>
      this.service.execute({
        action: "messages",
        ...this.query(c, messagesSchema),
      })
    );
  }

  getSource(c: Context<AppContext>): Promise<Response> {
    return this.respond(c, () =>
      this.service.execute({
        action: "source",
        id: this.id(c),
        ...this.query(c, sourceSchema),
      })
    );
  }

  getEntries(c: Context<AppContext>): Promise<Response> {
    return this.respond(c, () =>
      this.service.execute({
        action: "memories",
        ...this.query(c, entriesSchema),
      })
    );
  }

  getEntry(c: Context<AppContext>): Promise<Response> {
    return this.respond(c, () => {
      this.query(c, emptySchema);
      return this.service.execute({ action: "detail", id: this.id(c) });
    });
  }

  retireEntry(c: Context<AppContext>): Promise<Response> {
    return this.respond(c, async () =>
      this.service.execute({
        action: "retire",
        id: this.id(c),
        ...(await this.body(c, retireSchema)),
      })
    );
  }

  deleteEntry(c: Context<AppContext>): Promise<Response> {
    return this.respond(c, async () =>
      this.service.execute({
        action: "delete",
        id: this.id(c),
        ...(await this.body(c, deleteSchema)),
      })
    );
  }

  getList(
    c: Context<AppContext>,
    action: "summaries" | "captures" | "operations"
  ): Promise<Response> {
    return this.respond(c, () => {
      this.query(c, emptySchema);
      return this.service.execute({ action } as MemoryAdminRequest);
    });
  }

  undoOperation(c: Context<AppContext>): Promise<Response> {
    return this.respond(c, async () => {
      await this.body(c, emptySchema, true);
      return this.service.execute({ action: "undo", operationId: this.id(c) });
    });
  }

  startSync(c: Context<AppContext>): Promise<Response> {
    return this.respond(
      c,
      async () => {
        await this.body(c, emptySchema, true);
        return this.service.startSync();
      },
      202
    );
  }

  async exportData(c: Context<AppContext>): Promise<Response> {
    try {
      this.query(c, emptySchema);
      const data = await this.service.execute({ action: "export" });
      c.header("Content-Type", "application/json; charset=utf-8");
      c.header(
        "Content-Disposition",
        `attachment; filename="memory-export-${new Date().toISOString().slice(0, 10)}.json"`
      );
      return c.body(JSON.stringify(data));
    } catch (error) {
      return this.failure(c, error);
    }
  }

  createBackup(c: Context<AppContext>): Promise<Response> {
    return this.respond(c, async () => {
      await this.body(c, emptySchema, true);
      return this.service.createBackup();
    });
  }

  async downloadBackup(c: Context<AppContext>): Promise<Response> {
    try {
      this.query(c, emptySchema);
      const fileName = this.id(c, "fileName");
      const file = await this.service.openBackup(fileName);
      c.header("Content-Type", "application/vnd.sqlite3");
      c.header("Content-Length", String(file.bytes));
      c.header("Content-Disposition", `attachment; filename="${fileName}"`);
      return c.body(file.stream);
    } catch (error) {
      return this.failure(c, error);
    }
  }

  close(): void {
    this.service.close();
  }
}
