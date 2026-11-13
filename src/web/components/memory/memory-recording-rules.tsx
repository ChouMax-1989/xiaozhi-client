import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export function MemoryRecordingRules({ prompt = "" }: { prompt?: string }) {
  const [manualCopy, setManualCopy] = useState(false);
  const [copying, setCopying] = useState(false);

  async function copyRules() {
    if (!prompt || copying) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(prompt);
      setManualCopy(false);
      toast.success("角色记录规则已复制，请追加到小智角色介绍，保留原有人设。");
    } catch {
      setManualCopy(true);
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="outline"
        disabled={!prompt || copying}
        onClick={() => void copyRules()}
      >
        <Copy data-icon="inline-start" />
        {copying ? "正在复制…" : "复制角色记录规则"}
      </Button>
      <p className="text-xs leading-relaxed text-muted-foreground">
        追加到小智角色介绍，保留原有人设；工具名以小智实际工具列表为准。
      </p>
      {!prompt ? (
        <output className="text-xs text-muted-foreground">
          暂未提供记录规则，请刷新服务状态后重试。
        </output>
      ) : null}
      {manualCopy ? (
        <div className="flex w-full flex-col gap-2">
          <output className="text-sm text-muted-foreground">
            浏览器未能自动复制，请选择下方全文后手动复制。
          </output>
          <Textarea
            aria-label="角色记录规则全文"
            value={prompt}
            readOnly
            rows={7}
            onFocus={(event) => event.target.select()}
          />
        </div>
      ) : null}
    </div>
  );
}
