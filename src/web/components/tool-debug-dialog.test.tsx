import "@testing-library/jest-dom/vitest";
import { apiClient } from "@/services/api";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolDebugDialog } from "./tool-debug-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("工具调试动态表单", () => {
  it("保留原有字段校验，合法输入以原始值提交给工具", async () => {
    const callTool = vi
      .spyOn(apiClient, "callTool")
      .mockResolvedValue({ content: [] });
    const errorToast = vi.spyOn(toast, "error");
    const user = userEvent.setup();
    render(
      <ToolDebugDialog
        open
        onOpenChange={vi.fn()}
        tool={{
          name: "test-search",
          serverName: "test-server",
          toolName: "search",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 2 },
              limit: { type: "integer", minimum: 1 },
            },
            required: ["query", "limit"],
          },
        }}
      />
    );
    await user.click(screen.getByRole("button", { name: /调用工具/ }));
    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith("请检查表单中的错误")
    );
    expect(callTool).not.toHaveBeenCalled();
    await user.type(screen.getByPlaceholderText("输入query"), "抹茶");
    fireEvent.change(screen.getByPlaceholderText("输入limit"), {
      target: { value: "2" },
    });
    await user.click(screen.getByRole("button", { name: /调用工具/ }));
    await waitFor(() =>
      expect(callTool).toHaveBeenCalledWith("test-server", "search", {
        query: "抹茶",
        limit: 2,
      })
    );
  });
});
