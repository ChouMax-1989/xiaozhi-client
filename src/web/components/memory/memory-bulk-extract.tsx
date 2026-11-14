import { Button } from "@/components/ui/button";
import { memoryError } from "@/hooks/useMemoryResource";
import { memoryApi } from "@/services/memoryApi";
import { useState } from "react";
import type { MemoryBulkExtractStatus } from "../../../types/memory-admin";

export function MemoryBulkExtract({
  status,
  loading,
  onSaved,
}: {
  status?: MemoryBulkExtractStatus;
  loading: boolean;
  onSaved: (saved: MemoryBulkExtractStatus) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const paused = !status?.active && (status?.remaining ?? 0) > 0;
  const label = status?.active ? "暂停整理" : paused ? "继续整理" : "整理全部";

  async function changeBulkExtract() {
    if (!status || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await memoryApi.setBulkExtract(!status.active);
      setEmpty(!status.active && !saved.active && saved.remaining === 0);
      onSaved(saved);
    } catch (failure) {
      setError(memoryError(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={!status || saving || loading}
          onClick={() => void changeBulkExtract()}
          aria-describedby="memory-bulk-extract-help"
        >
          {label}
        </Button>
        <output className="text-sm text-muted-foreground">
          {empty && !status?.remaining
            ? "暂无待整理的对话。"
            : status && status.total > 0
              ? `${paused ? "已暂停，" : ""}已整理 ${status.total - status.remaining} / ${status.total} 条，剩余 ${status.remaining} 条`
              : null}
        </output>
      </div>
      <p
        id="memory-bulk-extract-help"
        className="text-sm text-muted-foreground"
      >
        下次和小智开聊时，会分批整理点击时所有待处理的原文。聊天中断后，下次开聊会接着整理。自动提炼关闭时也可使用。
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          整理设置保存失败：{error}
        </p>
      ) : null}
    </div>
  );
}
