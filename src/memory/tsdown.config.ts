import { defineConfig } from "tsdown";

// 独立入口避免普通客户端启动时加载实验性的 SQLite 模块。
export default defineConfig({
  entry: { stdio: "stdio.ts", cli: "cli.ts" },
  outDir: "../../dist/memory",
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  fixedExtension: false,
  outExtensions: () => ({ js: ".js" }),
  // CLI 输出和 MCP 传输属于功能，不应被生产压缩删除。
  minify: false,
  deps: { neverBundle: ["@modelcontextprotocol/sdk", "zod", "commander"] },
});
