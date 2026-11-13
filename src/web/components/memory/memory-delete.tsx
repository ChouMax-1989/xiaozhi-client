import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { memoryError } from "@/hooks/useMemoryResource";
import { memoryApi } from "@/services/memoryApi";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { MemoryRecord } from "../../../types/memory-admin";

export function MemoryDelete({
  memory,
  iconOnly = false,
  compact = false,
  onDeleted,
}: {
  memory: Pick<MemoryRecord, "id" | "revision" | "facet" | "value">;
  iconOnly?: boolean;
  compact?: boolean;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await memoryApi.delete(memory.id, memory.revision);
      setOpen(false);
      toast.success("记忆及历史版本已删除，原始对话保留。");
      onDeleted();
    } catch (failure) {
      setError(memoryError(failure));
    } finally {
      setDeleting(false);
    }
  }
  return (
    <>
      <Button
        variant="ghost"
        size={iconOnly ? "icon" : "sm"}
        className="shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={
          iconOnly || compact
            ? `删除记忆：${memory.facet}：${memory.value}`
            : "删除记忆"
        }
        title="删除记忆"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <Trash2 className="size-4" />
        {iconOnly ? null : compact ? "删除" : "删除记忆"}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!deleting) setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条记忆？</AlertDialogTitle>
            <AlertDialogDescription>
              删除该记忆和历史版本，不能撤销；原始对话保留。引用它的摘要也会删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="max-h-40 overflow-y-auto break-words rounded-md bg-muted px-3 py-2 text-sm leading-6">
            <strong>{memory.facet}:</strong> {memory.value}
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error} 请重试；若记录已更新，请取消后重新打开。
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void remove();
              }}
            >
              {deleting ? "正在删除…" : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
