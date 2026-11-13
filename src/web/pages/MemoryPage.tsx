import { ManagementPage } from "@/components/management-page";
import { MemoryCategory } from "@/components/memory/memory-categories";
import { MemoryChats } from "@/components/memory/memory-chats";
import {
  MemoryErrorState,
  MemoryLoading,
  formatMemoryTime,
} from "@/components/memory/memory-common";
import {
  MemoryDetailSheet,
  type MemorySelection,
} from "@/components/memory/memory-detail";
import { MemoryEntries } from "@/components/memory/memory-entries";
import { MemoryGraph } from "@/components/memory/memory-graph";
import {
  MemoryOperations,
  MemorySummaries,
} from "@/components/memory/memory-history";
import { MemoryRestartHint } from "@/components/memory/memory-restart-hint";
import { MemorySettings } from "@/components/memory/memory-settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { memoryError, useMemoryResource } from "@/hooks/useMemoryResource";
import { memoryApi } from "@/services/memoryApi";
import { Copy, MoreHorizontal, RefreshCw, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  MemoryAdminOverview,
  MemorySyncJob,
} from "../../types/memory-admin";

const syncLabels: Record<MemorySyncJob["state"], string> = {
  idle: "尚未手动同步",
  running: "正在同步对话",
  complete: "同步完成",
  partial: "本轮同步未完成",
  error: "同步失败",
};

function syncDisabledReason(overview: MemoryAdminOverview) {
  if (!overview.settings.configured) return "先到设置中关联小智智能体。";
  if (overview.settings.restartRequired)
    return "设置等待重启生效，重启后再同步。";
  if (!overview.ready) return "记忆服务尚未就绪，请检查设置和服务状态。";
  if (!overview.settings.tokenConfigured)
    return "先到设置中保存官方历史访问凭据。";
  if (overview.settings.syncIntervalSeconds > 0)
    return "自动同步已开启，由服务按间隔同步。若需手动同步，请关闭自动同步并重启。";
  if (overview.syncJob.state === "running")
    return "同步任务正在后台运行，页面会自动更新进度。";
  return null;
}

export default function MemoryPage() {
  const overview = useMemoryResource(memoryApi.overview);
  const [moreOpen, setMoreOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [selection, setSelection] = useState<MemorySelection | null>(null);
  const [syncStarting, setSyncStarting] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const previousSync = useRef<MemorySyncJob["state"] | null>(null);
  const refreshOverview = overview.refresh;
  const onChanged = useCallback(() => {
    refreshOverview();
    setRevision((value) => value + 1);
  }, [refreshOverview]);
  const refreshAll = useCallback(() => {
    onChanged();
    setSettingsRevision((value) => value + 1);
  }, [onChanged]);
  const state = overview.data?.syncJob.state;

  useEffect(() => {
    if (state !== "running" || overview.loading || overview.error) return;
    const timeout = window.setTimeout(refreshOverview, 2000);
    return () => window.clearTimeout(timeout);
  }, [state, overview.loading, overview.error, refreshOverview]);

  useEffect(() => {
    if (previousSync.current === "running" && state && state !== "running") {
      setRevision((value) => value + 1);
    }
    previousSync.current = state ?? null;
  }, [state]);

  async function startSync() {
    setSyncStarting(true);
    try {
      const job = await memoryApi.sync();
      overview.setData((value) => (value ? { ...value, syncJob: job } : value));
      refreshOverview();
      toast.success("已启动对话同步，进度会在页面中更新。");
    } catch (error) {
      toast.error(memoryError(error));
      refreshOverview();
    } finally {
      setSyncStarting(false);
    }
  }

  async function copyPrompt() {
    const prompt = overview.data?.extractionPrompt;
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      toast.success("整理提示已复制，请粘贴到小智聊天中发送。");
    } catch {
      setPromptOpen(true);
    }
  }

  const data = overview.data;
  const ready = data?.ready ?? false;
  const syncReason = data ? syncDisabledReason(data) : "正在读取服务状态。";
  const lastVerifiedAt =
    typeof data?.sync?.lastVerifiedAt === "string"
      ? data.sync.lastVerifiedAt
      : null;

  const legacyImport = data ? (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          disabled={Boolean(syncReason) || syncStarting}
          onClick={() => void startSync()}
        >
          <RefreshCw
            data-icon="inline-start"
            className={
              state === "running" || syncStarting ? "animate-spin" : undefined
            }
          />
          {state === "running" || syncStarting ? "正在同步…" : "导入旧对话"}
        </Button>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {syncLabels[data.syncJob.state]}
        </p>
      </div>
      {data.syncJob.message ? (
        <p className="text-sm">{data.syncJob.message}</p>
      ) : null}
      {syncReason ? (
        <p className="text-sm text-muted-foreground">{syncReason}</p>
      ) : null}
      {lastVerifiedAt ? (
        <p className="text-xs text-muted-foreground">
          上次完整核验：{formatMemoryTime(lastVerifiedAt)}
        </p>
      ) : null}
      {state === "partial" ? (
        <p className="text-sm text-muted-foreground">
          已保留进度，可继续导入剩余内容。
        </p>
      ) : null}
    </div>
  ) : null;

  return (
    <>
      <ManagementPage
        title="对话与记忆"
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label="刷新"
              title="刷新"
              disabled={overview.loading}
              onClick={refreshAll}
            >
              <RefreshCw
                className={overview.loading ? "animate-spin" : undefined}
              />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMoreOpen(true)}>
              <MoreHorizontal data-icon="inline-start" />
              更多
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 data-icon="inline-start" />
              设置
            </Button>
          </>
        }
      >
        {overview.loading && !data ? (
          <MemoryLoading label="正在连接记忆服务…" />
        ) : null}
        {overview.error ? (
          <MemoryErrorState message={overview.error} retry={refreshAll} />
        ) : null}
        {data?.error ? (
          <Alert variant="destructive">
            <AlertTitle>记忆服务需要检查</AlertTitle>
            <AlertDescription>{data.error}</AlertDescription>
          </Alert>
        ) : null}
        {data?.settings.restartRequired ? (
          <Alert>
            <AlertTitle>有设置等待重启</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              <MemoryRestartHint containerMode={data.settings.containerMode} />
            </AlertDescription>
          </Alert>
        ) : null}
        {!ready && !overview.loading ? (
          <Alert>
            <AlertTitle>
              {data?.settings.configured
                ? "记忆服务尚未就绪"
                : "先完成记忆服务设置"}
            </AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              <p>
                {data?.settings.configured
                  ? "请检查服务状态；刚保存过设置时，重启后再刷新。"
                  : "关联小智智能体后，即可查看保存的对话和记忆。"}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSettingsOpen(true)}
              >
                前往设置
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {ready ? (
          <>
            <section
              aria-label="对话记录"
              className="flex min-w-0 flex-col gap-3"
            >
              <h3 className="text-base font-semibold">对话记录</h3>
              <MemoryChats revision={revision} />
            </section>
            <section
              aria-label="提炼记忆"
              className="flex min-w-0 flex-col gap-6 pb-6 pt-3"
            >
              <div className="flex items-center justify-between gap-3 border-b pb-3">
                <h2 className="text-lg font-semibold">提炼记忆</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!data?.extractionPrompt}
                  onClick={() => void copyPrompt()}
                  aria-label="复制整理提示"
                  title="复制后粘贴到小智聊天，整理已有原文"
                >
                  <Copy data-icon="inline-start" />
                  复制整理提示
                </Button>
              </div>
              <MemoryCategory
                category="user_profile"
                title="用户画像"
                revision={revision}
                onSelect={setSelection}
                onChanged={onChanged}
              />
              <MemoryCategory
                category="situational"
                title="情境记忆"
                revision={revision}
                onSelect={setSelection}
                onChanged={onChanged}
              />
              <MemoryGraph revision={revision} onSelect={setSelection} />
            </section>
          </>
        ) : null}
      </ManagementPage>
      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogContent className="memory-workspace max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>更多记忆管理</DialogTitle>
            <DialogDescription>
              查看全部状态、摘要与可撤销的操作。
            </DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="entries" className="min-w-0">
            <TabsList className="w-full" aria-label="更多记忆管理">
              <TabsTrigger className="flex-1" value="entries">
                全部记忆
              </TabsTrigger>
              <TabsTrigger className="flex-1" value="summaries">
                摘要
              </TabsTrigger>
              <TabsTrigger className="flex-1" value="operations">
                操作记录
              </TabsTrigger>
            </TabsList>
            <TabsContent value="entries">
              {ready ? (
                <MemoryEntries
                  revision={revision}
                  onSelect={setSelection}
                  onChanged={onChanged}
                />
              ) : null}
            </TabsContent>
            <TabsContent value="summaries">
              {ready ? (
                <MemorySummaries revision={revision} onSelect={setSelection} />
              ) : null}
            </TabsContent>
            <TabsContent value="operations">
              {ready ? (
                <MemoryOperations
                  revision={revision}
                  onChanged={onChanged}
                  onSelect={setSelection}
                />
              ) : null}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="memory-workspace max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>记忆设置</DialogTitle>
            <DialogDescription>管理本地档案、身份与备份。</DialogDescription>
          </DialogHeader>
          <MemorySettings
            key={settingsRevision}
            ready={ready}
            onChanged={onChanged}
            legacyImport={legacyImport}
            recordingPrompt={data?.recordingPrompt ?? ""}
          />
        </DialogContent>
      </Dialog>
      <MemoryDetailSheet
        key={
          selection
            ? `${selection.id}:${selection.revision ?? "current"}`
            : "closed"
        }
        selection={selection}
        onClose={() => setSelection(null)}
        onChanged={onChanged}
      />
      <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>手动复制整理提示</DialogTitle>
            <DialogDescription>
              浏览器暂时无法自动复制。请选择下方全文，复制后粘贴到小智聊天中发送。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="整理提示全文"
            value={data?.extractionPrompt ?? ""}
            readOnly
            rows={10}
            onFocus={(event) => event.target.select()}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
