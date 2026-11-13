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
import {
  MemoryOperations,
  MemorySummaries,
} from "@/components/memory/memory-history";
import { MemoryRestartHint } from "@/components/memory/memory-restart-hint";
import { MemorySettings } from "@/components/memory/memory-settings";
import { SiteHeader } from "@/components/site-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Copy, RefreshCw, Settings2 } from "lucide-react";
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
  const [tab, setTab] = useState("entries");
  const [revision, setRevision] = useState(0);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [selection, setSelection] = useState<MemorySelection | null>(null);
  const [syncStarting, setSyncStarting] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
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
  const counts = data?.counts;
  const syncReason = data ? syncDisabledReason(data) : "正在读取服务状态。";
  const lastVerifiedAt =
    typeof data?.sync?.lastVerifiedAt === "string"
      ? data.sync.lastVerifiedAt
      : null;

  return (
    <div className="flex min-h-screen min-w-0 flex-col">
      <SiteHeader title="记忆库" />
      <main className="mx-auto flex w-full max-w-7xl min-w-0 flex-1 flex-col gap-6 px-4 py-6 lg:px-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="flex flex-col gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">
              小智记忆库
            </h2>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              查看保存的记忆，追溯每条事实的原话依据，并管理对话同步与本地备份。
            </p>
          </div>
          <Button
            variant="outline"
            className="self-start"
            disabled={overview.loading}
            onClick={refreshAll}
          >
            <RefreshCw
              data-icon="inline-start"
              className={overview.loading ? "animate-spin" : undefined}
            />
            刷新
          </Button>
        </div>
        {overview.loading && !data ? (
          <MemoryLoading label="正在连接记忆服务…" />
        ) : null}
        {overview.error ? (
          <MemoryErrorState message={overview.error} retry={refreshAll} />
        ) : null}
        {data ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={ready ? "default" : "outline"}>
                {ready
                  ? "记忆服务已就绪"
                  : data.settings.configured
                    ? "记忆服务未就绪"
                    : "记忆服务未配置"}
              </Badge>
              <Badge variant="secondary">
                {data.settings.tokenConfigured
                  ? "历史凭据已配置"
                  : "历史凭据未配置"}
              </Badge>
              <Badge variant="outline">
                {data.settings.syncIntervalSeconds > 0
                  ? `自动同步 · 每 ${data.settings.syncIntervalSeconds} 秒`
                  : "自动同步已关闭"}
                {data.settings.restartRequired ? " · 待生效" : ""}
              </Badge>
            </div>
            {data.error ? (
              <Alert variant="destructive">
                <AlertTitle>记忆服务需要检查</AlertTitle>
                <AlertDescription>{data.error}</AlertDescription>
              </Alert>
            ) : null}
            {data.settings.restartRequired && tab !== "settings" ? (
              <Alert>
                <AlertTitle>有设置等待重启</AlertTitle>
                <AlertDescription className="flex flex-col items-start gap-3">
                  <MemoryRestartHint
                    containerMode={data.settings.containerMode}
                  />
                </AlertDescription>
              </Alert>
            ) : null}
            {counts ? (
              <section
                className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
                aria-label="记忆库概况"
              >
                <Card>
                  <CardHeader>
                    <CardDescription>生效中的记忆</CardDescription>
                    <CardTitle>{counts.activeMemories}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      全部状态共 {counts.memories} 条
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardDescription>待整理的原文</CardDescription>
                    <CardTitle>{counts.pendingMessages}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      同步完成后，可交给小智整理
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardDescription>已同步的会话</CardDescription>
                    <CardTitle>{counts.chats}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      共 {counts.messages} 条原文消息
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardDescription>候选与摘要</CardDescription>
                    <CardTitle>
                      {counts.candidates} / {counts.summaries}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      另有 {counts.provisionalCaptures} 条暂存待核验
                    </p>
                  </CardContent>
                </Card>
              </section>
            ) : null}
            <Card>
              <CardHeader>
                <CardTitle>从对话到记忆</CardTitle>
                <CardDescription>
                  先同步官方历史，再在小智聊天中整理。整理会使用你当前的小智模型，通过
                  MCP 读取原话并记录有依据的记忆，无需另接付费模型。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={Boolean(syncReason) || syncStarting}
                    onClick={() => void startSync()}
                  >
                    <RefreshCw
                      data-icon="inline-start"
                      className={
                        state === "running" || syncStarting
                          ? "animate-spin"
                          : undefined
                      }
                    />
                    {state === "running" || syncStarting
                      ? "正在同步…"
                      : "同步对话历史"}
                  </Button>
                  <Button
                    disabled={!ready || !data.extractionPrompt}
                    onClick={() => void copyPrompt()}
                  >
                    <Copy data-icon="inline-start" />
                    复制整理提示
                  </Button>
                  <Button variant="ghost" onClick={() => setTab("settings")}>
                    <Settings2 data-icon="inline-start" />
                    打开设置
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  复制后，粘贴到小智聊天中发送。这里不会在后台自动调用模型或自动批准候选内容。
                </p>
                <div className="flex flex-col gap-1 text-sm" aria-live="polite">
                  <p>
                    {syncLabels[data.syncJob.state]}
                    {data.syncJob.message ? `：${data.syncJob.message}` : ""}
                  </p>
                  {syncReason ? (
                    <p className="text-muted-foreground">{syncReason}</p>
                  ) : null}
                  {data.syncJob.finishedAt ? (
                    <p className="text-muted-foreground">
                      本轮结束：{formatMemoryTime(data.syncJob.finishedAt)}
                    </p>
                  ) : null}
                  {lastVerifiedAt ? (
                    <p className="text-muted-foreground">
                      上次完整核验：{formatMemoryTime(lastVerifiedAt)}
                    </p>
                  ) : null}
                  {state === "partial" ? (
                    <p className="text-muted-foreground">
                      已保留同步进度，可以继续同步完成剩余内容。
                    </p>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          </>
        ) : null}
        <Tabs value={tab} onValueChange={setTab} className="min-w-0">
          <div className="overflow-x-auto pb-1">
            <TabsList
              className="w-max min-w-full justify-start sm:min-w-0"
              aria-label="记忆库管理"
            >
              <TabsTrigger value="entries">记忆</TabsTrigger>
              <TabsTrigger value="chats">对话原文</TabsTrigger>
              <TabsTrigger value="summaries">摘要</TabsTrigger>
              <TabsTrigger value="operations">操作记录</TabsTrigger>
              <TabsTrigger value="settings">设置</TabsTrigger>
            </TabsList>
          </div>
          {!ready && tab !== "settings" && !overview.loading ? (
            <Alert className="mt-4">
              <AlertTitle>
                {data?.settings.configured
                  ? "记忆服务尚未就绪"
                  : "先完成记忆服务设置"}
              </AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-3">
                <p>
                  {data?.settings.configured
                    ? "请检查服务状态；如果刚保存过设置，重启服务后再刷新。"
                    : "填写小智智能体 ID 并保存，再配置官方历史访问凭据，即可同步对话。"}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTab("settings")}
                >
                  前往设置
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          <TabsContent value="entries" className="mt-5">
            {ready ? (
              <MemoryEntries revision={revision} onSelect={setSelection} />
            ) : null}
          </TabsContent>
          <TabsContent value="chats" className="mt-5">
            {ready ? <MemoryChats revision={revision} /> : null}
          </TabsContent>
          <TabsContent value="summaries" className="mt-5">
            {ready ? (
              <MemorySummaries revision={revision} onSelect={setSelection} />
            ) : null}
          </TabsContent>
          <TabsContent value="operations" className="mt-5">
            {ready ? (
              <MemoryOperations
                revision={revision}
                onChanged={onChanged}
                onSelect={setSelection}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="settings" className="mt-5">
            <MemorySettings
              key={settingsRevision}
              ready={ready}
              onChanged={onChanged}
            />
          </TabsContent>
        </Tabs>
      </main>
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
    </div>
  );
}
