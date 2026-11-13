import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { memoryError, useMemoryResource } from "@/hooks/useMemoryResource";
import { memoryApi } from "@/services/memoryApi";
import { Download, KeyRound, Save } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import type { MemoryAdminSettings } from "../../../types/memory-admin";
import { MemoryErrorState, MemoryLoading } from "./memory-common";
import { MemoryRestartHint } from "./memory-restart-hint";

export function MemorySettings({
  ready,
  onChanged,
}: { ready: boolean; onChanged: () => void }) {
  const settings = useMemoryResource(memoryApi.settings);
  if (settings.loading) return <MemoryLoading label="正在读取设置…" />;
  if (settings.error)
    return (
      <MemoryErrorState message={settings.error} retry={settings.refresh} />
    );
  if (!settings.data) return null;
  return (
    <MemorySettingsForm
      settings={settings.data}
      ready={ready}
      onSaved={(value) => {
        settings.setData(value);
        onChanged();
      }}
      onCredentialSaved={() => {
        settings.refresh();
        onChanged();
      }}
    />
  );
}

export function MemorySettingsForm({
  settings,
  ready,
  onSaved,
  onCredentialSaved,
}: {
  settings: MemoryAdminSettings;
  ready: boolean;
  onSaved: (settings: MemoryAdminSettings) => void;
  onCredentialSaved: () => void;
}) {
  const [agentId, setAgentId] = useState(settings.agentId);
  const [ownerId, setOwnerId] = useState(settings.ownerId);
  const [automatic, setAutomatic] = useState(settings.syncIntervalSeconds > 0);
  const [interval, setInterval] = useState(
    String(settings.syncIntervalSeconds || 300)
  );
  const [maxRequests, setMaxRequests] = useState(
    String(settings.syncMaxRequests)
  );
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState<"export" | "backup" | null>(
    null
  );
  const [backup, setBackup] = useState<{
    fileName: string;
    bytes: number;
  } | null>(null);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const seconds = automatic ? Number(interval) : 0;
    const requests = Number(maxRequests);
    if (!agentId.trim()) {
      setFormError("请填写小智智能体 ID。");
      return;
    }
    if (
      automatic &&
      (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 2147483)
    ) {
      setFormError("自动同步间隔应为 60 到 2147483 秒之间的整数。");
      return;
    }
    if (!Number.isSafeInteger(requests) || requests < 1 || requests > 1000) {
      setFormError("每轮请求上限应为 1 到 1000 之间的整数。");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const saved = await memoryApi.saveSettings({
        agentId: agentId.trim(),
        ownerId: ownerId.trim(),
        syncIntervalSeconds: seconds,
        syncMaxRequests: requests,
      });
      onSaved(saved);
      toast.success("记忆设置已保存，请重启服务使配置生效。");
    } catch (error) {
      setFormError(memoryError(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token.trim()) return;
    const value = token.trim();
    setToken("");
    setSavingToken(true);
    setTokenError(null);
    try {
      await memoryApi.saveCredential(value);
      onCredentialSaved();
      toast.success("凭据已保存，输入框已清空。请按页面提示重启服务。");
    } catch (error) {
      setTokenError(memoryError(error));
    } finally {
      setSavingToken(false);
    }
  }

  async function download(kind: "export" | "backup") {
    setDownloadBusy(kind);
    try {
      if (kind === "export") {
        await memoryApi.export();
        toast.success("完整记忆数据已开始下载。");
      } else {
        const result = await memoryApi.backup();
        setBackup(result);
        await memoryApi.downloadBackup(result.fileName);
        toast.success("数据库备份已创建并开始下载。");
      }
    } catch (error) {
      toast.error(memoryError(error));
    } finally {
      setDownloadBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {settings.restartRequired ? (
        <Alert>
          <AlertTitle>设置已保存，等待重启</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <MemoryRestartHint containerMode={settings.containerMode} />
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid min-w-0 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>记忆服务</CardTitle>
            <CardDescription>
              关联一个小智智能体，设置官方对话历史的同步方式。
            </CardDescription>
          </CardHeader>
          <form onSubmit={saveSettings}>
            <CardContent className="flex flex-col gap-5">
              {settings.identityLocked ? (
                <Alert>
                  <AlertTitle>记忆库身份已锁定</AlertTitle>
                  <AlertDescription>
                    这个数据库已绑定身份。智能体和归属标识只读，避免把不同用户的记忆混在一起。
                  </AlertDescription>
                </Alert>
              ) : null}
              <div className="flex flex-col gap-2">
                <Label htmlFor="memory-agent-id">小智智能体 ID（必填）</Label>
                <Input
                  id="memory-agent-id"
                  value={agentId}
                  onChange={(event) => setAgentId(event.target.value)}
                  readOnly={settings.identityLocked}
                  required
                  maxLength={200}
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="memory-owner-id">记忆归属标识（选填）</Label>
                <Input
                  id="memory-owner-id"
                  value={ownerId}
                  onChange={(event) => setOwnerId(event.target.value)}
                  readOnly={settings.identityLocked}
                  maxLength={200}
                  autoComplete="off"
                  aria-describedby="memory-owner-help"
                />
                <p
                  id="memory-owner-help"
                  className="text-sm text-muted-foreground"
                >
                  仅当这个智能体只由一人使用时填写稳定标识；多人共用请留空，记忆按会话分开。
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="memory-database-path">数据库路径（只读）</Label>
                <Input
                  id="memory-database-path"
                  value={settings.databasePath || "首次保存设置后确定"}
                  readOnly
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="memory-auto-sync">自动同步对话历史</Label>
                  <p
                    id="memory-auto-help"
                    className="text-sm text-muted-foreground"
                  >
                    同步只保存原始对话。记忆整理需在小智聊天中进行。
                  </p>
                </div>
                <Switch
                  id="memory-auto-sync"
                  checked={automatic}
                  onCheckedChange={setAutomatic}
                  aria-describedby="memory-auto-help"
                />
              </div>
              {automatic ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="memory-sync-interval">同步间隔（秒）</Label>
                  <Input
                    id="memory-sync-interval"
                    type="number"
                    min={60}
                    max={2147483}
                    step={1}
                    value={interval}
                    onChange={(event) => setInterval(event.target.value)}
                    required
                  />
                </div>
              ) : null}
              <div className="flex flex-col gap-2">
                <Label htmlFor="memory-request-limit">每轮请求上限</Label>
                <Input
                  id="memory-request-limit"
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  value={maxRequests}
                  onChange={(event) => setMaxRequests(event.target.value)}
                  required
                  aria-describedby="memory-request-help"
                />
                <p
                  id="memory-request-help"
                  className="text-sm text-muted-foreground"
                >
                  范围 1–1000。达到上限后保留进度，下轮继续。
                </p>
              </div>
              {formError ? (
                <p role="alert" className="text-sm text-destructive">
                  {formError}
                </p>
              ) : null}
            </CardContent>
            <CardFooter>
              <Button type="submit" disabled={saving}>
                <Save data-icon="inline-start" />
                {saving ? "正在保存…" : "保存设置"}
              </Button>
            </CardFooter>
          </form>
        </Card>
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>官方历史访问凭据</CardTitle>
              <CardDescription>
                用于读取当前智能体的官方对话历史，仅提交到本机记忆服务。
              </CardDescription>
            </CardHeader>
            <form onSubmit={saveToken}>
              <CardContent className="flex flex-col gap-4">
                <div>
                  <Badge
                    variant={settings.tokenConfigured ? "secondary" : "outline"}
                  >
                    {settings.tokenConfigured ? "已配置凭据" : "尚未配置凭据"}
                  </Badge>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="memory-token">
                    {settings.tokenConfigured ? "替换访问 Token" : "访问 Token"}
                  </Label>
                  <Input
                    id="memory-token"
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={savingToken || !settings.configured}
                    aria-describedby="memory-token-help"
                  />
                  <p
                    id="memory-token-help"
                    className="text-sm text-muted-foreground"
                  >
                    填写官方控制台历史接口的 Bearer 凭据值，不含 Bearer
                    前缀；不是 MCP
                    接入地址里的令牌。凭据不会回显，也不会保存在浏览器本地存储中。提交后会清空输入框；留空不会删除已有凭据。
                  </p>
                </div>
                {!settings.configured ? (
                  <p className="text-sm text-muted-foreground">
                    请先填写智能体 ID 并保存记忆服务设置。
                  </p>
                ) : null}
                {tokenError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {tokenError} 请重新输入凭据后重试。
                  </p>
                ) : null}
              </CardContent>
              <CardFooter>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={
                    savingToken || !settings.configured || !token.trim()
                  }
                >
                  <KeyRound data-icon="inline-start" />
                  {savingToken ? "正在保存…" : "保存凭据"}
                </Button>
              </CardFooter>
            </form>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>导出与备份</CardTitle>
              <CardDescription>
                完整导出为 JSON；数据库备份为 SQLite
                文件，包含原始对话和记忆记录。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                文件中包含你的对话正文，请存放在可信的位置。
              </p>
              {!ready ? (
                <p className="text-sm text-muted-foreground">
                  记忆服务就绪后可以导出和备份。
                </p>
              ) : null}
              {backup ? (
                <div className="flex flex-col items-start gap-2">
                  <p className="break-all text-sm">
                    最近备份：{backup.fileName}（
                    {Math.max(1, Math.round(backup.bytes / 1024))} KB）
                  </p>
                  <Button
                    variant="link"
                    size="sm"
                    disabled={downloadBusy !== null}
                    onClick={() =>
                      void memoryApi
                        .downloadBackup(backup.fileName)
                        .catch((error: unknown) =>
                          toast.error(memoryError(error))
                        )
                    }
                  >
                    重新下载这份备份
                  </Button>
                </div>
              ) : null}
            </CardContent>
            <CardFooter className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!ready || downloadBusy !== null}
                onClick={() => void download("export")}
              >
                <Download data-icon="inline-start" />
                {downloadBusy === "export" ? "正在导出…" : "导出完整 JSON"}
              </Button>
              <Button
                variant="outline"
                disabled={!ready || downloadBusy !== null}
                onClick={() => void download("backup")}
              >
                <Download data-icon="inline-start" />
                {downloadBusy === "backup" ? "正在备份…" : "创建并下载备份"}
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}
