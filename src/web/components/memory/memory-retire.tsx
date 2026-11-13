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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { memoryError } from "@/hooks/useMemoryResource";
import { memoryApi } from "@/services/memoryApi";
import { CirclePause } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { MemoryRecord } from "../../../types/memory-admin";

export function MemoryRetire({
  memory,
  onRetired,
}: { memory: MemoryRecord; onRetired: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (memory.status !== "active" && memory.status !== "candidate") return null;
  async function retire() {
    if (saving || !reason.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await memoryApi.retire(memory.id, memory.revision, reason.trim());
      setOpen(false);
      setReason("");
      toast.success("这条记忆已停用，可在操作记录中查看或撤销。");
      onRetired();
    } catch (failure) {
      setError(memoryError(failure));
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-muted-foreground"
        title="停用记忆"
        aria-label={`停用记忆：${memory.facet}：${memory.value}`}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <CirclePause className="size-4" />
        停用
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!saving) setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认停用这条记忆？</AlertDialogTitle>
            <AlertDialogDescription>
              停用后不再参与记忆检索，原始对话和历史记录保留，可在操作记录中撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="max-h-32 overflow-y-auto break-words rounded-md bg-muted px-3 py-2 text-sm">
            <strong>{memory.facet}:</strong> {memory.value}
          </p>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`retire-reason-${memory.id}`}>
              停用原因（必填）
            </Label>
            <Textarea
              id={`retire-reason-${memory.id}`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={1000}
              placeholder="例如：这项偏好已经改变"
              disabled={saving}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error} 如记录已更新，请取消后重新打开。
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving || !reason.trim()}
              onClick={(event) => {
                event.preventDefault();
                void retire();
              }}
            >
              {saving ? "正在停用…" : "确认停用"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
