import { Button } from "@/components/ui/button";
import { memoryError } from "@/hooks/useMemoryResource";
import { memoryApi } from "@/services/memoryApi";
import { useState } from "react";
import type { MemoryBulkExtractStatus } from "../../../types/memory-admin";

export function MemoryBulkExtract({
  enabled,
  status,
  loading,
  onSaved,
  onOpenSettings,
}: {
  enabled?: boolean;
  status?: MemoryBulkExtractStatus;
  loading: boolean;
  onSaved: () => void;
  onOpenSettings: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changeBulkExtract() {
    if (enabled === undefined || !status || saving) return;
    setSaving(true);
    setError(null);
    try {
      await memoryApi.setBulkExtract(!enabled);
      onSaved();
    } catch (failure) {
      setError(memoryError(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-semibold">整理全部</h3>
        <Button
          variant="outline"
          size="sm"
          disabled={enabled === undefined || !status || saving || loading}
          onClick={() => void changeBulkExtract()}
          aria-describedby="memory-bulk-extract-help"
        >
          {enabled === undefined
            ? "正在读取状态"
            : enabled
              ? "暂停整理"
              : "继续整理"}
        </Button>
        <output className="text-sm text-muted-foreground">
          {enabled === false ? "已暂停" : null}
          {status && status.total > 0
            ? `${enabled === false ? "，" : ""}已整理 ${status.total - status.remaining} / ${status.total} 条，剩余 ${status.remaining} 条`
            : null}
          {enabled && !status?.active ? " 等待整理" : null}
        </output>
      </div>
      <p
        id="memory-bulk-extract-help"
        className="text-sm text-muted-foreground"
      >
        批量提炼默认开启。首次使用请先
        <button
          type="button"
          className="text-foreground underline underline-offset-4"
          onClick={onOpenSettings}
        >
          更新角色介绍
        </button>
        。告别时只整理本次对话的一小批原文。要整理积压，请使用「复制整理提示」。暂停会保留批量任务的进度。
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          整理设置保存失败：{error}
        </p>
      ) : null}
    </div>
  );
}
